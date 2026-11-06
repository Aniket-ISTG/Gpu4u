"use strict";

const { normalizeTransactionId } = require("../payment/Settlement_Verifier");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Hedera reserves account numbers below 1000 for the network: nodes, fee collectors, staking rewards.
const isSystemAccount = (account) => Number(account.split(".")[2]) < 1000;

/** The account that pays the network fee is the one named in the transaction ID. */
const transactionPayer = (transactionId) => String(transactionId).split("@")[0];

/**
 * Independent settlement check. It does not trust the facilitator's answer: it
 * reads the transaction back from the ledger and confirms the money moved
 * exactly as quoted, between exactly the expected accounts.
 */
class SettlementVerifier {
    /**
     * @param {object} opts
     * @param {(mirrorId:string)=>Promise<object|null>} opts.fetchTransaction  Returns the mirror REST body, or null if not yet there
     * @param {string} [opts.explorerBase]  e.g. https://hashscan.io/testnet/transaction
     */
    constructor({ fetchTransaction, explorerBase = null, retries = 8, retryDelayMs = 2000 }) {
        this.fetchTransaction = fetchTransaction;
        this.explorerBase = explorerBase;
        this.retries = retries;
        this.retryDelayMs = retryDelayMs;
    }

    /** Waits for the transaction to appear on the ledger. Returns the record, or an error message. */
    async waitForRecord(mirrorId) {
        let body = null;
        for (let attempt = 1; attempt <= this.retries; attempt++) {
            try {
                body = await this.fetchTransaction(mirrorId);
            } catch (error) {
                if (attempt === this.retries) return { error: `Ledger lookup failed: ${error.message}` };
            }
            if (body?.transactions?.length) break;
            if (attempt < this.retries) await wait(this.retryDelayMs);
        }
        if (!body?.transactions?.length) return { error: "Transaction was not found on the ledger in time" };
        return { record: body.transactions.find((t) => (t.nonce ?? 0) === 0) || body.transactions[0] };
    }

    explorerUrlFor(record, mirrorId) {
        return this.explorerBase ? `${this.explorerBase}/${record.consensus_timestamp || mirrorId}` : null;
    }

    /**
     * Verifies an ordinary transfer, such as a refund: it succeeded, the receiver was credited exactly
     * the amount, the sender lost the amount plus at most the network fee, and nobody else received value.
     */
    async verifyTransfer({ transactionId, sender, receiver, tinybars }) {
        const mirrorId = normalizeTransactionId(transactionId);
        const found = await this.waitForRecord(mirrorId);
        if (found.error) return this.fail(mirrorId, found.error);
        const record = found.record;

        const problems = [];
        if (record.result !== "SUCCESS") problems.push(`Transaction result was ${record.result}`);

        const expected = BigInt(tinybars);
        const net = new Map();
        for (const t of record.transfers || []) net.set(t.account, (net.get(t.account) ?? 0n) + BigInt(t.amount));

        const credited = net.get(receiver) ?? 0n;
        if (credited !== expected) problems.push(`Receiver ${receiver} received ${credited} tinybars, expected exactly ${expected}`);

        const fee = BigInt(record.charged_tx_fee ?? 0);
        const debited = -(net.get(sender) ?? 0n);
        if (debited < expected || debited > expected + fee) {
            problems.push(`Sender ${sender} lost ${debited} tinybars, expected ${expected} plus at most the ${fee} tinybar fee`);
        }
        for (const [account, amount] of net) {
            if (amount > 0n && account !== receiver && !isSystemAccount(account)) {
                problems.push(`Unexpected credit of ${amount} tinybars to ${account}`);
            }
        }

        return {
            verified: problems.length === 0,
            settled: record.result === "SUCCESS",
            status: record.result,
            transactionId: mirrorId,
            consensusTimestamp: record.consensus_timestamp,
            chargedTxFee: record.charged_tx_fee,
            transfers: record.transfers,
            problems,
            explorerUrl: this.explorerUrlFor(record, mirrorId),
        };
    }

    async verify({ transactionId, payer, payTo, tinybars, feePayers = [] }) {
        const mirrorId = normalizeTransactionId(transactionId);
        const found = await this.waitForRecord(mirrorId);
        if (found.error) return this.fail(mirrorId, found.error);

        const record = found.record;
        const problems = [];
        if (record.result !== "SUCCESS") problems.push(`Transaction result was ${record.result}`);

        const expected = BigInt(tinybars);
        const net = new Map();
        for (const t of record.transfers || []) net.set(t.account, (net.get(t.account) ?? 0n) + BigInt(t.amount));

        const credited = net.get(payTo) ?? 0n;
        if (credited !== expected) problems.push(`Merchant ${payTo} received ${credited} tinybars, expected exactly ${expected}`);

        const debited = net.get(payer) ?? 0n;
        if (debited !== -expected) problems.push(`Payer ${payer} net change was ${debited} tinybars, expected exactly ${-expected}`);

        // No one else may have received value, apart from system accounts that collect fees.
        for (const [account, amount] of net) {
            if (amount > 0n && account !== payTo && !isSystemAccount(account)) {
                problems.push(`Unexpected credit of ${amount} tinybars to ${account}`);
            }
        }

        const feePayer = transactionPayer(record.transaction_id.replace(/-(\d+)-(\d+)$/, "@$1.$2"));
        if (feePayers.length && !feePayers.includes(feePayer)) {
            problems.push(`Fee was paid by ${feePayer}, which is not a known facilitator account`);
        }
        if (feePayer === payer) problems.push("The fee payer must not be the paying account");

        return {
            verified: problems.length === 0,
            settled: record.result === "SUCCESS",
            status: record.result,
            transactionId: mirrorId,
            consensusTimestamp: record.consensus_timestamp,
            chargedTxFee: record.charged_tx_fee,
            feePayer,
            transfers: record.transfers,
            problems,
            explorerUrl: this.explorerUrlFor(record, mirrorId),
        };
    }

    fail(mirrorId, problem) {
        return { verified: false, settled: false, status: "UNKNOWN", transactionId: mirrorId, problems: [problem], explorerUrl: null };
    }
}

/** Reads transactions from a Hedera mirror node. */
function mirrorFetcher(mirrorUrl, fetchImpl = fetch) {
    return async (mirrorId) => {
        const response = await fetchImpl(`${mirrorUrl}/api/v1/transactions/${mirrorId}`, { signal: AbortSignal.timeout(10000) });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`Mirror node returned HTTP ${response.status}`);
        return response.json();
    };
}

module.exports = { SettlementVerifier, mirrorFetcher, transactionPayer };
