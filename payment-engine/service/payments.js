"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { describeSignedTransaction, saveRejectedPayment } = require("./tx-diagnostic");
const { PaymentStatus, ApprovalStatus, IN_FLIGHT } = require("./states");
const { ApprovalError } = require("./approvals");
const { tinybarsToHbarString } = require("./rate");
const { checkWalletPayload } = require("./payload-check");
const { transactionLinks, topicLinks, accountLinks } = require("./links");
const { secondsToCap } = require("./metering");

class PaymentError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = "PaymentError";
        this.code = code;
        this.status = status;
    }
}

/**
 * Runs one payment from quote to lease. The flow follows docs/x402-agent-workflow.md and
 * docs/testnet-wallet-payments.md.
 *
 * Two ways to pay, chosen by configuration:
 *   agent   a server-held key pays (simulated development only)
 *   wallet  the user's wallet signs the exact x402 payment (the only mode allowed on testnet)
 *
 * Either way: policy check, optional human approval, payment, independent verification against the
 * ledger, and only then a lease. Every step is stored and written to the audit log.
 */
class PaymentService {
    constructor({ config, store, policy, approvals, audit, agent, relay, verifier, leases, knownFeePayers, topicId = () => null, now = Date.now }) {
        this.config = config;
        this.store = store;
        this.policy = policy;
        this.approvals = approvals;
        this.audit = audit;
        this.agent = agent;
        this.relay = relay;
        this.verifier = verifier;
        this.leases = leases;
        this.knownFeePayers = knownFeePayers;
        this.topicId = topicId;
        this.now = now;
        this.running = new Set();
    }

    get walletMode() {
        return this.config.payer.mode === "wallet";
    }

    // ---- starting a payment

    /** Starts a payment for a quote. Calling it again for the same quote returns the same payment. */
    start({ quoteId }) {
        const quote = this.store.getQuote(quoteId);
        if (!quote) throw new PaymentError("QUOTE_NOT_FOUND", "Quote not found", 404);

        const existing = this.store.getPaymentByQuote(quoteId);
        if (existing) return this.view(existing.id);

        if (this.now() >= quote.expiresAt) throw new PaymentError("QUOTE_EXPIRED", "This quote has expired. Request a new one.", 410);

        let payment;
        try {
            payment = this.store.insertPayment({
                id: "pay_" + crypto.randomBytes(12).toString("hex"),
                quoteId: quote.id,
                wallet: quote.wallet,
                status: PaymentStatus.RECEIVED,
                createdAt: this.now(),
                capUsd: quote.capUsd,
                tinybars: quote.tinybars,
                mode: this.config.mode,
            });
        } catch (error) {
            // Two requests for one quote at once: the second finds the first.
            const raced = this.store.getPaymentByQuote(quoteId);
            if (raced) return this.view(raced.id);
            throw error;
        }
        this.store.markQuoteUsed(quote.id);
        this.audit.append({
            paymentId: payment.id, eventType: "PAYMENT_RECEIVED", status: payment.status,
            details: {
                quoteId: quote.id, wallet: quote.wallet, payTo: quote.payTo, capUsd: quote.capUsd,
                tinybars: quote.tinybars, mode: this.config.mode, payer: this.config.payer.mode,
            },
        });

        // Everything from here to the status change is synchronous, so two payments
        // started together cannot both slip under a limit.
        const decision = this.policy.evaluate({ capUsd: quote.capUsd, payTo: quote.payTo, wallet: quote.wallet });
        this.store.updatePayment(payment.id, { decision: decision.decision, decisionReasons: decision.reasons });
        this.audit.append({
            paymentId: payment.id, eventType: "POLICY_EVALUATED", status: PaymentStatus.POLICY_CHECKED,
            details: {
                decision: decision.decision, reasons: decision.reasons, limits: decision.limits,
                committedTodayUsd: decision.committedTodayUsd, capUsd: quote.capUsd,
            },
        });

        if (decision.decision === "refuse") {
            this.move(payment.id, PaymentStatus.REFUSED, { error: decision.reasons.join("; ") },
                { type: "PAYMENT_REFUSED", details: { reasons: decision.reasons } });
        } else if (decision.decision === "approval") {
            const approval = this.approvals.create({ payment, quote });
            this.move(payment.id, PaymentStatus.PENDING_APPROVAL, {},
                { type: "HUMAN_APPROVAL_REQUESTED", details: { approvalId: approval.id, expiresAt: new Date(approval.expiresAt).toISOString(), reasons: decision.reasons } });
        } else {
            this.move(payment.id, PaymentStatus.APPROVED, {}, { type: "AUTO_APPROVED", details: { capUsd: quote.capUsd } });
            this.proceed(payment.id);
        }
        return this.view(payment.id);
    }

