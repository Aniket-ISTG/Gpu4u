"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { PrivateKey } = require("@hiero-ledger/sdk");
const { proto } = require("@hiero-ledger/proto");

const { loadConfig, assertRunnable } = require("../service/config");
const { makeRate, usdToTinybars, tinybarsToUsd, tinybarsToHbarString, RateService } = require("../service/rate");
const { Store } = require("../service/store");
const { PolicyEngine } = require("../service/policy");
const { QuoteService } = require("../service/quotes");
const { AuditLog, sanitize } = require("../service/audit");
const { HcsPublisher } = require("../service/hcs");
const { SimLedger } = require("../service/sim-ledger");
const { SettlementVerifier } = require("../service/verifier");
const { prefixMessage, verifyWalletSignature } = require("../service/wallet-signature");
const { FIXED_RATE } = require("./helpers/service");

const LIMITS = { autoApproveLimitUsd: 0.5, dailyLimitUsd: 5, hardCeilingUsd: 25, globalDailyLimitUsd: 50 };
const WALLET = "0.0.5000001";
const MERCHANT = "0.0.2";

describe("configuration", () => {
    it("has safe defaults and runs in simulated mode", () => {
        const c = loadConfig({});
        assert.equal(c.mode, "simulated");
        assert.equal(c.approval.mode, "click");
        assert.equal(c.facilitator.mode, "local");
        assert.deepEqual(c.policy, { autoApproveLimitUsd: 0.5, dailyLimitUsd: 5, hardCeilingUsd: 25, globalDailyLimitUsd: 50 });
    });

    it("rejects invalid values at startup", () => {
        assert.throws(() => loadConfig({ PAYMENT_MODE: "mainnet" }), /PAYMENT_MODE/);
        assert.throws(() => loadConfig({ AUTO_APPROVE_LIMIT_USD: "abc" }), /AUTO_APPROVE_LIMIT_USD/);
        assert.throws(() => loadConfig({ HEDERA_RECEIVER_ID: "not-an-id" }), /HEDERA_RECEIVER_ID/);
    });

    it("never lets the auto limit exceed the hard ceiling", () => {
        const c = loadConfig({ AUTO_APPROVE_LIMIT_USD: "100", HARD_CEILING_USD: "10" });
        assert.equal(c.policy.autoApproveLimitUsd, 10);
    });

    it("requires a service token, and merchant and facilitator credentials in testnet mode", () => {
        assert.throws(() => assertRunnable(loadConfig({})), /SERVICE_TOKEN/);
        assert.doesNotThrow(() => assertRunnable(loadConfig({ SERVICE_TOKEN: "x".repeat(16) })));
        const base = { SERVICE_TOKEN: "x".repeat(16), PAYMENT_MODE: "testnet" };
        assert.throws(() => assertRunnable(loadConfig(base)), /HEDERA_RECEIVER_ID/);
        assert.throws(() => assertRunnable(loadConfig({ ...base, HEDERA_RECEIVER_ID: "0.0.20" })), /FACILITATOR_FEE_PAYER_ID/);
        // The receiver needs no key: only the fee payer's account and key are required.
        assert.doesNotThrow(() =>
            assertRunnable(loadConfig({ ...base, HEDERA_RECEIVER_ID: "0.0.20", FACILITATOR_FEE_PAYER_ID: "0.0.30", FACILITATOR_FEE_PAYER_KEY: "k" })),
        );
    });

    it("refuses a local facilitator whose fee payer is the merchant", () => {
        const config = loadConfig({
            SERVICE_TOKEN: "x".repeat(16), PAYMENT_MODE: "testnet", HEDERA_RECEIVER_ID: "0.0.20",
            HEDERA_MERCHANT_PRIVATE_KEY: "k", FACILITATOR_FEE_PAYER_ID: "0.0.20", FACILITATOR_FEE_PAYER_KEY: "k",
        });
        assert.throws(() => assertRunnable(config), /fee payer must be a different account/);
    });

    it("in testnet the wallet is the only payer, and a server-held agent payer is refused", () => {
        const testnet = loadConfig({ PAYMENT_MODE: "testnet" });
        assert.equal(testnet.payer.mode, "wallet");
        assert.equal(testnet.facilitator.mode, "local", "testnet defaults to a local facilitator");
        assert.throws(() => loadConfig({ PAYMENT_MODE: "testnet", PAYER_MODE: "agent" }), /not allowed with PAYMENT_MODE=testnet/);
        assert.equal(loadConfig({}).payer.mode, "agent", "simulated development keeps its agent payer");
        assert.equal(loadConfig({ PAYER_MODE: "wallet" }).payer.mode, "wallet", "simulated can also exercise the wallet flow");
    });

    it("never accepts mainnet, through any setting", () => {
        for (const env of [
            { HEDERA_NETWORK: "mainnet" }, { HEDERA_NETWORK: "hedera:mainnet" },
            { HEDERA_MIRROR_URL: "https://mainnet.mirrornode.hedera.com" },
            { FACILITATOR_URL: "https://api.blocky402.mainnet.example" },
        ]) {
            assert.throws(() => loadConfig(env), /mainnet|testnet/i, JSON.stringify(env));
        }
        assert.doesNotThrow(() => loadConfig({ HEDERA_NETWORK: "testnet" }));
        assert.equal(loadConfig({}).hedera.network, "hedera:testnet");
    });

    it("simulated mode always uses its local facilitator, so it can never be pointed at a real one", () => {
        assert.equal(loadConfig({ FACILITATOR_MODE: "external" }).facilitator.mode, "local");
    });
});

