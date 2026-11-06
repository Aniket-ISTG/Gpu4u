import { simulateExecution } from "../../lib/billing/usage-billing.ts";
import type { PaymentView } from "../../lib/payments/types.ts";

export interface LeaseRunResult {
  actualUsd: number;
  actualDurationHours: number;
  status: "completed" | "stopped_at_cap";
  run: {
    source: "simulated";
    simulatedFullDurationHours: number;
    completedFraction: number;
    estimatedDurationHours: number;
    estimatedCostUsd: number;
    hourlyRateUsd: number;
  };
}

/**
 * Plans the simulated lease run for a paid quote. Stage 0 rents no GPU, so the "actual" usage is
 * simulated. It is billed per second against the cap that was paid and can never exceed it. The
 * result is labelled simulated everywhere it is stored or shown.
 */
export function planLeaseRun(view: PaymentView): LeaseRunResult {
  const { quote, payment } = view;
  const report = simulateExecution({
    jobId: payment.id,
    hourlyRateUsd: quote.hourlyUsd,
    estimatedDurationHours: quote.hours,
    estimatedCostUsd: quote.estimateUsd,
    spendingCapUsd: quote.capUsd,
  });
  return {
    actualUsd: report.actualCostUsd,
    actualDurationHours: report.actualDurationHours,
    status: report.status,
    run: {
      source: "simulated",
      simulatedFullDurationHours: report.simulatedFullDurationHours,
      completedFraction: report.completedFraction,
      estimatedDurationHours: report.estimatedDurationHours,
      estimatedCostUsd: report.estimatedCostUsd,
      hourlyRateUsd: report.hourlyRateUsd,
    },
  };
}