    /**
     * Policy and approval are done. In wallet mode the payment now waits for the user's wallet to sign
     * it, and nothing moves until it does. In agent mode the server's agent pays.
     */
    proceed(paymentId) {
        if (!this.walletMode) return this.schedule(paymentId);
        const payment = this.store.getPayment(paymentId);
        const quote = this.store.getQuote(payment.quoteId);
        this.move(paymentId, PaymentStatus.AWAITING_SIGNATURE, {}, {
            type: "WALLET_SIGNATURE_REQUESTED",
            details: { wallet: quote.wallet, payTo: quote.payTo, tinybars: quote.tinybars, signBy: new Date(quote.expiresAt).toISOString() },
        });
        return null;
    }

    // ---- human approval

    async decideApproval({ approvalId, decision, wallet, signature = null, signatureMap = null }) {
        const approval = this.approvals.get(approvalId);
        if (!approval) throw new ApprovalError("NOT_FOUND", "Approval not found", 404);
        const payment = this.store.getPayment(approval.paymentId);
        const quote = this.store.getQuote(payment.quoteId);

        let decided;
        try {
            decided = await this.approvals.decide({ approvalId, decision, wallet, quote, signature, signatureMap });
        } catch (error) {
            if (error instanceof ApprovalError && error.code === "EXPIRED") this.expirePending(payment.id);
            throw error;
        }

        if (decided.status === ApprovalStatus.APPROVED) {
            this.move(payment.id, PaymentStatus.APPROVED, {},
                { type: "HUMAN_APPROVAL_GRANTED", details: { approvalId, method: decided.method, decidedBy: decided.decidedBy } });
            this.proceed(payment.id);
        } else {
            this.move(payment.id, PaymentStatus.REJECTED, { error: "Rejected by the wallet owner" },
                { type: "HUMAN_APPROVAL_REJECTED", details: { approvalId, decidedBy: decided.decidedBy } });
        }
        return this.view(payment.id);
    }

    /** Moves payments whose approval, or whose wallet signature window, ran out of time to EXPIRED. */
    sweepExpired() {
        for (const approval of this.store.listPendingApprovals()) {
            const refreshed = this.approvals.refresh(approval);
            if (refreshed.status === ApprovalStatus.EXPIRED) this.expirePending(refreshed.paymentId);
        }
        for (const payment of this.store.listByStatus([PaymentStatus.AWAITING_SIGNATURE])) {
            const quote = this.store.getQuote(payment.quoteId);
            if (this.now() >= quote.expiresAt) {
                this.move(payment.id, PaymentStatus.EXPIRED, { error: "The payment was not signed in time" },
                    { type: "SIGNATURE_WINDOW_EXPIRED", details: {} });
            }
        }
    }

    expirePending(paymentId) {
        const payment = this.store.getPayment(paymentId);
        if (payment && payment.status === PaymentStatus.PENDING_APPROVAL) {
            this.move(paymentId, PaymentStatus.EXPIRED, { error: "The approval was not given in time" },
                { type: "HUMAN_APPROVAL_EXPIRED", details: {} });
        }
    }

    // ---- wallet mode: the user's wallet signs the exact payment

    /** Everything the wallet needs to build and sign the payment, and what the user was quoted. */
    async getRequirements(paymentId) {
        const { payment, quote } = this.requireWalletPayment(paymentId);
        const required = await this.relay.requirements({ quote, payment });
        return {
            paymentId,
            required,
            expected: { payTo: quote.payTo, tinybars: quote.tinybars },
            wallet: quote.wallet,
            memo: "gpu4u:" + quote.id,
            expiresAt: quote.expiresAt,
        };
    }

