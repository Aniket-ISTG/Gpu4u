"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { PrivateKey } = require("@hiero-ledger/sdk");

const { transactionLinks, topicLinks, accountLinks, toMirrorTransactionId } = require("../service/links");
const { meterLease, secondsToCap } = require("../service/metering");
const { SettlementVerifier } = require("../service/verifier");
const { HcsPublisher } = require("../service/hcs");
const { AuditLog } = require("../service/audit");
const { Store } = require("../service/store");
const { mirrorWalletChecker, ledgerWalletChecker, assertWalletEligible, WalletError } = require("../service/wallet-check");
const { SimLedger } = require("../service/sim-ledger");

describe("verification links", () => {
    const tx = "0.0.7162784@1793912526.894421774";

    it("converts a transaction ID to the form the mirror node uses", () => {
        assert.equal(toMirrorTransactionId(tx), "0.0.7162784-1793912526-894421774");
        assert.equal(toMirrorTransactionId("0.0.7162784-1793912526-894421774"), "0.0.7162784-1793912526-894421774");
    });

    it("links a real testnet transaction on HashScan and as a mirror node record anyone can fetch", () => {
        const links = transactionLinks({ transactionId: tx, consensusTimestamp: "1793912531.123456789", simulated: false });
        assert.equal(links.hashscan, "https://hashscan.io/testnet/transaction/1793912531.123456789");
        assert.equal(links.mirrorApi, "https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1793912526-894421774");
    });

    it("falls back to the transaction ID when the consensus time is not known yet", () => {
        const links = transactionLinks({ transactionId: tx, simulated: false });
        assert.match(links.hashscan, /^https:\/\/hashscan\.io\/testnet\/transaction\/0\.0\.7162784@1793912526\.894421774$/);
    });

    it("never invents a link for a simulated payment, or for a missing transaction", () => {
        assert.deepEqual(transactionLinks({ transactionId: tx, simulated: true }), { hashscan: null, mirrorApi: null });
        assert.deepEqual(transactionLinks({ transactionId: null, simulated: false }), { hashscan: null, mirrorApi: null });
    });

    it("only ever points at testnet", () => {
        for (const url of Object.values(transactionLinks({ transactionId: tx, simulated: false }))) assert.doesNotMatch(url, /mainnet/);
        assert.match(topicLinks({ topicId: "0.0.99", simulated: false }).hashscan, /hashscan\.io\/testnet\/topic\/0\.0\.99$/);
        assert.match(topicLinks({ topicId: "0.0.99", simulated: false }).mirrorApi, /topics\/0\.0\.99\/messages$/);
        assert.match(accountLinks({ accountId: "0.0.5", simulated: false }).hashscan, /testnet\/account\/0\.0\.5$/);
        assert.equal(topicLinks({ topicId: "0.0.99", simulated: true }).hashscan, null);
    });
});