describe("USD to HBAR conversion", () => {
    it("converts at the network rate and matches the worked examples in the design doc", () => {
        assert.equal(FIXED_RATE.usdPerHbar, 0.068125);
        assert.equal(tinybarsToHbarString(usdToTinybars(0.3388, FIXED_RATE)), "4.97321101");
        assert.equal(tinybarsToHbarString(usdToTinybars(0.93, FIXED_RATE)), "13.65137615");
    });

    it("always rounds up, so a quote never undercharges", () => {
        for (const usd of [0.000001, 0.01, 0.3388, 0.42, 1.16, 24.99, 25]) {
            const tinybars = usdToTinybars(usd, FIXED_RATE);
            assert.ok(tinybarsToUsd(tinybars, FIXED_RATE) >= usd - 1e-9, "usd " + usd);
            assert.ok(tinybarsToUsd(tinybars - 1n, FIXED_RATE) < usd + 1e-9, "one tinybar less would undercharge, usd " + usd);
        }
    });

    it("rejects amounts that cannot be priced", () => {
        for (const bad of [0, -1, NaN, Infinity, "1"]) assert.throws(() => usdToTinybars(bad, FIXED_RATE));
        assert.throws(() => usdToTinybars(1, { centEquivalent: 0, hbarEquivalent: 1 }), /invalid/);
    });

    it("formats tinybars as HBAR without losing precision", () => {
        assert.equal(tinybarsToHbarString(100_000_000n), "1");
        assert.equal(tinybarsToHbarString(1n), "0.00000001");
        assert.equal(tinybarsToHbarString(150_000_000n), "1.5");
    });

    it("reads the mirror node rate, caches it, and falls back only in simulated mode", async () => {
        let calls = 0;
        const body = { current_rate: { cent_equivalent: 204375, hbar_equivalent: 30000, expiration_time: 1900000000 } };
        const ok = async () => { calls++; return new Response(JSON.stringify(body)); };
        const live = new RateService({ mirrorUrl: "http://m", fetchImpl: ok });
        const rate = await live.getRate();
        await live.getRate();
        assert.equal(calls, 1);
        assert.equal(rate.source, "hedera-mirror-node");
        assert.equal(rate.usdPerHbar, 0.068125);

        const down = async () => { throw new Error("offline"); };
        const sim = await new RateService({ mirrorUrl: "http://m", fetchImpl: down, simulated: true, fallbackUsdPerHbar: 0.068 }).getRate();
        assert.equal(sim.source, "fixed-fallback");
        assert.ok(Math.abs(sim.usdPerHbar - 0.068) < 1e-9);

        await assert.rejects(new RateService({ mirrorUrl: "http://m", fetchImpl: down, simulated: false }).getRate(), /exchange rate/);
    });
});