    /**
     * Receives the payment the wallet signed. It is relayed to the facilitator only if it is exactly the
     * payment this quote asked for. A payment that fails these checks stays unsigned and can be retried.
     */
    async submitSigned(paymentId, { paymentPayload }) {
        const { payment, quote } = this.requireWalletPayment(paymentId);

        if (payment.decision === "approval") {
            const approval = this.approvals.getByPayment(paymentId);
            if (!approval || approval.status !== ApprovalStatus.APPROVED || approval.consumed) {
                throw new PaymentError("NOT_APPROVED", "This payment needs the owner's approval before it can be signed", 409);
            }
        }

        const required = await this.relay.requirements({ quote, payment });
        const check = checkWalletPayload({ payload: paymentPayload, required, quote, knownFeePayers: await this.knownFeePayers() });
        if (check.problems.length) {
            this.audit.append({ paymentId, eventType: "SIGNED_PAYMENT_REJECTED", status: payment.status, details: { problems: check.problems } });
            throw new PaymentError("PAYLOAD_REJECTED", "The signed payment was not accepted: " + check.problems.join("; "), 422);
        }

        // Claim the payment: only one signed payment can ever be settled for it.
        if (!this.store.transitionPayment(paymentId, PaymentStatus.AWAITING_SIGNATURE, PaymentStatus.SIGNING)) {
            throw new PaymentError("ALREADY_SUBMITTED", "A signed payment was already submitted for this payment", 409);
        }
        const approval = this.approvals.getByPayment(paymentId);
        if (approval && !this.approvals.consume(approval.id)) {
            this.fail(paymentId, "This approval has already been used", "APPROVAL_ALREADY_USED");
            return this.view(paymentId);
        }
        this.audit.append({
            paymentId, eventType: "PAYMENT_SIGNED_BY_WALLET", status: PaymentStatus.SIGNING,
            transactionId: check.transactionId,
            details: { payer: quote.wallet, payTo: quote.payTo, tinybars: quote.tinybars },
        });

        this.track(this.settleSigned(paymentId, paymentPayload));
        return this.view(paymentId);
    }

    requireWalletPayment(paymentId) {
        if (!this.walletMode) throw new PaymentError("NOT_WALLET_MODE", "This service does not take wallet-signed payments", 409);
        const payment = this.store.getPayment(paymentId);
        if (!payment) throw new PaymentError("NOT_FOUND", "Payment not found", 404);
        if (payment.status !== PaymentStatus.AWAITING_SIGNATURE) {
            throw new PaymentError("NOT_AWAITING_SIGNATURE", `This payment is ${payment.status}, not waiting for a signature`, 409);
        }
        const quote = this.store.getQuote(payment.quoteId);
        if (this.now() >= quote.expiresAt) {
            this.move(paymentId, PaymentStatus.EXPIRED, { error: "The payment was not signed in time" },
                { type: "SIGNATURE_WINDOW_EXPIRED", details: {} });
            throw new PaymentError("QUOTE_EXPIRED", "This quote expired before the payment was signed. Request a new one.", 410);
        }
        return { payment, quote };
    }

    async settleSigned(paymentId, paymentPayload) {
        try {
            const payment = this.store.getPayment(paymentId);
            const quote = this.store.getQuote(payment.quoteId);

            let result;
            try {
                result = await this.relay.submit({ quote, payment, paymentPayload });
            } catch (error) {
                this.recordRejectedPayment(paymentId, paymentPayload, error);
                return this.fail(paymentId, error.message, "WALLET_PAYMENT_FAILED");
            }
            return await this.verifyAndActivate(paymentId, quote, result, quote.wallet);
        } catch (error) {
            return this.fail(paymentId, error.message, "PAYMENT_ERROR");
        }
    }

    /** When a wallet-signed payment is rejected, records what the wallet produced so the cause can be found. */
    recordRejectedPayment(paymentId, paymentPayload, error) {
        try {
            const transaction = paymentPayload && paymentPayload.payload && paymentPayload.payload.transaction;
            if (typeof transaction !== "string") return;
            const described = describeSignedTransaction(transaction);
            const dbPath = this.config.dbPath || "./data/payments.sqlite";
            const file = dbPath === ":memory:" ? null : saveRejectedPayment(path.join(path.dirname(dbPath), "rejected"), paymentId, {
                paymentId, reason: error.message, described, accepted: paymentPayload.accepted, transaction,
            });
            console.error("[service] rejected wallet payment " + paymentId + ": " + error.message);
            console.error("[service] what the wallet returned: " + JSON.stringify(described));
            if (file) console.error("[service] saved to " + file);
        } catch (diagnosticError) {
            console.error("[service] could not describe the rejected payment: " + diagnosticError.message);
        }
    }

