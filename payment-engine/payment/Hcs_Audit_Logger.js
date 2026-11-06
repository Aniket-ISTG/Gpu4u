"use strict";

const {
    Client,
    PrivateKey,
    TopicCreateTransaction,
    TopicMessageSubmitTransaction
} = require("@hiero-ledger/sdk");

/**
 * HCS Audit Logger
 * Writes tamper-evident structured payment logs to Hedera Consensus Service (HCS).
 */
class HcsAuditLogger {
    constructor(options = {}) {
        this.topicId = options.topicId || process.env.HEDERA_HCS_TOPIC_ID || null;
        this.network = options.network || process.env.HEDERA_NETWORK || "testnet";
        this.operatorAccountId = options.operatorAccountId || process.env.HEDERA_ACCOUNT_ID || null;
        this.operatorPrivateKey = options.operatorPrivateKey || process.env.HEDERA_PRIVATE_KEY || null;
        this.enabled = options.enabled !== false; // Default true, can disable in tests
        this.inMemoryLogs = []; // In-memory buffer for verification & fallback
        this.client = null;
    }

    getClient() {
        if (!this.client && this.operatorAccountId && this.operatorPrivateKey) {
            try {
                this.client = Client.forTestnet();
                const key = PrivateKey.fromStringDer(this.operatorPrivateKey.trim());
                this.client.setOperator(this.operatorAccountId, key);
            } catch (err) {
                console.warn(`[HCS_LOGGER] Failed to initialize Hedera client: ${err.message}`);
                this.client = null;
            }
        }
        return this.client;
    }

    /**
     * Initializes or verifies the HCS Topic.
     */
    async ensureTopic() {
        if (this.topicId) {
            return this.topicId;
        }

        const client = this.getClient();
        if (!client) {
            console.warn("[HCS_LOGGER] No client available; topic creation skipped. Logs will be kept in memory.");
            return null;
        }

        try {
            console.log("[HCS_LOGGER] Creating new HCS topic for GPU Router Audit Trail...");
            const tx = await new TopicCreateTransaction()
                .setTopicMemo("GPU_Router_Payment_Audit_Trail")
                .execute(client);
            const receipt = await tx.getReceipt(client);
            this.topicId = receipt.topicId.toString();
            console.log(`[HCS_LOGGER] Topic created successfully: ${this.topicId}`);
            return this.topicId;
        } catch (err) {
            console.error(`[HCS_LOGGER] Failed to create HCS topic: ${err.message}`);
            return null;
        }
    }

    /**
     * Submits an audit event.
     * Guaranteed never to throw an unhandled exception that causes a settled payment to fail.
     */
    async logEvent({
        paymentId,
        requestId,
        eventType,
        status,
        transactionId = null,
        details = {}
    }) {
        const timestamp = new Date().toISOString();

        // Sanitize details: strictly strip any accidental sensitive keys
        const sanitizedDetails = { ...details };
        delete sanitizedDetails.privateKey;
        delete sanitizedDetails.recoveryPhrase;
        delete sanitizedDetails.mnemonic;
        delete sanitizedDetails.secret;

        const auditMessage = {
            version: "1.0",
            paymentId: paymentId || "N/A",
            requestId: requestId || "N/A",
            eventType,
            status,
            transactionId: transactionId || null,
            timestamp,
            details: sanitizedDetails
        };

        // Always save to in-memory log buffer
        this.inMemoryLogs.push(auditMessage);
        console.log(`[AUDIT_LOG] [${eventType}] Status: ${status} | Req: ${requestId} | Tx: ${transactionId || "None"}`);

        if (!this.enabled) {
            return {
                logged: true,
                target: "in-memory",
                message: auditMessage
            };
        }

        // Attempt HCS on-chain submission with retries
        let lastError = null;
        const maxRetries = 2;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const client = this.getClient();
                if (!client) {
                    break;
                }

                if (!this.topicId) {
                    await this.ensureTopic();
                }

                if (!this.topicId) {
                    break;
                }

                const messageJson = JSON.stringify(auditMessage);
                const submitTx = await new TopicMessageSubmitTransaction()
                    .setTopicId(this.topicId)
                    .setMessage(messageJson)
                    .execute(client);

                const receipt = await submitTx.getReceipt(client);
                const sequenceNumber = receipt.topicSequenceNumber ? receipt.topicSequenceNumber.toString() : null;

                return {
                    logged: true,
                    target: "hcs",
                    topicId: this.topicId,
                    sequenceNumber,
                    transactionId: submitTx.transactionId ? submitTx.transactionId.toString() : null,
                    message: auditMessage
                };
            } catch (err) {
                lastError = err;
                console.warn(`[HCS_LOGGER] Attempt ${attempt} failed to submit to HCS topic: ${err.message}`);
                if (attempt < maxRetries) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
        }

        // If HCS fails, log warning but DO NOT fail payment
        console.warn(`[HCS_LOGGER] Notice: Audit message preserved in-memory (HCS offline or timeout: ${lastError ? lastError.message : "No client"}). Payment flow continues safely.`);
        return {
            logged: true,
            target: "in-memory-fallback",
            error: lastError ? lastError.message : "No HCS client",
            message: auditMessage
        };
    }

    /**
     * Retrieves stored in-memory audit logs for verification.
     */
    getLogs(requestId = null) {
        if (!requestId) return [...this.inMemoryLogs];
        return this.inMemoryLogs.filter(l => l.requestId === requestId);
    }

    /**
     * Clears in-memory logs (for test teardown)
     */
    clearLogs() {
        this.inMemoryLogs = [];
    }

    close() {
        if (this.client) {
            try {
                this.client.close();
            } catch (_) {}
            this.client = null;
        }
    }
}

// Export singleton instance and class
const defaultLogger = new HcsAuditLogger();

module.exports = {
    HcsAuditLogger,
    defaultLogger
};

