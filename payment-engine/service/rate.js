"use strict";

/**
 * USD to HBAR conversion using the Hedera network exchange rate, which the
 * mirror node publishes as cents per N HBAR. All math is integer (BigInt) so a
 * quoted amount is exact and always rounds up to a whole tinybar.
 */

const TINYBARS_PER_HBAR = 100_000_000n;

function assertRate(rate) {
    if (!rate || !(rate.centEquivalent > 0) || !(rate.hbarEquivalent > 0)) {
        throw new Error("Exchange rate is missing or invalid");
    }
}

/** Builds a rate object from a cents-per-HBAR ratio. */
function makeRate({ centEquivalent, hbarEquivalent, source, validUntil }) {
    const rate = {
        centEquivalent: Number(centEquivalent),
        hbarEquivalent: Number(hbarEquivalent),
        source,
        validUntil,
    };
    assertRate(rate);
    rate.usdPerHbar = rate.centEquivalent / (rate.hbarEquivalent * 100);
    return rate;
}

function ceilDiv(a, b) {
    return (a + b - 1n) / b;
}

/** USD to tinybars, rounded up. usd is converted at micro-dollar precision. */
function usdToTinybars(usd, rate) {
    assertRate(rate);
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) {
        throw new Error("USD amount must be a positive finite number");
    }
    const usdMicro = BigInt(Math.round(usd * 1_000_000));
    if (usdMicro <= 0n) throw new Error("USD amount is too small to convert");
    // hbar     = usd * 100 * hbarEquivalent / centEquivalent
    // tinybars = hbar * 1e8
    //          = (usdMicro / 1e6) * 100 * hbarEquivalent * 1e8 / centEquivalent
    //          = usdMicro * hbarEquivalent * 10_000 / centEquivalent
    return ceilDiv(usdMicro * BigInt(rate.hbarEquivalent) * 10_000n, BigInt(rate.centEquivalent));
}

/** Tinybars to USD as a number. Used for display and reconciliation. */
function tinybarsToUsd(tinybars, rate) {
    assertRate(rate);
    const value = BigInt(tinybars);
    // usd = tinybars / 1e8 * cent / (hbarEquivalent * 100)
    const numerator = value * BigInt(rate.centEquivalent);
    const denominator = TINYBARS_PER_HBAR * BigInt(rate.hbarEquivalent) * 100n;
    return Number((numerator * 1_000_000_000n) / denominator) / 1_000_000_000;
}

function tinybarsToHbarString(tinybars) {
    const value = BigInt(tinybars);
    const whole = value / TINYBARS_PER_HBAR;
    const fraction = (value % TINYBARS_PER_HBAR).toString().padStart(8, "0").replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/**
 * Fetches and caches the rate. In simulated mode a failed fetch falls back to a
 * fixed rate and says so in `source`. In testnet mode a failed fetch is an error,
 * because pricing a real payment from a guess is not acceptable.
 */
class RateService {
    constructor({ mirrorUrl, fetchImpl = fetch, simulated = false, fallbackUsdPerHbar = 0.068, ttlMs = 60_000, now = Date.now }) {
        this.mirrorUrl = mirrorUrl;
        this.fetchImpl = fetchImpl;
        this.simulated = simulated;
        this.fallbackUsdPerHbar = fallbackUsdPerHbar;
        this.ttlMs = ttlMs;
        this.now = now;
        this.cached = null;
    }

    async getRate() {
        if (this.cached && this.now() - this.cached.fetchedAt < this.ttlMs) return this.cached.rate;
        try {
            const response = await this.fetchImpl(`${this.mirrorUrl}/api/v1/network/exchangerate`, {
                signal: AbortSignal.timeout(8000),
            });
            if (!response.ok) throw new Error(`Mirror node returned HTTP ${response.status}`);
            const body = await response.json();
            const current = body.current_rate;
            const rate = makeRate({
                centEquivalent: current.cent_equivalent,
                hbarEquivalent: current.hbar_equivalent,
                source: "hedera-mirror-node",
                validUntil: Number(current.expiration_time) * 1000,
            });
            this.cached = { rate, fetchedAt: this.now() };
            return rate;
        } catch (error) {
            if (!this.simulated) throw new Error(`Could not read the HBAR exchange rate: ${error.message}`);
            const rate = makeRate({
                centEquivalent: Math.round(this.fallbackUsdPerHbar * 100 * 1000),
                hbarEquivalent: 1000,
                source: "fixed-fallback",
                validUntil: this.now() + this.ttlMs,
            });
            this.cached = { rate, fetchedAt: this.now() };
            return rate;
        }
    }
}

module.exports = { RateService, makeRate, usdToTinybars, tinybarsToUsd, tinybarsToHbarString, TINYBARS_PER_HBAR };