    // ---- agent mode: a server-held key pays (simulated development only)

    schedule(paymentId) {
        this.track(this.run(paymentId).catch((error) => this.fail(paymentId, error.message, "PAYMENT_ERROR")));
    }

    track(task) {
        const wrapped = task.finally(() => this.running.delete(wrapped));
        this.running.add(wrapped);
    }

    /** Waits for every payment currently running. Used by tests and graceful shutdown. */
    async idle() {
        while (this.running.size) await Promise.allSettled([...this.running]);
    }

    async run(paymentId) {
        if (!this.agent) return this.fail(paymentId, "No agent is configured for this mode", "NO_AGENT");
        const payment = this.store.getPayment(paymentId);
        if (!payment || payment.status !== PaymentStatus.APPROVED) return null;
        const quote = this.store.getQuote(payment.quoteId);

        // An approval pays once. A second run for the same approval is refused.
        const approval = this.approvals.getByPayment(paymentId);
        if (approval && !this.approvals.consume(approval.id)) {
            return this.fail(paymentId, "This approval has already been used", "APPROVAL_ALREADY_USED");
        }
        if (this.now() >= quote.expiresAt) {
            return this.move(paymentId, PaymentStatus.EXPIRED, { error: "The quote expired before payment" },
                { type: "QUOTE_EXPIRED", details: {} });
        }

        this.move(paymentId, PaymentStatus.AWAITING_402, {},
            { type: "AGENT_REQUESTING_LEASE", details: { payTo: quote.payTo, tinybars: quote.tinybars } });

        let result;
        try {
            result = await this.agent.pay({
                payment, quote,
                onEvent: (event) => {
                    if (event.type === "TERMS_ACCEPTED" || event.type === "TERMS_REJECTED") {
                        const { type, ...details } = event;
                        this.audit.append({
                            paymentId, eventType: "AGENT_" + type, status: this.store.getPayment(paymentId).status, details,
                        });
                    }
                },
                onSigned: async () => {
                    this.move(paymentId, PaymentStatus.SIGNING, {},
                        { type: "PAYMENT_SIGNED", details: { payer: this.agent.accountId } });
                },
            });
        } catch (error) {
            const code = error.code === "TERMS_REJECTED" ? "AGENT_REJECTED_TERMS" : "AGENT_PAYMENT_FAILED";
            return this.fail(paymentId, error.message, code, error.details);
        }
        return this.verifyAndActivate(paymentId, quote, result, this.agent.accountId);
    }

    // ---- shared: verify against the ledger, and only then create the lease

    async verifyAndActivate(paymentId, quote, result, payerAccountId) {
        this.move(paymentId, PaymentStatus.SUBMITTED,
            { transactionId: result.transactionId, settlement: { facilitator: result.settlement, payer: payerAccountId } },
            { type: "PAYMENT_SETTLED_BY_FACILITATOR", details: { network: result.network }, transactionId: result.transactionId });

        // Do not trust the facilitator's answer: read the transaction back from the ledger.
        const verification = await this.verifier.verify({
            transactionId: result.transactionId,
            payer: payerAccountId,
            payTo: quote.payTo,
            tinybars: quote.tinybars,
            feePayers: await this.knownFeePayers(),
        });
        if (!verification.verified) {
            return this.fail(
                paymentId,
                "Settlement could not be verified: " + verification.problems.join("; ") + ". If money moved, check transaction " + result.transactionId + ".",
                "SETTLEMENT_VERIFICATION_FAILED",
                { problems: verification.problems },
            );
        }

        this.move(paymentId, PaymentStatus.CONFIRMED,
            { settlement: { facilitator: result.settlement, payer: payerAccountId, ...verification } },
            { type: "SETTLEMENT_VERIFIED", transactionId: result.transactionId,
              details: { consensusTimestamp: verification.consensusTimestamp, feePayer: verification.feePayer, tinybars: quote.tinybars, payer: payerAccountId } });

        // The lease exists only now, after the payment was confirmed on the ledger.
        const lease = this.leases.create({ payment: this.store.getPayment(paymentId), quote });
        this.move(paymentId, PaymentStatus.LEASE_ACTIVE, {},
            { type: "LEASE_CREATED", details: { leaseId: lease.id, startedAt: new Date(lease.createdAt).toISOString() } });
        return null;
    }

