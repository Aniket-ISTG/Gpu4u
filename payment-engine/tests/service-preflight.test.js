"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { PrivateKey } = require("@hiero-ledger/sdk");

const { loadConfig } = require("../service/config");
const { runPreflight, keyMatchesAccount, PreflightError } = require("../service/preflight");

const HBAR = 100_000_000;
const merchantKey = PrivateKey.generateECDSA();
const feeKey = PrivateKey.generateECDSA();

const config = () =>
    loadConfig({
        PAYMENT_MODE: "testnet", SERVICE_TOKEN: "x".repeat(20), DB_PATH: ":memory:",
        HEDERA_RECEIVER_ID: "0.0.2000", HEDERA_MERCHANT_PRIVATE_KEY: merchantKey.toStringDer(),
        FACILITATOR_FEE_PAYER_ID: "0.0.3000", FACILITATOR_FEE_PAYER_KEY: feeKey.toStringDer(),
    });

const account = (key, hbar) => ({
    key: { _type: "ECDSA_SECP256K1", key: key.publicKey.toStringRaw() },
    balance: { balance: hbar * HBAR },
});

/** A mirror node with the given accounts and topics. */
function mirror({ accounts = {}, topics = {} } = {}) {
    return async (url) => {
        const acc = url.match(/\/accounts\/(0\.0\.\d+)$/);
        const top = url.match(/\/topics\/(0\.0\.\d+)$/);
        const table = acc ? accounts : top ? topics : {};
        const id = (acc || top || [])[1];
        if (!table[id]) return new Response("{}", { status: 404 });
        return new Response(JSON.stringify(table[id]));
    };
}

const services = (over = {}) => ({
    rates: { getRate: async () => ({ usdPerHbar: 0.068, source: "hedera-mirror-node" }) },
    publisher: null,
    ...over,
});

const healthy = () => ({ "0.0.2000": account(merchantKey, 10), "0.0.3000": account(feeKey, 50) });

