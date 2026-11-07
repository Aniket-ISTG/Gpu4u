"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PrivateKey } = require("@hiero-ledger/sdk");

const { startWalletService, walletPay, HBAR } = require("./helpers/wallet");
const { quoteRequest, WALLET, TOKEN, FIXED_RATE } = require("./helpers/service");
const { SimLedger, SIM_FEE_TINYBARS } = require("../service/sim-ledger");
const { usdToTinybars } = require("../service/rate");
const { meterLease } = require("../service/metering");
const { PaymentStatus } = require("../service/states");
const { buildServices } = require("../service/container");
const { createApp, startServer } = require("../service/app");
const { loadConfig } = require("../service/config");

const running = [];
const start = async (options) => {
    const svc = await startWalletService(options);
    running.push(svc);
    return svc;
};
afterEach(async () => {
    while (running.length) await running.pop().stop().catch(() => {});
});

const BIG = { estimateUsd: 0.93, capUsd: 1.16 }; // above the $0.50 automatic limit
const kinds = (view) => view.events.map((e) => e.eventType);
const get = async (svc, id) => (await svc.call("GET", "/v1/payments/" + id)).body;
const begin = async (svc, over) => {
    const quote = await svc.quote(over);
    const started = await svc.call("POST", "/v1/payments", { quoteId: quote.id });
    return { quote, id: started.body.payment.id, started };
};

/** A payment that has been signed and confirmed, with an active lease. */
async function activeLease(svc, over) {
    const { quote, id } = await begin(svc, over);
    const paid = await walletPay(svc, id);
    assert.equal(paid.submit.status, 200, JSON.stringify(paid.submit.body));
    await svc.services.payments.idle();
    const view = await get(svc, id);
    assert.equal(view.payment.status, PaymentStatus.LEASE_ACTIVE, view.payment.error || "");
    return { quote, id, view };
}

describe("wallet mode: a small payment", () => {
    it("waits for the wallet and moves no money until it signs", async () => {
        const svc = await start();
        const { id } = await begin(svc);
        const view = await get(svc, id);
        assert.equal(view.payment.status, PaymentStatus.AWAITING_SIGNATURE);
        assert.deepEqual(kinds(view), ["PAYMENT_RECEIVED", "POLICY_EVALUATED", "AUTO_APPROVED", "WALLET_SIGNATURE_REQUESTED"]);
        assert.equal(svc.merchantBalance(), 0n);
        assert.equal(svc.userBalance(), 1000n * HBAR);
        assert.equal(view.lease, null, "no lease before payment");
        assert.equal(view.payerMode, "wallet");
    });

    it("tells the wallet exactly what to sign, from the stored quote", async () => {
        const svc = await start();
        const { quote, id } = await begin(svc);
        const r = (await svc.call("GET", `/v1/payments/${id}/requirements`)).body;
        const terms = r.required.accepts[0];
        assert.equal(terms.scheme, "exact");
        assert.equal(terms.network, "hedera:testnet");
        assert.equal(terms.asset, "0.0.0");
        assert.equal(terms.amount, quote.tinybars);
        assert.equal(terms.payTo, svc.services.accounts.merchant);
        assert.equal(terms.extra.feePayer, svc.services.accounts.feePayer);
        assert.deepEqual(r.expected, { payTo: quote.payTo, tinybars: quote.tinybars, asset: "0.0.0" });
        assert.equal(r.wallet, WALLET);
    });

    it("settles the wallet's own payment: exact amount from the user, fee paid by the facilitator, then a lease", async () => {
        const svc = await start();
        const feePayer = svc.services.accounts.feePayer;
        const feeBefore = svc.ledger.balanceOf(feePayer);
        const { quote, view } = await activeLease(svc);

        assert.equal(svc.merchantBalance(), BigInt(quote.tinybars), "the merchant received exactly the quote");
        assert.equal(svc.userBalance(), 1000n * HBAR - BigInt(quote.tinybars), "the user paid exactly the quote and no fee");
        assert.ok(svc.ledger.balanceOf(feePayer) < feeBefore, "the facilitator paid the network fee");
        assert.equal(view.payment.settlement.payer, WALLET, "the payer is the user's wallet");
        assert.equal(view.payment.settlement.verified, true, "confirmed against the ledger");
        assert.deepEqual(kinds(view).slice(3), [
            "WALLET_SIGNATURE_REQUESTED", "PAYMENT_SIGNED_BY_WALLET", "PAYMENT_SETTLED_BY_FACILITATOR", "SETTLEMENT_VERIFIED", "LEASE_CREATED",
        ].slice(0), "signature, settlement, verification, then the lease");
        assert.equal(view.chain.valid, true);
    });

    it("creates the lease only after settlement is verified", async () => {
        const svc = await start();
        svc.services.verifier.fetchTransaction = async () => ({ transactions: [] });
        svc.services.verifier.retries = 1;
        const { id } = await begin(svc);
        await walletPay(svc, id);
        await svc.services.payments.idle();
        const view = await get(svc, id);
        assert.equal(view.payment.status, PaymentStatus.FAILED);
        assert.match(view.payment.error, /could not be verified/);
        assert.equal(view.lease, null, "no lease without a verified payment");
    });

    it("never signs or pays anything on the server: there is no agent", async () => {
        const svc = await start();
        assert.equal(svc.services.agent, null);
        assert.equal(svc.services.accounts.agent, null);
        const config = (await svc.call("GET", "/v1/config", undefined, { token: null })).body;
        assert.equal(config.payer, "wallet");
        assert.equal(config.accounts.agent, null);
    });
});

