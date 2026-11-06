/**
 * Stage 0 usage billing. Everything here is SIMULATED: no GPU runs and no money
 * moves. "Actual" values are simulated, never measured, and the report says so.
 * Money is tracked in integer micro-dollars to avoid floating-point drift.
 */
const MICRO = 1_000_000;

export function usdToMicro(usd: number): number {
  return Math.round(usd * MICRO);
}
export function microToUsd(micro: number): number {
  return micro / MICRO;
}

export interface SpendingCap {
  capUsd: number;
  /** False when the cap is below the estimated cost, so the job will likely be stopped early. */
  coversEstimate: boolean;
}

export function approveSpendingCap(capUsd: number, estimatedCostUsd: number): SpendingCap {
  if (!Number.isFinite(capUsd) || capUsd <= 0) {
    throw new Error("Spending cap must be a positive number");
  }
  return { capUsd, coversEstimate: capUsd >= estimatedCostUsd };
}

/** Accrues cost per second at a fixed hourly rate and refuses to pass the cap. */
export class UsageMeter {
  private elapsed = 0;
  private readonly rateMicroPerHour: number;
  private readonly capMicro: number;

  constructor(ratePerHourUsd: number, spendingCapUsd: number) {
    if (!(ratePerHourUsd > 0)) throw new Error("Hourly rate must be positive");
    approveSpendingCap(spendingCapUsd, 0);
    this.rateMicroPerHour = usdToMicro(ratePerHourUsd);
    this.capMicro = usdToMicro(spendingCapUsd);
  }

  get elapsedSeconds(): number {
    return this.elapsed;
  }

  get accumulatedMicro(): number {
    const micro = Math.floor((this.elapsed * this.rateMicroPerHour) / 3600);
    return Math.min(micro, this.capMicro);
  }

  get accumulatedUsd(): number {
    return microToUsd(this.accumulatedMicro);
  }

  get capReached(): boolean {
    return this.accumulatedMicro >= this.capMicro;
  }

  /** Run for up to `seconds`, stopping early if the next second would exceed the cap. */
  advance(seconds: number): { advancedSeconds: number; stoppedAtCap: boolean } {
    const capSeconds = (this.capMicro * 3600) / this.rateMicroPerHour;
    const allowed = Math.max(0, Math.min(seconds, capSeconds - this.elapsed));
    this.elapsed += allowed;
    return { advancedSeconds: allowed, stoppedAtCap: allowed < seconds };
  }
}

export type ExecutionStatus = "completed" | "stopped_at_cap";

export interface UsageTick {
  elapsedSeconds: number;
  accumulatedUsd: number;
}

export interface ReconciliationReport {
  estimatedCostUsd: number;
  billedCostUsd: number;
  deltaUsd: number;
  /** (billed - estimated) / estimated, as a percentage. */
  deltaPct: number;
  estimatedDurationHours: number;
  actualDurationHours: number;
  authorizedCapUsd: number;
  /** Authorization that was never used. */
  unusedAuthorizationUsd: number;
  outcome: "within_tolerance" | "under_estimated" | "over_estimated" | "stopped_at_cap";
}

export interface SimulatedExecutionReport {
  /** Stage 0: durations and costs below come from a simulation, not a real run. */
  source: "simulated";
  status: ExecutionStatus;
  hourlyRateUsd: number;
  spendingCapUsd: number;
  estimatedDurationHours: number;
  estimatedCostUsd: number;
  /** Simulated run length for the whole job, had the cap not applied. */
  simulatedFullDurationHours: number;
  /** Time actually run before completing or being stopped. */
  actualDurationHours: number;
  actualCostUsd: number;
  /** Share of the job completed, 0-1. */
  completedFraction: number;
  timeline: UsageTick[];
  reconciliation: ReconciliationReport;
}

export const RECONCILIATION_TOLERANCE_PCT = 5;

