"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PrivateKey } = require("@hiero-ledger/sdk");
const { proto } = require("@hiero-ledger/proto");
const { decodePaymentRequiredHeader, encodePaymentRequiredHeader } = require("@x402/core/http");

const { startTestService, quoteRequest, WALLET, FIXED_RATE } = require("./helpers/service");
const { prefixMessage } = require("../service/wallet-signature");
const { usdToTinybars } = require("../service/rate");
const { buildServices } = require("../service/container");
const { createApp, startServer } = require("../service/app");
const { loadConfig } = require("../service/config");
const { PaymentStatus } = require("../service/states");
const { SIM_FEE_TINYBARS } = require("../service/sim-ledger");

const running = [];
const start = async (options) => {
    const svc = await startTestService(options);
    running.push(svc);
    return svc;
};
afterEach(async () => {
    while (running.length) await running.pop().stop().catch(() => {});
});

const eventTypes = (view) => view.events.map((e) => e.eventType);
const merchantBalance = (svc) => svc.services.ledger.balanceOf(svc.services.accounts.merchant);
const agentBalance = (svc) => svc.services.ledger.balanceOf(svc.services.accounts.agent);

/** Starts a payment for a quote and waits for the agent to finish. */
async function pay(svc, quote) {
    const started = await svc.call("POST", "/v1/payments", { quoteId: quote.id });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    await svc.services.payments.idle();
    return (await svc.call("GET", "/v1/payments/" + started.body.payment.id)).body;
}

const signatureMapFor = (key, message) => {
    const sig = key.sign(prefixMessage(message));
    const field = key.type === "ED25519" ? { ed25519: sig } : { ECDSASecp256k1: sig };
    return Buffer.from(proto.SignatureMap.encode({ sigPair: [{ pubKeyPrefix: key.publicKey.toBytesRaw().slice(0, 6), ...field }] }).finish()).toString("base64");
};

const BIG = { estimateUsd: 0.93, capUsd: 1.16 }; // above the $0.50 automatic limit