    // ---- ending the lease (the payment is final, nothing is refunded)

    /** Ends the lease now and bills the time it was held. */
    async endLease(paymentId) {
        const { payment, quote } = this.loadForLease(paymentId);
        const result = await this.leases.end({ payment, quote });
        return this.finishLease(paymentId, result);
    }

    /**
     * Ends the lease with a reported usage. Only simulated development uses this. In wallet mode a lease ends
     * by its own clock, because a caller who could name the usage could end a paid lease at any cost.
     */
    async completeLease(paymentId, usage) {
        if (this.walletMode) {
            throw new PaymentError("NOT_ALLOWED", "In wallet mode a lease is ended by its clock, not with a reported usage", 409);
        }
        const { payment, quote } = this.loadForLease(paymentId);
        const result = await this.leases.complete({ payment, quote, ...usage });
        return this.finishLease(paymentId, result);
    }

    loadForLease(paymentId) {
        const payment = this.store.getPayment(paymentId);
        if (!payment) throw new PaymentError("NOT_FOUND", "Payment not found", 404);
        return { payment, quote: this.store.getQuote(payment.quoteId) };
    }

    finishLease(paymentId, result) {
        if (result.settled && !result.alreadyReconciled) {
            this.move(paymentId, PaymentStatus.RECONCILED, {}, {
                type: "PAYMENT_RECONCILED",
                details: { billedTinybars: result.reconciliation.billedTinybars, refundPolicy: "none" },
            });
        }
        return this.view(paymentId);
    }

    /**
     * Ends any lease that has used up its cap. Billing can never pass the cap, so a lease that reaches it
     * is closed instead of running on.
     */
    async sweepLeases() {
        if (!this.walletMode) return 0;
        let ended = 0;
        for (const lease of this.store.listLeasesByStatus("ACTIVE")) {
            const payment = this.store.getPayment(lease.paymentId);
            if (!payment || payment.status !== PaymentStatus.LEASE_ACTIVE) continue;
            const quote = this.store.getQuote(payment.quoteId);
            const capMs = secondsToCap({ hourlyUsd: quote.hourlyUsd, capUsd: quote.capUsd }) * 1000;
            if (this.now() - lease.createdAt >= capMs) {
                try {
                    await this.endLease(payment.id);
                    ended++;
                } catch (error) {
                    if (error.code !== "BUSY") console.error("[service] could not end lease " + lease.id + ": " + error.message);
                }
            }
        }
        return ended;
    }

    // ---- state helpers

    move(paymentId, status, patch = {}, event = null) {
        const updated = this.store.updatePayment(paymentId, { status, ...patch });
        if (event) {
            this.audit.append({
                paymentId, eventType: event.type, status,
                transactionId: event.transactionId || updated.transactionId || null,
                details: event.details || {},
            });
        }
        return updated;
    }

    fail(paymentId, message, eventType, details = {}) {
        const payment = this.store.getPayment(paymentId);
        if (!payment) return null;
        return this.move(paymentId, PaymentStatus.FAILED, { error: message }, { type: eventType, details: { error: message, ...details } });
    }

    /**
     * Payments caught mid-flight by a restart cannot be resumed safely, because a payment may already
     * have been signed or settled. They are failed with a clear note so nothing pays twice. Pending
     * approvals and payments still waiting for a signature survive. A lease caught mid-end is closed.
     */
    recover() {
        const interrupted = this.store.listByStatus(IN_FLIGHT);
        for (const payment of interrupted) {
            this.fail(
                payment.id,
                "The service restarted while this payment was in progress. If money moved, check the transaction on the ledger.",
                "PAYMENT_INTERRUPTED",
            );
        }
        let leases = 0;
        for (const lease of this.store.listLeasesByStatus("ENDING")) {
            this.store.updateLease(lease.id, { status: "ACTIVE" });
            this.audit.append({ paymentId: lease.paymentId, eventType: "LEASE_INTERRUPTED", status: PaymentStatus.LEASE_ACTIVE, details: {} });
            leases++;
        }
        return interrupted.length + leases;
    }

