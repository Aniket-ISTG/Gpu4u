"use strict";

/**
 * Service configuration. Every setting has a documented default, and invalid values fail at
 * startup instead of at payment time.
 *
 * Two modes, never mixed:
 *   simulated  development and automated tests. Settles on an in-memory ledger. Nothing reaches Hedera.
 *   testnet    the real Hedera testnet. The user's wallet signs every payment. There is no fallback to
 *              anything simulated, no server-held payer, and no mainnet.
 */

const MODES = ["simulated", "testnet"];
const APPROVAL_MODES = ["click", "wallet"];
const FACILITATOR_MODES = ["local", "external"];
const PAYER_MODES = ["agent", "wallet"];
const ASSETS = ["hbar", "usdc"];
const { HBAR, tokenAsset, TESTNET_USDC_ID } = require("./asset");

const BLOCKY402_TESTNET = "https://api.testnet.blocky402.com";

function num(env, key, fallback, { min = -Infinity, max = Infinity } = {}) {
    const raw = env[key];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) {
        throw new Error(`${key} must be a number between ${min} and ${max}, got '${raw}'`);
    }
    return value;
}

function oneOf(env, key, allowed, fallback) {
    const value = (env[key] || fallback).toLowerCase();
    if (!allowed.includes(value)) {
        throw new Error(`${key} must be one of ${allowed.join(", ")}, got '${env[key]}'`);
    }
    return value;
}

function accountId(env, key, fallback = null) {
    const value = env[key] || fallback;
    if (value && !/^0\.0\.\d+$/.test(value)) throw new Error(`${key} must look like 0.0.1234, got '${value}'`);
    return value || null;
}

/** This service only ever talks to Hedera testnet. Anything that names another network is refused. */
function assertTestnetOnly(env) {
    const network = (env.HEDERA_NETWORK || "").toLowerCase();
    if (network && network !== "testnet" && network !== "hedera:testnet") {
        throw new Error(`HEDERA_NETWORK='${env.HEDERA_NETWORK}' is not allowed: this service only supports Hedera testnet`);
    }
    for (const key of ["HEDERA_MIRROR_URL", "FACILITATOR_URL"]) {
        if (/mainnet/i.test(env[key] || "")) {
            throw new Error(`${key} points at mainnet, which is not allowed: this service only supports Hedera testnet`);
        }
    }
}