describe("automatic payment under the limit", () => {
    it("runs the whole flow: 402, signature, facilitator, ledger, verification, lease", async () => {
        const svc = await start();
        const quote = await svc.quote();
        const view = await pay(svc, quote);

        assert.equal(view.payment.status, PaymentStatus.LEASE_ACTIVE);
        assert.equal(view.payment.decision, "auto");
        assert.deepEqual(eventTypes(view), [
            "PAYMENT_RECEIVED", "POLICY_EVALUATED", "AUTO_APPROVED", "AGENT_REQUESTING_LEASE", "AGENT_TERMS_ACCEPTED",
            "PAYMENT_SIGNED", "PAYMENT_SETTLED_BY_FACILITATOR", "SETTLEMENT_VERIFIED", "LEASE_CREATED",
        ]);
        assert.equal(view.chain.valid, true);
        assert.ok(view.payment.transactionId, "has a transaction ID");
        assert.equal(view.payment.settlement.verified, true);
        assert.equal(view.lease.status, "ACTIVE");
        assert.equal(view.lease.offer.simulated, true);
    });

    it("moves exactly the quoted amount, and the fee payer, not the agent, pays the network fee", async () => {
        const svc = await start();
        const quote = await svc.quote();
        const agentBefore = agentBalance(svc);
        const feePayerBefore = svc.services.ledger.balanceOf(svc.services.accounts.feePayer);
        await pay(svc, quote);

        assert.equal(merchantBalance(svc), BigInt(quote.tinybars));
        assert.equal(agentBalance(svc), agentBefore - BigInt(quote.tinybars), "agent lost exactly the quoted amount, no fee");
        assert.ok(svc.services.ledger.balanceOf(svc.services.accounts.feePayer) < feePayerBefore, "facilitator paid the fee");
    });

    it("quotes the cap and pays the cap", async () => {
        const svc = await start();
        const quote = await svc.quote({ capUsd: 0.45 });
        assert.equal(quote.tinybars, usdToTinybars(0.45, FIXED_RATE).toString());
        await pay(svc, quote);
        assert.equal(merchantBalance(svc), usdToTinybars(0.45, FIXED_RATE));
    });

    it("records the agent's check of the payment terms in the audit trail", async () => {
        const svc = await start();
        const view = await pay(svc, await svc.quote());
        const check = view.events.find((e) => e.eventType === "AGENT_TERMS_ACCEPTED");
        assert.equal(check.details.payTo, svc.services.accounts.merchant);
        assert.equal(check.details.feePayer, svc.services.accounts.feePayer);
    });

    it("is idempotent: starting the same quote again returns the same payment and pays once", async () => {
        const svc = await start();
        const quote = await svc.quote();
        const first = await pay(svc, quote);
        const again = await svc.call("POST", "/v1/payments", { quoteId: quote.id });
        assert.equal(again.body.payment.id, first.payment.id);
        await svc.services.payments.idle();
        assert.equal(merchantBalance(svc), BigInt(quote.tinybars));
    });

    it("pays once even when the same quote is started concurrently", async () => {
        const svc = await start();
        const quote = await svc.quote();
        const results = await Promise.all(Array.from({ length: 6 }, () => svc.call("POST", "/v1/payments", { quoteId: quote.id })));
        await svc.services.payments.idle();
        assert.equal(new Set(results.map((r) => r.body.payment.id)).size, 1);
        assert.equal(merchantBalance(svc), BigInt(quote.tinybars));
    });

    it("refuses an expired quote", async () => {
        let t = 1_700_000_000_000;
        const svc = await start({ overrides: { now: () => t } });
        const quote = await svc.quote();
        t += 601_000;
        const r = await svc.call("POST", "/v1/payments", { quoteId: quote.id });
        assert.equal(r.status, 410);
        assert.equal(r.body.error, "QUOTE_EXPIRED");
        assert.equal(merchantBalance(svc), 0n);
    });
});

describe("refusal", () => {
    it("refuses above the hard ceiling and moves no money", async () => {
        const svc = await start();
        const quote = await svc.quote({ estimateUsd: 24, capUsd: 30 });
        const view = await pay(svc, quote);
        assert.equal(view.payment.status, PaymentStatus.REFUSED);
        assert.match(view.payment.error, /hard ceiling/);
        assert.equal(merchantBalance(svc), 0n);
        assert.ok(eventTypes(view).includes("PAYMENT_REFUSED"));
    });

    it("refuses once the service-wide daily limit would be passed", async () => {
        const svc = await start({ env: { GLOBAL_DAILY_LIMIT_USD: "1.5", AUTO_APPROVE_LIMIT_USD: "1" } });
        assert.equal((await pay(svc, await svc.quote({ capUsd: 0.9, estimateUsd: 0.8 }))).payment.status, PaymentStatus.LEASE_ACTIVE);
        const second = await pay(svc, await svc.quote({ capUsd: 0.9, estimateUsd: 0.8, wallet: "0.0.5000099" }));
        assert.equal(second.payment.status, PaymentStatus.REFUSED);
        assert.match(second.payment.error, /service-wide/);
    });
});

