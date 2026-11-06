import assert from "node:assert/strict";
import test from "node:test";
import {
  UsageMeter,
  approveSpendingCap,
  reconcile,
  simulateExecution,
  simulatedRuntimeFactor,
} from "../lib/billing/usage-billing.ts";

const base = {
  jobId: "job-1",
  hourlyRateUsd: 2,
  estimatedDurationHours: 2,
  estimatedCostUsd: 4,
};

test("meter accrues cost by actual elapsed time", () => {
  const meter = new UsageMeter(3.6, 100);
  meter.advance(1800); // half an hour
  assert.equal(meter.accumulatedUsd, 1.8);
  assert.equal(meter.elapsedSeconds, 1800);
});

test("meter stops exactly at the cap and never exceeds it", () => {
  const meter = new UsageMeter(2, 1); // cap reached after 30 minutes
  const result = meter.advance(7200);
  assert.equal(result.stoppedAtCap, true);
  assert.equal(result.advancedSeconds, 1800);
  assert.ok(meter.accumulatedUsd <= 1);
  assert.equal(meter.capReached, true);
  assert.equal(meter.advance(60).advancedSeconds, 0);
});

test("rejects invalid caps and rates", () => {
  assert.throws(() => approveSpendingCap(0, 5));
  assert.throws(() => approveSpendingCap(Number.NaN, 5));
  assert.throws(() => new UsageMeter(0, 5));
  assert.equal(approveSpendingCap(3, 5).coversEstimate, false);
  assert.equal(approveSpendingCap(8, 5).coversEstimate, true);
});

test("completed run bills the actual duration, not the estimate", () => {
  const report = simulateExecution({ ...base, spendingCapUsd: 100, runtimeFactor: 1.2 });
  assert.equal(report.source, "simulated");
  assert.equal(report.status, "completed");
  assert.ok(Math.abs(report.actualDurationHours - 2.4) < 1e-6);
  assert.ok(Math.abs(report.actualCostUsd - 4.8) < 1e-4);
  assert.equal(report.completedFraction, 1);
});

test("run is stopped before the spending cap is exceeded", () => {
  const report = simulateExecution({ ...base, spendingCapUsd: 3, runtimeFactor: 1.0 });
  assert.equal(report.status, "stopped_at_cap");
  assert.ok(report.actualCostUsd <= 3);
  assert.ok(report.actualCostUsd > 2.99);
  assert.ok(report.completedFraction < 1);
  assert.ok(report.timeline.every((t) => t.accumulatedUsd <= 3));
  assert.equal(report.reconciliation.outcome, "stopped_at_cap");
  assert.ok(report.reconciliation.unusedAuthorizationUsd < 0.01);
});

test("timeline accumulated cost never decreases", () => {
  const report = simulateExecution({ ...base, spendingCapUsd: 100, runtimeFactor: 0.9 });
  for (let i = 1; i < report.timeline.length; i++) {
    assert.ok(report.timeline[i].accumulatedUsd >= report.timeline[i - 1].accumulatedUsd);
  }
});

test("reconciliation compares estimated and billed cost", () => {
  const over = reconcile({
    estimatedCostUsd: 10, billedCostUsd: 12, estimatedDurationHours: 5,
    actualDurationHours: 6, authorizedCapUsd: 15, status: "completed",
  });
  assert.equal(over.deltaUsd, 2);
  assert.equal(over.deltaPct, 20);
  assert.equal(over.outcome, "under_estimated");
  assert.equal(over.unusedAuthorizationUsd, 3);

  const under = reconcile({
    estimatedCostUsd: 10, billedCostUsd: 8, estimatedDurationHours: 5,
    actualDurationHours: 4, authorizedCapUsd: 15, status: "completed",
  });
  assert.equal(under.outcome, "over_estimated");

  const close = reconcile({
    estimatedCostUsd: 10, billedCostUsd: 10.3, estimatedDurationHours: 5,
    actualDurationHours: 5.1, authorizedCapUsd: 15, status: "completed",
  });
  assert.equal(close.outcome, "within_tolerance");
});

test("reconciliation in a full run matches billed = actual cost", () => {
  const report = simulateExecution({ ...base, spendingCapUsd: 100 });
  assert.equal(report.reconciliation.billedCostUsd, report.actualCostUsd);
  assert.ok(Math.abs(report.reconciliation.deltaUsd - (report.actualCostUsd - 4)) < 1e-9);
});

test("simulation is deterministic per job id and bounded", () => {
  assert.equal(simulatedRuntimeFactor("a"), simulatedRuntimeFactor("a"));
  for (const id of ["a", "b", "c", "job-99"]) {
    const f = simulatedRuntimeFactor(id);
    assert.ok(f >= 0.8 && f <= 1.3);
  }
});