    // ---- reading

    view(paymentId) {
        let payment = this.store.getPayment(paymentId);
        if (!payment) throw new PaymentError("NOT_FOUND", "Payment not found", 404);
        if (payment.status === PaymentStatus.PENDING_APPROVAL) {
            const waiting = this.approvals.getByPayment(paymentId);
            if (waiting && waiting.status === ApprovalStatus.EXPIRED) {
                this.expirePending(paymentId);
                payment = this.store.getPayment(paymentId);
            }
        }
        const quote = this.store.getQuote(payment.quoteId);
        const approval = this.approvals.getByPayment(paymentId);
        const lease = this.store.getLeaseByPayment(paymentId);
        return {
            payment,
            quote: { ...quote, hbar: tinybarsToHbarString(quote.tinybars) },
            approval: approval ? { ...approval, signature: undefined } : null,
            lease,
            events: this.audit.list(paymentId),
            chain: this.audit.verifyChain(paymentId),
            links: this.linksFor(payment, lease),
            payerMode: this.config.payer.mode,
            serverTime: this.now(),
        };
    }

    /** Where a person can check each transaction on the public ledger. Null for simulated payments. */
    linksFor(payment, lease) {
        const simulated = this.config.simulated;
        const mirrorUrl = this.config.hedera.mirrorUrl;
        const settlement = payment.settlement || {};
        return {
            payment: transactionLinks({ transactionId: payment.transactionId, consensusTimestamp: settlement.consensusTimestamp, simulated, mirrorUrl }),
            topic: topicLinks({ topicId: this.topicId(), simulated, mirrorUrl }),
            wallet: accountLinks({ accountId: payment.wallet, simulated }),
        };
    }

    /** The final receipt: what was paid, what was used, and how to check each on the ledger. */
    receipt(paymentId) {
        const view = this.view(paymentId);
        const { payment, quote, lease, events } = view;
        const settlement = payment.settlement || {};
        const reconciliation = lease && lease.reconciliation;
        const anchors = { published: 0, confirmed: 0, failed: 0, local: 0 };
        for (const event of events) {
            const s = event.hcs.status;
            if (s === "CONFIRMED") anchors.confirmed++;
            else if (s === "PUBLISHED" || s === "UNCONFIRMED") anchors.published++;
            else if (s === "FAILED" || s === "MISMATCH") anchors.failed++;
            else anchors.local++;
        }
        return {
            receiptVersion: 1,
            generatedAt: new Date(this.now()).toISOString(),
            complete: payment.status === PaymentStatus.RECONCILED,
            status: payment.status,
            mode: payment.mode,
            simulated: payment.mode === "simulated",
            network: this.config.hedera.network,
            payer: { wallet: payment.wallet, mode: this.config.payer.mode },
            merchant: quote.payTo,
            offer: quote.offer,
            quote: {
                id: quote.id,
                estimateUsd: quote.estimateUsd,
                capUsd: quote.capUsd,
                hourlyUsd: quote.hourlyUsd,
                paidTinybars: quote.tinybars,
                paidHbar: view.quote.hbar,
                rate: quote.rate,
            },
            payment: {
                transactionId: payment.transactionId,
                consensusTimestamp: settlement.consensusTimestamp || null,
                feePayer: settlement.feePayer || null,
                verifiedOnLedger: Boolean(settlement.verified),
                links: view.links.payment,
            },
            lease: lease ? {
                id: lease.id,
                status: lease.status,
                startedAt: new Date(lease.createdAt).toISOString(),
                billingBasis: reconciliation ? reconciliation.billingBasis : null,
                billingNote: reconciliation ? reconciliation.billingNote : null,
                billedHbar: reconciliation ? reconciliation.billedHbar : null,
                billedUsd: reconciliation ? reconciliation.actualUsd : null,
                billedSeconds: lease.run && lease.run.billedSeconds != null ? lease.run.billedSeconds : null,
                runStatus: reconciliation ? reconciliation.runStatus : null,
            } : null,
            refund: { policy: "none", note: "Payments are final. Nothing is refunded when a lease ends." },
            audit: {
                events: events.length,
                chainIntact: view.chain.valid,
                anchors,
                topic: { id: this.topicId(), links: view.links.topic },
            },
        };
    }
}

module.exports = { PaymentService, PaymentError };
