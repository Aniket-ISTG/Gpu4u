"use strict";

const crypto = require("node:crypto");
const express = require("express");
const { ZodError } = require("zod");
const { paymentMiddleware } = require("@x402/express");
const { x402ResourceServer, HTTPFacilitatorClient } = require("@x402/core/server");
const { ExactHederaScheme } = require("@x402/hedera/exact/server");
const { HBAR_ASSET_ID } = require("@x402/hedera");
const { PaymentStatus } = require("./states");
const { createFacilitatorRouter } = require("./facilitator");
const { NETWORK } = require("./agent");
const { RELAY_HEADER } = require("./relay");

const sha = (text) => crypto.createHash("sha256").update(String(text)).digest();
const sameSecret = (given, expected) => Boolean(given) && crypto.timingSafeEqual(sha(given), sha(expected));

/** Constant-time check of the bearer token the web app sends. */
function requireServiceToken(token) {
    const expected = sha(token);
    return (req, res, next) => {
        const header = req.get("authorization") || "";
        const given = header.startsWith("Bearer ") ? header.slice(7) : "";
        if (!given || !crypto.timingSafeEqual(sha(given), expected)) {
            return res.status(401).json({ error: "UNAUTHORIZED", message: "A valid service token is required" });
        }
        next();
    };
}

const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

/**
 * Builds the HTTP application. The x402-protected lease endpoint is attached after the server is
 * listening (see attachLeaseApi), because the resource server needs the facilitator's address.
 */
