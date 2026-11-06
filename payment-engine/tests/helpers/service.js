"use strict";

const { loadConfig } = require("../../service/config");
const { buildServices } = require("../../service/container");
const { createApp, startServer } = require("../../service/app");
const { makeRate } = require("../../service/rate");

const TOKEN = "test-service-token-0123456789";
const WALLET = "0.0.5000001";

/** 204375 cents per 30000 HBAR, so 1 HBAR is $0.068125. The same figure the mirror node published in testing. */
const FIXED_RATE = makeRate({
    centEquivalent: 204375,
    hbarEquivalent: 30000,
    source: "test-fixed",
    validUntil: Date.now() + 365 * 24 * 3600 * 1000,
});

const OFFER = {
    id: "simplepod:483:1",
    provider: "simplepod",
    gpuModel: "RTX 3090",
    gpuCount: 1,
    vramGb: 24,
    region: "United States",
};

function quoteRequest(over = {}) {
    return {
        wallet: WALLET,
        offer: OFFER,
        hours: 1.54,
        hourlyUsd: 0.22,
        estimateUsd: 0.3388,
        capUsd: 0.42,
        ...over,
    };
}

/**
 * Starts the real service in-process: simulated mode, in-memory database, fixed exchange rate, the
 * real x402 server and client talking over HTTP to a facilitator that settles on a simulated ledger.
 */
async function startTestService({ env = {}, overrides = {} } = {}) {
    const config = loadConfig({
        PAYMENT_MODE: "simulated",
        SERVICE_TOKEN: TOKEN,
        DB_PATH: ":memory:",
        PORT: "0",
        ...env,
    });
    const services = await buildServices(config, { rates: { getRate: async () => FIXED_RATE }, ...overrides });
    const app = createApp(services);
    const running = await startServer(app, services, 0);

    async function call(method, path, body, { token = TOKEN } = {}) {
        const response = await fetch(running.baseUrl + path, {
            method,
            headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await response.text();
        let json = null;
        try {
            json = text ? JSON.parse(text) : null;
        } catch {
            json = { raw: text };
        }
        return { status: response.status, body: json };
    }

    return {
        services, config, app, baseUrl: running.baseUrl, call,
        async quote(over) {
            const r = await call("POST", "/v1/quotes", quoteRequest(over));
            if (r.status !== 201) throw new Error("quote failed: " + JSON.stringify(r.body));
            return r.body;
        },
        async stop() {
            await services.payments.idle();
            await new Promise((resolve) => running.server.close(resolve));
            await services.close();
        },
    };
}

module.exports = { startTestService, quoteRequest, TOKEN, WALLET, OFFER, FIXED_RATE };
