"use strict";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Spending policy, all in USD. It decides one of three things for a payment:
 *   auto      pay without asking
 *   approval  hold for a human
 *   refuse    never pay, and no approval can override it
 */
class PolicyEngine {
    /**
     * @param {object} opts
     * @param {{autoApproveLimitUsd:number,dailyLimitUsd:number,hardCeilingUsd:number}} opts.limits
     * @param {string[]} opts.allowedPayTo  Merchant accounts that may be paid
     * @param {import("./store").Store} opts.store
     */
    constructor({ limits, allowedPayTo, store, now = Date.now }) {
        this.limits = limits;
        this.allowedPayTo = new Set(allowedPayTo);
        this.store = store;
        this.now = now;
    }

    evaluate({ capUsd, payTo, wallet }) {
        const committedTodayUsd = this.store.committedUsdSince(wallet, this.now() - DAY_MS);
        const { autoApproveLimitUsd, dailyLimitUsd, hardCeilingUsd, globalDailyLimitUsd } = this.limits;
        const committedGlobalUsd = this.store.committedUsdSinceGlobal(this.now() - DAY_MS);
        const reasons = [];
        const base = {
            limits: { ...this.limits },
            committedTodayUsd,
            remainingDailyUsd: Math.max(0, dailyLimitUsd - committedTodayUsd),
        };

        if (!this.allowedPayTo.has(payTo)) {
            return { ...base, decision: "refuse", reasons: [`Pay-to account ${payTo} is not on the allowlist`] };
        }
        if (capUsd > hardCeilingUsd) {
            return { ...base, decision: "refuse", reasons: [`$${capUsd.toFixed(2)} is above the hard ceiling of $${hardCeilingUsd.toFixed(2)}`] };
        }
        if (globalDailyLimitUsd != null && committedGlobalUsd + capUsd > globalDailyLimitUsd) {
            return {
                ...base,
                decision: "refuse",
                reasons: ["The service-wide daily limit of $" + globalDailyLimitUsd.toFixed(2) + " would be exceeded"],
            };
        }
        if (capUsd > autoApproveLimitUsd) {
            reasons.push(`$${capUsd.toFixed(2)} is above the automatic limit of $${autoApproveLimitUsd.toFixed(2)}`);
        }
        if (committedTodayUsd + capUsd > dailyLimitUsd) {
            reasons.push(
                `$${committedTodayUsd.toFixed(2)} already committed today, so $${capUsd.toFixed(2)} would pass the daily limit of $${dailyLimitUsd.toFixed(2)}`,
            );
        }
        return { ...base, decision: reasons.length ? "approval" : "auto", reasons };
    }
}

module.exports = { PolicyEngine, DAY_MS };
