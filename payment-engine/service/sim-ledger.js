"use strict";

const { normalizeTransactionId } = require("../payment/Settlement_Verifier");

const SIM_FEE_TINYBARS = 100_000n; // 0.001 HBAR, charged to the fee payer
const FEE_COLLECTOR = "0.0.98";

/**
 * An in-memory stand-in for the Hedera ledger, used only in simulated mode.
 * It enforces what matters for payments: balances cannot go negative, transfers
 * must net to zero, and a transaction ID can settle only once. Transactions are
 * returned in the same shape as the mirror node so the verifier is the same code.
 */
class SimLedger {
    constructor({ now = Date.now } = {}) {
        this.now = now;
        this.accounts = new Map();
        this.transactions = new Map();
        this.sequence = 0;
    }

    addAccount(id, { key = null, balance = 0n } = {}) {
        this.accounts.set(id, { key, balance: BigInt(balance) });
        return id;
    }

    keyOf(id) {
        return this.accounts.get(id)?.key || null;
    }

    balanceOf(id) {
        return this.accounts.get(id)?.balance ?? 0n;
    }

    hasAccount(id) {
        return this.accounts.has(id);
    }

    /** Settles one transaction. transfers: [{ account, amount: bigint }] where debits are negative. */
    submit({ transactionId, transfers, feePayer, memo = "" }) {
        const mirrorId = normalizeTransactionId(transactionId);
        if (this.transactions.has(mirrorId)) throw new Error("DUPLICATE_TRANSACTION");

        const net = transfers.reduce((sum, t) => sum + BigInt(t.amount), 0n);
        if (net !== 0n) throw new Error("INVALID_ACCOUNT_AMOUNTS");

        const all = [...transfers.map((t) => ({ account: t.account, amount: BigInt(t.amount) }))];
        if (feePayer) {
            all.push({ account: feePayer, amount: -SIM_FEE_TINYBARS });
            all.push({ account: FEE_COLLECTOR, amount: SIM_FEE_TINYBARS });
        }

        // Check every balance before applying anything.
        const totals = new Map();
        for (const t of all) totals.set(t.account, (totals.get(t.account) ?? 0n) + t.amount);
        for (const [account, delta] of totals) {
            if (!this.accounts.has(account)) {
                if (account === FEE_COLLECTOR) continue;
                throw new Error("INVALID_ACCOUNT_ID");
            }
            if (this.accounts.get(account).balance + delta < 0n) throw new Error("INSUFFICIENT_ACCOUNT_BALANCE");
        }
        for (const [account, delta] of totals) {
            if (!this.accounts.has(account)) this.accounts.set(account, { key: null, balance: 0n });
            this.accounts.get(account).balance += delta;
        }

        const ms = this.now();
        const record = {
            transaction_id: mirrorId,
            name: "CRYPTOTRANSFER",
            result: "SUCCESS",
            consensus_timestamp: `${Math.floor(ms / 1000)}.${String(++this.sequence).padStart(9, "0")}`,
            charged_tx_fee: feePayer ? Number(SIM_FEE_TINYBARS) : 0,
            memo_base64: Buffer.from(memo).toString("base64"),
            nonce: 0,
            transfers: [...totals].map(([account, amount]) => ({ account, amount: Number(amount), is_approval: false })),
        };
        this.transactions.set(mirrorId, record);
        return { transactionId, mirrorTransactionId: mirrorId, consensusTimestamp: record.consensus_timestamp };
    }

    /** A plain account-to-account transfer paid for by the sender, such as a refund. */
    transfer({ from, to, amount, memo = "" }) {
        const ms = this.now();
        const transactionId = `${from}@${Math.floor(ms / 1000)}.${String(++this.sequence).padStart(9, "0")}`;
        return this.submit({
            transactionId,
            feePayer: from,
            memo,
            transfers: [
                { account: from, amount: -BigInt(amount) },
                { account: to, amount: BigInt(amount) },
            ],
        });
    }

    /** Mirror node REST shape for GET /api/v1/transactions/:id. */
    getMirrorTransactions(mirrorId) {
        const record = this.transactions.get(mirrorId);
        return record ? { transactions: [record] } : null;
    }
}

module.exports = { SimLedger, SIM_FEE_TINYBARS, FEE_COLLECTOR };
