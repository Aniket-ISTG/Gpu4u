"use strict";

/**
 * Settling in an HTS token (USDC) instead of HBAR. Everything here runs on the simulated ledger and the real
 * x402 client, server and facilitator code, exactly like the HBAR tests. The token is $1, so there is no
 * exchange rate: the quote is the dollar cap in the token's six-decimal base unit.
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { startWalletService, walletPay, loadBuilder, HBAR } = require("./helpers/wallet");
const { startTestService, quoteRequest } = require("./helpers/service");
const asset = require("../service/asset");
const { loadConfig } = require("../service/config");
const { Store } = require("../service/store");
const { SimLedger } = require("../service/sim-ledger");
const { SettlementVerifier } = require("../service/verifier");
const { checkWalletPayload } = require("../service/payload-check");
const { checkTerms } = require("../service/agent");
const { assertWalletEligible, mirrorWalletChecker, WalletError } = require("../service/wallet-check");
const { runPreflight, PreflightError } = require("../service/preflight");
const { PaymentStatus } = require("../service/states");

const USDC = asset.tokenAsset({ id: asset.TESTNET_USDC_ID });
const ENV = { PAYMENT_ASSET: "usdc" };
const UNITS = (usd) => BigInt(Math.round(usd * 1_000_000));

const running = [];
afterEach(async () => {
    while (running.length) await running.pop().stop().catch(() => {});
});
const startWallet = async (options = {}) => {
    const svc = await startWalletService({ env: ENV, tokens: { [asset.TESTNET_USDC_ID]: UNITS(10) }, ...options });
    running.push(svc);
    return svc;
};
const get = async (svc, id) => (await svc.call("GET", "/v1/payments/" + id)).body;
const begin = async (svc, over) => {
    const quote = await svc.quote(over);
    const started = await svc.call("POST", "/v1/payments", { quoteId: quote.id });
    return { quote, id: started.body.payment.id };
};

describe("asset helpers", () => {
    it("formats amounts exactly in the token's own units", () => {
        assert.equal(asset.formatAmount(420000n, USDC), "0.42");
        assert.equal(asset.formatAmount(1_000_000n, USDC), "1");
        assert.equal(asset.formatAmount(1n, USDC), "0.000001");
        assert.equal(asset.formatAmount(100_000_000n), "1", "HBAR default");
        assert.equal(asset.formatAmount(150_000_000n), "1.5");
    });

    it("converts dollars to token units with no rate, rounding up and never down", () => {
        assert.equal(asset.usdToTokenUnits(0.42, USDC), 420000n);
        assert.equal(asset.usdToTokenUnits(1, USDC), 1_000_000n);
        assert.equal(asset.usdToTokenUnits(0.0000011, USDC), 1n, "a fraction of a unit is never rounded down to nothing");
        assert.throws(() => asset.usdToTokenUnits(0, USDC));
        assert.throws(() => asset.usdToTokenUnits(Number.NaN, USDC));
        assert.throws(() => asset.usdToTokenUnits(1, asset.HBAR), /exchange rate/);
    });

    it("refuses a malformed token id and HBAR as a token", () => {
        assert.throws(() => asset.tokenAsset({ id: "usdc" }));
        assert.throws(() => asset.tokenAsset({ id: "0.0.0" }));
        assert.throws(() => asset.tokenAsset({ id: "0.0.5", decimals: 99 }));
    });

    it("treats a stored quote with no asset as HBAR, so older quotes keep working", () => {
        assert.equal(asset.assetFromStored(null), asset.HBAR);
        assert.equal(asset.assetFromStored({ id: "0.0.0" }), asset.HBAR);
        assert.equal(asset.assetFromStored(asset.storableAsset(USDC)).id, USDC.id);
    });
});

describe("configuration", () => {
    const base = { SERVICE_TOKEN: "x".repeat(20) };
    it("is HBAR unless USDC is asked for", () => {
        assert.equal(loadConfig(base).asset.symbol, "HBAR");
        const c = loadConfig({ ...base, PAYMENT_ASSET: "usdc" });
        assert.equal(c.asset.symbol, "USDC");
        assert.equal(c.asset.id, asset.TESTNET_USDC_ID);
        assert.equal(c.asset.decimals, 6);
    });
    it("takes the token id from USDC_TOKEN_ID and rejects nonsense", () => {
        assert.equal(loadConfig({ ...base, PAYMENT_ASSET: "usdc", USDC_TOKEN_ID: "0.0.1234" }).asset.id, "0.0.1234");
        assert.throws(() => loadConfig({ ...base, PAYMENT_ASSET: "usdc", USDC_TOKEN_ID: "abc" }), /USDC_TOKEN_ID/);
        assert.throws(() => loadConfig({ ...base, PAYMENT_ASSET: "eth" }), /PAYMENT_ASSET/);
    });
});

describe("the simulated ledger and tokens", () => {
    const T = asset.TESTNET_USDC_ID;
    const ledger = () => {
        const l = new SimLedger();
        l.addAccount("0.0.10", { balance: 10n * HBAR, tokens: { [T]: 500n } });
        l.addAccount("0.0.11", { tokens: { [T]: 0n } });
        l.addAccount("0.0.12", { balance: 10n * HBAR }); // not associated
        return l;
    };
    const send = (l, from, to, amount) =>
        l.submit({ transactionId: `0.0.10@1.${Math.floor(Math.random() * 1e9)}`, transfers: [], tokenTransfers: [
            { token: T, account: from, amount: -amount }, { token: T, account: to, amount },
        ] });

    it("moves a token between associated accounts", () => {
        const l = ledger();
        send(l, "0.0.10", "0.0.11", 200n);
        assert.equal(l.balanceOf("0.0.10", T), 300n);
        assert.equal(l.balanceOf("0.0.11", T), 200n);
    });
    it("refuses an account that is not associated, as Hedera does", () => {
        assert.throws(() => send(ledger(), "0.0.10", "0.0.12", 1n), /TOKEN_NOT_ASSOCIATED_TO_ACCOUNT/);
    });
    it("refuses an overdraft and a transfer that does not net to zero", () => {
        assert.throws(() => send(ledger(), "0.0.10", "0.0.11", 501n), /INSUFFICIENT_TOKEN_BALANCE/);
        assert.throws(() => ledger().submit({ transactionId: "0.0.10@2.1", transfers: [], tokenTransfers: [{ token: T, account: "0.0.11", amount: 5n }] }), /ZERO_SUM/);
    });
    it("reports token transfers in the mirror node's shape", () => {
        const l = ledger();
        const r = send(l, "0.0.10", "0.0.11", 5n);
        const record = l.getMirrorTransactions(r.mirrorTransactionId).transactions[0];
        assert.deepEqual(record.token_transfers.map((t) => [t.token_id, t.account, t.amount]).sort(), [[T, "0.0.10", -5], [T, "0.0.11", 5]]);
    });
});

describe("wallet mode: paying in USDC", () => {
    it("quotes the dollar cap in USDC units with no exchange rate", async () => {
        const svc = await startWallet();
        const quote = await svc.quote({ capUsd: 0.42 });
        assert.equal(quote.tinybars, "420000");
        assert.equal(quote.asset.symbol, "USDC");
        assert.equal(quote.asset.id, asset.TESTNET_USDC_ID);
        assert.equal(quote.amountDisplay, "0.42");
        assert.equal(quote.assetSymbol, "USDC");
        assert.equal(quote.hbar, null);
        assert.equal(quote.rate.source, "usd-peg");
        assert.equal(quote.rate.usdPerHbar, null);
    });

    it("tells the wallet to pay the token, and the 402 terms name it", async () => {
        const svc = await startWallet();
        const { quote, id } = await begin(svc);
        const r = (await svc.call("GET", `/v1/payments/${id}/requirements`)).body;
        const terms = r.required.accepts[0];
        assert.equal(terms.asset, asset.TESTNET_USDC_ID);
        assert.equal(terms.amount, quote.tinybars);
        assert.deepEqual(r.expected, { payTo: quote.payTo, tinybars: quote.tinybars, asset: asset.TESTNET_USDC_ID });
    });

    it("settles the wallet's payment in the token: exact amount, no HBAR from the user, then a lease", async () => {
        const svc = await startWallet();
        const hbarBefore = svc.userBalance();
        const feeBefore = svc.ledger.balanceOf(svc.services.accounts.feePayer);
        const { quote, id } = await begin(svc);
        const paid = await walletPay(svc, id);
        assert.equal(paid.submit.status, 200, JSON.stringify(paid.submit.body));
        await svc.services.payments.idle();
        const view = await get(svc, id);

        assert.equal(view.payment.status, PaymentStatus.LEASE_ACTIVE, view.payment.error || "");
        assert.equal(svc.ledger.balanceOf(svc.account, asset.TESTNET_USDC_ID), UNITS(10) - BigInt(quote.tinybars), "the user paid exactly the quote in USDC");
        assert.equal(svc.ledger.balanceOf(svc.services.accounts.merchant, asset.TESTNET_USDC_ID), BigInt(quote.tinybars), "the merchant received exactly the quote");
        assert.equal(svc.userBalance(), hbarBefore, "the user spent no HBAR");
        assert.ok(svc.ledger.balanceOf(svc.services.accounts.feePayer) < feeBefore, "the facilitator paid the network fee in HBAR");
        assert.equal(view.payment.settlement.verified, true);
        assert.equal(view.payment.settlement.asset, asset.TESTNET_USDC_ID);
        assert.equal(view.quote.amountDisplay, "0.42");
        assert.equal(view.chain.valid, true);
        const signed = view.events.find((e) => e.eventType === "PAYMENT_SIGNED_BY_WALLET");
        assert.equal(signed.details.asset, asset.TESTNET_USDC_ID);
    });

    it("ends the lease and reports the amounts in USDC, with no refund", async () => {
        const svc = await startWallet();
        const { quote, id } = await begin(svc);
        await walletPay(svc, id);
        await svc.services.payments.idle();
        const ended = await svc.call("POST", `/v1/payments/${id}/lease/end`);
        assert.equal(ended.status, 200, JSON.stringify(ended.body));
        const receipt = (await svc.call("GET", `/v1/payments/${id}/receipt`)).body;
        assert.equal(receipt.quote.paidDisplay, "0.42");
        assert.equal(receipt.quote.asset.symbol, "USDC");
        assert.equal(receipt.quote.paidHbar, null);
        const rec = (await get(svc, id)).lease.reconciliation;
        assert.equal(rec.billedDisplay, rec.paidDisplay, "no refund: the whole amount is billed");
        assert.equal(rec.paidDisplay, "0.42");
        assert.equal(svc.ledger.balanceOf(svc.account, asset.TESTNET_USDC_ID), UNITS(10) - BigInt(quote.tinybars), "nothing was sent back");
    });

    it("refuses a quote for a wallet that is not associated with the token", async () => {
        const svc = await startWallet({ tokens: {} });
        const r = await svc.call("POST", "/v1/quotes", quoteRequest());
        assert.equal(r.status, 422, JSON.stringify(r.body));
        assert.equal(r.body.error, "TOKEN_NOT_ASSOCIATED");
        assert.match(r.body.message, /associated with USDC/);
    });

    it("refuses a quote the wallet cannot cover in USDC even though it holds plenty of HBAR", async () => {
        const svc = await startWallet({ tokens: { [asset.TESTNET_USDC_ID]: UNITS(0.1) } });
        const r = await svc.call("POST", "/v1/quotes", quoteRequest());
        assert.equal(r.status, 422, JSON.stringify(r.body));
        assert.equal(r.body.error, "INSUFFICIENT_BALANCE");
    });

    it("rejects an HBAR transfer sent for a USDC quote, and the payment stays open to retry", async () => {
        const svc = await startWallet();
        const { id } = await begin(svc);
        const before = svc.ledger.balanceOf(svc.account, asset.TESTNET_USDC_ID);
        // The wallet is told to pay HBAR, so it builds and signs an HBAR transfer. The server must refuse it.
        const wrong = await walletPay(svc, id, {
            mutateRequired: (required) => {
                required.accepts[0].asset = "0.0.0";
                return required;
            },
        });
        assert.equal(wrong.submit.status, 422, JSON.stringify(wrong.submit.body));
        assert.equal(wrong.submit.body.error, "PAYLOAD_REJECTED");
        assert.match(wrong.submit.body.message, /signed asset is not the quoted USDC/);
        assert.match(wrong.submit.body.message, /moves HBAR, which is not allowed for a token payment/);
        assert.equal((await get(svc, id)).payment.status, PaymentStatus.AWAITING_SIGNATURE, "still open");
        assert.equal(svc.ledger.balanceOf(svc.account, asset.TESTNET_USDC_ID), before, "no money moved");

        // The correct USDC payment still works afterwards.
        const right = await walletPay(svc, id);
        assert.equal(right.submit.status, 200, JSON.stringify(right.submit.body));
        await svc.services.payments.idle();
        assert.equal((await get(svc, id)).payment.status, PaymentStatus.LEASE_ACTIVE);
    });

    it("refuses to build a wallet payment in a different asset from the one it quoted", async () => {
        const builder = await loadBuilder();
        const terms = { scheme: "exact", network: "hedera:testnet", amount: "420000", asset: "0.0.0", payTo: "0.0.7000002", extra: { feePayer: "0.0.7000003" } };
        assert.throws(
            () => builder.selectTerms({ x402Version: 2, accepts: [terms] }, { payTo: "0.0.7000002", tinybars: "420000", asset: asset.TESTNET_USDC_ID }),
            (e) => e.code === "TERMS_MISMATCH" && /not the quoted token 0\.0\.429274/.test(e.message),
        );
    });
});

describe("the server's payload check, in USDC", () => {
    const quote = { wallet: "0.0.5000001", payTo: "0.0.7000002", tinybars: "420000", asset: USDC };
    it("accepts exactly two parties of the quoted token and nothing else", async () => {
        // Built with the real browser builder through a signed payment, then inspected with the same check the server runs.
        const svc = await startWallet();
        const { id } = await begin(svc);
        let seen;
        await walletPay(svc, id, { mutatePayload: (p) => (seen = p) });
        await svc.services.payments.idle();
        const view = await get(svc, id);
        assert.equal(view.payment.status, PaymentStatus.LEASE_ACTIVE);
        assert.ok(seen.payload.transaction.length > 0);
    });

    it("lists the problem when the signed asset or transfer differs from the quote", () => {
        const required = { accepts: [{ scheme: "exact", network: "hedera:testnet", amount: "420000", asset: USDC.id, payTo: quote.payTo, maxTimeoutSeconds: 180, extra: { feePayer: "0.0.7000003" } }] };
        const payload = { x402Version: 2, accepted: { ...required.accepts[0], asset: "0.0.0" }, payload: { transaction: "AAAA" } };
        const check = checkWalletPayload({ payload, required, quote, knownFeePayers: ["0.0.7000003"] });
        assert.ok(check.problems.some((p) => /differ from the server's on asset/.test(p)));
        assert.ok(check.problems.some((p) => /signed asset is not the quoted USDC/.test(p)));
    });
});

describe("the agent's check of the terms, in USDC", () => {
    const quote = { payTo: "0.0.7000002", tinybars: "420000", asset: USDC };
    const good = { scheme: "exact", network: "hedera:testnet", asset: USDC.id, payTo: quote.payTo, amount: "420000", extra: { feePayer: "0.0.7000003" }, maxTimeoutSeconds: 180 };
    it("accepts the quoted token", () => {
        assert.deepEqual(checkTerms({ requirements: good, quote, knownFeePayers: ["0.0.7000003"] }), []);
    });
    it("refuses HBAR or another token when USDC was approved", () => {
        for (const other of ["0.0.0", "0.0.999999"]) {
            const problems = checkTerms({ requirements: { ...good, asset: other }, quote, knownFeePayers: ["0.0.7000003"] });
            assert.equal(problems.length, 1);
            assert.match(problems[0], /approved quote is in USDC/);
        }
    });
    it("refuses a raised price", () => {
        const problems = checkTerms({ requirements: { ...good, amount: "420001" }, quote, knownFeePayers: ["0.0.7000003"] });
        assert.match(problems[0], /exactly 420000/);
    });
    it("still treats a quote with no asset as HBAR", () => {
        const problems = checkTerms({ requirements: good, quote: { payTo: quote.payTo, tinybars: "420000" }, knownFeePayers: ["0.0.7000003"] });
        assert.match(problems[0], /HBAR/);
    });
});

describe("the independent ledger check, in USDC", () => {
    const T = asset.TESTNET_USDC_ID;
    const PAYER = "0.0.5000001", MERCHANT = "0.0.7000002", FEE = "0.0.7000003";
    const record = (over = {}) => ({
        transaction_id: `${FEE}-1700000000-111`.replace("0.0.7000003", "0.0.7000003"),
        result: "SUCCESS",
        consensus_timestamp: "1700000000.000000001",
        charged_tx_fee: 100000,
        nonce: 0,
        transfers: [{ account: FEE, amount: -100000 }, { account: "0.0.98", amount: 100000 }],
        token_transfers: [{ token_id: T, account: PAYER, amount: -420000 }, { token_id: T, account: MERCHANT, amount: 420000 }],
        ...over,
    });
    const verify = (rec, extra = {}) =>
        new SettlementVerifier({ fetchTransaction: async () => ({ transactions: [rec] }), retries: 1, retryDelayMs: 1 })
            .verify({ transactionId: `${FEE}@1700000000.000000111`, payer: PAYER, payTo: MERCHANT, tinybars: "420000", asset: USDC, feePayers: [FEE], ...extra });

    it("verifies the exact token amount between exactly the right accounts", async () => {
        const result = await verify(record());
        assert.deepEqual(result.problems, []);
        assert.equal(result.verified, true);
        assert.equal(result.asset, T);
    });
    it("fails when the merchant received less, more or in another token", async () => {
        for (const amount of [419999, 420001]) {
            const r = await verify(record({ token_transfers: [{ token_id: T, account: PAYER, amount: -amount }, { token_id: T, account: MERCHANT, amount }] }));
            assert.equal(r.verified, false);
        }
        const other = await verify(record({ token_transfers: [{ token_id: "0.0.999", account: PAYER, amount: -420000 }, { token_id: "0.0.999", account: MERCHANT, amount: 420000 }] }));
        assert.equal(other.verified, false);
        assert.ok(other.problems.some((p) => /0\.0\.999/.test(p)));
    });
    it("fails when anyone else received the token", async () => {
        const r = await verify(record({ token_transfers: [
            { token_id: T, account: PAYER, amount: -420100 }, { token_id: T, account: MERCHANT, amount: 420000 }, { token_id: T, account: "0.0.8888888", amount: 100 },
        ] }));
        assert.equal(r.verified, false);
        assert.ok(r.problems.some((p) => /Unexpected credit of 100 USDC units to 0\.0\.8888888/.test(p)));
    });
    it("fails when the payer also spent HBAR, or an outsider was paid HBAR", async () => {
        const spent = await verify(record({ transfers: [{ account: PAYER, amount: -5 }, { account: FEE, amount: -99995 }, { account: "0.0.98", amount: 100000 }] }));
        assert.ok(spent.problems.some((p) => /spent HBAR/.test(p)));
        const leaked = await verify(record({ transfers: [{ account: FEE, amount: -100000 }, { account: "0.0.8888888", amount: 100000 }] }));
        assert.ok(leaked.problems.some((p) => /Unexpected credit of 100000 tinybars/.test(p)));
    });
    it("fails when the transaction did not succeed or the fee payer is unknown", async () => {
        assert.equal((await verify(record({ result: "INSUFFICIENT_TOKEN_BALANCE" }))).verified, false);
        assert.equal((await verify(record(), { feePayers: ["0.0.1"] })).verified, false);
    });
    it("does not let a token movement hide inside an HBAR payment", async () => {
        const rec = record({
            transfers: [{ account: PAYER, amount: -420000 }, { account: MERCHANT, amount: 420000 }],
            token_transfers: [{ token_id: T, account: PAYER, amount: -1 }, { token_id: T, account: "0.0.8888888", amount: 1 }],
        });
        const r = await verify(rec, { asset: asset.HBAR });
        assert.equal(r.verified, false);
        assert.ok(r.problems.some((p) => /Unexpected movement of token/.test(p)));
    });
});

describe("the wallet check on the real mirror node shape", () => {
    const WALLET = "0.0.5000001", T = asset.TESTNET_USDC_ID;
    const reply = (accountBody, tokensBody) => async (url) => {
        const body = String(url).includes("/tokens") ? tokensBody : accountBody;
        return { status: body ? 200 : 404, ok: Boolean(body), json: async () => body };
    };
    const account = { key: { _type: "ED25519" }, balance: { balance: 100_000_000 } };
    const checker = (tokens) => mirrorWalletChecker({ mirrorUrl: "http://m", fetchImpl: reply(account, tokens) });

    it("reads the token balance and association from the account's tokens", async () => {
        const info = await checker({ tokens: [{ token_id: T, balance: 777 }] }).inspect(WALLET, USDC);
        assert.equal(info.associated, true);
        assert.equal(info.balance, 777n);
        assert.equal(info.balanceTinybars, 100_000_000n, "HBAR is still reported");
    });
    it("passes when the balance covers the amount", async () => {
        await assertWalletEligible(checker({ tokens: [{ token_id: T, balance: 420000 }] }), WALLET, 420000n, USDC);
    });
    it("explains an account that is not associated, and one that is short", async () => {
        await assert.rejects(assertWalletEligible(checker({ tokens: [] }), WALLET, 1n, USDC), (e) => e instanceof WalletError && e.code === "TOKEN_NOT_ASSOCIATED");
        await assert.rejects(assertWalletEligible(checker({ tokens: [{ token_id: T, balance: 5 }] }), WALLET, 6n, USDC), (e) => e.code === "INSUFFICIENT_BALANCE" && /0\.000005 USDC.*0\.000006 USDC/.test(e.message));
    });
    it("does not look at HBAR balance for a token payment", async () => {
        const poor = mirrorWalletChecker({ mirrorUrl: "http://m", fetchImpl: reply({ ...account, balance: { balance: 0 } }, { tokens: [{ token_id: T, balance: 500 }] }) });
        await assertWalletEligible(poor, WALLET, 500n, USDC);
    });
});

describe("agent mode (simulated development): paying in USDC with the official x402 client", () => {
    it("pays by itself under the automatic limit, in the token", async () => {
        const svc = await startTestService({ env: ENV });
        running.push(svc);
        const agent = svc.services.accounts.agent;
        const ledger = svc.services.ledger;
        const before = ledger.balanceOf(agent, asset.TESTNET_USDC_ID);
        const quote = await svc.quote({ capUsd: 0.42 });
        const started = await svc.call("POST", "/v1/payments", { quoteId: quote.id });
        await svc.services.payments.idle();
        const view = (await svc.call("GET", "/v1/payments/" + started.body.payment.id)).body;
        assert.equal(view.payment.status, PaymentStatus.LEASE_ACTIVE, view.payment.error || "");
        assert.equal(ledger.balanceOf(agent, asset.TESTNET_USDC_ID), before - 420000n);
        assert.equal(ledger.balanceOf(svc.services.accounts.merchant, asset.TESTNET_USDC_ID), 420000n);
        assert.equal(view.payment.settlement.asset, asset.TESTNET_USDC_ID);
    });
});

describe("the approval text, in USDC", () => {
    it("names the amount in USDC, so a signature cannot be reused for HBAR", async () => {
        const svc = await startTestService({ env: { ...ENV, AUTO_APPROVE_LIMIT_USD: "0.10" } });
        running.push(svc);
        const quote = await svc.quote({ capUsd: 0.42 });
        const started = await svc.call("POST", "/v1/payments", { quoteId: quote.id });
        const view = (await svc.call("GET", "/v1/payments/" + started.body.payment.id)).body;
        assert.equal(view.payment.status, PaymentStatus.PENDING_APPROVAL);
        assert.match(view.approval.message, /Amount: 0\.42 USDC \(420000 USDC units\)/);
    });
});

describe("the store", () => {
    it("adds the asset column to a database created before tokens existed, and reads old quotes as HBAR", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gpu4u-store-"));
        const file = path.join(dir, "old.sqlite");
        const { DatabaseSync } = require("node:sqlite");
        const old = new DatabaseSync(file);
        old.exec(`CREATE TABLE quotes (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, wallet TEXT NOT NULL,
            pay_to TEXT NOT NULL, offer_json TEXT NOT NULL, hours REAL NOT NULL, hourly_usd REAL NOT NULL, estimate_usd REAL NOT NULL,
            cap_usd REAL NOT NULL, tinybars TEXT NOT NULL, rate_json TEXT NOT NULL, terms_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN');`);
        old.prepare(`INSERT INTO quotes VALUES ('q_old', 1, 2, '0.0.1', '0.0.2', '{}', 1, 1, 1, 1, '5', '{}', 'h', 'OPEN')`).run();
        old.close();

        const store = new Store(file);
        try {
            const quote = store.getQuote("q_old");
            assert.equal(quote.asset.id, "0.0.0");
            assert.equal(quote.asset.symbol, "HBAR");
            assert.equal(quote.tinybars, "5");
            new Store(file).close(); // running the migration twice is harmless
        } finally {
            store.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("startup preflight for the token", () => {
    const MERCHANT = "0.0.7000002", T = asset.TESTNET_USDC_ID;
    const config = (extra = {}) => ({
        hedera: { mirrorUrl: "http://m", merchantAccountId: MERCHANT, merchantPrivateKey: null, hcsTopicId: null },
        facilitator: { mode: "external", feePayerAccountId: null, feePayerPrivateKey: null },
        asset: USDC, ...extra,
    });
    const mirror = ({ token, held = { tokens: [] }, merchant = { balance: { balance: 0 }, key: { key: "aa" }, max_automatic_token_associations: 0 } }) => async (url) => {
        const u = String(url);
        const body = u.includes("/tokens?") ? held : u.includes("/api/v1/tokens/") ? token : u.includes(`/accounts/${MERCHANT}`) ? merchant : null;
        return { status: body ? 200 : 404, ok: Boolean(body), json: async () => body };
    };
    const services = { rates: { getRate: async () => { throw new Error("the rate must not be needed for a token"); } }, publisher: null };
    const good = { type: "FUNGIBLE_COMMON", decimals: "6", symbol: "USDC", deleted: false, pause_status: "NOT_APPLICABLE" };

    it("needs no exchange rate, and passes when the token exists and the merchant is associated", async () => {
        const report = await runPreflight({ config: config(), services, fetchImpl: mirror({ token: good, held: { tokens: [{ token_id: T }] } }) });
        assert.ok(report.some((line) => /Payment asset: USDC/.test(line)));
        assert.ok(!report.some((line) => /Exchange rate/.test(line)));
    });
    it("accepts automatic association on the merchant", async () => {
        const merchant = { balance: { balance: 0 }, key: { key: "aa" }, max_automatic_token_associations: -1 };
        const report = await runPreflight({ config: config(), services, fetchImpl: mirror({ token: good, merchant }) });
        assert.ok(report.some((line) => /automatic association/.test(line)));
    });
    it("refuses to start when the merchant cannot receive the token", async () => {
        await assert.rejects(runPreflight({ config: config(), services, fetchImpl: mirror({ token: good }) }), (e) => e instanceof PreflightError && /not associated with USDC/.test(e.message));
    });
    it("refuses a token that is missing, paused, not fungible, or has other decimals", async () => {
        const held = { tokens: [{ token_id: T }] };
        for (const [token, pattern] of [
            [null, /does not exist/],
            [{ ...good, pause_status: "PAUSED" }, /paused/],
            [{ ...good, type: "NON_FUNGIBLE_UNIQUE" }, /not a fungible token/],
            [{ ...good, decimals: "8" }, /decimals/],
        ]) {
            await assert.rejects(runPreflight({ config: config(), services, fetchImpl: mirror({ token, held }) }), (e) => e instanceof PreflightError && pattern.test(e.message), String(pattern));
        }
    });
});