describe("wallet mode: the server accepts only the exact payment that was quoted", () => {
    it("rejects a payment whose sender is not the quote's wallet, and the payment stays open to retry", async () => {
        const svc = await start();
        const other = "0.0.5000009";
        const otherKey = PrivateKey.generateECDSA();
        svc.ledger.addAccount(other, { key: otherKey.publicKey, balance: 100n * HBAR });
        const { id } = await begin(svc);

        const wrong = await walletPay(svc, id, { key: otherKey, account: other });
        assert.equal(wrong.submit.status, 422);
        assert.equal(wrong.submit.body.error, "PAYLOAD_REJECTED");
        assert.match(wrong.submit.body.message, /from your wallet/);
        assert.equal(svc.merchantBalance(), 0n);
        assert.equal((await get(svc, id)).payment.status, PaymentStatus.AWAITING_SIGNATURE);

        const right = await walletPay(svc, id);
        assert.equal(right.submit.status, 200);
        await svc.services.payments.idle();
        assert.equal((await get(svc, id)).payment.status, PaymentStatus.LEASE_ACTIVE);
    });

    it("rejects a different amount, recipient, or fee payer", async () => {
        const svc = await start();
        const { id } = await begin(svc);
        const tamper = {
            amount: (r) => { r.accepts[0].amount = String(BigInt(r.accepts[0].amount) + 1n); return r; },
            payTo: (r) => { r.accepts[0].payTo = "0.0.9999999"; return r; },
            feePayer: (r) => { r.accepts[0].extra.feePayer = "0.0.123456"; return r; },
        };
        for (const [name, mutateRequired] of Object.entries(tamper)) {
            const r = await walletPay(svc, id, { mutateRequired });
            assert.equal(r.submit.status, 422, name);
            assert.equal(r.submit.body.error, "PAYLOAD_REJECTED", name);
        }
        assert.equal(svc.merchantBalance(), 0n);
        assert.equal((await get(svc, id)).payment.status, PaymentStatus.AWAITING_SIGNATURE);
        assert.ok(kinds(await get(svc, id)).filter((k) => k === "SIGNED_PAYMENT_REJECTED").length >= 3, "each rejection is audited");
    });

    it("rejects garbage in place of a payment", async () => {
        const svc = await start();
        const { id } = await begin(svc);
        for (const bad of [undefined, null, "x", {}, { x402Version: 2 }, { x402Version: 1, accepted: {}, payload: {} }, { x402Version: 2, accepted: {}, payload: { transaction: "not-base64!!" } }]) {
            const r = await svc.call("POST", `/v1/payments/${id}/submit`, { paymentPayload: bad });
            assert.equal(r.status, 422, JSON.stringify(bad));
        }
        assert.equal(svc.merchantBalance(), 0n);
    });

    it("fails, with no money moved, when the signature is not the wallet's key", async () => {
        const svc = await start();
        const { id } = await begin(svc);
        const forged = await walletPay(svc, id, { key: PrivateKey.generateECDSA() });
        assert.equal(forged.submit.status, 200, "structurally valid, so it goes to the facilitator");
        await svc.services.payments.idle();
        const view = await get(svc, id);
        assert.equal(view.payment.status, PaymentStatus.FAILED, "the facilitator checks the signature against the account's key");
        assert.equal(svc.merchantBalance(), 0n);
        assert.equal(svc.userBalance(), 1000n * HBAR);
    });

    it("fails cleanly when the wallet cannot cover the payment", async () => {
        const svc = await start();
        const { id } = await begin(svc);
        svc.ledger.accounts.get(WALLET).balance = 1n; // spent elsewhere after the quote
        await walletPay(svc, id);
        await svc.services.payments.idle();
        const view = await get(svc, id);
        assert.equal(view.payment.status, PaymentStatus.FAILED);
        assert.equal(svc.merchantBalance(), 0n);
        assert.equal(svc.userBalance(), 1n);
    });

    it("settles one signed payment only, even if two are submitted at the same moment", async () => {
        const svc = await start();
        const { quote, id } = await begin(svc);
        const results = await Promise.all([walletPay(svc, id), walletPay(svc, id)]);
        await svc.services.payments.idle();
        const statuses = results.map((r) => r.submit.status).sort();
        assert.ok(statuses.includes(200), "one was accepted");
        assert.ok(statuses.some((s) => s === 409), "the other was refused");
        assert.equal(svc.merchantBalance(), BigInt(quote.tinybars), "the merchant was paid once");
    });

    it("refuses a second payment after the first was accepted", async () => {
        const svc = await start();
        const { id } = await activeLease(svc);
        const again = await walletPay(svc, id);
        assert.equal(again.requirements.status, 409);
    });
});