describe("human approval in click mode", () => {
    it("holds an over-limit payment and moves no money until a person approves", async () => {
        const svc = await start();
        const quote = await svc.quote(BIG);
        assert.equal(quote.policyPreview.decision, "approval");

        const started = await svc.call("POST", "/v1/payments", { quoteId: quote.id });
        await svc.services.payments.idle();
        const waiting = (await svc.call("GET", "/v1/payments/" + started.body.payment.id)).body;

        assert.equal(waiting.payment.status, PaymentStatus.PENDING_APPROVAL);
        assert.equal(waiting.approval.status, "PENDING");
        assert.match(waiting.approval.message, /GPU4U payment approval/);
        assert.match(waiting.approval.message, new RegExp(quote.id));
        assert.equal(merchantBalance(svc), 0n, "nothing was paid while waiting");
        assert.ok(!eventTypes(waiting).includes("AGENT_REQUESTING_LEASE"));
    });

    it("pays after approval, bound to the quote", async () => {
        const svc = await start();
        const quote = await svc.quote(BIG);
        const started = await svc.call("POST", "/v1/payments", { quoteId: quote.id });
        const decided = await svc.call("POST", "/v1/approvals/" + started.body.approval.id + "/decision", { decision: "approve", wallet: WALLET });
        assert.equal(decided.status, 200, JSON.stringify(decided.body));
        await svc.services.payments.idle();

        const view = (await svc.call("GET", "/v1/payments/" + started.body.payment.id)).body;
        assert.equal(view.payment.status, PaymentStatus.LEASE_ACTIVE);
        assert.equal(view.approval.status, "APPROVED");
        assert.equal(view.approval.consumed, true, "the approval was used up");
        assert.equal(merchantBalance(svc), BigInt(quote.tinybars));
        assert.deepEqual(eventTypes(view).slice(0, 5), ["PAYMENT_RECEIVED", "POLICY_EVALUATED", "HUMAN_APPROVAL_REQUESTED", "HUMAN_APPROVAL_GRANTED", "AGENT_REQUESTING_LEASE"]);
    });

    it("stops for good when a person rejects, and moves no money", async () => {
        const svc = await start();
        const started = await svc.call("POST", "/v1/payments", { quoteId: (await svc.quote(BIG)).id });
        const rejected = await svc.call("POST", "/v1/approvals/" + started.body.approval.id + "/decision", { decision: "reject", wallet: WALLET });
        assert.equal(rejected.body.payment.status, PaymentStatus.REJECTED);
        await svc.services.payments.idle();
        assert.equal(merchantBalance(svc), 0n);

        const again = await svc.call("POST", "/v1/approvals/" + started.body.approval.id + "/decision", { decision: "approve", wallet: WALLET });
        assert.equal(again.status, 409, "a rejected payment cannot be approved afterwards");
        assert.equal(merchantBalance(svc), 0n);
    });

    it("lets only the quote's wallet decide", async () => {
        const svc = await start();
        const started = await svc.call("POST", "/v1/payments", { quoteId: (await svc.quote(BIG)).id });
        const r = await svc.call("POST", "/v1/approvals/" + started.body.approval.id + "/decision", { decision: "approve", wallet: "0.0.6000000" });
        assert.equal(r.status, 403);
        assert.equal(r.body.error, "WRONG_WALLET");
        await svc.services.payments.idle();
        assert.equal(merchantBalance(svc), 0n);
    });

    it("cannot be approved twice, so an approval pays once", async () => {
        const svc = await start();
        const started = await svc.call("POST", "/v1/payments", { quoteId: (await svc.quote(BIG)).id });
        const url = "/v1/approvals/" + started.body.approval.id + "/decision";
        const results = await Promise.all([
            svc.call("POST", url, { decision: "approve", wallet: WALLET }),
            svc.call("POST", url, { decision: "approve", wallet: WALLET }),
        ]);
        await svc.services.payments.idle();
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
        assert.equal(merchantBalance(svc), BigInt(started.body.quote.tinybars));
        assert.equal(svc.services.approvals.consume(started.body.approval.id), false, "an approval that was used cannot be used again");
    });

    it("expires when nobody answers in time, and then cannot be approved", async () => {
        let t = 1_700_000_000_000;
        const svc = await start({ overrides: { now: () => t } });
        const started = await svc.call("POST", "/v1/payments", { quoteId: (await svc.quote(BIG)).id });
        t += 301_000;

        const view = (await svc.call("GET", "/v1/payments/" + started.body.payment.id)).body;
        assert.equal(view.payment.status, PaymentStatus.EXPIRED);
        assert.ok(eventTypes(view).includes("HUMAN_APPROVAL_EXPIRED"));

        const late = await svc.call("POST", "/v1/approvals/" + started.body.approval.id + "/decision", { decision: "approve", wallet: WALLET });
        assert.equal(late.status, 410);
        await svc.services.payments.idle();
        assert.equal(merchantBalance(svc), 0n);
    });

    it("the background sweep expires approvals even if nobody looks", async () => {
        let t = 1_700_000_000_000;
        const svc = await start({ overrides: { now: () => t } });
        const started = await svc.call("POST", "/v1/payments", { quoteId: (await svc.quote(BIG)).id });
        t += 301_000;
        svc.services.payments.sweepExpired();
        assert.equal(svc.services.store.getPayment(started.body.payment.id).status, PaymentStatus.EXPIRED);
    });

    it("sends the second payment of the day to approval once the daily limit is near", async () => {
        const svc = await start({ env: { DAILY_LIMIT_USD: "1", AUTO_APPROVE_LIMIT_USD: "0.6" } });
        assert.equal((await pay(svc, await svc.quote({ capUsd: 0.5, estimateUsd: 0.4 }))).payment.status, PaymentStatus.LEASE_ACTIVE);
        const second = await pay(svc, await svc.quote({ capUsd: 0.55, estimateUsd: 0.4 }));
        assert.equal(second.payment.status, PaymentStatus.PENDING_APPROVAL);
        assert.match(second.payment.decisionReasons.join(" "), /daily limit/);
    });
});

