"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { PaymentStatus, COMMITTED } = require("./states");
const { assetFromStored, storableAsset } = require("./asset");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS quotes (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    wallet TEXT NOT NULL,
    pay_to TEXT NOT NULL,
    offer_json TEXT NOT NULL,
    hours REAL NOT NULL,
    hourly_usd REAL NOT NULL,
    estimate_usd REAL NOT NULL,
    cap_usd REAL NOT NULL,
    tinybars TEXT NOT NULL,
    rate_json TEXT NOT NULL,
    terms_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    asset_json TEXT
);
CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    quote_id TEXT NOT NULL UNIQUE,
    wallet TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    decision TEXT,
    decision_reasons TEXT,
    cap_usd REAL NOT NULL,
    tinybars TEXT NOT NULL,
    transaction_id TEXT,
    settlement_json TEXT,
    error TEXT,
    mode TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_wallet_created ON payments (wallet, created_at);
CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    payment_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    decided_at INTEGER,
    decided_by TEXT,
    method TEXT,
    signature TEXT,
    consumed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    status TEXT NOT NULL,
    transaction_id TEXT,
    created_at TEXT NOT NULL,
    details_json TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL,
    hcs_status TEXT NOT NULL DEFAULT 'PENDING',
    hcs_sequence TEXT,
    hcs_consensus TEXT,
    hcs_error TEXT,
    UNIQUE (payment_id, seq)
);
CREATE TABLE IF NOT EXISTS leases (
    id TEXT PRIMARY KEY,
    payment_id TEXT NOT NULL UNIQUE,
    quote_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    offer_json TEXT NOT NULL,
    run_json TEXT,
    reconciliation_json TEXT,
    refund_json TEXT
);
`;

const json = (value) => (value === undefined || value === null ? null : JSON.stringify(value));
const parse = (text) => (text ? JSON.parse(text) : null);

function quoteFromRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        wallet: row.wallet,
        payTo: row.pay_to,
        offer: parse(row.offer_json),
        hours: row.hours,
        hourlyUsd: row.hourly_usd,
        estimateUsd: row.estimate_usd,
        capUsd: row.cap_usd,
        tinybars: row.tinybars,
        // The asset the amount is in. Quotes made before tokens existed have none, and are HBAR.
        asset: assetFromStored(parse(row.asset_json)),
        rate: parse(row.rate_json),
        termsHash: row.terms_hash,
        status: row.status,
    };
}

function paymentFromRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        quoteId: row.quote_id,
        wallet: row.wallet,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        decision: row.decision,
        decisionReasons: parse(row.decision_reasons) || [],
        capUsd: row.cap_usd,
        tinybars: row.tinybars,
        transactionId: row.transaction_id,
        settlement: parse(row.settlement_json),
        error: row.error,
        mode: row.mode,
    };
}

function approvalFromRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        paymentId: row.payment_id,
        status: row.status,
        message: row.message,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        decidedAt: row.decided_at,
        decidedBy: row.decided_by,
        method: row.method,
        signature: row.signature,
        consumed: Boolean(row.consumed),
    };
}

function leaseFromRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        paymentId: row.payment_id,
        quoteId: row.quote_id,
        status: row.status,
        createdAt: row.created_at,
        offer: parse(row.offer_json),
        run: parse(row.run_json),
        reconciliation: parse(row.reconciliation_json),
        refund: parse(row.refund_json),
    };
}

function eventFromRow(row) {
    return {
        id: row.id,
        paymentId: row.payment_id,
        seq: row.seq,
        eventType: row.event_type,
        status: row.status,
        transactionId: row.transaction_id,
        createdAt: row.created_at,
        details: parse(row.details_json) || {},
        prevHash: row.prev_hash,
        hash: row.hash,
        hcs: {
            status: row.hcs_status,
            sequence: row.hcs_sequence,
            consensusTimestamp: row.hcs_consensus,
            error: row.hcs_error,
        },
    };
}

/** SQLite-backed state so quotes, approvals and audit events survive a restart. */
class Store {
    constructor(dbPath = ":memory:") {
        if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
        this.db = new DatabaseSync(dbPath);
        this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
        this.db.exec(SCHEMA);
        this.migrate();
    }

    /** Adds columns that older database files lack. Safe to run on every start. */
    migrate() {
        const quoteColumns = this.db.prepare("PRAGMA table_info(quotes)").all().map((c) => c.name);
        if (!quoteColumns.includes("asset_json")) this.db.exec("ALTER TABLE quotes ADD COLUMN asset_json TEXT");
    }

    close() {
        this.db.close();
    }

    /** Runs fn inside one transaction, rolling back if it throws. */
    transaction(fn) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const result = fn();
            this.db.exec("COMMIT");
            return result;
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }

    // ---- quotes
    insertQuote(q) {
        this.db
            .prepare(
                `INSERT INTO quotes (id, created_at, expires_at, wallet, pay_to, offer_json, hours, hourly_usd,
                    estimate_usd, cap_usd, tinybars, rate_json, terms_hash, status, asset_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)`,
            )
            .run(q.id, q.createdAt, q.expiresAt, q.wallet, q.payTo, json(q.offer), q.hours, q.hourlyUsd,
                q.estimateUsd, q.capUsd, String(q.tinybars), json(q.rate), q.termsHash, json(q.asset ? storableAsset(q.asset) : null));
        return this.getQuote(q.id);
    }

    getQuote(id) {
        return quoteFromRow(this.db.prepare("SELECT * FROM quotes WHERE id = ?").get(id));
    }

    markQuoteUsed(id) {
        const result = this.db.prepare("UPDATE quotes SET status = 'USED' WHERE id = ? AND status = 'OPEN'").run(id);
        return result.changes === 1;
    }

    // ---- payments
    insertPayment(p) {
        this.db
            .prepare(
                `INSERT INTO payments (id, quote_id, wallet, status, created_at, updated_at, cap_usd, tinybars, mode)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(p.id, p.quoteId, p.wallet, p.status, p.createdAt, p.createdAt, p.capUsd, String(p.tinybars), p.mode);
        return this.getPayment(p.id);
    }

    getPayment(id) {
        return paymentFromRow(this.db.prepare("SELECT * FROM payments WHERE id = ?").get(id));
    }

    getPaymentByQuote(quoteId) {
        return paymentFromRow(this.db.prepare("SELECT * FROM payments WHERE quote_id = ?").get(quoteId));
    }

    updatePayment(id, patch) {
        const columns = {
            status: "status",
            decision: "decision",
            decisionReasons: "decision_reasons",
            transactionId: "transaction_id",
            settlement: "settlement_json",
            error: "error",
        };
        const sets = ["updated_at = ?"];
        const values = [Date.now()];
        for (const [key, value] of Object.entries(patch)) {
            if (!columns[key]) throw new Error(`Unknown payment field '${key}'`);
            sets.push(`${columns[key]} = ?`);
            values.push(key === "decisionReasons" || key === "settlement" ? json(value) : value);
        }
        this.db.prepare(`UPDATE payments SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
        return this.getPayment(id);
    }

    /**
     * Moves a payment from one status to another only if it is still in the first. Returns false when
     * someone else moved it first, which is how a payment is made to be signed and settled only once.
     */
    transitionPayment(id, from, to, patch = {}) {
        const columns = { error: "error", transactionId: "transaction_id", settlement: "settlement_json" };
        const sets = ["status = ?", "updated_at = ?"];
        const values = [to, Date.now()];
        for (const [key, value] of Object.entries(patch)) {
            if (!columns[key]) throw new Error(`Unknown payment field '${key}'`);
            sets.push(`${columns[key]} = ?`);
            values.push(key === "settlement" ? json(value) : value);
        }
        const result = this.db.prepare(`UPDATE payments SET ${sets.join(", ")} WHERE id = ? AND status = ?`).run(...values, id, from);
        return result.changes === 1;
    }

    listPayments(wallet, limit = 50) {
        return this.db
            .prepare("SELECT * FROM payments WHERE wallet = ? ORDER BY created_at DESC LIMIT ?")
            .all(wallet, limit)
            .map(paymentFromRow);
    }

    /** Payments in these statuses at startup were interrupted mid-flight. */
    listByStatus(statuses) {
        const marks = statuses.map(() => "?").join(", ");
        return this.db.prepare(`SELECT * FROM payments WHERE status IN (${marks})`).all(...statuses).map(paymentFromRow);
    }

    /** USD committed by a wallet since a time, counting only payments that hold or may hold money. */
    committedUsdSince(wallet, sinceMs) {
        const marks = COMMITTED.map(() => "?").join(", ");
        const row = this.db
            .prepare(
                `SELECT COALESCE(SUM(cap_usd), 0) AS total FROM payments
                 WHERE wallet = ? AND created_at >= ? AND status IN (${marks})`,
            )
            .get(wallet, sinceMs, ...COMMITTED);
        return row.total;
    }

    /** USD committed by everyone since a time. */
    committedUsdSinceGlobal(sinceMs) {
        const marks = COMMITTED.map(() => "?").join(", ");
        const row = this.db
            .prepare(`SELECT COALESCE(SUM(cap_usd), 0) AS total FROM payments WHERE created_at >= ? AND status IN (${marks})`)
            .get(sinceMs, ...COMMITTED);
        return row.total;
    }

    // ---- approvals
    insertApproval(a) {
        this.db
            .prepare(
                `INSERT INTO approvals (id, payment_id, status, message, created_at, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(a.id, a.paymentId, a.status, a.message, a.createdAt, a.expiresAt);
        return this.getApproval(a.id);
    }

    getApproval(id) {
        return approvalFromRow(this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id));
    }

    getApprovalByPayment(paymentId) {
        return approvalFromRow(this.db.prepare("SELECT * FROM approvals WHERE payment_id = ?").get(paymentId));
    }

    /** Moves a pending approval to a decision. Returns false when it was no longer pending. */
    decideApproval(id, { status, decidedBy, method, signature }) {
        const result = this.db
            .prepare(
                `UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, method = ?, signature = ?
                 WHERE id = ? AND status = 'PENDING'`,
            )
            .run(status, Date.now(), decidedBy || null, method || null, signature || null, id);
        return result.changes === 1;
    }

    expireApproval(id) {
        const result = this.db.prepare("UPDATE approvals SET status = 'EXPIRED' WHERE id = ? AND status = 'PENDING'").run(id);
        return result.changes === 1;
    }

    /** Marks an approved approval as used. Returns false if it was already used, so a replay fails. */
    consumeApproval(id) {
        const result = this.db
            .prepare("UPDATE approvals SET consumed = 1 WHERE id = ? AND status = 'APPROVED' AND consumed = 0")
            .run(id);
        return result.changes === 1;
    }

    listPendingApprovals() {
        return this.db.prepare("SELECT * FROM approvals WHERE status = 'PENDING'").all().map(approvalFromRow);
    }

    // ---- audit
    lastAuditEvent(paymentId) {
        const row = this.db
            .prepare("SELECT * FROM audit_events WHERE payment_id = ? ORDER BY seq DESC LIMIT 1")
            .get(paymentId);
        return row ? eventFromRow(row) : null;
    }

    insertAuditEvent(e) {
        this.db
            .prepare(
                `INSERT INTO audit_events (payment_id, seq, event_type, status, transaction_id, created_at,
                    details_json, prev_hash, hash, hcs_status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(e.paymentId, e.seq, e.eventType, e.status, e.transactionId || null, e.createdAt,
                json(e.details || {}), e.prevHash, e.hash, e.hcsStatus || "PENDING");
    }

    listAuditEvents(paymentId) {
        return this.db
            .prepare("SELECT * FROM audit_events WHERE payment_id = ? ORDER BY seq ASC")
            .all(paymentId)
            .map(eventFromRow);
    }

    updateAuditHcs(paymentId, seq, { status, sequence, consensus, error }) {
        this.db
            .prepare(
                `UPDATE audit_events SET hcs_status = ?, hcs_sequence = ?, hcs_consensus = ?, hcs_error = ?
                 WHERE payment_id = ? AND seq = ?`,
            )
            .run(status, sequence || null, consensus || null, error || null, paymentId, seq);
    }

    /** Events posted to the topic but not yet read back from the mirror node. */
    listUnconfirmedAuditEvents() {
        return this.db
            .prepare("SELECT * FROM audit_events WHERE hcs_status IN ('PUBLISHED', 'UNCONFIRMED') ORDER BY id ASC")
            .all()
            .map(eventFromRow);
    }

    listUnpublishedAuditEvents() {
        return this.db
            .prepare("SELECT * FROM audit_events WHERE hcs_status = 'PENDING' ORDER BY id ASC")
            .all()
            .map(eventFromRow);
    }

    // ---- leases
    insertLease(l) {
        this.db
            .prepare(
                `INSERT INTO leases (id, payment_id, quote_id, status, created_at, offer_json)
                 VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(l.id, l.paymentId, l.quoteId, l.status, l.createdAt, json(l.offer));
        return this.getLease(l.id);
    }

    getLease(id) {
        return leaseFromRow(this.db.prepare("SELECT * FROM leases WHERE id = ?").get(id));
    }

    getLeaseByPayment(paymentId) {
        return leaseFromRow(this.db.prepare("SELECT * FROM leases WHERE payment_id = ?").get(paymentId));
    }

    /** Takes an active lease for ending. Returns false if another caller already took it. */
    claimLease(id, from = "ACTIVE") {
        const result = this.db.prepare("UPDATE leases SET status = 'ENDING' WHERE id = ? AND status = ?").run(id, from);
        return result.changes === 1;
    }

    listLeasesByStatus(status) {
        return this.db.prepare("SELECT * FROM leases WHERE status = ?").all(status).map(leaseFromRow);
    }

    updateLease(id, patch) {
        const columns = { status: "status", run: "run_json", reconciliation: "reconciliation_json", refund: "refund_json" };
        const sets = [];
        const values = [];
        for (const [key, value] of Object.entries(patch)) {
            if (!columns[key]) throw new Error(`Unknown lease field '${key}'`);
            sets.push(`${columns[key]} = ?`);
            values.push(key === "status" ? value : json(value));
        }
        this.db.prepare(`UPDATE leases SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
        return this.getLease(id);
    }
}

module.exports = { Store, PaymentStatus };
