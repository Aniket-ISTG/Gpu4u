import assert from "node:assert/strict";
import test from "node:test";
import { resolveProfile } from "../lib/estimation/workload-profile.ts";
import {
  rankOffersByEstimatedCost,
  totalCostUsd,
  type RoutingConstraints,
} from "../lib/routing/cost-ranking.ts";
import { offers } from "./fixtures/offers.ts";

const profile = resolveProfile("inference", { modelParamsB: 8, numPrompts: 5000 }).profile;
const constraints = (over: Partial<RoutingConstraints> = {}): RoutingConstraints => ({
  minVramGb: 16,
  gpuCount: 1,
  maxHourlyBudgetUsd: null,
  maxTotalBudgetUsd: null,
  maxDurationHours: null,
  cudaRequired: null,
  optimization: "cost",
  ...over,
});
const run = (over: Partial<RoutingConstraints> = {}, p = profile) =>
  rankOffersByEstimatedCost(offers, p, constraints(over));

test("total cost is the whole-offer hourly price times duration", () => {
  assert.equal(totalCostUsd(2, 1.5), 3);
  const { ranked } = run();
  assert.ok(ranked.length > 10);
  for (const r of ranked) {
    assert.equal(r.hourlyPriceUsd, r.offer.bundlePricePerHourUsd);
    assert.equal(r.estimatedTotalCostUsd, r.hourlyPriceUsd * r.estimatedDurationHours);
  }
});

test("cost optimization selects the lowest estimated total cost", () => {
  const { ranked, selected } = run();
  const min = Math.min(...ranked.map((r) => r.estimatedTotalCostUsd));
  assert.equal(selected?.estimatedTotalCostUsd, min);
  const costs = ranked.map((r) => r.estimatedTotalCostUsd);
  assert.deepEqual(costs, [...costs].sort((a, b) => a - b));
  assert.equal(ranked[0].routingScore, 100);
});

test("the cheapest hourly rate is not necessarily the cheapest job", () => {
  // A 70B model on one GPU: a low hourly rate on a slow GPU costs far more overall than a fast GPU.
  const big = resolveProfile("inference", { modelParamsB: 70, numPrompts: 5000 }).profile;
  const { ranked } = run({}, big);
  const cheapestHourly = [...ranked].sort((a, b) => a.hourlyPriceUsd - b.hourlyPriceUsd)[0];
  assert.notEqual(ranked[0].offer.id, cheapestHourly.offer.id);
  assert.ok(ranked[0].estimatedTotalCostUsd < cheapestHourly.estimatedTotalCostUsd);
  assert.ok(ranked[0].hourlyPriceUsd > cheapestHourly.hourlyPriceUsd);
});

test("performance optimization prefers faster jobs than cost optimization", () => {
  const cost = run().selected!;
  const perf = run({ optimization: "performance" }).selected!;
  assert.ok(perf.estimatedDurationHours <= cost.estimatedDurationHours);
  assert.ok(perf.routingScore > 0 && perf.routingScore <= 100);
});

test("balanced optimization sits between cost and performance on cost", () => {
  const cost = run().selected!;
  const perf = run({ optimization: "performance" }).selected!;
  const balanced = run({ optimization: "balanced" }).selected!;
  assert.ok(balanced.estimatedTotalCostUsd >= cost.estimatedTotalCostUsd);
  assert.ok(balanced.estimatedTotalCostUsd <= perf.estimatedTotalCostUsd + 1e-9);
});

test("only bundles of exactly the requested GPU count are matched", () => {
  const { ranked, rejected } = run({ minVramGb: 24, gpuCount: 2 });
  assert.ok(ranked.length > 0);
  for (const r of ranked) {
    assert.equal(r.offer.gpuCount, 2);
    assert.ok(r.offer.vramGb >= 24 && r.offer.available);
  }
  assert.ok(rejected.some((r) => r.reasons.some((m) => m.includes("exactly 2"))));
});

test("unavailable offers are rejected with a reason", () => {
  const { ranked, rejected } = run();
  assert.ok(ranked.every((r) => r.offer.available));
  assert.ok(rejected.some((r) => r.reasons.includes("Not available")));
});

test("hourly budget excludes offers and explains why", () => {
  const { ranked, rejected } = run({ maxHourlyBudgetUsd: 0.5 });
  assert.ok(ranked.every((r) => r.hourlyPriceUsd <= 0.5));
  assert.ok(rejected.some((r) => r.reasons.some((m) => m.includes("budget"))));
});

test("total budget excludes offers whose estimated cost is too high", () => {
  const all = run();
  const median = all.ranked[Math.floor(all.ranked.length / 2)].estimatedTotalCostUsd;
  const limited = run({ maxTotalBudgetUsd: median });
  assert.ok(limited.ranked.length < all.ranked.length);
  assert.ok(limited.ranked.every((r) => r.estimatedTotalCostUsd <= median));
});

test("duration limit is enforced", () => {
  const all = run();
  const limit = Math.min(...all.ranked.map((r) => r.estimatedDurationHours)) * 1.01;
  const fast = run({ maxDurationHours: limit });
  assert.ok(fast.ranked.length >= 1);
  assert.ok(fast.ranked.every((r) => r.estimatedDurationHours <= limit));
});

test("minimum VRAM and CUDA are enforced", () => {
  const { ranked } = run({ minVramGb: 48, cudaRequired: true });
  assert.ok(ranked.length > 0);
  assert.ok(ranked.every((r) => r.offer.vramGb >= 48 && r.offer.cudaSupported));
});

test("returns no selection when nothing satisfies the constraints", () => {
  const result = run({ maxHourlyBudgetUsd: 0.001 });
  assert.equal(result.selected, null);
  assert.equal(result.ranked.length, 0);
  assert.equal(result.rejected.length, offers.length);
});

test("rejects GPUs where the model estimate does not fit in VRAM", () => {
  const big = resolveProfile("inference", { modelParamsB: 70 }).profile;
  const { ranked, rejected } = run({ minVramGb: null }, big);
  assert.ok(ranked.every((r) => r.estimate.fitsInVram));
  assert.ok(rejected.some((r) => r.reasons.some((m) => m.includes("needed"))));
});

test("every ranked offer carries estimate-labelled duration data", () => {
  for (const r of run().ranked) {
    assert.equal(r.estimate.kind, "estimate");
    assert.equal(r.estimatedDurationHours, r.estimate.hours);
  }
});