/** HBAR by default. PAYMENT_ASSET=usdc settles in the HTS token USDC_TOKEN_ID (Circle's testnet USDC by default). */
function paymentAsset(env) {
    const choice = oneOf(env, "PAYMENT_ASSET", ASSETS, "hbar");
    if (choice === "hbar") return HBAR;
    const id = accountId(env, "USDC_TOKEN_ID", TESTNET_USDC_ID);
    return tokenAsset({ id });
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function loadConfig(env = process.env) {
    assertTestnetOnly(env);
    const mode = oneOf(env, "PAYMENT_MODE", MODES, "simulated");
    const simulated = mode === "simulated";

    // In testnet the wallet is the only payer. A server-held agent key is a development convenience.
    const payerMode = oneOf(env, "PAYER_MODE", PAYER_MODES, simulated ? "agent" : "wallet");
    if (!simulated && payerMode !== "wallet") {
        throw new Error("PAYER_MODE=agent is not allowed with PAYMENT_MODE=testnet: every payment must be signed by the user's wallet");
    }

    const config = {
        mode,
        simulated,
        port: num(env, "PORT", 4021, { min: 0, max: 65535 }),
        dbPath: env.DB_PATH || "./data/payments.sqlite",
        serviceToken: env.SERVICE_TOKEN || null,

        payer: { mode: payerMode },

        // What a payment is made in. HBAR is converted from USD at the network rate. USDC is an HTS token worth
        // exactly $1, so it needs no rate: the quote is the cap in dollars, to the cent.
        asset: paymentAsset(env),

        // Spending policy, all in USD so limits do not drift with the HBAR price.
        policy: {
            autoApproveLimitUsd: num(env, "AUTO_APPROVE_LIMIT_USD", 0.5, { min: 0 }),
            dailyLimitUsd: num(env, "DAILY_LIMIT_USD", 5, { min: 0 }),
            hardCeilingUsd: num(env, "HARD_CEILING_USD", 25, { min: 0 }),
            // Across all wallets. Nothing proves who is asking, so this caps what can ever be committed.
            globalDailyLimitUsd: num(env, "GLOBAL_DAILY_LIMIT_USD", 50, { min: 0 }),
        },

        approval: {
            mode: oneOf(env, "APPROVAL_MODE", APPROVAL_MODES, "click"),
            ttlSeconds: num(env, "APPROVAL_TTL_SECONDS", 300, { min: 10 }),
        },

        quoteTtlSeconds: num(env, "QUOTE_TTL_SECONDS", 600, { min: 30 }),

        hedera: {
            network: "hedera:testnet",
            mirrorUrl: env.HEDERA_MIRROR_URL || "https://testnet.mirrornode.hedera.com",
            // Only used when PAYER_MODE=agent (simulated development). Never used in testnet.
            agentAccountId: accountId(env, "HEDERA_ACCOUNT_ID"),
            agentPrivateKey: env.HEDERA_PRIVATE_KEY || null,
            // The merchant receives payments. Its key is optional and only used for audit messages.
            merchantAccountId: accountId(env, "HEDERA_RECEIVER_ID"),
            merchantPrivateKey: env.HEDERA_MERCHANT_PRIVATE_KEY || null,
            hcsTopicId: env.HEDERA_HCS_TOPIC_ID || null,
        },

        facilitator: {
            // Testnet defaults to a local facilitator so its behavior is the official scheme code.
            mode: simulated ? "local" : oneOf(env, "FACILITATOR_MODE", FACILITATOR_MODES, "local"),
            url: env.FACILITATOR_URL || BLOCKY402_TESTNET,
            feePayerAccountId: accountId(env, "FACILITATOR_FEE_PAYER_ID"),
            feePayerPrivateKey: env.FACILITATOR_FEE_PAYER_KEY || null,
        },

        // Simulation knobs. Only used when PAYMENT_MODE=simulated.
        simulation: {
            fallbackUsdPerHbar: num(env, "SIM_USD_PER_HBAR", 0.068, { min: 0.000001 }),
            startingBalanceHbar: num(env, "SIM_STARTING_BALANCE_HBAR", 1000, { min: 1 }),
            startingBalanceToken: num(env, "SIM_STARTING_BALANCE_USDC", 1000, { min: 1 }),
        },

        // Refunds smaller than this are not worth a transaction.
        refundDustTinybars: BigInt(num(env, "REFUND_DUST_TINYBARS", 1_000_000, { min: 0 })),
    };

    config.policy.autoApproveLimitUsd = Math.min(config.policy.autoApproveLimitUsd, config.policy.hardCeilingUsd);
    return config;
}

/** Throws on settings that are unsafe or incomplete for the chosen mode. */
function assertRunnable(config) {
    const problems = [];
    if (!config.serviceToken || config.serviceToken.length < 16) {
        problems.push("SERVICE_TOKEN must be set to at least 16 characters");
    }
    if (!config.simulated) {
        const { merchantAccountId, merchantPrivateKey } = config.hedera;
        if (!merchantAccountId) problems.push("HEDERA_RECEIVER_ID (the merchant account) is required in testnet mode");
        // The receiver needs no key to receive HBAR. A funded key is only needed to post audit messages.
        if (!auditSigner(config)) {
            problems.push("A funded account key is needed to post audit messages: set FACILITATOR_FEE_PAYER_ID and FACILITATOR_FEE_PAYER_KEY (or, optionally, HEDERA_MERCHANT_PRIVATE_KEY)");
        }
        if (config.facilitator.mode === "local") {
            const { feePayerAccountId, feePayerPrivateKey } = config.facilitator;
            if (!feePayerAccountId || !feePayerPrivateKey) {
                problems.push("FACILITATOR_FEE_PAYER_ID and FACILITATOR_FEE_PAYER_KEY are required for a local facilitator");
            }
            if (feePayerAccountId && feePayerAccountId === merchantAccountId) {
                problems.push("The facilitator fee payer must be a different account from the merchant");
            }
        }
    }
    if (problems.length) throw new Error(`Invalid configuration:\n - ${problems.join("\n - ")}`);
}

/**
 * The account that signs and pays for audit messages. Receiving a payment needs no key, so the receiver's
 * key is optional; by default the facilitator fee payer, which is already funded, posts the audit messages.
 */
function auditSigner(config) {
    const { merchantAccountId, merchantPrivateKey } = config.hedera;
    if (merchantAccountId && merchantPrivateKey) return { accountId: merchantAccountId, privateKey: merchantPrivateKey, label: "Merchant" };
    const { feePayerAccountId, feePayerPrivateKey } = config.facilitator;
    if (feePayerAccountId && feePayerPrivateKey) return { accountId: feePayerAccountId, privateKey: feePayerPrivateKey, label: "Facilitator fee payer" };
    return null;
}

module.exports = { loadConfig, assertRunnable, auditSigner, BLOCKY402_TESTNET };
