import assert from "node:assert/strict";
import test from "node:test";
import { mockGpuOffers } from "../data/mock-gpus.ts";
import { resolveProfile } from "../lib/estimation/workload-profile.ts";
import {
  rankOffersByEstimatedCost,
  totalCostUsd,
  type RoutingConstraints,
} from "../lib/routing/cost-ranking.ts";

const profile = resolveProfile("inference", { modelParamsB: 8, numPrompts: 5000 }).profile;
const constraints = (over: Partial<RoutingConstraints> = {}): RoutingConstraints => ({
  minVramGb: 16,
  gpuCount: 1,
  maxHourlyBudgetUsd: null,
  maxTotalBudgetUsd: null,
  minPerformanceScore: null,
  maxDurationHours: null,
  cudaRequired: null,
  optimization: "cost",
  ...over,
});

test("total cost is hourly price times duration", () => {
  assert.equal(totalCostUsd(2, 1.5), 3);
  const { ranked } = rankOffersByEstimatedCost(mockGpuOffers, profile, constraints());
  for (const r of ranked) {
    assert.equal(r.estimatedTotalCostUsd, r.hourlyPriceUsd * r.estimatedDurationHours);
  }
});

test("cost optimization selects the lowest estimated total cost", () => {
  const { ranked, selected } = rankOffersByEstimatedCost(mockGpuOffers, profile, constraints());
  const min = Math.min(...ranked.map((r) => r.estimatedTotalCostUsd));
  assert.equal(selected?.estimatedTotalCostUsd, min);
  assert.deepEqual(
    ranked.map((r) => r.estimatedTotalCostUsd),
    [...ranked.map((r) => r.estimatedTotalCostUsd)].sort((a, b) => a - b),
  );
});

test("cheapest hourly price is not necessarily the cheapest job", () => {
  const tuning = resolveProfile("fine-tuning", { modelParamsB: 3 }).profile;
  const { ranked } = rankOffersByEstimatedCost(mockGpuOffers, tuning, constraints());
  const cheapestHourly = [...ranked].sort((a, b) => a.hourlyPriceUsd - b.hourlyPriceUsd)[0];
  assert.notEqual(ranked[0].offer.id, cheapestHourly.offer.id);
  assert.ok(ranked[0].estimatedTotalCostUsd < cheapestHourly.estimatedTotalCostUsd);
});

test("performance optimization ranks the faster GPU first", () => {
  const { selected } = rankOffersByEstimatedCost(
    mockGpuOffers,
    profile,
    constraints({ optimization: "performance" }),
  );
  const { ranked } = rankOffersByEstimatedCost(mockGpuOffers, profile, constraints());
  const fastest = Math.min(...ranked.map((r) => r.estimatedDurationHours));
  assert.ok(selected!.estimatedDurationHours <= fastest * 1.5);
  assert.ok(selected!.routingScore > 0 && selected!.routingScore <= 100);
});

test("respects minimum VRAM, GPU count and availability", () => {
  const { ranked } = rankOffersByEstimatedCost(
    mockGpuOffers,
    profile,
    constraints({ minVramGb: 40, gpuCount: 2 }),
  );
  assert.ok(ranked.length > 0);
  for (const r of ranked) {
    assert.ok(r.offer.vramGb >= 40 && r.offer.gpuCount >= 2 && r.offer.available);
    assert.equal(r.hourlyPriceUsd, r.offer.pricePerHourUsd * 2);
  }
});

test("hourly budget excludes offers and explains why", () => {
  const { ranked, rejected } = rankOffersByEstimatedCost(
    mockGpuOffers,
    profile,
    constraints({ maxHourlyBudgetUsd: 0.5 }),
  );
  assert.ok(ranked.every((r) => r.hourlyPriceUsd <= 0.5));
  assert.ok(rejected.some((r) => r.reasons.some((m) => m.includes("budget"))));
});

test("total budget excludes offers whose estimated cost is too high", () => {
  const all = rankOffersByEstimatedCost(mockGpuOffers, profile, constraints());
  const median = all.ranked[Math.floor(all.ranked.length / 2)].estimatedTotalCostUsd;
  const limited = rankOffersByEstimatedCost(
    mockGpuOffers,
    profile,
    constraints({ maxTotalBudgetUsd: median }),
  );
  assert.ok(limited.ranked.length < all.ranked.length);
  assert.ok(limited.ranked.every((r) => r.estimatedTotalCostUsd <= median));
});

test("performance requirement and duration limit are enforced", () => {
  const perf = rankOffersByEstimatedCost(mockGpuOffers, profile, constraints({ minPerformanceScore: 90 }));
  assert.ok(perf.ranked.every((r) => (r.offer.performanceScore ?? 0) >= 90));

  const all = rankOffersByEstimatedCost(mockGpuOffers, profile, constraints());
  const limit = Math.min(...all.ranked.map((r) => r.estimatedDurationHours)) * 1.01;
  const fast = rankOffersByEstimatedCost(mockGpuOffers, profile, constraints({ maxDurationHours: limit }));
  assert.ok(fast.ranked.length >= 1 && fast.ranked.every((r) => r.estimatedDurationHours <= limit));
});

test("returns no selection when nothing satisfies the constraints", () => {
  const result = rankOffersByEstimatedCost(mockGpuOffers, profile, constraints({ maxHourlyBudgetUsd: 0.01 }));
  assert.equal(result.selected, null);
  assert.equal(result.ranked.length, 0);
  assert.equal(result.rejected.length, mockGpuOffers.length);
});

test("rejects GPUs where the model estimate does not fit in VRAM", () => {
  const big = resolveProfile("inference", { modelParamsB: 70 }).profile;
  const { ranked, rejected } = rankOffersByEstimatedCost(mockGpuOffers, big, constraints({ minVramGb: null }));
  assert.ok(ranked.every((r) => r.offer.vramGb >= 100 || r.offer.vramGb * r.gpusUsed >= r.estimate.requiredVramGb));
  assert.ok(rejected.some((r) => r.reasons.some((m) => m.includes("needed"))));
});
