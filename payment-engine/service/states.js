"use strict";

/** Payment lifecycle. Terminal states are final. */
const PaymentStatus = Object.freeze({
    RECEIVED: "RECEIVED",
    POLICY_CHECKED: "POLICY_CHECKED",
    REFUSED: "REFUSED",
    PENDING_APPROVAL: "PENDING_APPROVAL",
    APPROVED: "APPROVED",
    REJECTED: "REJECTED",
    EXPIRED: "EXPIRED",
    AWAITING_SIGNATURE: "AWAITING_SIGNATURE",
    AWAITING_402: "AWAITING_402",
    SIGNING: "SIGNING",
    SUBMITTED: "SUBMITTED",
    CONFIRMED: "CONFIRMED",
    LEASE_ACTIVE: "LEASE_ACTIVE",
    RECONCILED: "RECONCILED",
    FAILED: "FAILED",
});

const TERMINAL = new Set([
    PaymentStatus.REFUSED,
    PaymentStatus.REJECTED,
    PaymentStatus.EXPIRED,
    PaymentStatus.FAILED,
    PaymentStatus.RECONCILED,
]);

/** Statuses that count against the daily budget: money is, or may be, committed. */
const COMMITTED = [
    PaymentStatus.APPROVED,
    PaymentStatus.AWAITING_SIGNATURE,
    PaymentStatus.AWAITING_402,
    PaymentStatus.SIGNING,
    PaymentStatus.SUBMITTED,
    PaymentStatus.CONFIRMED,
    PaymentStatus.LEASE_ACTIVE,
    PaymentStatus.RECONCILED,
];

/** Statuses that are in flight inside this process and cannot resume after a restart. */
const IN_FLIGHT = [
    PaymentStatus.APPROVED,
    PaymentStatus.AWAITING_402,
    PaymentStatus.SIGNING,
    PaymentStatus.SUBMITTED,
];

const ApprovalStatus = Object.freeze({
    PENDING: "PENDING",
    APPROVED: "APPROVED",
    REJECTED: "REJECTED",
    EXPIRED: "EXPIRED",
});

module.exports = { PaymentStatus, ApprovalStatus, TERMINAL, COMMITTED, IN_FLIGHT };