describe("startup checks for real testnet mode", () => {
    it("passes and reports each account when everything is in order", async () => {
        const report = await runPreflight({ config: config(), services: services(), fetchImpl: mirror({ accounts: healthy() }) });
        assert.ok(report.some((l) => /Merchant \(receiver\): 0\.0\.2000 · 10\.0000 HBAR · key verified/.test(l)));
        assert.ok(report.some((l) => /Facilitator fee payer: 0\.0\.3000/.test(l)));
        assert.ok(report.some((l) => /Exchange rate: \$0\.068000/.test(l)));
    });

    it("needs no key and no balance for the receiver, since receiving HBAR requires neither", async () => {
        const noKey = loadConfig({
            PAYMENT_MODE: "testnet", SERVICE_TOKEN: "x".repeat(20), DB_PATH: ":memory:", HEDERA_RECEIVER_ID: "0.0.2000",
            FACILITATOR_FEE_PAYER_ID: "0.0.3000", FACILITATOR_FEE_PAYER_KEY: feeKey.toStringDer(),
        });
        const accounts = { "0.0.2000": account(PrivateKey.generateECDSA(), 0), "0.0.3000": account(feeKey, 50) };
        const topics = { "0.0.8888": { submit_key: { _type: "ECDSA_SECP256K1", key: feeKey.publicKey.toStringRaw() } } };
        const pub = { topicId: "0.0.8888" };
        const report = await runPreflight({ config: noKey, services: services({ publisher: pub }), fetchImpl: mirror({ accounts, topics }) });
        assert.ok(report.some((l) => /Merchant \(receiver\): 0\.0\.2000 .* no key needed/.test(l)));
        assert.ok(report.some((l) => /0\.0\.8888 · only this service can post/.test(l)), "the fee payer posts the audit messages");
    });

    it("stops when an account does not exist", async () => {
        const accounts = healthy();
        delete accounts["0.0.3000"];
        await assert.rejects(
            runPreflight({ config: config(), services: services(), fetchImpl: mirror({ accounts }) }),
            (e) => e instanceof PreflightError && /0\.0\.3000 does not exist/.test(e.message),
        );
    });

    it("stops when a private key is not the account's key, which would fail every payment later", async () => {
        const accounts = { ...healthy(), "0.0.2000": account(PrivateKey.generateECDSA(), 10) };
        await assert.rejects(
            runPreflight({ config: config(), services: services(), fetchImpl: mirror({ accounts }) }),
            /does not match the account's on-chain key/,
        );
    });

    it("stops when an account cannot afford its work, and says where to get testnet HBAR", async () => {
        const accounts = { ...healthy(), "0.0.3000": account(feeKey, 1) };
        await assert.rejects(
            runPreflight({ config: config(), services: services(), fetchImpl: mirror({ accounts }) }),
            /holds 1 HBAR, less than the 5 HBAR.*faucet/,
        );
    });

    it("stops when the Hedera testnet cannot be reached, instead of assuming it is fine", async () => {
        const down = async () => { throw new Error("connect timeout"); };
        await assert.rejects(runPreflight({ config: config(), services: services(), fetchImpl: down }), /could not reach the Hedera testnet/);
    });

    it("stops when the exchange rate cannot be read, with no fixed-rate fallback", async () => {
        const broken = services({ rates: { getRate: async () => { throw new Error("Could not read the HBAR exchange rate: offline"); } } });
        await assert.rejects(runPreflight({ config: config(), services: broken, fetchImpl: mirror({ accounts: healthy() }) }), /exchange rate/);
    });

    it("reports every problem at once, not just the first", async () => {
        const accounts = { "0.0.2000": account(PrivateKey.generateECDSA(), 0), "0.0.3000": account(PrivateKey.generateECDSA(), 1) };
        await assert.rejects(runPreflight({ config: config(), services: services(), fetchImpl: mirror({ accounts }) }), (e) => e.problems.length >= 3);
    });

    describe("the audit topic", () => {
        const publisherWith = (topicId) => ({ topicId, createTopic: async () => { publisherWith.created = true; return "0.0.7777"; } });

        it("creates a topic with a submit key when none is configured, and says to save its ID", async () => {
            publisherWith.created = false;
            const pub = publisherWith(null);
            pub.createTopic = async () => { pub.topicId = "0.0.7777"; return "0.0.7777"; };
            const report = await runPreflight({ config: config(), services: services({ publisher: pub }), fetchImpl: mirror({ accounts: healthy() }) });
            assert.ok(report.some((l) => /created 0\.0\.7777 with a submit key/.test(l)));
            assert.ok(report.some((l) => /HEDERA_HCS_TOPIC_ID=0\.0\.7777/.test(l)));
        });

        it("accepts a topic that only the merchant's key can post to", async () => {
            const topics = { "0.0.8888": { submit_key: { _type: "ECDSA_SECP256K1", key: merchantKey.publicKey.toStringRaw() } } };
            const report = await runPreflight({ config: config(), services: services({ publisher: publisherWith("0.0.8888") }), fetchImpl: mirror({ accounts: healthy(), topics }) });
            assert.ok(report.some((l) => /0\.0\.8888 · only this service can post/.test(l)));
        });

        it("warns, but starts, when the topic has no submit key, since anyone could post fake audit messages", async () => {
            const topics = { "0.0.8888": { submit_key: null } };
            const report = await runPreflight({ config: config(), services: services({ publisher: publisherWith("0.0.8888") }), fetchImpl: mirror({ accounts: healthy(), topics }) });
            assert.ok(report.some((l) => /WARNING: it has no submit key/.test(l)));
        });

        it("stops when the topic only accepts someone else's key, because audit messages could never be posted", async () => {
            const topics = { "0.0.8888": { submit_key: { _type: "ECDSA_SECP256K1", key: PrivateKey.generateECDSA().publicKey.toStringRaw() } } };
            await assert.rejects(
                runPreflight({ config: config(), services: services({ publisher: publisherWith("0.0.8888") }), fetchImpl: mirror({ accounts: healthy(), topics }) }),
                /only accepts a different key/,
            );
        });

        it("stops when the configured topic does not exist", async () => {
            await assert.rejects(
                runPreflight({ config: config(), services: services({ publisher: publisherWith("0.0.8888") }), fetchImpl: mirror({ accounts: healthy() }) }),
                /does not exist on Hedera testnet/,
            );
        });
    });

    it("recognizes whether a key belongs to an account", () => {
        assert.equal(keyMatchesAccount(merchantKey.toStringDer(), { key: merchantKey.publicKey.toStringRaw() }), true);
        assert.equal(keyMatchesAccount(merchantKey.toStringDer(), { key: feeKey.publicKey.toStringRaw() }), false);
        assert.equal(keyMatchesAccount(merchantKey.toStringDer(), null), false);
    });
});
