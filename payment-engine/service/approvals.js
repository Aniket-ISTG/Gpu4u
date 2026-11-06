"use strict";

const crypto = require("node:crypto");
const { ApprovalStatus } = require("./states");
const { verifyWalletSignature } = require("./wallet-signature");
const { tinybarsToHbarString } = require("./rate");

class ApprovalError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = "ApprovalError";
        this.code = code;
        this.status = status;
    }
}

/** The exact text a person signs. It names every term that matters, so a signature cannot be reused. */
function approvalMessage({ payment, quote, approvalId, expiresAt }) {
    return [
        "GPU4U payment approval",
        `Approval: ${approvalId}`,
        `Quote: ${quote.id}`,
        `Payment: ${payment.id}`,
        `Wallet: ${quote.wallet}`,
        `Pay to: ${quote.payTo}`,
        `Amount: ${tinybarsToHbarString(quote.tinybars)} HBAR (${quote.tinybars} tinybars)`,
        `Cap: $${quote.capUsd.toFixed(2)} USD`,
        `GPU: ${quote.offer.gpuModel} x${quote.offer.gpuCount} from ${quote.offer.provider}`,
        `Terms: ${quote.termsHash.slice(0, 16)}`,
        `Expires: ${new Date(expiresAt).toISOString()}`,
    ].join("\n");
}

class ApprovalService {
    /**
     * @param {object} opts
     * @param {import("./store").Store} opts.store
     * @param {"click"|"wallet"} opts.mode  wallet requires a verified signature to approve
     * @param {(accountId:string)=>Promise<import("@hiero-ledger/sdk").PublicKey>} [opts.publicKeyResolver]
     */
    constructor({ store, mode, ttlMs, publicKeyResolver = null, now = Date.now }) {
        this.store = store;
        this.mode = mode;
        this.ttlMs = ttlMs;
        this.publicKeyResolver = publicKeyResolver;
        this.now = now;
    }

    /** Creates a pending approval that expires before the quote does. */
    create({ payment, quote }) {
        const id = `appr_${crypto.randomBytes(12).toString("hex")}`;
        const createdAt = this.now();
        const expiresAt = Math.min(createdAt + this.ttlMs, quote.expiresAt - 30_000);
        if (expiresAt <= createdAt) throw new ApprovalError("QUOTE_TOO_CLOSE_TO_EXPIRY", "The quote expires too soon to be approved");
        return this.store.insertApproval({
            id, paymentId: payment.id, status: ApprovalStatus.PENDING,
            message: approvalMessage({ payment, quote, approvalId: id, expiresAt }),
            createdAt, expiresAt,
        });
    }

    get(id) {
        return this.refresh(this.store.getApproval(id));
    }

    getByPayment(paymentId) {
        return this.refresh(this.store.getApprovalByPayment(paymentId));
    }

    /** Marks a pending approval expired once its time has passed. */
    refresh(approval) {
        if (approval && approval.status === ApprovalStatus.PENDING && this.now() >= approval.expiresAt) {
            this.store.expireApproval(approval.id);
            return this.store.getApproval(approval.id);
        }
        return approval;
    }

    /**
     * Records a decision. Returns the updated approval.
     * Approving in wallet mode needs a valid signature from the quote's wallet over the stored message.
     */
    async decide({ approvalId, decision, wallet, quote, signature = null, signatureMap = null }) {
        const approval = this.get(approvalId);
        if (!approval) throw new ApprovalError("NOT_FOUND", "Approval not found", 404);
        if (approval.status === ApprovalStatus.EXPIRED) throw new ApprovalError("EXPIRED", "This approval has expired", 410);
        if (approval.status !== ApprovalStatus.PENDING) throw new ApprovalError("ALREADY_DECIDED", `This approval is already ${approval.status.toLowerCase()}`, 409);
        if (wallet !== quote.wallet) throw new ApprovalError("WRONG_WALLET", "Only the wallet named in the quote can decide", 403);
        if (decision !== "approve" && decision !== "reject") throw new ApprovalError("BAD_DECISION", "Decision must be approve or reject");

        if (decision === "reject") {
            this.store.decideApproval(approvalId, { status: ApprovalStatus.REJECTED, decidedBy: wallet, method: "reject" });
            return this.store.getApproval(approvalId);
        }

        let method = "click";
        if (this.mode === "wallet") {
            if (!signature && !signatureMap) throw new ApprovalError("SIGNATURE_REQUIRED", "A wallet signature is required to approve", 401);
            if (!this.publicKeyResolver) throw new ApprovalError("NO_KEY_RESOLVER", "Wallet signatures cannot be verified on this server", 500);
            let publicKey;
            try {
                publicKey = await this.publicKeyResolver(wallet);
            } catch (error) {
                throw new ApprovalError("KEY_LOOKUP_FAILED", `Could not look up the wallet's key: ${error.message}`, 502);
            }
            if (!verifyWalletSignature({ message: approval.message, signatureMap, signature, publicKey })) {
                throw new ApprovalError("BAD_SIGNATURE", "The signature does not match this approval and wallet", 401);
            }
            method = "wallet-signature";
        }

        const stored = this.store.decideApproval(approvalId, {
            status: ApprovalStatus.APPROVED, decidedBy: wallet, method,
            signature: signature || signatureMap || null,
        });
        if (!stored) throw new ApprovalError("ALREADY_DECIDED", "This approval was decided at the same time by someone else", 409);
        return this.store.getApproval(approvalId);
    }

    /** Uses up an approval. A second attempt returns false, so an approval cannot pay twice. */
    consume(approvalId) {
        return this.store.consumeApproval(approvalId);
    }
}

module.exports = { ApprovalService, ApprovalError, approvalMessage };