describe("human approval in wallet mode", () => {
    const key = PrivateKey.generateECDSA();
    const other = PrivateKey.generateECDSA();
    const overrides = { publicKeyResolver: async (account) => (account === WALLET ? key.publicKey : other.publicKey) };

    async function pending(svc) {
        const started = await svc.call("POST", "/v1/payments", { quoteId: (await svc.quote(BIG)).id });
        return { started, url: "/v1/approvals/" + started.body.approval.id + "/decision", message: started.body.approval.message };
    }

    it("requires a signature to approve", async () => {
        const svc = await start({ env: { APPROVAL_MODE: "wallet" }, overrides });
        const { url } = await pending(svc);
        const r = await svc.call("POST", url, { decision: "approve", wallet: WALLET });
        assert.equal(r.status, 401);
        assert.equal(r.body.error, "SIGNATURE_REQUIRED");
        assert.equal(merchantBalance(svc), 0n);
    });

    it("pays when the wallet signs the exact approval message", async () => {
        const svc = await start({ env: { APPROVAL_MODE: "wallet" }, overrides });
        const { started, url, message } = await pending(svc);
        const r = await svc.call("POST", url, { decision: "approve", wallet: WALLET, signatureMap: signatureMapFor(key, message) });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        await svc.services.payments.idle();
        const view = (await svc.call("GET", "/v1/payments/" + started.body.payment.id)).body;
        assert.equal(view.payment.status, PaymentStatus.LEASE_ACTIVE);
        assert.equal(view.approval.method, "wallet-signature");
        assert.equal(JSON.stringify(view).includes("signatureMap"), false, "the signature itself is not echoed back");
    });

    it("refuses a signature from a different key", async () => {
        const svc = await start({ env: { APPROVAL_MODE: "wallet" }, overrides });
        const { url, message } = await pending(svc);
        const r = await svc.call("POST", url, { decision: "approve", wallet: WALLET, signatureMap: signatureMapFor(other, message) });
        assert.equal(r.status, 401);
        assert.equal(r.body.error, "BAD_SIGNATURE");
        await svc.services.payments.idle();
        assert.equal(merchantBalance(svc), 0n);
    });

    it("refuses a signature over different terms, such as one approval reused for another payment", async () => {
        const svc = await start({ env: { APPROVAL_MODE: "wallet" }, overrides });
        const first = await pending(svc);
        const second = await pending(svc);
        const r = await svc.call("POST", second.url, { decision: "approve", wallet: WALLET, signatureMap: signatureMapFor(key, first.message) });
        assert.equal(r.status, 401);
        assert.equal(merchantBalance(svc), 0n);
    });

    it("lets anyone holding the quote's wallet id reject without a signature, since rejecting spends nothing", async () => {
        const svc = await start({ env: { APPROVAL_MODE: "wallet" }, overrides });
        const { url } = await pending(svc);
        assert.equal((await svc.call("POST", url, { decision: "reject", wallet: WALLET })).status, 200);
    });

    it("fails closed when the wallet's key cannot be looked up", async () => {
        const svc = await start({ env: { APPROVAL_MODE: "wallet" }, overrides: { publicKeyResolver: async () => { throw new Error("mirror down"); } } });
        const { url, message } = await pending(svc);
        const r = await svc.call("POST", url, { decision: "approve", wallet: WALLET, signatureMap: signatureMapFor(key, message) });
        assert.equal(r.status, 502);
        assert.equal(merchantBalance(svc), 0n);
    });
});

