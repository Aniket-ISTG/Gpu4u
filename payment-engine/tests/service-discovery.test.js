"use strict";

/**
 * How an agent finds and prices the x402 endpoint: a public discovery document, and an unpaid request that is
 * answered with HTTP 402 and the exact price of that quote. Anyone may ask the price; only the relay may pay.
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { decodePaymentRequiredHeader } = require("@x402/core/http");

const { startWalletService } = require("./helpers/wallet");

const running = [];
afterEach(async () => {
    while (running.length) await running.pop().stop().catch(() => {});
});
const start = async (options) => {
    const svc = await startWalletService(options);
    running.push(svc);
    return svc;
};
const begin = async (svc, over) => {
    const quote = await svc.quote(over);
    const started = await svc.call("POST", "/v1/payments", { quoteId: quote.id });
    return { quote, paymentId: started.body.payment.id };
};
const probe = (svc, body, headers = {}) =>
    fetch(svc.baseUrl + "/v1/leases", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("discovery", () => {
    it("publishes the x402 endpoint, its network, asset, recipient and spending controls, with no secrets and no token", async () => {
        const svc = await start();
        const response = await fetch(svc.baseUrl + "/.well-known/x402");
        assert.equal(response.status, 200);
        const doc = await response.json();
        assert.equal(doc.x402Version, 2);
        assert.equal(doc.network, "hedera:testnet");
        const r = doc.resources[0];
        assert.equal(r.resource, svc.baseUrl + "/v1/leases");
        assert.equal(r.scheme, "exact");
        assert.equal(r.pricing, "dynamic");
        assert.equal(r.payTo, svc.services.accounts.merchant);
        assert.equal(r.asset.id, "0.0.0");
        assert.equal(doc.facilitator.feePayer, svc.services.accounts.feePayer);
        assert.equal(doc.spendingControls.hardCeilingUsd, svc.config.policy.hardCeilingUsd);
        assert.deepEqual(doc.spendingControls.recipientAllowlist, [svc.services.accounts.merchant]);
        const text = JSON.stringify(doc);
        assert.ok(!text.includes(svc.config.serviceToken), "the service token is never published");
        assert.ok(!text.includes(svc.services.relaySecret), "the relay secret is never published");
    });

    it("is also served as .json and names the audit topic and settlement asset", async () => {
        const svc = await start({ env: { PAYMENT_ASSET: "usdc" }, tokens: { "0.0.429274": 5_000_000n } });
        const doc = await (await fetch(svc.baseUrl + "/.well-known/x402.json")).json();
        assert.equal(doc.resources[0].asset.symbol, "USDC");
        assert.equal(doc.resources[0].asset.id, "0.0.429274");
        assert.ok("audit" in doc);
    });
});

describe("a dynamic 402 for each quote", () => {
    it("answers an unpaid request with 402 and the exact price of that quote, to anyone", async () => {
        const svc = await start();
        const { quote, paymentId } = await begin(svc);
        const response = await probe(svc, { quoteId: quote.id, paymentId });
        assert.equal(response.status, 402, "payment required");
        const required = decodePaymentRequiredHeader(response.headers.get("PAYMENT-REQUIRED"));
        const terms = required.accepts[0];
        assert.equal(terms.scheme, "exact");
        assert.equal(terms.network, "hedera:testnet");
        assert.equal(terms.asset, "0.0.0");
        assert.equal(terms.amount, quote.tinybars, "the price is the quote's price");
        assert.equal(terms.payTo, svc.services.accounts.merchant);
        assert.equal(terms.extra.feePayer, svc.services.accounts.feePayer, "the facilitator pays the network fee");
    });

    it("prices each quote separately: a different job is a different price", async () => {
        const svc = await start();
        const a = await begin(svc, { estimateUsd: 0.1, capUsd: 0.12 });
        const b = await begin(svc, { estimateUsd: 0.3, capUsd: 0.4 });
        const termsOf = async (q) => decodePaymentRequiredHeader((await probe(svc, { quoteId: q.quote.id, paymentId: q.paymentId })).headers.get("PAYMENT-REQUIRED")).accepts[0].amount;
        const first = await termsOf(a);
        assert.equal(first, a.quote.tinybars);
        const second = await termsOf(b);
        assert.equal(second, b.quote.tinybars);
        assert.ok(BigInt(second) > BigInt(first), "a bigger job costs more");
    });

    it("refuses an unknown quote and a payment that does not come through the relay", async () => {
        const svc = await start();
        assert.equal((await probe(svc, { quoteId: "q_000000000000000000000000" })).status, 404);

        const { quote, paymentId } = await begin(svc);
        const forged = await probe(svc, { quoteId: quote.id, paymentId }, { "PAYMENT-SIGNATURE": Buffer.from("{}").toString("base64") });
        assert.equal(forged.status, 403, "a payment sent straight to the endpoint is refused");
        const old = await probe(svc, { quoteId: quote.id, paymentId }, { "X-PAYMENT": "x" });
        assert.equal(old.status, 403);
    });

    it("moves no money when the price is only asked", async () => {
        const svc = await start();
        const before = svc.merchantBalance();
        const { quote, paymentId } = await begin(svc);
        for (let i = 0; i < 3; i++) await probe(svc, { quoteId: quote.id, paymentId });
        assert.equal(svc.merchantBalance(), before);
        assert.equal(svc.userBalance(), 1000n * 100_000_000n);
    });
});
