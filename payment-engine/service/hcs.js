"use strict";

const {
    Client,
    PrivateKey,
    TopicCreateTransaction,
    TopicMessageSubmitTransaction,
} = require("@hiero-ledger/sdk");
const { parsePrivateKey } = require("./keys");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Anchors audit events on a Hedera Consensus Service topic. Messages are compact and carry
 * the event hash, which commits to the full details held in the database, so anyone can
 * check the database against the public ledger. Publishing never blocks or fails a payment:
 * events queue in order, retry, and are marked FAILED if the network stays down.
 */
class HcsPublisher {
    constructor({
        store, accountId, privateKey, topicId = null, network = "testnet", retries = 3, retryDelayMs = 1500,
        clientFactory = null, log = console,
        // When a mirror node is given, every posted message is read back and compared to its event hash.
        mirrorUrl = null, fetchImpl = fetch, confirmRetries = 8, confirmDelayMs = 3000,
    }) {
        this.store = store;
        this.accountId = accountId;
        this.key = parsePrivateKey(privateKey);
        this.topicId = topicId;
        this.network = network;
        this.retries = retries;
        this.retryDelayMs = retryDelayMs;
        this.clientFactory = clientFactory;
        this.log = log;
        this.mirrorUrl = mirrorUrl ? mirrorUrl.replace(/\/$/, "") : null;
        this.fetchImpl = fetchImpl;
        this.confirmRetries = confirmRetries;
        this.confirmDelayMs = confirmDelayMs;
        this.client = null;
        this.chain = Promise.resolve();
    }

    getClient() {
        if (!this.client) {
            this.client = this.clientFactory
                ? this.clientFactory()
                : (this.network === "mainnet" ? Client.forMainnet() : Client.forTestnet());
            if (!this.clientFactory) this.client.setOperator(this.accountId, this.key);
        }
        return this.client;
    }

    /**
     * Creates the audit topic with a submit key, so only this service can write to it.
     * A topic with no submit key accepts messages from anyone, which would let a stranger
     * post fake audit entries.
     */
    async createTopic(memo = "GPU4U_Payment_Audit") {
        const client = this.getClient();
        const response = await new TopicCreateTransaction()
            .setTopicMemo(memo)
            .setSubmitKey(this.key.publicKey)
            .execute(client);
        const receipt = await response.getReceipt(client);
        this.topicId = receipt.topicId.toString();
        return this.topicId;
    }

    /** Sends one message to the topic and returns its sequence number. The only network call. */
    async submit(message) {
        if (!this.topicId) await this.createTopic();
        const client = this.getClient();
        const response = await new TopicMessageSubmitTransaction().setTopicId(this.topicId).setMessage(message).execute(client);
        const receipt = await response.getReceipt(client);
        return { sequence: receipt.topicSequenceNumber ? receipt.topicSequenceNumber.toString() : null };
    }

    /** One message from the topic, as the mirror node reports it. Null while it has not been ingested yet. */
    async fetchMessage(sequence) {
        const response = await this.fetchImpl(`${this.mirrorUrl}/api/v1/topics/${this.topicId}/messages/${sequence}`, {
            signal: AbortSignal.timeout(10000),
        });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`Mirror node returned HTTP ${response.status}`);
        return response.json();
    }

    /**
     * Reads a posted message back from the mirror node and compares it to the event. Marks it CONFIRMED when
     * the topic holds a message with this payment, sequence and hash, MISMATCH when it holds something else,
     * and UNCONFIRMED when it was not visible in time. UNCONFIRMED is retried by confirmPending().
     */
    async confirmEvent({ paymentId, seq, hash }, sequence) {
        for (let attempt = 1; attempt <= this.confirmRetries; attempt++) {
            let record = null;
            try {
                record = await this.fetchMessage(sequence);
            } catch {
                /* the mirror node is slow or down; try again */
            }
            if (record) {
                let message = null;
                try {
                    message = JSON.parse(Buffer.from(record.message, "base64").toString("utf8"));
                } catch {
                    /* not our JSON */
                }
                const matches = message && message.p === paymentId && message.s === seq && message.h === hash;
                this.store.updateAuditHcs(paymentId, seq, {
                    status: matches ? "CONFIRMED" : "MISMATCH",
                    sequence,
                    consensus: record.consensus_timestamp || null,
                    error: matches ? null : "The message on the topic does not match this event",
                });
                return matches ? "CONFIRMED" : "MISMATCH";
            }
            if (attempt < this.confirmRetries) await wait(this.confirmDelayMs);
        }
        this.store.updateAuditHcs(paymentId, seq, { status: "UNCONFIRMED", sequence, error: "Not yet visible on the mirror node" });
        return "UNCONFIRMED";
    }

    /** Re-checks every message that was posted but not yet confirmed. */
    async confirmPending() {
        if (!this.mirrorUrl) return { checked: 0 };
        const events = this.store.listUnconfirmedAuditEvents();
        let confirmed = 0;
        for (const e of events) {
            if (!e.hcs.sequence) continue;
            const outcome = await this.confirmEvent({ paymentId: e.paymentId, seq: e.seq, hash: e.hash }, e.hcs.sequence);
            if (outcome === "CONFIRMED") confirmed++;
        }
        return { checked: events.length, confirmed };
    }

    enqueue(event) {
        this.chain = this.chain.then(() => this.publish(event)).catch(() => {});
    }

    async flush() {
        await this.chain;
    }

    async publish(event) {
        const message = JSON.stringify({
            v: 2,
            p: event.paymentId,
            s: event.seq,
            e: event.eventType,
            st: event.status,
            tx: event.transactionId,
            ts: event.createdAt,
            ph: event.prevHash,
            h: event.hash,
        });

        let lastError = null;
        for (let attempt = 1; attempt <= this.retries; attempt++) {
            try {
                const { sequence } = await this.submit(message);
                this.store.updateAuditHcs(event.paymentId, event.seq, { status: "PUBLISHED", sequence, consensus: null });
                // Posting succeeded. Now check the ledger really holds this message.
                if (this.mirrorUrl && sequence) {
                    await this.confirmEvent({ paymentId: event.paymentId, seq: event.seq, hash: event.hash }, sequence).catch(() => {});
                }
                return;
            } catch (error) {
                lastError = error;
                if (attempt < this.retries) await wait(this.retryDelayMs * attempt);
            }
        }
        this.log.warn?.(`[hcs] could not publish ${event.paymentId}#${event.seq}: ${lastError?.message}`);
        this.store.updateAuditHcs(event.paymentId, event.seq, { status: "FAILED", error: lastError?.message || "unknown error" });
    }

    close() {
        try {
            this.client?.close();
        } catch {
            /* nothing to close */
        }
        this.client = null;
    }
}

module.exports = { HcsPublisher };
