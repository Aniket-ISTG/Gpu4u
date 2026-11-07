"use strict";

const { normalizeTransactionId } = require("../payment/Settlement_Verifier");
const { HBAR_ASSET_ID } = require("./asset");

const SIM_FEE_TINYBARS = 100_000n; // 0.001 HBAR, charged to the fee payer
const FEE_COLLECTOR = "0.0.98";

/**
 * An in-memory stand-in for the Hedera ledger, used only in simulated mode.
 * It enforces what matters for payments: balances cannot go negative, transfers
 * must net to zero (per asset), a transaction ID can settle only once, and an account
 * can only hold or receive a token it is associated with, as on Hedera. Transactions are
 * returned in the same shape as the mirror node so the verifier is the same code.
 */
class SimLedger {
    constructor({ now = Date.now } = {}) {
        this.now = now;
        this.accounts = new Map();
        this.transactions = new Map();
        this.sequence = 0;
    }

    /** tokens: { "0.0.429274": 1000000n } associates the account with each token and gives it that balance. */
    addAccount(id, { key = null, balance = 0n, tokens = {} } = {}) {
        const held = new Map(Object.entries(tokens).map(([token, amount]) => [token, BigInt(amount)]));
        this.accounts.set(id, { key, balance: BigInt(balance), tokens: held });
        return id;
    }

    /** Associates an account with a token, so it can hold it. A new association holds zero. */
    associate(id, tokenId) {
        const account = this.accounts.get(id);
        if (!account) throw new Error("INVALID_ACCOUNT_ID");
        if (!account.tokens.has(tokenId)) account.tokens.set(tokenId, 0n);
    }

    isAssociated(id, tokenId) {
        return Boolean(this.accounts.get(id)?.tokens.has(tokenId));
    }

    keyOf(id) {
        return this.accounts.get(id)?.key || null;
    }

    /** HBAR in tinybars by default, or the balance of one token in its base unit. */
    balanceOf(id, tokenId = HBAR_ASSET_ID) {
        const account = this.accounts.get(id);
        if (!account) return 0n;
        return tokenId === HBAR_ASSET_ID ? account.balance : account.tokens.get(tokenId) ?? 0n;
    }

    hasAccount(id) {
        return this.accounts.has(id);
    }

    /**
     * Settles one transaction. transfers: [{ account, amount: bigint }] in tinybars, where debits are negative.
     * tokenTransfers: [{ token, account, amount }] in the token's base unit, which must net to zero per token.
     */
    submit({ transactionId, transfers, tokenTransfers = [], feePayer, memo = "" }) {
        const mirrorId = normalizeTransactionId(transactionId);
        if (this.transactions.has(mirrorId)) throw new Error("DUPLICATE_TRANSACTION");

        const net = transfers.reduce((sum, t) => sum + BigInt(t.amount), 0n);
        if (net !== 0n) throw new Error("INVALID_ACCOUNT_AMOUNTS");

        const tokenNet = new Map();
        for (const t of tokenTransfers) tokenNet.set(t.token, (tokenNet.get(t.token) ?? 0n) + BigInt(t.amount));
        for (const total of tokenNet.values()) if (total !== 0n) throw new Error("TRANSFERS_NOT_ZERO_SUM_FOR_TOKEN");

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
        const tokenTotals = new Map();
        for (const t of tokenTransfers) {
            const k = `${t.token}|${t.account}`;
            tokenTotals.set(k, { token: t.token, account: t.account, amount: (tokenTotals.get(k)?.amount ?? 0n) + BigInt(t.amount) });
        }
        for (const { token, account, amount } of tokenTotals.values()) {
            if (!this.accounts.has(account)) throw new Error("INVALID_ACCOUNT_ID");
            if (!this.isAssociated(account, token)) throw new Error("TOKEN_NOT_ASSOCIATED_TO_ACCOUNT");
            if (this.balanceOf(account, token) + amount < 0n) throw new Error("INSUFFICIENT_TOKEN_BALANCE");
        }

        for (const [account, delta] of totals) {
            if (!this.accounts.has(account)) this.accounts.set(account, { key: null, balance: 0n, tokens: new Map() });
            this.accounts.get(account).balance += delta;
        }
        for (const { token, account, amount } of tokenTotals.values()) {
            const held = this.accounts.get(account).tokens;
            held.set(token, (held.get(token) ?? 0n) + amount);
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
            token_transfers: [...tokenTotals.values()].map((t) => ({ token_id: t.token, account: t.account, amount: Number(t.amount), is_approval: false })),
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
