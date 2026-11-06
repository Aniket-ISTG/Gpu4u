"use strict";

const { auditSigner } = require("./config");
const { parsePrivateKey } = require("./keys");
const { accountLinks, topicLinks } = require("./links");

const TINYBARS_PER_HBAR = 100_000_000n;

class PreflightError extends Error {
    constructor(problems) {
        super("Testnet is not ready:\n - " + problems.join("\n - "));
        this.name = "PreflightError";
        this.problems = problems;
    }
}

async function mirrorJson(fetchImpl, url) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Mirror node returned HTTP ${response.status} for ${url}`);
    return response.json();
}

/** True when a private key belongs to the account's single on-chain public key. */
function keyMatchesAccount(privateKey, mirrorKey) {
    if (!mirrorKey || !mirrorKey.key) return false;
    const derived = parsePrivateKey(privateKey).publicKey.toStringRaw().toLowerCase();
    return derived === String(mirrorKey.key).toLowerCase();
}

/**
 * Checks, before the service accepts any request, that everything real testnet mode depends on is there:
 * the accounts exist, their keys really are theirs, they have HBAR to work with, the exchange rate is
 * readable, and the audit topic exists and only accepts this service's key. It never substitutes
 * anything simulated: a problem stops the service.
 */
async function runPreflight({ config, services, fetchImpl = fetch }) {
    const mirror = config.hedera.mirrorUrl.replace(/\/$/, "");
    const problems = [];
    const report = [];

    // The receiver needs no key and no balance to receive HBAR; it only has to exist.
    const accounts = [
        { label: "Merchant (receiver)", id: config.hedera.merchantAccountId, key: config.hedera.merchantPrivateKey || null, minHbar: 0n },
    ];
    if (config.facilitator.mode === "local") {
        accounts.push({ label: "Facilitator fee payer", id: config.facilitator.feePayerAccountId, key: config.facilitator.feePayerPrivateKey, minHbar: 5n });
    }

    const signer = auditSigner(config);
    let merchantPublicKey = null; // the public key of the account that posts audit messages
    for (const a of accounts) {
        let account;
        try {
            account = await mirrorJson(fetchImpl, `${mirror}/api/v1/accounts/${a.id}`);
        } catch (error) {
            problems.push(`${a.label} ${a.id}: could not reach the Hedera testnet (${error.message})`);
            continue;
        }
        if (!account) {
            problems.push(`${a.label} ${a.id} does not exist on Hedera testnet`);
            continue;
        }
        if (a.key) {
            let matches = false;
            try {
                matches = keyMatchesAccount(a.key, account.key);
            } catch (error) {
                problems.push(`${a.label} ${a.id}: the private key could not be read (${error.message})`);
                continue;
            }
            if (!matches) problems.push(`${a.label} ${a.id}: the configured private key does not match the account's on-chain key`);
        }
        if (signer && a.id === signer.accountId) merchantPublicKey = account.key && account.key.key;

        const balance = BigInt((account.balance && account.balance.balance) || 0);
        const hbar = Number(balance) / Number(TINYBARS_PER_HBAR);
        if (balance < a.minHbar * TINYBARS_PER_HBAR) {
            problems.push(`${a.label} ${a.id} holds ${hbar} HBAR, less than the ${a.minHbar} HBAR it needs. Fund it from the testnet faucet`);
        }
        report.push(`${a.label}: ${a.id} · ${hbar.toFixed(4)} HBAR · ${a.key ? "key verified" : "no key needed"}${accountLinks({ accountId: a.id, simulated: false }).hashscan ? " · " + accountLinks({ accountId: a.id, simulated: false }).hashscan : ""}`);
    }

    try {
        const rate = await services.rates.getRate();
        report.push(`Exchange rate: $${rate.usdPerHbar.toFixed(6)} per HBAR (${rate.source})`);
    } catch (error) {
        problems.push(error.message);
    }

    if (problems.length) throw new PreflightError(problems);

    // The audit topic: use the configured one, or create one only this service can write to.
    const publisher = services.publisher;
    if (publisher) {
        if (publisher.topicId) {
            const topic = await mirrorJson(fetchImpl, `${mirror}/api/v1/topics/${publisher.topicId}`).catch(() => null);
            if (!topic) throw new PreflightError([`Audit topic ${publisher.topicId} does not exist on Hedera testnet`]);
            if (!topic.submit_key) {
                report.push(`Audit topic: ${publisher.topicId} WARNING: it has no submit key, so anyone could post fake audit messages to it. Create a new topic with a submit key by leaving HEDERA_HCS_TOPIC_ID empty.`);
            } else if (merchantPublicKey && String(topic.submit_key.key).toLowerCase() !== String(merchantPublicKey).toLowerCase()) {
                throw new PreflightError([`Audit topic ${publisher.topicId} only accepts a different key than the audit account's, so this service could not post to it`]);
            } else {
                report.push(`Audit topic: ${publisher.topicId} · only this service can post · ${topicLinks({ topicId: publisher.topicId, simulated: false }).hashscan}`);
            }
        } else {
            const topicId = await publisher.createTopic();
            report.push(`Audit topic: created ${topicId} with a submit key · ${topicLinks({ topicId, simulated: false }).hashscan}`);
            report.push(`  Save it so restarts reuse it: HEDERA_HCS_TOPIC_ID=${topicId}`);
        }
    }
    return report;
}

module.exports = { runPreflight, keyMatchesAccount, PreflightError };
