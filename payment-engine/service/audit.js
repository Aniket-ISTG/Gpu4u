"use strict";

const crypto = require("node:crypto");

const GENESIS = "genesis";
const SECRET_KEY = /(private|secret|mnemonic|seed|token|signature|password|authorization)/i;

/** Deep-copies details, dropping anything that looks like a secret and turning bigints into strings. */
function sanitize(value) {
    if (typeof value === "bigint") return value.toString();
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === "object") {
        const out = {};
        for (const [key, inner] of Object.entries(value)) {
            if (!SECRET_KEY.test(key)) out[key] = sanitize(inner);
        }
        return out;
    }
    return value;
}

/** Stable JSON so the same event always hashes the same way. */
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

function hashEvent({ paymentId, seq, eventType, status, transactionId, createdAt, details, prevHash }) {
    return `sha256:${crypto
        .createHash("sha256")
        .update(canonical({ paymentId, seq, eventType, status, transactionId: transactionId || null, createdAt, details, prevHash }))
        .digest("hex")}`;
}

/**
 * Append-only audit log. Each payment has its own hash chain: an event commits to the
 * one before it, so editing or removing any event breaks every hash after it. A publisher
 * (Hedera Consensus Service in testnet mode) anchors the chain on a public ledger.
 */
class AuditLog {
    /**
     * @param {object} opts
     * @param {import("./store").Store} opts.store
     * @param {{enqueue:(event:object)=>void, flush:()=>Promise<void>}|null} [opts.publisher]
     * @param {"HCS"|"LOCAL"} [opts.target]  Label for where events are anchored
     */
    constructor({ store, publisher = null, now = () => new Date() }) {
        this.store = store;
        this.publisher = publisher;
        this.now = now;
    }

    append({ paymentId, eventType, status, transactionId = null, details = {} }) {
        const event = this.store.transaction(() => {
            const last = this.store.lastAuditEvent(paymentId);
            const seq = last ? last.seq + 1 : 1;
            const prevHash = last ? last.hash : GENESIS;
            const createdAt = this.now().toISOString();
            const clean = sanitize(details);
            const hash = hashEvent({ paymentId, seq, eventType, status, transactionId, createdAt, details: clean, prevHash });
            this.store.insertAuditEvent({
                paymentId, seq, eventType, status, transactionId, createdAt, details: clean, prevHash, hash,
                hcsStatus: this.publisher ? "PENDING" : "LOCAL",
            });
            return { paymentId, seq, eventType, status, transactionId, createdAt, details: clean, prevHash, hash };
        });
        if (this.publisher) this.publisher.enqueue(event);
        return event;
    }

    list(paymentId) {
        return this.store.listAuditEvents(paymentId);
    }

    /** Recomputes every hash and link for a payment. */
    verifyChain(paymentId) {
        let prev = GENESIS;
        for (const event of this.store.listAuditEvents(paymentId)) {
            const expected = hashEvent({
                paymentId: event.paymentId, seq: event.seq, eventType: event.eventType, status: event.status,
                transactionId: event.transactionId, createdAt: event.createdAt, details: event.details, prevHash: prev,
            });
            if (event.prevHash !== prev || event.hash !== expected) return { valid: false, brokenAtSeq: event.seq };
            prev = event.hash;
        }
        return { valid: true, brokenAtSeq: null };
    }

    async flush() {
        if (this.publisher) await this.publisher.flush();
    }
}

module.exports = { AuditLog, GENESIS, sanitize, canonical, hashEvent };