describe("lease-time billing", () => {
    const base = { hourlyUsd: 0.22, capUsd: 0.42, startedAtMs: 1_000_000 };

    it("bills the hourly price by the second", () => {
        const hour = meterLease({ ...base, capUsd: 5, endedAtMs: base.startedAtMs + 3600 * 1000 });
        assert.equal(hour.billedSeconds, 3600);
        assert.equal(hour.actualUsd, 0.22);
        const minute = meterLease({ ...base, endedAtMs: base.startedAtMs + 60 * 1000 });
        assert.equal(minute.actualUsd, 0.003666);
        assert.equal(minute.stoppedAtCap, false);
    });

    it("counts a partial second as a whole second, and the first second always counts", () => {
        assert.equal(meterLease({ ...base, endedAtMs: base.startedAtMs + 1001 }).billedSeconds, 2);
        assert.equal(meterLease({ ...base, endedAtMs: base.startedAtMs }).billedSeconds, 1);
        assert.ok(meterLease({ ...base, endedAtMs: base.startedAtMs }).actualUsd > 0);
    });

    it("never bills past the cap, and says it stopped there", () => {
        const long = meterLease({ ...base, endedAtMs: base.startedAtMs + 10 * 3600 * 1000 });
        assert.equal(long.stoppedAtCap, true);
        assert.equal(long.billedSeconds, long.capSeconds);
        assert.ok(long.actualUsd <= 0.42);
        assert.ok(long.actualUsd > 0.4199);
        // The browser's live meter (frontend/lib/payments/lease-meter.ts) must show this exact figure, so what the user
        // watches is what they are billed. frontend/tests/payment-transaction.test.ts pins the same number.
        assert.equal(long.actualUsd, 0.419955);
        assert.equal(long.capSeconds, 6872);
        assert.equal(secondsToCap({ hourlyUsd: 0.22, capUsd: 0.42 }), long.capSeconds);
    });

    it("is monotonic: a longer lease never costs less", () => {
        let last = 0;
        for (let s = 1; s <= 8000; s += 37) {
            const { actualUsd } = meterLease({ ...base, endedAtMs: base.startedAtMs + s * 1000 });
            assert.ok(actualUsd >= last);
            last = actualUsd;
        }
    });

    it("rejects impossible input", () => {
        assert.throws(() => meterLease({ ...base, hourlyUsd: 0, endedAtMs: 2_000_000 }));
        assert.throws(() => meterLease({ ...base, capUsd: -1, endedAtMs: 2_000_000 }));
        assert.throws(() => meterLease({ ...base, endedAtMs: base.startedAtMs - 1 }), /cannot end before/);
    });
});

describe("refund verification on the ledger", () => {
    const record = (transfers, over = {}) => ({
        transactions: [{ transaction_id: "0.0.2000-1700000000-000000001", result: "SUCCESS", consensus_timestamp: "1700000005.000000001", charged_tx_fee: 100_000, nonce: 0, transfers, ...over }],
    });
    const verifier = (body) => new SettlementVerifier({ fetchTransaction: async () => body, retries: 1, retryDelayMs: 1 });
    const check = (body, over = {}) =>
        verifier(body).verifyTransfer({ transactionId: "0.0.2000@1700000000.000000001", sender: "0.0.2000", receiver: "0.0.5000001", tinybars: 500n, ...over });

    it("accepts a refund that credited exactly the amount, with the sender paying only the network fee on top", async () => {
        const v = await check(record([
            { account: "0.0.2000", amount: -(500 + 100_000) }, { account: "0.0.5000001", amount: 500 }, { account: "0.0.3", amount: 60_000 }, { account: "0.0.98", amount: 40_000 },
        ]));
        assert.equal(v.verified, true, v.problems.join("; "));
        assert.equal(v.consensusTimestamp, "1700000005.000000001");
    });

    it("rejects a refund that credited the wrong amount", async () => {
        const v = await check(record([{ account: "0.0.2000", amount: -400 }, { account: "0.0.5000001", amount: 400 }]));
        assert.equal(v.verified, false);
        assert.ok(v.problems.some((p) => /expected exactly 500/.test(p)));
    });

    it("rejects value sent to anyone else, and a sender who lost more than the amount plus the fee", async () => {
        const stray = await check(record([{ account: "0.0.2000", amount: -(500 + 300) }, { account: "0.0.5000001", amount: 500 }, { account: "0.0.8000000", amount: 300 }]));
        assert.ok(stray.problems.some((p) => /Unexpected credit/.test(p)));
        const drained = await check(record([{ account: "0.0.2000", amount: -50_000_000 }, { account: "0.0.5000001", amount: 500 }, { account: "0.0.98", amount: 100 }]));
        assert.ok(drained.problems.some((p) => /lost/.test(p)));
    });

    it("rejects a failed transaction and one that never appears", async () => {
        const failed = await check(record([{ account: "0.0.2000", amount: -500 }, { account: "0.0.5000001", amount: 500 }], { result: "INSUFFICIENT_PAYER_BALANCE" }));
        assert.equal(failed.verified, false);
        assert.ok(failed.problems.some((p) => /INSUFFICIENT_PAYER_BALANCE/.test(p)));
        const missing = await verifier({ transactions: [] }).verifyTransfer({ transactionId: "0.0.2000@1.1", sender: "0.0.2000", receiver: "0.0.5", tinybars: 5n });
        assert.equal(missing.verified, false);
        assert.match(missing.problems[0], /not found/);
    });

    it("links to the explorer by consensus time when it has an explorer address", async () => {
        const v = await new SettlementVerifier({
            fetchTransaction: async () => record([{ account: "0.0.2000", amount: -500 }, { account: "0.0.5000001", amount: 500 }, { account: "0.0.98", amount: 0 }]),
            explorerBase: "https://hashscan.io/testnet/transaction", retries: 1,
        }).verifyTransfer({ transactionId: "0.0.2000@1700000000.000000001", sender: "0.0.2000", receiver: "0.0.5000001", tinybars: 500n });
        assert.equal(v.explorerUrl, "https://hashscan.io/testnet/transaction/1700000005.000000001");
    });
});