describe("wallet mode: only the service's relay may pay at the lease endpoint", () => {
    it("shows the price to anyone, but answers 403 to a payment that did not come through the relay", async () => {
        const svc = await start();
        const { quote } = await begin(svc);
        const post = (headers = {}) => fetch(svc.baseUrl + "/v1/leases", {
            method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ quoteId: quote.id }),
        });
        const paid = { "PAYMENT-SIGNATURE": Buffer.from("{}").toString("base64") };
        assert.equal((await post()).status, 402, "anyone may ask the price; it moves no money");
        assert.equal((await post(paid)).status, 403, "a payment straight to the endpoint is refused");
        assert.equal((await post({ ...paid, "x-gpu4u-relay": "wrong-secret" })).status, 403);
        assert.equal((await post({ "x-gpu4u-relay": svc.services.relaySecret })).status, 402, "the relay gets the payment terms");
    });
});

describe("wallet mode: human approval, then the wallet's signature", () => {
    it("holds a large payment, and nothing can be signed before the owner approves", async () => {
        const svc = await start();
        const { id, started } = await begin(svc, BIG);
        assert.equal(started.body.payment.status, PaymentStatus.PENDING_APPROVAL);
        const early = await walletPay(svc, id);
        assert.equal(early.requirements.status, 409, "no payment terms are given before approval");
        const direct = await svc.call("POST", `/v1/payments/${id}/submit`, { paymentPayload: {} });
        assert.equal(direct.status, 409);
        assert.equal(svc.merchantBalance(), 0n);
    });

    it("needs both: an approval click, then the wallet signature, before anything settles", async () => {
        const svc = await start();
        const { quote, id, started } = await begin(svc, BIG);
        const approved = await svc.call("POST", `/v1/approvals/${started.body.approval.id}/decision`, { decision: "approve", wallet: WALLET });
        assert.equal(approved.status, 200);
        const mid = await get(svc, id);
        assert.equal(mid.payment.status, PaymentStatus.AWAITING_SIGNATURE, "approved, but still unsigned");
        assert.equal(svc.merchantBalance(), 0n, "approval alone moves no money");

        await walletPay(svc, id);
        await svc.services.payments.idle();
        const view = await get(svc, id);
        assert.equal(view.payment.status, PaymentStatus.LEASE_ACTIVE);
        assert.equal(svc.merchantBalance(), BigInt(quote.tinybars));
        const order = kinds(view);
        assert.ok(order.indexOf("HUMAN_APPROVAL_GRANTED") < order.indexOf("WALLET_SIGNATURE_REQUESTED"));
        assert.ok(order.indexOf("WALLET_SIGNATURE_REQUESTED") < order.indexOf("PAYMENT_SIGNED_BY_WALLET"));
        assert.equal(view.approval.consumed, true);
    });

    it("moves no HBAR when the owner rejects, and the wallet is never asked", async () => {
        const svc = await start();
        const { id, started } = await begin(svc, BIG);
        const rejected = await svc.call("POST", `/v1/approvals/${started.body.approval.id}/decision`, { decision: "reject", wallet: WALLET });
        assert.equal(rejected.body.payment.status, PaymentStatus.REJECTED);
        const attempt = await walletPay(svc, id);
        assert.equal(attempt.requirements.status, 409);
        assert.equal(svc.merchantBalance(), 0n);
        assert.equal(svc.userBalance(), 1000n * HBAR);
        assert.ok(!kinds(await get(svc, id)).includes("WALLET_SIGNATURE_REQUESTED"));
    });

    it("never overrides the hard ceiling: refused, no approval offered, no signature possible", async () => {
        const svc = await start();
        const { id } = await begin(svc, { estimateUsd: 24, capUsd: 30 });
        const view = await get(svc, id);
        assert.equal(view.payment.status, PaymentStatus.REFUSED);
        assert.equal(view.approval, null);
        assert.equal((await walletPay(svc, id)).requirements.status, 409);
        assert.equal(svc.merchantBalance(), 0n);
    });

    it("counts a payment waiting for its signature toward the daily limit", async () => {
        const svc = await start({ env: { DAILY_LIMIT_USD: "1", AUTO_APPROVE_LIMIT_USD: "0.6" } });
        await begin(svc, { capUsd: 0.5, estimateUsd: 0.4 });
        const second = await begin(svc, { capUsd: 0.55, estimateUsd: 0.4 });
        assert.equal(second.started.body.payment.status, PaymentStatus.PENDING_APPROVAL);
    });
});