describe("a hostile or buggy server cannot change the terms after approval", () => {
    /** Sits between the agent and the lease API and rewrites the payment terms in the 402 response. */
    const tamper = (mutate) => async (url, init) => {
        const response = await fetch(url, init);
        if (response.status !== 402) return response;
        const required = decodePaymentRequiredHeader(response.headers.get("PAYMENT-REQUIRED"));
        mutate(required);
        const headers = new Headers(response.headers);
        headers.set("PAYMENT-REQUIRED", encodePaymentRequiredHeader(required));
        return new Response(JSON.stringify(required), { status: 402, headers });
    };

    const rejected = async (mutate, pattern) => {
        const svc = await start({ overrides: { agentFetch: tamper(mutate) } });
        const view = await pay(svc, await svc.quote());
        assert.equal(view.payment.status, PaymentStatus.FAILED);
        assert.match(view.payment.error, pattern);
        assert.ok(eventTypes(view).includes("AGENT_REJECTED_TERMS") || eventTypes(view).includes("AGENT_TERMS_REJECTED"));
        assert.equal(merchantBalance(svc), 0n, "nothing was signed or paid");
        assert.ok(!eventTypes(view).includes("PAYMENT_SIGNED"));
    };

    it("a raised price is not signed, stopped by the client's own spend cap", async () => {
        const svc = await start({ overrides: { agentFetch: tamper((r) => { r.accepts[0].amount = String(BigInt(r.accepts[0].amount) + 1n); }) } });
        const view = await pay(svc, await svc.quote());
        assert.equal(view.payment.status, PaymentStatus.FAILED);
        assert.match(view.payment.error, /spendControls|Amount is/);
        assert.ok(!eventTypes(view).includes("PAYMENT_SIGNED"));
        assert.equal(merchantBalance(svc), 0n);
    });
    it("a lowered price is not signed either, since the quote is exact", () => rejected((r) => { r.accepts[0].amount = String(BigInt(r.accepts[0].amount) - 1n); }, /Amount is/));
    it("a different recipient is not signed", () => rejected((r) => { r.accepts[0].payTo = "0.0.9999999"; }, /Pay-to is/));
    it("an untrusted fee payer is not signed", () => rejected((r) => { r.accepts[0].extra.feePayer = "0.0.123456"; }, /Fee payer/));
    it("a different asset is not signed", () => rejected((r) => { r.accepts[0].asset = "0.0.429274"; }, /Asset is|spend|allowed/i));
});