describe("audit messages are confirmed on the ledger", () => {
    function setup({ fetchMessage, retries = 2 }) {
        const store = new Store(":memory:");
        const audit = new AuditLog({ store });
        const event = audit.append({ paymentId: "pay_1", eventType: "PAYMENT_RECEIVED", status: "RECEIVED" });
        const publisher = new HcsPublisher({
            store, accountId: "0.0.1", privateKey: PrivateKey.generateECDSA().toStringDer(), topicId: "0.0.99",
            mirrorUrl: "http://mirror", confirmRetries: retries, confirmDelayMs: 1, retries: 1, retryDelayMs: 1, log: { warn() {} },
        });
        publisher.fetchMessage = fetchMessage;
        audit.publisher = publisher;
        const messageFor = (over = {}) => ({
            consensus_timestamp: "1700000009.000000001",
            message: Buffer.from(JSON.stringify({ v: 2, p: event.paymentId, s: event.seq, h: event.hash, ...over })).toString("base64"),
        });
        return { store, audit, publisher, event, messageFor };
    }

    it("marks a posted message CONFIRMED when the topic holds a message with the same payment, sequence and hash", async () => {
        let ctx;
        ctx = setup({ fetchMessage: async () => ctx.messageFor() });
        const outcome = await ctx.publisher.confirmEvent({ paymentId: "pay_1", seq: 1, hash: ctx.event.hash }, "7");
        assert.equal(outcome, "CONFIRMED");
        const e = ctx.store.listAuditEvents("pay_1")[0];
        assert.equal(e.hcs.status, "CONFIRMED");
        assert.equal(e.hcs.sequence, "7");
        assert.equal(e.hcs.consensusTimestamp, "1700000009.000000001");
    });

    it("flags a message on the topic that does not match the event", async () => {
        let ctx;
        ctx = setup({ fetchMessage: async () => ctx.messageFor({ h: "sha256:forged" }) });
        assert.equal(await ctx.publisher.confirmEvent({ paymentId: "pay_1", seq: 1, hash: ctx.event.hash }, "7"), "MISMATCH");
        assert.equal(ctx.store.listAuditEvents("pay_1")[0].hcs.status, "MISMATCH");
    });

    it("keeps a message UNCONFIRMED while the mirror node has not seen it, and confirms it on a later check", async () => {
        let visible = false;
        let ctx;
        ctx = setup({ fetchMessage: async () => (visible ? ctx.messageFor() : null) });
        assert.equal(await ctx.publisher.confirmEvent({ paymentId: "pay_1", seq: 1, hash: ctx.event.hash }, "7"), "UNCONFIRMED");
        assert.equal(ctx.store.listAuditEvents("pay_1")[0].hcs.status, "UNCONFIRMED");

        visible = true;
        const result = await ctx.publisher.confirmPending();
        assert.deepEqual(result, { checked: 1, confirmed: 1 });
        assert.equal(ctx.store.listAuditEvents("pay_1")[0].hcs.status, "CONFIRMED");
    });

    it("treats a slow or failing mirror node as not yet visible, never as confirmed", async () => {
        const ctx = setup({ fetchMessage: async () => { throw new Error("mirror node down"); } });
        assert.equal(await ctx.publisher.confirmEvent({ paymentId: "pay_1", seq: 1, hash: ctx.event.hash }, "7"), "UNCONFIRMED");
    });

    it("confirms each message right after posting it", async () => {
        let ctx;
        ctx = setup({ fetchMessage: async () => ctx.messageFor() });
        ctx.publisher.submit = async () => ({ sequence: "12" });
        ctx.publisher.enqueue(ctx.event);
        await ctx.publisher.flush();
        const e = ctx.store.listAuditEvents("pay_1")[0];
        assert.equal(e.hcs.status, "CONFIRMED");
        assert.equal(e.hcs.sequence, "12");
    });

    it("does nothing without a mirror node to read from", async () => {
        const store = new Store(":memory:");
        const publisher = new HcsPublisher({ store, accountId: "0.0.1", privateKey: PrivateKey.generateECDSA().toStringDer(), topicId: "0.0.99" });
        assert.deepEqual(await publisher.confirmPending(), { checked: 0 });
    });
});