describe("wallet mode: time limits and restarts", () => {
    it("expires a payment that was never signed, and then refuses a late signature", async () => {
        let t = 1_700_000_000_000;
        const svc = await start({ overrides: { now: () => t } });
        const { id } = await begin(svc);
        t += 601_000;
        svc.services.payments.sweepExpired();
        const view = await get(svc, id);
        assert.equal(view.payment.status, PaymentStatus.EXPIRED);
        assert.ok(kinds(view).includes("SIGNATURE_WINDOW_EXPIRED"));
        assert.equal((await walletPay(svc, id)).requirements.status, 409);
        assert.equal(svc.merchantBalance(), 0n);
    });

    it("refuses a signature once the quote has expired, even before the sweep runs", async () => {
        let t = 1_700_000_000_000;
        const svc = await start({ overrides: { now: () => t } });
        const { id } = await begin(svc);
        t += 601_000;
        const r = await svc.call("GET", `/v1/payments/${id}/requirements`);
        assert.equal(r.status, 410);
        assert.equal(svc.merchantBalance(), 0n);
    });

    it("refuses a quote for a wallet that cannot complete it", async () => {
        const svc = await start({ balanceHbar: 1n });
        const poor = await svc.call("POST", "/v1/quotes", quoteRequest());
        assert.equal(poor.status, 422);
        assert.equal(poor.body.error, "INSUFFICIENT_BALANCE");

        const ghost = await svc.call("POST", "/v1/quotes", quoteRequest({ wallet: "0.0.5999999" }));
        assert.equal(ghost.status, 404);
        assert.equal(ghost.body.error, "WALLET_NOT_FOUND");
    });

    const tempDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gpu4u-wallet-")), "payments.sqlite");
    const booted = new Set();
    async function boot(dbPath) {
        const key = PrivateKey.generateECDSA();
        const ledger = new SimLedger();
        ledger.addAccount(WALLET, { key: key.publicKey, balance: 1000n * HBAR });
        const config = loadConfig({ PAYMENT_MODE: "simulated", PAYER_MODE: "wallet", SERVICE_TOKEN: TOKEN, DB_PATH: dbPath });
        const services = await buildServices(config, { rates: { getRate: async () => FIXED_RATE }, ledger });
        const server = await startServer(createApp(services), services, 0);
        const instance = { services, server, key, ledger, baseUrl: server.baseUrl };
        instance.call = async (method, p, body) => {
            const response = await fetch(server.baseUrl + p, {
                method, headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            return { status: response.status, body: await response.json() };
        };
        instance.userKey = key;
        instance.account = WALLET;
        booted.add(instance);
        return instance;
    }
    const shut = async (i) => {
        if (!booted.delete(i)) return;
        await i.services.payments.idle();
        await new Promise((resolve) => i.server.server.close(resolve));
        await i.services.close();
    };
    afterEach(async () => { for (const i of [...booted]) await shut(i).catch(() => {}); });

    it("keeps a payment that is waiting for a signature across a restart, and it can still be signed", async () => {
        const dbPath = tempDb();
        const a = await boot(dbPath);
        const quote = await a.services.quotes.create(quoteRequest());
        const payment = a.services.payments.start({ quoteId: quote.id }).payment;
        assert.equal(payment.status, PaymentStatus.AWAITING_SIGNATURE);
        await shut(a);

        const b = await boot(dbPath);
        assert.equal(b.services.payments.recover(), 0, "waiting for a signature is not interrupted work");
        const paid = await walletPay(b, payment.id);
        assert.equal(paid.submit.status, 200, JSON.stringify(paid.submit.body));
        await b.services.payments.idle();
        assert.equal(b.services.payments.view(payment.id).payment.status, PaymentStatus.LEASE_ACTIVE);
        await shut(b);
    });

    it("fails a payment that was being settled at restart instead of risking a second payment", async () => {
        const dbPath = tempDb();
        const a = await boot(dbPath);
        const quote = await a.services.quotes.create(quoteRequest());
        const payment = a.services.payments.start({ quoteId: quote.id }).payment;
        a.services.store.updatePayment(payment.id, { status: PaymentStatus.SIGNING });
        await shut(a);

        const b = await boot(dbPath);
        assert.equal(b.services.payments.recover(), 1);
        const view = b.services.payments.view(payment.id);
        assert.equal(view.payment.status, PaymentStatus.FAILED);
        assert.match(view.payment.error, /restarted/);
        await shut(b);
    });
});

describe("wallet mode: lease time, with no refund", () => {
    /** A service whose clock the test controls, with an active lease. */
    async function clocked(over) {
        const clock = { t: 1_700_000_000_000 };
        const svc = await start({ overrides: { now: () => clock.t } });
        const lease = await activeLease(svc, over);
        return { svc, clock, ...lease };
    }
    const end = (svc, id) => svc.call("POST", `/v1/payments/${id}/lease/end`);

    it("measures the seconds the lease was held, keeps the whole payment, and refunds nothing", async () => {
        const { svc, clock, quote, id, view } = await clocked();
        const startedAt = view.lease.createdAt;
        clock.t = startedAt + 1800 * 1000; // half an hour
        const userBefore = svc.userBalance();
        const merchantBefore = svc.merchantBalance();

        const r = await end(svc, id);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const metered = meterLease({ hourlyUsd: quote.hourlyUsd, capUsd: quote.capUsd, startedAtMs: startedAt, endedAtMs: clock.t });
        assert.equal(metered.billedSeconds, 1800);
        const rec = r.body.lease.reconciliation;
        assert.equal(rec.billedTinybars, quote.tinybars, "the whole payment is final");
        assert.equal(rec.refundPolicy, "none");
        assert.equal(rec.refundTinybars, undefined);
        assert.equal(rec.actualUsd, metered.actualUsd, "the lease time is still measured");
        assert.equal(svc.userBalance(), userBefore, "nothing went back to the user");
        assert.equal(svc.merchantBalance(), merchantBefore, "the merchant sent nothing");
        assert.equal(r.body.lease.refund, null);
        assert.equal(r.body.payment.status, PaymentStatus.RECONCILED);
        assert.equal(r.body.lease.status, "RECONCILED");
    });

    it("labels it lease-time billing and not GPU utilization", async () => {
        const { svc, clock, id, view } = await clocked();
        clock.t = view.lease.createdAt + 60_000;
        const rec = (await end(svc, id)).body.lease.reconciliation;
        assert.equal(rec.billingBasis, "lease-time");
        assert.equal(rec.simulatedRun, false);
        assert.match(rec.billingNote, /not a measurement of GPU utilization/);
    });

    it("says plainly that payments are final", async () => {
        const { svc, clock, id, view } = await clocked();
        clock.t = view.lease.createdAt + 600_000;
        await end(svc, id);
        const receipt = (await svc.call("GET", `/v1/payments/${id}/receipt`)).body;
        assert.equal(receipt.refund.policy, "none");
        assert.match(receipt.refund.note, /final/);
        assert.equal(receipt.links, undefined);
    });

    it("bills at least one second, and never more than the cap", async () => {
        const first = await clocked();
        first.clock.t = first.view.lease.createdAt; // ended the instant it started
        const quick = (await end(first.svc, first.id)).body.lease.reconciliation;
        assert.equal(quick.actualUsd > 0, true);
        assert.equal(meterLease({ hourlyUsd: 0.22, capUsd: 0.42, startedAtMs: 0, endedAtMs: 0 }).billedSeconds, 1);

        const capped = await clocked();
        capped.clock.t = capped.view.lease.createdAt + 48 * 3600 * 1000; // two days
        const r = (await end(capped.svc, capped.id)).body;
        assert.equal(r.lease.reconciliation.runStatus, "stopped_at_cap");
        assert.equal(r.lease.reconciliation.billedTinybars, capped.quote.tinybars, "the whole cap, never more");
        assert.equal(capped.svc.merchantBalance(), BigInt(capped.quote.tinybars));
    });

    it("closes a lease by itself when it reaches its cap, and not before", async () => {
        const { svc, clock, id, view, quote } = await clocked();
        const capSeconds = meterLease({ hourlyUsd: quote.hourlyUsd, capUsd: quote.capUsd, startedAtMs: 0, endedAtMs: 10 ** 9 * 1000 }).capSeconds;
        clock.t = view.lease.createdAt + (capSeconds - 5) * 1000;
        assert.equal(await svc.services.payments.sweepLeases(), 0);
        assert.equal((await get(svc, id)).payment.status, PaymentStatus.LEASE_ACTIVE);

        clock.t = view.lease.createdAt + (capSeconds + 1) * 1000;
        assert.equal(await svc.services.payments.sweepLeases(), 1);
        const after = await get(svc, id);
        assert.equal(after.payment.status, PaymentStatus.RECONCILED);
        assert.equal(after.lease.reconciliation.runStatus, "stopped_at_cap");
    });

    it("ends once: a second end, even at the same moment, changes nothing", async () => {
        const { svc, clock, id, view, quote } = await clocked();
        clock.t = view.lease.createdAt + 900_000;
        const results = await Promise.all([end(svc, id), end(svc, id), end(svc, id)]);
        assert.ok(results.some((r) => r.status === 200));
        assert.equal(svc.userBalance(), 1000n * HBAR - BigInt(quote.tinybars));
        const later = await end(svc, id);
        assert.equal(later.status, 200);
        assert.equal(svc.userBalance(), 1000n * HBAR - BigInt(quote.tinybars), "no money came back");
    });

    it("does not let anyone end a paid lease at a usage they choose", async () => {
        const { svc, id, quote } = await clocked();
        const r = await svc.call("POST", `/v1/payments/${id}/lease/complete`, { actualUsd: 0.000001, actualDurationHours: 0.0001 });
        assert.equal(r.status, 409);
        assert.equal(r.body.error, "NOT_ALLOWED");
        assert.equal((await get(svc, id)).payment.status, PaymentStatus.LEASE_ACTIVE, "the lease is untouched");
        assert.equal(svc.merchantBalance(), BigInt(quote.tinybars));
    });

    it("cannot end a lease that does not exist or was never paid", async () => {
        const svc = await start();
        const { id } = await begin(svc);
        assert.equal((await end(svc, id)).status, 404, "no lease before payment");
    });

    it("has no refund endpoint", async () => {
        const { svc, id } = await clocked();
        assert.equal((await svc.call("POST", `/v1/payments/${id}/refund/retry`)).status, 404);
    });
});

describe("wallet mode: the final receipt and verification links", () => {
    it("gives no ledger link for a simulated payment, and says why", async () => {
        const svc = await start();
        const { id, view } = await activeLease(svc);
        assert.equal(view.links.payment.hashscan, null);
        assert.equal(view.links.payment.mirrorApi, null);
        const receipt = (await svc.call("GET", `/v1/payments/${id}/receipt`)).body;
        assert.equal(receipt.simulated, true);
        assert.equal(receipt.payment.links.hashscan, null);
    });

    it("produces a complete receipt once the lease is reconciled", async () => {
        const clock = { t: 1_700_000_000_000 };
        const svc = await start({ overrides: { now: () => clock.t } });
        const { id, view, quote } = await activeLease(svc);
        const early = (await svc.call("GET", `/v1/payments/${id}/receipt`)).body;
        assert.equal(early.complete, false);

        clock.t = view.lease.createdAt + 1200_000;
        await svc.call("POST", `/v1/payments/${id}/lease/end`);
        const r = (await svc.call("GET", `/v1/payments/${id}/receipt`)).body;
        assert.equal(r.complete, true);
        assert.equal(r.status, "RECONCILED");
        assert.equal(r.payer.wallet, WALLET);
        assert.equal(r.payer.mode, "wallet");
        assert.equal(r.quote.paidTinybars, quote.tinybars);
        assert.equal(r.payment.verifiedOnLedger, true);
        assert.equal(r.lease.billingBasis, "lease-time");
        assert.equal(r.lease.billedSeconds, 1200);
        assert.equal(r.refund.policy, "none");
        assert.equal(r.audit.chainIntact, true);
        assert.equal(r.network, "hedera:testnet");
    });
});

describe("modes can never be mixed", () => {
    it("testnet mode refuses a simulated ledger, an agent payer, or missing merchant credentials", async () => {
        const testnet = (env) => loadConfig({ PAYMENT_MODE: "testnet", SERVICE_TOKEN: TOKEN, DB_PATH: ":memory:", ...env });
        await assert.rejects(buildServices(testnet({}), {}), /receiver account/);
        await assert.rejects(
            buildServices(testnet({ HEDERA_RECEIVER_ID: "0.0.20", HEDERA_MERCHANT_PRIVATE_KEY: "k" }), { ledger: new SimLedger() }),
            /simulated ledger cannot be used in testnet/,
        );
        const config = testnet({ HEDERA_RECEIVER_ID: "0.0.20", HEDERA_MERCHANT_PRIVATE_KEY: "k" });
        config.payer.mode = "agent"; // even if a config object is tampered with after loading
        await assert.rejects(buildServices(config, {}), /requires PAYER_MODE=wallet/);
    });

    it("simulated mode keeps its agent payer for development, and the original tests", async () => {
        const config = loadConfig({ PAYMENT_MODE: "simulated", SERVICE_TOKEN: TOKEN, DB_PATH: ":memory:" });
        const services = await buildServices(config, { rates: { getRate: async () => FIXED_RATE } });
        assert.ok(services.agent, "simulated development still has an agent");
        await services.close();
    });
});