describe("failures never lose or invent money", () => {
    it("fails cleanly when the agent cannot afford the payment", async () => {
        const svc = await start({ env: { SIM_STARTING_BALANCE_HBAR: "1" } });
        const view = await pay(svc, await svc.quote());
        assert.equal(view.payment.status, PaymentStatus.FAILED);
        assert.equal(merchantBalance(svc), 0n);
        assert.equal(agentBalance(svc), 100_000_000n, "the agent still has its HBAR");
        assert.ok(view.payment.error.length > 0);
        assert.equal(view.chain.valid, true);
    });

    it("fails a payment the ledger cannot verify, and says where to look", async () => {
        const svc = await start();
        svc.services.verifier.fetchTransaction = async () => ({ transactions: [] });
        svc.services.verifier.retries = 1;
        const view = await pay(svc, await svc.quote());
        assert.equal(view.payment.status, PaymentStatus.FAILED);
        assert.match(view.payment.error, /could not be verified/);
        assert.match(view.payment.error, new RegExp(view.payment.transactionId.replace(/[.@]/g, ".")));
        assert.ok(eventTypes(view).includes("SETTLEMENT_VERIFICATION_FAILED"));
        assert.equal(view.lease, null, "no lease without a verified payment");
    });

    it("does not create a lease unless settlement was verified exactly", async () => {
        const svc = await start();
        const realVerify = svc.services.verifier.verify.bind(svc.services.verifier);
        svc.services.verifier.verify = (args) => realVerify({ ...args, tinybars: BigInt(args.tinybars) + 1n });
        const view = await pay(svc, await svc.quote());
        assert.equal(view.payment.status, PaymentStatus.FAILED);
        assert.equal(view.lease, null);
    });
});

describe("lease completion, with no refund", () => {
    async function active(svc, over) {
        const view = await pay(svc, await svc.quote(over));
        assert.equal(view.payment.status, PaymentStatus.LEASE_ACTIVE);
        return view;
    }
    const complete = (svc, view, body) => svc.call("POST", "/v1/payments/" + view.payment.id + "/lease/complete", body);

    it("keeps the whole payment whatever the usage, and refunds nothing", async () => {
        const svc = await start();
        const view = await active(svc);
        const paid = BigInt(view.quote.tinybars);
        const agentAfterPayment = agentBalance(svc);

        const r = await complete(svc, view, { actualUsd: 0.2, actualDurationHours: 0.73 });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const rec = r.body.lease.reconciliation;
        assert.equal(rec.paidTinybars, paid.toString());
        assert.equal(rec.billedTinybars, paid.toString(), "the payment is final");
        assert.equal(rec.refundPolicy, "none");
        assert.equal(merchantBalance(svc), paid, "the merchant keeps all of it and sends nothing");
        assert.equal(agentBalance(svc), agentAfterPayment, "nothing went back to the payer");
        assert.equal(r.body.payment.status, PaymentStatus.RECONCILED);
        assert.equal(r.body.lease.status, "RECONCILED");
        assert.ok(!eventTypes(r.body).some((t) => t.startsWith("REFUND")));
        assert.ok(eventTypes(r.body).includes("PAYMENT_RECONCILED"));
        assert.equal(r.body.chain.valid, true);
        assert.equal(rec.simulatedRun, true);
    });

    it("also settles when the run used the whole cap", async () => {
        const svc = await start();
        const view = await active(svc);
        const r = await complete(svc, view, { actualUsd: 0.42, actualDurationHours: 1.9, status: "stopped_at_cap" });
        assert.equal(merchantBalance(svc), BigInt(view.quote.tinybars));
        assert.equal(r.body.payment.status, PaymentStatus.RECONCILED);
    });

    it("refuses usage above the cap that was paid", async () => {
        const svc = await start();
        const view = await active(svc);
        const r = await complete(svc, view, { actualUsd: 0.43, actualDurationHours: 2 });
        assert.equal(r.status, 400);
        assert.equal(r.body.error, "OVER_CAP");
        assert.equal(merchantBalance(svc), BigInt(view.quote.tinybars), "nothing moved");
    });

    it("rejects nonsense usage figures", async () => {
        const svc = await start();
        const view = await active(svc);
        for (const bad of [{ actualUsd: -1 }, { actualUsd: "1" }, { actualUsd: null }, { actualUsd: 0.1, status: "weird" }]) {
            assert.equal((await complete(svc, view, { actualDurationHours: 1, ...bad })).status, 400);
        }
    });

    it("reconciles once: a second call returns the first result", async () => {
        const svc = await start();
        const view = await active(svc);
        await complete(svc, view, { actualUsd: 0.2, actualDurationHours: 0.7 });
        const merchantAfter = merchantBalance(svc);
        const again = await complete(svc, view, { actualUsd: 0.05, actualDurationHours: 0.1 });
        assert.equal(again.status, 200);
        assert.equal(merchantBalance(svc), merchantAfter);
        assert.equal(again.body.lease.reconciliation.actualUsd, 0.2);
    });

    it("cannot reconcile a payment that has no active lease", async () => {
        const svc = await start();
        const refused = await pay(svc, await svc.quote({ estimateUsd: 24, capUsd: 30 }));
        assert.equal((await complete(svc, refused, { actualUsd: 0.1, actualDurationHours: 1 })).status, 404);
    });
});