function createApp(services) {
    const { config, store, payments, quotes, audit, state, facilitator, publisher } = services;
    const app = express();
    app.disable("x-powered-by");
    app.use(express.json({ limit: "256kb" }));

    // ---- public
    app.get("/v1/health", (_req, res) => {
        res.json({
            ok: true,
            mode: config.mode,
            simulated: config.simulated,
            payer: config.payer.mode,
            network: NETWORK,
            facilitator: config.facilitator.mode === "local" ? "local" : config.facilitator.url,
            leaseApiReady: Boolean(state.baseUrl),
        });
    });

    app.get("/v1/config", (_req, res) => {
        res.json({
            mode: config.mode,
            simulated: config.simulated,
            // "wallet": the user's wallet signs every payment. "agent": a server key pays (simulated development only).
            payer: config.payer.mode,
            network: NETWORK,
            accounts: services.accounts,
            facilitator: { mode: config.facilitator.mode, feePayer: services.accounts.feePayer },
            limits: config.policy,
            approvalMode: config.approval.mode,
            approvalTtlSeconds: config.approval.ttlSeconds,
            quoteTtlSeconds: config.quoteTtlSeconds,
            hcsTopicId: publisher ? publisher.topicId : config.hedera.hcsTopicId,
            explorer: config.simulated ? null : { hashscan: "https://hashscan.io/testnet", mirror: config.hedera.mirrorUrl },
        });
    });

    if (facilitator) app.use("/facilitator", createFacilitatorRouter(facilitator));

    // ---- authenticated: used by the web app server, never by the browser
    const auth = requireServiceToken(config.serviceToken);

    app.post("/v1/quotes", auth, handle(async (req, res) => {
        res.status(201).json(await quotes.create(req.body));
    }));

    app.get("/v1/quotes/:id", auth, handle(async (req, res) => {
        const quote = quotes.get(req.params.id);
        if (!quote) return res.status(404).json({ error: "NOT_FOUND", message: "Quote not found" });
        res.json(quote);
    }));

    app.post("/v1/payments", auth, handle(async (req, res) => {
        const quoteId = req.body && req.body.quoteId;
        if (typeof quoteId !== "string") return res.status(400).json({ error: "BAD_REQUEST", message: "quoteId is required" });
        res.status(201).json(payments.start({ quoteId }));
    }));

    app.get("/v1/payments", auth, handle(async (req, res) => {
        const wallet = String(req.query.wallet || "");
        if (!/^0\.0\.\d+$/.test(wallet)) return res.status(400).json({ error: "BAD_REQUEST", message: "wallet is required" });
        res.json({ payments: store.listPayments(wallet) });
    }));

    app.get("/v1/payments/:id", auth, handle(async (req, res) => {
        res.json(payments.view(req.params.id));
    }));

    app.get("/v1/payments/:id/receipt", auth, handle(async (req, res) => {
        res.json(payments.receipt(req.params.id));
    }));

    // ---- wallet mode: the user's wallet signs the exact payment
    app.get("/v1/payments/:id/requirements", auth, handle(async (req, res) => {
        res.json(await payments.getRequirements(req.params.id));
    }));

    app.post("/v1/payments/:id/submit", auth, handle(async (req, res) => {
        const paymentPayload = req.body && req.body.paymentPayload;
        res.json(await payments.submitSigned(req.params.id, { paymentPayload }));
    }));

    app.post("/v1/approvals/:id/decision", auth, handle(async (req, res) => {
        const { decision, wallet, signature, signatureMap } = req.body || {};
        res.json(await payments.decideApproval({ approvalId: req.params.id, decision, wallet, signature, signatureMap }));
    }));

    // ---- lease: end it and bill the time it was held, or (simulated development) complete it with a usage
    app.post("/v1/payments/:id/lease/end", auth, handle(async (req, res) => {
        res.json(await payments.endLease(req.params.id));
    }));

    app.post("/v1/payments/:id/lease/complete", auth, handle(async (req, res) => {
        const { actualUsd, actualDurationHours, status, run, basis } = req.body || {};
        res.json(await payments.completeLease(req.params.id, { actualUsd, actualDurationHours, status, run, basis }));
    }));


    app.get("/v1/audit/:paymentId", auth, handle(async (req, res) => {
        res.json({ events: audit.list(req.params.paymentId), chain: audit.verifyChain(req.params.paymentId) });
    }));

    // Re-reads posted audit messages from the mirror node and confirms they match.
    app.post("/v1/audit/:paymentId/confirm", auth, handle(async (req, res) => {
        const result = publisher ? await publisher.confirmPending() : { checked: 0, confirmed: 0 };
        res.json({ ...result, events: audit.list(req.params.paymentId), chain: audit.verifyChain(req.params.paymentId) });
    }));

    // ---- the x402-protected lease endpoint is added here once the server is listening
    const leaseSlot = express.Router();
    leaseSlot.use("/v1/leases", (_req, res, next) => (state.baseUrl ? next() : res.status(503).json({ error: "STARTING", message: "Lease API is starting" })));
    app.use(leaseSlot);
    app.locals.leaseSlot = leaseSlot;

    app.use((req, res) => res.status(404).json({ error: "NOT_FOUND", message: "No such route" }));

    // eslint-disable-next-line no-unused-vars
    app.use((error, _req, res, _next) => {
        if (error instanceof ZodError) {
            return res.status(400).json({ error: "VALIDATION_FAILED", message: "The request is not valid", issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
        }
        if (error && error.status && error.code) {
            return res.status(error.status).json({ error: error.code, message: error.message });
        }
        if (error && error.type === "entity.parse.failed") {
            return res.status(400).json({ error: "BAD_JSON", message: "Request body must be valid JSON" });
        }
        console.error("[service] unexpected error:", error);
        res.status(500).json({ error: "INTERNAL", message: "Something went wrong" });
    });

    return app;
}

/**
 * Adds the lease endpoint: an x402 merchant. Without payment it answers 402 with the exact price
 * for the quote. With a valid payment it has the facilitator verify and settle, then answers 200.
 *
 * In wallet mode only the service's own relay may call it, so a signed payment reaches the facilitator
 * only after the checks in payments.js.
 */
function attachLeaseApi(app, services, baseUrl) {
    const { config, store, state } = services;
    state.baseUrl = baseUrl;
    const walletMode = config.payer.mode === "wallet";

    const facilitatorUrl = config.facilitator.mode === "local" ? baseUrl + "/facilitator" : config.facilitator.url;
    const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitatorUrl }))
        .register(NETWORK, new ExactHederaScheme());

    const slot = app.locals.leaseSlot;

    // Only a quote with a payment waiting for its x402 step can be paid.
    const payableStates = walletMode
        ? [PaymentStatus.AWAITING_SIGNATURE, PaymentStatus.SIGNING]
        : [PaymentStatus.AWAITING_402, PaymentStatus.SIGNING];
    slot.post("/v1/leases", (req, res, next) => {
        if (walletMode && !sameSecret(req.get(RELAY_HEADER), services.relaySecret)) {
            return res.status(403).json({ error: "FORBIDDEN", message: "Payments are relayed by the payment service only" });
        }
        const quoteId = req.body && req.body.quoteId;
        const quote = typeof quoteId === "string" ? store.getQuote(quoteId) : null;
        if (!quote) return res.status(404).json({ error: "QUOTE_NOT_FOUND", message: "Unknown quote" });
        if (services.now() >= quote.expiresAt) return res.status(410).json({ error: "QUOTE_EXPIRED", message: "This quote has expired" });
        const payment = store.getPaymentByQuote(quote.id);
        if (!payment || !payableStates.includes(payment.status)) {
            return res.status(409).json({ error: "NOT_PAYABLE", message: "This quote is not waiting for payment" });
        }
        next();
    });

    const routes = {
        "POST /v1/leases": {
            accepts: {
                scheme: "exact",
                network: NETWORK,
                payTo: services.accounts.merchant,
                // The price comes from the stored quote, never from the request.
                price: async (context) => {
                    const body = context.adapter.getBody ? context.adapter.getBody() : null;
                    const quote = store.getQuote(body && body.quoteId);
                    return { asset: HBAR_ASSET_ID, amount: String(quote.tinybars) };
                },
                maxTimeoutSeconds: 180,
            },
            description: "GPU4U GPU lease",
            mimeType: "application/json",
        },
    };
    slot.use(paymentMiddleware(routes, resourceServer));

    slot.post("/v1/leases", (req, res) => {
        res.json({ accepted: true, quoteId: req.body.quoteId, paymentId: req.body.paymentId || null });
    });
}

/** Starts listening, then attaches the lease API. Resolves with the running server. */
function startServer(app, services, port) {
    return new Promise((resolve, reject) => {
        const server = app.listen(port, "127.0.0.1", () => {
            try {
                const { port: actual } = server.address();
                const baseUrl = "http://127.0.0.1:" + actual;
                attachLeaseApi(app, services, baseUrl);
                resolve({ server, baseUrl, port: actual });
            } catch (error) {
                server.close();
                reject(error);
            }
        });
        server.on("error", reject);
    });
}

module.exports = { createApp, attachLeaseApi, startServer, requireServiceToken };
