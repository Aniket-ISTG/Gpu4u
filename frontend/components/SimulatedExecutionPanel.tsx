"use client";

import React, { useEffect, useRef, useState } from "react";
import type { RoutedOffer } from "@/lib/routing/cost-ranking";
import {
  approveSpendingCap,
  simulateExecution,
  type SimulatedExecutionReport,
} from "@/lib/billing/usage-billing";

const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
const hrs = (h: number) => `${h.toFixed(2)} h`;

export default function SimulatedExecutionPanel({ routed }: { routed: RoutedOffer | null }) {
  const [capOverride, setCapOverride] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [run, setRun] = useState<{ report: SimulatedExecutionReport; label: string } | null>(null);
  const [step, setStep] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Suggest a cap 25% above the estimate until the user edits it.
  const suggested = routed ? Math.ceil(routed.estimatedTotalCostUsd * 1.25 * 100) / 100 : 0;
  const capInput = capOverride ?? (routed ? String(suggested) : "");

  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  if (!routed) return null;

  function start() {
    if (!routed) return;
    setError("");
    let cap;
    try {
      cap = approveSpendingCap(Number(capInput), routed.estimatedTotalCostUsd);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid cap");
      return;
    }
    const report = simulateExecution({
      jobId: `${routed.offer.id}-${Date.now()}`,
      hourlyRateUsd: routed.hourlyPriceUsd,
      estimatedDurationHours: routed.estimatedDurationHours,
      estimatedCostUsd: routed.estimatedTotalCostUsd,
      spendingCapUsd: cap.capUsd,
    });
    if (timer.current) clearInterval(timer.current);
    setRun({ report, label: `${routed.offer.gpuModel} ×${routed.gpusUsed} · ${routed.offer.provider}` });
    setStep(0);
    const total = report.timeline.length;
    const increment = Math.max(1, Math.ceil(total / 60));
    timer.current = setInterval(() => {
      setStep((s) => {
        const next = Math.min(total - 1, s + increment);
        if (next >= total - 1 && timer.current) clearInterval(timer.current);
        return next;
      });
    }, 70);
  }

  const report = run?.report;
  const tick = report?.timeline[step];
  const done = report ? step >= report.timeline.length - 1 : false;
  const r = report?.reconciliation;

  return (
    <section className="rounded-md border border-[#A5A79B]/25 bg-[#0D1B2E]/80 p-6 backdrop-blur-xl shadow-xl font-sans space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold text-[#FAF4EB] font-display">Usage-Based Billing (Simulation)</h2>
          <p className="text-xs text-[#A5A79B]">
            Stage 0: no GPU runs and no payment is made. The &quot;actual&quot; run is simulated and billed per second
            against your approved spending cap.
          </p>
        </div>
        <span className="rounded-sm border border-[#E8D2B5]/40 px-2 py-1 text-[10px] font-bold uppercase text-[#E8D2B5] font-display">
          Simulated
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto] items-end">
        <label className="block space-y-1">
          <span className="text-[11px] uppercase tracking-wider text-[#A5A79B] font-display">
            Approved maximum spend (USD) · estimate {usd(routed.estimatedTotalCostUsd)}
          </span>
          <input
            type="number"
            min={0}
            step={0.01}
            className="field"
            value={capInput}
            onChange={(e) => setCapOverride(e.target.value)}
          />
        </label>
        <button
          type="button"
          onClick={start}
          className="rounded-sm bg-[#E8D2B5] px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-[#1E3A5F] hover:bg-[#FAF4EB] font-display"
        >
          Approve cap & simulate run
        </button>
      </div>
      {error && <p className="text-xs text-[#E8D2B5]">{error}</p>}
      {Number(capInput) > 0 && Number(capInput) < routed.estimatedTotalCostUsd && (
        <p className="text-xs text-[#E8D2B5]">
          This cap is below the estimated cost, so the job will likely be stopped before it finishes.
        </p>
      )}

      {report && tick && (
        <div className="space-y-3 rounded-sm border border-[#A5A79B]/25 bg-[#091424]/90 p-4">
          <div className="flex justify-between text-xs font-mono text-[#E8D2B5]">
            <span>{run?.label}</span>
            <span>
              simulated {hrs(tick.elapsedSeconds / 3600)} · accrued {usd(tick.accumulatedUsd)} / cap {usd(report.spendingCapUsd)}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-sm bg-[#070F1C] border border-[#A5A79B]/20">
            <div
              className="h-full bg-[#E8D2B5] transition-all"
              style={{ width: `${Math.min(100, (tick.accumulatedUsd / report.spendingCapUsd) * 100)}%` }}
            />
          </div>

          {done && r && (
            <div className="space-y-3 pt-2">
              <p className="text-sm font-bold text-[#FAF4EB] font-display">
                {report.status === "completed"
                  ? "Simulated run completed"
                  : `Stopped at spending cap · ${(report.completedFraction * 100).toFixed(0)}% of the job done`}
              </p>
              <table className="w-full text-xs">
                <thead className="text-left text-[#A5A79B] uppercase tracking-wider font-display">
                  <tr><th className="py-1"></th><th>Estimated</th><th>Simulated actual</th></tr>
                </thead>
                <tbody className="font-mono text-[#E8D2B5]">
                  <tr><td className="py-1 font-sans text-[#A5A79B]">Duration</td><td>{hrs(r.estimatedDurationHours)}</td><td>{hrs(r.actualDurationHours)}</td></tr>
                  <tr><td className="py-1 font-sans text-[#A5A79B]">Cost</td><td>{usd(r.estimatedCostUsd)}</td><td>{usd(r.billedCostUsd)}</td></tr>
                </tbody>
              </table>
              <p className="text-xs text-[#E8D2B5]">
                {r.outcome === "stopped_at_cap" && "Execution was halted before the cap could be exceeded. "}
                {r.outcome === "within_tolerance" && "Actual cost landed within 5% of the estimate. "}
                {r.outcome === "under_estimated" && `The estimate was low by ${usd(r.deltaUsd)} (${r.deltaPct.toFixed(1)}%). `}
                {r.outcome === "over_estimated" && `The estimate was high by ${usd(-r.deltaUsd)} (${(-r.deltaPct).toFixed(1)}%). `}
                Final bill {usd(r.billedCostUsd)}; {usd(r.unusedAuthorizationUsd)} of the approved cap was not used.
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