export function reconcile(input: {
  estimatedCostUsd: number;
  billedCostUsd: number;
  estimatedDurationHours: number;
  actualDurationHours: number;
  authorizedCapUsd: number;
  status: ExecutionStatus;
}): ReconciliationReport {
  const deltaUsd = input.billedCostUsd - input.estimatedCostUsd;
  const deltaPct = input.estimatedCostUsd > 0 ? (deltaUsd / input.estimatedCostUsd) * 100 : 0;
  const outcome =
    input.status === "stopped_at_cap"
      ? "stopped_at_cap"
      : Math.abs(deltaPct) <= RECONCILIATION_TOLERANCE_PCT
        ? "within_tolerance"
        : deltaPct > 0
          ? "under_estimated"
          : "over_estimated";

  return {
    estimatedCostUsd: input.estimatedCostUsd,
    billedCostUsd: input.billedCostUsd,
    deltaUsd,
    deltaPct,
    estimatedDurationHours: input.estimatedDurationHours,
    actualDurationHours: input.actualDurationHours,
    authorizedCapUsd: input.authorizedCapUsd,
    unusedAuthorizationUsd: Math.max(0, input.authorizedCapUsd - input.billedCostUsd),
    outcome,
  };
}

/** Deterministic 0-1 value from a string, so a job id always simulates the same way. */
function seededUnit(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

/** Simulated runtime as a multiple of the estimate: 0.8x to 1.3x, deterministic per job. */
export function simulatedRuntimeFactor(jobId: string): number {
  return 0.8 + seededUnit(jobId) * 0.5;
}

export interface SimulationInput {
  jobId: string;
  hourlyRateUsd: number;
  estimatedDurationHours: number;
  estimatedCostUsd: number;
  spendingCapUsd: number;
  /** Override the simulated runtime multiplier (tests, what-if). */
  runtimeFactor?: number;
  tickSeconds?: number;
}

export function simulateExecution(input: SimulationInput): SimulatedExecutionReport {
  const factor = input.runtimeFactor ?? simulatedRuntimeFactor(input.jobId);
  const fullSeconds = input.estimatedDurationHours * 3600 * factor;
  const tick = Math.max(input.tickSeconds ?? 60, Math.ceil(fullSeconds / 500));

  const meter = new UsageMeter(input.hourlyRateUsd, input.spendingCapUsd);
  const timeline: UsageTick[] = [{ elapsedSeconds: 0, accumulatedUsd: 0 }];
  let status: ExecutionStatus = "completed";

  while (meter.elapsedSeconds < fullSeconds) {
    const remaining = fullSeconds - meter.elapsedSeconds;
    const { stoppedAtCap } = meter.advance(Math.min(tick, remaining));
    timeline.push({ elapsedSeconds: meter.elapsedSeconds, accumulatedUsd: meter.accumulatedUsd });
    if (stoppedAtCap) {
      status = "stopped_at_cap";
      break;
    }
  }

  const actualDurationHours = meter.elapsedSeconds / 3600;
  const actualCostUsd = meter.accumulatedUsd;

  return {
    source: "simulated",
    status,
    hourlyRateUsd: input.hourlyRateUsd,
    spendingCapUsd: input.spendingCapUsd,
    estimatedDurationHours: input.estimatedDurationHours,
    estimatedCostUsd: input.estimatedCostUsd,
    simulatedFullDurationHours: fullSeconds / 3600,
    actualDurationHours,
    actualCostUsd,
    completedFraction: fullSeconds > 0 ? Math.min(1, meter.elapsedSeconds / fullSeconds) : 1,
    timeline,
    reconciliation: reconcile({
      estimatedCostUsd: input.estimatedCostUsd,
      billedCostUsd: actualCostUsd,
      estimatedDurationHours: input.estimatedDurationHours,
      actualDurationHours,
      authorizedCapUsd: input.spendingCapUsd,
      status,
    }),
  };
}