describe("a wallet must be able to complete the payment", () => {
    const account = (over = {}) => ({
        account: "0.0.5000001", receiver_sig_required: false, balance: { balance: 5_000_000_000 },
        key: { _type: "ECDSA_SECP256K1", key: "02" + "ab".repeat(32) }, ...over,
    });
    const checker = (response) => mirrorWalletChecker({ mirrorUrl: "http://m", fetchImpl: async () => response });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

    it("accepts a funded account with a single key that can receive HBAR", async () => {
        const info = await assertWalletEligible(checker(json(account())), "0.0.5000001", 1_000_000_000n);
        assert.equal(info.keyType, "ECDSA_SECP256K1");
    });

    it("refuses an account that does not exist", async () => {
        await assert.rejects(assertWalletEligible(checker(json({}, 404)), "0.0.5000001", 1n), (e) => e instanceof WalletError && e.code === "WALLET_NOT_FOUND" && e.status === 404);
    });

    it("does not care whether the account needs a signature to receive, since nothing is ever sent to it", async () => {
        await assertWalletEligible(checker(json(account({ receiver_sig_required: true }))), "0.0.5000001", 1n);
    });

    it("refuses a multi-signature account and an account too poor to pay", async () => {
        await assert.rejects(assertWalletEligible(checker(json(account({ key: { _type: "ProtobufEncoded", key: "x" } }))), "0.0.5000001", 1n), () => true);
        await assert.rejects(assertWalletEligible(checker(json(account({ key: { _type: "KeyList" } }))), "0.0.5000001", 1n), (e) => e.code === "UNSUPPORTED_KEY");
        await assert.rejects(assertWalletEligible(checker(json(account({ balance: { balance: 10 } }))), "0.0.5000001", 1_000_000_000n), (e) => e.code === "INSUFFICIENT_BALANCE");
    });

    it("reports an unreachable ledger as unavailable, never as eligible", async () => {
        const down = mirrorWalletChecker({ mirrorUrl: "http://m", fetchImpl: async () => { throw new Error("timeout"); } });
        await assert.rejects(assertWalletEligible(down, "0.0.5000001", 1n), (e) => e.code === "LEDGER_UNAVAILABLE" && e.status === 503);
        await assert.rejects(assertWalletEligible(checker(json({}, 500)), "0.0.5000001", 1n), (e) => e.code === "LEDGER_UNAVAILABLE");
    });

    it("the simulated ledger answers the same way for development", async () => {
        const ledger = new SimLedger();
        ledger.addAccount("0.0.5000001", { key: PrivateKey.generateECDSA().publicKey, balance: 100n });
        const sim = ledgerWalletChecker({ ledger });
        assert.equal((await sim.inspect("0.0.5000001")).exists, true);
        assert.equal((await sim.inspect("0.0.9")).exists, false);
        await assert.rejects(assertWalletEligible(sim, "0.0.5000001", 1000n), (e) => e.code === "INSUFFICIENT_BALANCE");
    });
});