describe("spending policy", () => {
    const make = () => {
        const store = new Store(":memory:");
        return { store, policy: new PolicyEngine({ limits: LIMITS, allowedPayTo: [MERCHANT], store }) };
    };
    const evaluate = (p, capUsd, payTo = MERCHANT, wallet = WALLET) => p.evaluate({ capUsd, payTo, wallet });
    const commit = (store, id, wallet, capUsd, status = "CONFIRMED") => {
        store.insertQuote({ id: "q" + id, createdAt: 1, expiresAt: 9, wallet, payTo: MERCHANT, offer: {}, hours: 1, hourlyUsd: 1, estimateUsd: 1, capUsd, tinybars: 1n, rate: {}, termsHash: "h" });
        store.insertPayment({ id: "p" + id, quoteId: "q" + id, wallet, status, createdAt: Date.now(), capUsd, tinybars: 1n, mode: "simulated" });
    };

    it("pays automatically up to the limit, including exactly the limit", () => {
        const { policy } = make();
        assert.equal(evaluate(policy, 0.42).decision, "auto");
        assert.equal(evaluate(policy, 0.5).decision, "auto");
    });

    it("holds anything above the limit for a human", () => {
        const { policy } = make();
        const r = evaluate(policy, 0.51);
        assert.equal(r.decision, "approval");
        assert.match(r.reasons[0], /above the automatic limit/);
    });

    it("refuses above the hard ceiling and to unknown recipients, which no approval can override", () => {
        const { policy } = make();
        assert.equal(evaluate(policy, 25.01).decision, "refuse");
        assert.equal(evaluate(policy, 0.1, "0.0.999").decision, "refuse");
    });

    it("counts spend already committed today toward the daily limit", () => {
        const { store, policy } = make();
        commit(store, 1, WALLET, 4.8);
        const r = evaluate(policy, 0.3);
        assert.equal(r.decision, "approval");
        assert.match(r.reasons.join(" "), /daily limit/);
        assert.equal(r.committedTodayUsd, 4.8);
    });

    it("does not count refused, rejected, expired or failed payments", () => {
        const { store, policy } = make();
        ["REFUSED", "REJECTED", "EXPIRED", "FAILED"].forEach((status, i) => commit(store, i, WALLET, 4.9, status));
        assert.equal(evaluate(policy, 0.3).decision, "auto");
    });

    it("limits splitting: five small payments cannot slip past the daily total", () => {
        const { store, policy } = make();
        for (let i = 0; i < 4; i++) commit(store, i, WALLET, 1.25);
        assert.equal(evaluate(policy, 0.4).decision, "approval");
    });

    it("caps the whole service across wallets, since nothing proves who is asking", () => {
        const { store, policy } = make();
        for (let i = 0; i < 10; i++) commit(store, i, "0.0.60000" + i, 4.9);
        const r = evaluate(policy, 2, MERCHANT, "0.0.7777");
        assert.equal(r.decision, "refuse");
        assert.match(r.reasons[0], /service-wide/);
    });
});

describe("quotes", () => {
    const make = (over = {}) => {
        const store = new Store(":memory:");
        const policy = new PolicyEngine({ limits: LIMITS, allowedPayTo: [MERCHANT], store });
        const service = new QuoteService({
            store, policy, merchantAccountId: MERCHANT, network: "hedera:testnet", ttlSeconds: 600,
            rates: { getRate: async () => FIXED_RATE }, ...over,
        });
        return { store, service };
    };
    const request = (over = {}) => ({
        wallet: WALLET,
        offer: { id: "o1", provider: "simplepod", gpuModel: "RTX 3090", gpuCount: 1, vramGb: 24, region: "US" },
        hours: 1.54, hourlyUsd: 0.22, estimateUsd: 0.3388, capUsd: 0.42, ...over,
    });

    it("prices the cap in HBAR at the current rate and names the merchant", async () => {
        const { service } = make();
        const q = await service.create(request());
        assert.equal(q.tinybars, usdToTinybars(0.42, FIXED_RATE).toString());
        assert.equal(q.hbar, "6.16513762");
        assert.equal(q.payTo, MERCHANT);
        assert.equal(q.rate.source, "test-fixed");
        assert.equal(q.policyPreview.decision, "auto");
        assert.match(q.termsHash, /^[0-9a-f]{64}$/);
    });

    it("previews the approval requirement for a larger cap", async () => {
        const { service } = make();
        assert.equal((await service.create(request({ estimateUsd: 0.93, capUsd: 1.16 }))).policyPreview.decision, "approval");
    });

    it("expires on schedule", async () => {
        let t = 1_000_000;
        const { service } = make({ now: () => t });
        const q = await service.create(request());
        assert.equal(service.get(q.id).expired, false);
        t += 600_001;
        assert.equal(service.get(q.id).expired, true);
    });

    it("rejects malformed input, unknown fields, and a cap below the estimate", async () => {
        const { service } = make();
        for (const bad of [
            request({ wallet: "alice" }), request({ hours: 0 }), request({ capUsd: -1 }), request({ capUsd: 0.1 }),
            { ...request(), amountTinybars: "1" }, request({ offer: { id: "o" } }), null,
        ]) {
            await assert.rejects(service.create(bad), `should reject ${JSON.stringify(bad)?.slice(0, 60)}`);
        }
    });
});

