/**
 * Lease-time billing, for the live meter on screen. It mirrors the payment service's metering exactly, so the
 * running figure matches the final bill: the quoted hourly price by the second, never above the cap, with
 * the first second always counted and a partial second counted as a whole one.
 *
 * It measures how long the lease was held. It does not measure GPU utilization.
 */

const MICRO = 1_000_000;

export interface LeaseMeter {
  elapsedSeconds: number;
  billedSeconds: number;
  /** Whole seconds until the cap would be exceeded. */
  capSeconds: number;
  usd: number;
  stoppedAtCap: boolean;
  /** 0 to 1, how much of the cap has been used. */
  capFraction: number;
}

export function meterLeaseTime(options: { hourlyUsd: number; capUsd: number; startedAtMs: number; nowMs: number }): LeaseMeter {
  const ratePerHourMicro = Math.round(options.hourlyUsd * MICRO);
  const capMicro = Math.round(options.capUsd * MICRO);
  const capSeconds = Math.floor((capMicro * 3600) / ratePerHourMicro);

  const elapsedSeconds = Math.max(1, Math.ceil((options.nowMs - options.startedAtMs) / 1000));
  const billedSeconds = Math.min(elapsedSeconds, capSeconds);
  const costMicro = Math.min(capMicro, Math.floor((billedSeconds * ratePerHourMicro) / 3600));

  return {
    elapsedSeconds,
    billedSeconds,
    capSeconds,
    usd: costMicro / MICRO,
    stoppedAtCap: elapsedSeconds >= capSeconds,
    capFraction: Math.min(1, costMicro / capMicro),
  };
}

/** 3725 becomes "1:02:05". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  return `${h > 0 ? h + ":" : ""}${mm}:${String(sec).padStart(2, "0")}`;
}
