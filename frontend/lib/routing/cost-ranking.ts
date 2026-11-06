import type { GPUOffer } from "../marketplace/types.ts";
import { estimateDuration, type DurationEstimate } from "../estimation/duration-estimator.ts";
import type { WorkloadProfile } from "../estimation/workload-profile.ts";

export type Optimization = "cost" | "performance" | "balanced";

export interface RoutingConstraints {
  minVramGb: number | null;
  gpuCount: number;
  /** Cap on the hourly rate for all requested GPUs together. */
  maxHourlyBudgetUsd: number | null;
  /** Cap on the estimated total cost of the job. */
  maxTotalBudgetUsd: number | null;
  maxDurationHours: number | null;
  cudaRequired: boolean | null;
  optimization: Optimization;
}

export interface RoutedOffer {
  offer: GPUOffer;
  gpusUsed: number;
  /** Whole-offer rate: an offer is a fixed bundle, so all of its GPUs are rented and billed together. */
  hourlyPriceUsd: number;
  estimate: DurationEstimate;
  estimatedDurationHours: number;
  /** hourlyPriceUsd x estimatedDurationHours. An estimate, not a bill. */
  estimatedTotalCostUsd: number;
  /** 0-100, relative to the other eligible offers for this optimization preference. */
  routingScore: number;
}

export interface RejectedOffer {
  offer: GPUOffer;
  reasons: string[];
}

export interface RoutingResult {
  ranked: RoutedOffer[];
  rejected: RejectedOffer[];
  selected: RoutedOffer | null;
}

const WEIGHTS: Record<Optimization, { cost: number; time: number }> = {
  cost: { cost: 1, time: 0 },
  balanced: { cost: 0.5, time: 0.5 },
  performance: { cost: 0.2, time: 0.8 },
};

export function totalCostUsd(hourlyPriceUsd: number, durationHours: number): number {
  return hourlyPriceUsd * durationHours;
}

export function rankOffersByEstimatedCost(
  offers: GPUOffer[],
  profile: WorkloadProfile,
  constraints: RoutingConstraints,
): RoutingResult {
  const rejected: RejectedOffer[] = [];
  const candidates: Omit<RoutedOffer, "routingScore">[] = [];
  const gpusUsed = constraints.gpuCount;

  for (const offer of offers) {
    const reasons: string[] = [];
    // An offer is a fixed bundle at a fixed price, so we only match bundles of exactly the requested size.
    const hourlyPriceUsd = offer.bundlePricePerHourUsd;

    if (!offer.available) reasons.push("Not available");
    if (constraints.minVramGb !== null && offer.vramGb < constraints.minVramGb) {
      reasons.push(`VRAM ${offer.vramGb} GB below minimum ${constraints.minVramGb} GB`);
    }
    if (offer.gpuCount !== gpusUsed) reasons.push(`Bundle has ${offer.gpuCount} GPU(s), need exactly ${gpusUsed}`);
    if (constraints.cudaRequired && !offer.cudaSupported) reasons.push("CUDA not supported");
    if (constraints.maxHourlyBudgetUsd !== null && hourlyPriceUsd > constraints.maxHourlyBudgetUsd) {
      reasons.push(`Hourly rate $${hourlyPriceUsd.toFixed(2)} exceeds $${constraints.maxHourlyBudgetUsd}/hr budget`);
    }

    const estimate = estimateDuration(offer, gpusUsed, profile);
    const estimatedTotalCostUsd = totalCostUsd(hourlyPriceUsd, estimate.hours);

    if (!estimate.fitsInVram) {
      reasons.push(
        `Estimated ${estimate.requiredVramGb.toFixed(0)} GB needed, only ${offer.vramGb * gpusUsed} GB available`,
      );
    }
    if (constraints.maxTotalBudgetUsd !== null && estimatedTotalCostUsd > constraints.maxTotalBudgetUsd) {
      reasons.push(`Estimated total $${estimatedTotalCostUsd.toFixed(2)} exceeds $${constraints.maxTotalBudgetUsd} budget`);
    }
    if (constraints.maxDurationHours !== null && estimate.hours > constraints.maxDurationHours) {
      reasons.push(`Estimated ${estimate.hours.toFixed(2)} h exceeds ${constraints.maxDurationHours} h limit`);
    }

    if (reasons.length) {
      rejected.push({ offer, reasons });
    } else {
      candidates.push({
        offer,
        gpusUsed,
        hourlyPriceUsd,
        estimate,
        estimatedDurationHours: estimate.hours,
        estimatedTotalCostUsd,
      });
    }
  }

  if (!candidates.length) return { ranked: [], rejected, selected: null };

  const minCost = Math.min(...candidates.map((c) => c.estimatedTotalCostUsd));
  const minTime = Math.min(...candidates.map((c) => c.estimatedDurationHours));
  const w = WEIGHTS[constraints.optimization];

  const ranked: RoutedOffer[] = candidates.map((c) => ({
    ...c,
    routingScore:
      100 *
      (w.cost * (minCost / c.estimatedTotalCostUsd) + w.time * (minTime / c.estimatedDurationHours)),
  }));

  ranked.sort((a, b) => {
    const byCost = a.estimatedTotalCostUsd - b.estimatedTotalCostUsd;
    const byTime = a.estimatedDurationHours - b.estimatedDurationHours;
    const order =
      constraints.optimization === "cost"
        ? byCost || byTime
        : b.routingScore - a.routingScore || byCost;
    return order || a.offer.id.localeCompare(b.offer.id);
  });

  return { ranked, rejected, selected: ranked[0] };
}