describe("audit log", () => {
    it("chains events per payment and detects any edit", () => {
        const store = new Store(":memory:");
        const audit = new AuditLog({ store });
        audit.append({ paymentId: "p1", eventType: "A", status: "RECEIVED", details: { n: 1 } });
        audit.append({ paymentId: "p1", eventType: "B", status: "APPROVED" });
        audit.append({ paymentId: "p1", eventType: "C", status: "CONFIRMED", transactionId: "0.0.1@1.2" });
        audit.append({ paymentId: "p2", eventType: "A", status: "RECEIVED" });
        assert.deepEqual(audit.verifyChain("p1"), { valid: true, brokenAtSeq: null });
        assert.deepEqual(audit.list("p1").map((e) => e.seq), [1, 2, 3]);
        assert.equal(audit.list("p2")[0].seq, 1);

        store.db.prepare("UPDATE audit_events SET details_json = '{\"n\":2}' WHERE payment_id = 'p1' AND seq = 1").run();
        assert.deepEqual(audit.verifyChain("p1"), { valid: false, brokenAtSeq: 1 });
        assert.equal(audit.verifyChain("p2").valid, true);
    });

    it("detects a removed event", () => {
        const store = new Store(":memory:");
        const audit = new AuditLog({ store });
        for (const t of ["A", "B", "C"]) audit.append({ paymentId: "p", eventType: t, status: "X" });
        store.db.prepare("DELETE FROM audit_events WHERE payment_id = 'p' AND seq = 2").run();
        assert.equal(audit.verifyChain("p").valid, false);
    });

    it("never stores secrets, however deeply nested", () => {
        const clean = sanitize({
            ok: 1, amount: 5n, privateKey: "X", nested: { approvalToken: "t", signature: "s", fine: true, list: [{ secret: "y", keep: 2 }] },
        });
        assert.deepEqual(clean, { ok: 1, amount: "5", nested: { fine: true, list: [{ keep: 2 }] } });
    });

    it("marks events local when nothing anchors them, and pending when a publisher will", () => {
        const store = new Store(":memory:");
        new AuditLog({ store }).append({ paymentId: "p", eventType: "A", status: "X" });
        assert.equal(store.listAuditEvents("p")[0].hcs.status, "LOCAL");
        const queued = [];
        new AuditLog({ store, publisher: { enqueue: (e) => queued.push(e), flush: async () => {} } }).append({ paymentId: "q", eventType: "A", status: "X" });
        assert.equal(store.listAuditEvents("q")[0].hcs.status, "PENDING");
        assert.equal(queued.length, 1);
    });
});

