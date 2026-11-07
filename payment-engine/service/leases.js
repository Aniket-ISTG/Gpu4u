"use strict";

const crypto = require("node:crypto");
const { PaymentStatus } = require("./states");
const { formatAmount } = require("./asset");
const { meterLease } = require("./metering");

class LeaseError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = "LeaseError";
        this.code = code;
        this.status = status;
    }
}

class LeaseService {
    constructor({ store, audit, verifier, merchantAccountId, now = Date.now }) {
        this.store = store;
        this.audit = audit;
        this.verifier = verifier;
        this.merchantAccountId = merchantAccountId;
        this.now = now;
    }

    /** Creates the lease once payment is confirmed. The lease clock starts here. */
    create({ payment, quote }) {
        const existing = this.store.getLeaseByPayment(payment.id);
        if (existing) return existing;
        return this.store.insertLease({
            id: "lease_" + crypto.randomBytes(10).toString("hex"),
            paymentId: payment.id,
            quoteId: quote.id,
            status: "ACTIVE",
            createdAt: this.now(),
            offer: {
                ...quote.offer,
                hours: quote.hours,
                hourlyUsd: quote.hourlyUsd,
                estimateUsd: quote.estimateUsd,
                capUsd: quote.capUsd,
                simulated: true,
            },
        });
    }

    /**
     * Ends the lease and bills the time it was held. The bill is the quoted hourly price times the
     * seconds elapsed, never more than the cap that was paid. This measures lease time, not GPU use.
     */
    async end({ payment, quote, endedAtMs = null }) {
        const lease = this.store.getLeaseByPayment(payment.id);
        if (!lease) throw new LeaseError("NO_LEASE", "This payment has no lease", 404);
        if (lease.reconciliation) return this.complete({ payment, quote });

        const endedAt = endedAtMs ?? this.now();
        const metered = meterLease({ hourlyUsd: quote.hourlyUsd, capUsd: quote.capUsd, startedAtMs: lease.createdAt, endedAtMs: endedAt });
        return this.complete({
            payment, quote,
            actualUsd: metered.actualUsd,
            actualDurationHours: metered.billedSeconds / 3600,
            status: metered.stoppedAtCap ? "stopped_at_cap" : "completed",
            basis: "lease-time",
            run: {
                source: "lease-time",
                startedAt: lease.createdAt,
                endedAt,
                elapsedSeconds: metered.elapsedSeconds,
                billedSeconds: metered.billedSeconds,
                capSeconds: metered.capSeconds,
                hourlyUsd: quote.hourlyUsd,
            },
        });
    }

    /**
     * Ends the lease with a given usage. The payment is final; 
     * nothing is refunded. Calling this
     * twice returns the first result.
     */
    async complete({ payment, quote, actualUsd, actualDurationHours, status = "completed", run = null, basis = "simulated" }) {
        const lease = this.store.getLeaseByPayment(payment.id);
        if (!lease) throw new LeaseError("NO_LEASE", "This payment has no lease", 404);
        if (lease.reconciliation) return { lease, reconciliation: lease.reconciliation, settled: lease.status === "RECONCILED", alreadyReconciled: true };
        if (payment.status !== PaymentStatus.LEASE_ACTIVE) {
            throw new LeaseError("NOT_ACTIVE", "The lease is " + payment.status + ", not active", 409);
        }
        if (typeof actualUsd !== "number" || !Number.isFinite(actualUsd) || actualUsd < 0) {
            throw new LeaseError("BAD_USAGE", "actualUsd must be zero or a positive number");
        }
        if (actualUsd > quote.capUsd + 1e-9) {
            throw new LeaseError("OVER_CAP", "Actual usage of $" + actualUsd.toFixed(4) + " is above the paid cap of $" + quote.capUsd.toFixed(4));
        }
        if (!["completed", "stopped_at_cap"].includes(status)) throw new LeaseError("BAD_STATUS", "Unknown run status");
        if (!this.store.claimLease(lease.id)) throw new LeaseError("BUSY", "This lease is already being ended", 409);

        // There are no refunds. The payment is final, so the whole amount paid is what was billed.
        // The lease time is still measured and shown, so the person can see how long the lease ran.
        const paid = BigInt(quote.tinybars);
        const billed = paid;

        this.audit.append({
            paymentId: payment.id, eventType: "LEASE_COMPLETED", status: payment.status,
            details: { measuredUsd: actualUsd, actualDurationHours, runStatus: status, billingBasis: basis, billedTinybars: billed, refundPolicy: "none" },
        });

        const reconciliation = {
            paidTinybars: paid.toString(),
            billedTinybars: billed.toString(),
            asset: quote.asset,
            paidDisplay: formatAmount(paid, quote.asset),
            billedDisplay: formatAmount(billed, quote.asset),
            // Kept for HBAR clients. Null when the payment was not in HBAR.
            paidHbar: quote.asset.native ? formatAmount(paid, quote.asset) : null,
            billedHbar: quote.asset.native ? formatAmount(billed, quote.asset) : null,
            capUsd: quote.capUsd,
            estimateUsd: quote.estimateUsd,
            actualUsd,
            actualDurationHours,
            estimatedDurationHours: quote.hours,
            deltaVsEstimateUsd: actualUsd - quote.estimateUsd,
            runStatus: status,
            billingBasis: basis,
            // Lease-time billing measures how long the lease was held, not how much of the GPU was used.
            refundPolicy: "none",
            billingNote: "The payment is final and is not refunded. The lease time shown is how long the lease was held, by the second. It is not a measurement of GPU utilization.",
            simulatedRun: basis !== "lease-time",
            reconciledAt: new Date(this.now()).toISOString(),
        };

        const updated = this.store.updateLease(lease.id, { status: "RECONCILED", run, reconciliation });
        return { lease: updated, reconciliation, settled: true, alreadyReconciled: false };
    }
}

module.exports = { LeaseService, LeaseError };
