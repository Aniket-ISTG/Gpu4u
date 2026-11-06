"use strict";

const MICRO = 1_000_000;

/**
 * Lease-time billing. The bill is the quoted hourly price times the seconds the lease was held, and
 * never more than the cap that was paid. This is a measurement of how long the lease lasted. It is
 * NOT a measurement of GPU utilization, and every receipt says so.
 *
 * Money is integer micro-dollars so there is no rounding drift. Partial seconds count as a whole
 * second, and the first second always counts, as cloud providers bill.
 */
function meterLease({ hourlyUsd, capUsd, startedAtMs, endedAtMs }) {
    if (!(hourlyUsd > 0)) throw new Error("hourlyUsd must be positive");
    if (!(capUsd > 0)) throw new Error("capUsd must be positive");
    if (!(endedAtMs >= startedAtMs)) throw new Error("The lease cannot end before it started");

    const ratePerHourMicro = Math.round(hourlyUsd * MICRO);
    const capMicro = Math.round(capUsd * MICRO);
    // Whole seconds until the cap would be exceeded.
    const capSeconds = Math.floor((capMicro * 3600) / ratePerHourMicro);

    const elapsedSeconds = Math.max(1, Math.ceil((endedAtMs - startedAtMs) / 1000));
    const billedSeconds = Math.min(elapsedSeconds, capSeconds);
    const costMicro = Math.min(capMicro, Math.floor((billedSeconds * ratePerHourMicro) / 3600));

    return {
        elapsedSeconds,
        billedSeconds,
        capSeconds,
        actualUsd: costMicro / MICRO,
        stoppedAtCap: elapsedSeconds >= capSeconds,
        basis: "lease-time",
    };
}

/** Seconds from the start of a lease until it reaches its cap. */
function secondsToCap({ hourlyUsd, capUsd }) {
    return Math.floor((Math.round(capUsd * MICRO) * 3600) / Math.round(hourlyUsd * MICRO));
}

module.exports = { meterLease, secondsToCap };