describe("Hedera Consensus Service publisher", () => {
    const publisher = (submit, over = {}) => {
        const store = new Store(":memory:");
        const audit = new AuditLog({ store });
        const pub = new HcsPublisher({
            store, accountId: "0.0.1", privateKey: PrivateKey.generateECDSA().toStringDer(), topicId: "0.0.99",
            retries: 3, retryDelayMs: 1, log: { warn() {} }, ...over,
        });
        pub.submit = submit;
        audit.publisher = pub;
        return { store, audit, pub };
    };

    it("publishes compact, hash-committing messages in order and records the topic sequence", async () => {
        const sent = [];
        const { store, audit, pub } = publisher(async (message) => { sent.push(JSON.parse(message)); return { sequence: String(sent.length) }; });
        audit.append({ paymentId: "p", eventType: "A", status: "RECEIVED", details: { big: "x".repeat(5000) } });
        audit.append({ paymentId: "p", eventType: "B", status: "APPROVED" });
        await pub.flush();
        assert.deepEqual(sent.map((m) => m.e), ["A", "B"]);
        assert.equal(sent[1].ph, sent[0].h);
        assert.ok(JSON.stringify(sent[0]).length < 400, "messages stay small; details are committed by hash, not sent");
        assert.deepEqual(store.listAuditEvents("p").map((e) => [e.hcs.status, e.hcs.sequence]), [["PUBLISHED", "1"], ["PUBLISHED", "2"]]);
    });

    it("retries, then marks the event failed without throwing", async () => {
        let attempts = 0;
        const { store, audit, pub } = publisher(async () => { attempts++; throw new Error("network down"); });
        audit.append({ paymentId: "p", eventType: "A", status: "X" });
        await pub.flush();
        assert.equal(attempts, 3);
        const e = store.listAuditEvents("p")[0];
        assert.equal(e.hcs.status, "FAILED");
        assert.match(e.hcs.error, /network down/);
    });

    it("recovers on a later attempt", async () => {
        let attempts = 0;
        const { store, audit, pub } = publisher(async () => { if (++attempts < 2) throw new Error("blip"); return { sequence: "7" }; });
        audit.append({ paymentId: "p", eventType: "A", status: "X" });
        await pub.flush();
        assert.equal(store.listAuditEvents("p")[0].hcs.status, "PUBLISHED");
    });
});

describe("independent settlement verification", () => {
    const FEE_PAYER = "0.0.30";
    const setup = () => {
        const ledger = new SimLedger();
        ledger.addAccount("0.0.10", { balance: 1_000_000_000n });
        ledger.addAccount("0.0.20", { balance: 0n });
        ledger.addAccount("0.0.4000", { balance: 0n });
        ledger.addAccount(FEE_PAYER, { balance: 1_000_000_000n });
        const verifier = new SettlementVerifier({ fetchTransaction: async (id) => ledger.getMirrorTransactions(id), retries: 2, retryDelayMs: 1 });
        const settle = (transfers, feePayer = FEE_PAYER, id = "0.0.30@1700000000.000000001") =>
            ledger.submit({ transactionId: id, feePayer, transfers });
        return { ledger, verifier, settle };
    };
    const expected = (over = {}) => ({ payer: "0.0.10", payTo: "0.0.20", tinybars: 500n, feePayers: [FEE_PAYER], ...over });

    it("accepts an exact payment by the right payer to the right merchant", async () => {
        const { verifier, settle } = setup();
        const r = settle([{ account: "0.0.10", amount: -500n }, { account: "0.0.20", amount: 500n }]);
        const v = await verifier.verify({ transactionId: r.transactionId, ...expected() });
        assert.equal(v.verified, true);
        assert.deepEqual(v.problems, []);
    });

    it("rejects a different amount, in either direction", async () => {
        const { verifier, settle } = setup();
        const r = settle([{ account: "0.0.10", amount: -500n }, { account: "0.0.20", amount: 500n }]);
        assert.equal((await verifier.verify({ transactionId: r.transactionId, ...expected({ tinybars: 499n }) })).verified, false);
        assert.equal((await verifier.verify({ transactionId: r.transactionId, ...expected({ tinybars: 501n }) })).verified, false);
    });

    it("rejects value sent to someone else, and the wrong payer", async () => {
        const { verifier, settle } = setup();
        const r = settle([{ account: "0.0.10", amount: -500n }, { account: "0.0.20", amount: 400n }, { account: "0.0.4000", amount: 100n }]);
        const v = await verifier.verify({ transactionId: r.transactionId, ...expected() });
        assert.equal(v.verified, false);
        assert.ok(v.problems.some((p) => p.includes("Unexpected credit")));
        assert.equal((await verifier.verify({ transactionId: r.transactionId, ...expected({ payer: "0.0.4000" }) })).verified, false);
    });

    it("rejects a fee payer the agent does not trust, and a fee payer that is the payer", async () => {
        const { verifier, settle } = setup();
        const r = settle([{ account: "0.0.10", amount: -500n }, { account: "0.0.20", amount: 500n }]);
        const v = await verifier.verify({ transactionId: r.transactionId, ...expected({ feePayers: ["0.0.31"] }) });
        assert.ok(v.problems.some((p) => p.includes("not a known facilitator")));

        const self = settle([{ account: "0.0.10", amount: -500n }, { account: "0.0.20", amount: 500n }], "0.0.10", "0.0.10@1700000000.000000002");
        const v2 = await verifier.verify({ transactionId: self.transactionId, ...expected({ feePayers: [] }) });
        assert.ok(v2.problems.some((p) => p.includes("must not be the paying account")));
    });

    it("fails clearly when the transaction never shows up", async () => {
        const { verifier } = setup();
        const v = await verifier.verify({ transactionId: "0.0.30@1.1", ...expected() });
        assert.equal(v.verified, false);
        assert.match(v.problems[0], /not found/);
    });
});