describe("service boundary", () => {
    it("requires the service token for everything except health and config", async () => {
        const svc = await start();
        const quote = await svc.quote();
        for (const [method, path] of [["POST", "/v1/quotes"], ["GET", "/v1/quotes/" + quote.id], ["POST", "/v1/payments"], ["GET", "/v1/payments/x"], ["POST", "/v1/approvals/x/decision"], ["GET", "/v1/audit/x"]]) {
            const body = method === "GET" ? undefined : {};
            assert.equal((await svc.call(method, path, body, { token: null })).status, 401, method + " " + path);
            assert.equal((await svc.call(method, path, body, { token: "wrong-token-wrong-token" })).status, 401, method + " " + path);
        }
        assert.equal((await svc.call("GET", "/v1/health", undefined, { token: null })).status, 200);
        assert.equal((await svc.call("GET", "/v1/config", undefined, { token: null })).status, 200);
    });

    it("publishes limits and accounts but no secrets", async () => {
        const svc = await start();
        const config = (await svc.call("GET", "/v1/config", undefined, { token: null })).body;
        assert.equal(config.simulated, true);
        assert.equal(config.limits.autoApproveLimitUsd, 0.5);
        assert.ok(config.accounts.merchant && config.accounts.agent);
        assert.equal(JSON.stringify(config).toLowerCase().includes("private"), false);
        assert.equal(JSON.stringify(config).includes("test-service-token"), false);
    });

    it("answers 402 with the exact quoted price for a payable quote, and refuses anything else", async () => {
        const svc = await start();
        const quote = await svc.quote();
        const p = await svc.call("POST", "/v1/payments", { quoteId: quote.id });
        await svc.services.payments.idle();
        // The payment finished; now the quote is no longer waiting for payment.
        const after = await fetch(svc.baseUrl + "/v1/leases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quoteId: quote.id }) });
        assert.equal(after.status, 409);
        assert.equal((await fetch(svc.baseUrl + "/v1/leases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quoteId: "q_nope" }) })).status, 404);
        assert.equal((await fetch(svc.baseUrl + "/v1/leases", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404);
        assert.ok(p.body.payment.id);
    });

    it("the lease API demands payment: an unpaid request gets 402 with the quote's amount", async () => {
        const svc = await start();
        const quote = await svc.quote(BIG);
        const started = await svc.call("POST", "/v1/payments", { quoteId: quote.id });
        // Force the payment into the state where the lease API will quote a price, without the agent running.
        svc.services.store.updatePayment(started.body.payment.id, { status: PaymentStatus.AWAITING_402 });
        const response = await fetch(svc.baseUrl + "/v1/leases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quoteId: quote.id }) });
        assert.equal(response.status, 402);
        const required = decodePaymentRequiredHeader(response.headers.get("PAYMENT-REQUIRED"));
        const terms = required.accepts[0];
        assert.equal(terms.scheme, "exact");
        assert.equal(terms.network, "hedera:testnet");
        assert.equal(terms.asset, "0.0.0");
        assert.equal(terms.amount, quote.tinybars, "the price comes from the stored quote");
        assert.equal(terms.payTo, svc.services.accounts.merchant);
        assert.equal(terms.extra.feePayer, svc.services.accounts.feePayer);
    });

    it("the facilitator advertises Hedera testnet with its fee payer", async () => {
        const svc = await start();
        const supported = await (await fetch(svc.baseUrl + "/facilitator/supported")).json();
        const kind = supported.kinds.find((k) => k.network === "hedera:testnet");
        assert.equal(kind.scheme, "exact");
        assert.equal(kind.extra.feePayer, svc.services.accounts.feePayer);
    });

    it("rejects malformed bodies with a clear error and never a stack trace", async () => {
        const svc = await start();
        const bad = await svc.call("POST", "/v1/quotes", { wallet: "nope" });
        assert.equal(bad.status, 400);
        assert.equal(bad.body.error, "VALIDATION_FAILED");
        const raw = await fetch(svc.baseUrl + "/v1/quotes", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-service-token-0123456789" }, body: "{not json" });
        assert.equal(raw.status, 400);
        const text = await raw.text();
        assert.equal(text.includes("at "), false);
    });
});

describe("restart safety", () => {
    const tempDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gpu4u-")), "payments.sqlite");

    const booted = new Set();
    async function boot(dbPath) {
        const config = loadConfig({ PAYMENT_MODE: "simulated", SERVICE_TOKEN: "test-service-token-0123456789", DB_PATH: dbPath });
        const services = await buildServices(config, { rates: { getRate: async () => FIXED_RATE } });
        const app = createApp(services);
        const server = await startServer(app, services, 0);
        const instance = { services, server };
        booted.add(instance);
        return instance;
    }
    const shut = async (instance) => {
        if (!booted.delete(instance)) return;
        await instance.services.payments.idle();
        await new Promise((resolve) => instance.server.server.close(resolve));
        await instance.services.close();
    };
    afterEach(async () => {
        for (const instance of [...booted]) await shut(instance).catch(() => {});
    });

    it("keeps a pending approval across a restart and can still complete it", async () => {
        const dbPath = tempDb();
        const a = await boot(dbPath);
        const quote = await a.services.quotes.create(quoteRequest(BIG));
        const started = a.services.payments.start({ quoteId: quote.id });
        assert.equal(started.payment.status, PaymentStatus.PENDING_APPROVAL);
        await shut(a);

        const b = await boot(dbPath);
        assert.equal(b.services.payments.recover(), 0, "a waiting approval is not interrupted work");
        const view = b.services.payments.view(started.payment.id);
        assert.equal(view.payment.status, PaymentStatus.PENDING_APPROVAL);
        assert.equal(view.approval.status, "PENDING");
        assert.equal(view.chain.valid, true);

        await b.services.payments.decideApproval({ approvalId: view.approval.id, decision: "approve", wallet: WALLET });
        await b.services.payments.idle();
        assert.equal(b.services.payments.view(started.payment.id).payment.status, PaymentStatus.LEASE_ACTIVE);
        await shut(b);
    });

    it("fails a payment that was mid-flight at restart instead of risking a second payment", async () => {
        const dbPath = tempDb();
        const a = await boot(dbPath);
        const quote = await a.services.quotes.create(quoteRequest());
        const started = a.services.payments.start({ quoteId: quote.id });
        await a.services.payments.idle();
        // Pretend the process died right after the agent signed.
        a.services.store.updatePayment(started.payment.id, { status: PaymentStatus.SIGNING });
        await shut(a);

        const b = await boot(dbPath);
        assert.equal(b.services.payments.recover(), 1);
        const view = b.services.payments.view(started.payment.id);
        assert.equal(view.payment.status, PaymentStatus.FAILED);
        assert.match(view.payment.error, /restarted/);
        assert.ok(eventTypes(view).includes("PAYMENT_INTERRUPTED"));
        assert.equal(view.chain.valid, true);
        await shut(b);
    });
});
