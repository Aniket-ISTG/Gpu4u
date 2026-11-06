"use strict";

/**
 * Spending Limit Engine for GPU Router Payments
 * Evaluates spending policies independently of blockchain execution.
 */

const DEFAULT_SPENDING_LIMIT_HBAR = 5; // 5 HBAR per transaction (<= 5 automated, > 5 requires human approval)

/**
 * Evaluates whether a payment amount complies with current spending limits.
 * @param {number} amount - Amount in HBAR
 * @param {number} [limit=5] - Custom spending limit if configured
 * @returns {Object} Policy evaluation decision
 */
function checkSpendingLimit(amount, limit = DEFAULT_SPENDING_LIMIT_HBAR) {
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
        throw new Error("Amount must be a positive finite number to evaluate spending limit");
    }

    const effectiveLimit = (typeof limit === "number" && limit > 0) ? limit : DEFAULT_SPENDING_LIMIT_HBAR;

    if (amount <= effectiveLimit) {
        return {
            allowed: true,
            requiresApproval: false,
            policyState: "AUTO_APPROVED",
            spendingLimit: effectiveLimit,
            requestedAmount: amount,
            excessAmount: 0,
            message: `Payment of ${amount} HBAR is within the autonomous spending limit of ${effectiveLimit} HBAR.`
        };
    }

    const excess = Math.round((amount - effectiveLimit) * 1e8) / 1e8;
    return {
        allowed: false,
        requiresApproval: true,
        policyState: "PENDING_HUMAN_APPROVAL",
        spendingLimit: effectiveLimit,
        requestedAmount: amount,
        excessAmount: excess,
        message: `Payment of ${amount} HBAR exceeds spending limit of ${effectiveLimit} HBAR by ${excess} HBAR. Explicit human approval is required.`
    };
}

module.exports = {
    DEFAULT_SPENDING_LIMIT_HBAR,
    checkSpendingLimit
};