describe("simulated ledger", () => {
    it("refuses overdrafts, unbalanced transfers and a transaction ID used twice", () => {
        const ledger = new SimLedger();
        ledger.addAccount("0.0.10", { balance: 100n });
        ledger.addAccount("0.0.20", { balance: 0n });
        ledger.addAccount("0.0.30", { balance: 10_000_000n });
        const pay = (amount, id) => ledger.submit({ transactionId: id, feePayer: "0.0.30", transfers: [{ account: "0.0.10", amount: -amount }, { account: "0.0.20", amount }] });
        assert.throws(() => pay(101n, "0.0.30@1.1"), /INSUFFICIENT_ACCOUNT_BALANCE/);
        assert.throws(() => ledger.submit({ transactionId: "0.0.30@1.2", transfers: [{ account: "0.0.10", amount: -1n }, { account: "0.0.20", amount: 2n }] }), /INVALID_ACCOUNT_AMOUNTS/);
        pay(60n, "0.0.30@1.3");
        assert.throws(() => pay(10n, "0.0.30@1.3"), /DUPLICATE_TRANSACTION/);
        assert.equal(ledger.balanceOf("0.0.10"), 40n);
        assert.equal(ledger.balanceOf("0.0.20"), 60n);
    });
});

describe("wallet signatures", () => {
    const message = "GPU4U payment approval\nQuote: q_1\nAmount: 6.16 HBAR";
    const signatureMapFor = (key, text) => {
        const sig = key.sign(prefixMessage(text));
        const field = key.type === "ED25519" ? { ed25519: sig } : { ECDSASecp256k1: sig };
        const bytes = proto.SignatureMap.encode({ sigPair: [{ pubKeyPrefix: key.publicKey.toBytesRaw().slice(0, 6), ...field }] }).finish();
        return Buffer.from(bytes).toString("base64");
    };

    for (const [label, generate] of [["ECDSA", () => PrivateKey.generateECDSA()], ["ED25519", () => PrivateKey.generateED25519()]]) {
        it(label + ": accepts a wallet signature map and a bare signature", () => {
            const key = generate();
            assert.equal(verifyWalletSignature({ message, signatureMap: signatureMapFor(key, message), publicKey: key.publicKey }), true);
            const bare = Buffer.from(key.sign(prefixMessage(message))).toString("hex");
            assert.equal(verifyWalletSignature({ message, signature: bare, publicKey: key.publicKey }), true);
        });

        it(label + ": rejects a signature over different text, or from a different key", () => {
            const key = generate();
            const map = signatureMapFor(key, message);
            assert.equal(verifyWalletSignature({ message: message + " ", signatureMap: map, publicKey: key.publicKey }), false);
            assert.equal(verifyWalletSignature({ message, signatureMap: map, publicKey: generate().publicKey }), false);
        });
    }

    it("a signed message cannot be replayed as a transaction signature", () => {
        const key = PrivateKey.generateECDSA();
        const unprefixed = key.sign(Buffer.from(message));
        assert.equal(verifyWalletSignature({ message, signature: Buffer.from(unprefixed).toString("hex"), publicKey: key.publicKey }), false);
    });

    it("returns false for garbage instead of throwing", () => {
        const key = PrivateKey.generateECDSA();
        assert.equal(verifyWalletSignature({ message, signature: "zz", publicKey: key.publicKey }), false);
        assert.equal(verifyWalletSignature({ message, publicKey: key.publicKey }), false);
    });
});
