"use client";

import React from "react";
import type { RoutingResult, RoutedOffer } from "@/lib/routing/cost-ranking";

const MAX_ROWS = 25;

interface Props {
  result: RoutingResult;
  loading: boolean;
  optimization: "cost" | "performance" | "balanced";
  /** The offer currently open in the rent panel. */
  rentingOfferId?: string | null;
  onRent: (r: RoutedOffer) => void;
}

const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
function formatHours(h: number) {
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${h.toFixed(2)} h`;
}

export default function CostRankingTable({ result, loading, optimization, onRent, rentingOfferId }: Props) {
  const { ranked, rejected, selected } = result;

  return (
    <section className="rounded-md border border-[#A5A79B]/25 bg-[#0D1B2E]/80 backdrop-blur-xl shadow-2xl font-sans overflow-hidden">
      <div className="p-5 border-b border-[#A5A79B]/20 space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xl font-bold text-[#FAF4EB] font-display">Estimated Cost by GPU</h2>
          <span className="text-xs font-mono text-[#A5A79B]">
            {ranked.length} eligible · {rejected.length} excluded
          </span>
        </div>
        <p className="text-xs text-[#A5A79B]">
          Durations and totals are <strong className="text-[#E8D2B5]">estimates</strong> from an assumed performance
          model, not benchmarks. Total = hourly price × estimated duration. Ranked by{" "}
          {optimization === "cost" ? "lowest estimated total cost" : `routing score (${optimization})`}.
        </p>
      </div>

      {loading ? (
        <div className="p-8 text-sm text-[#A5A79B]">Loading offers…</div>
      ) : !ranked.length ? (
        <div className="p-8 text-sm text-[#E8D2B5] space-y-2">
          <p className="font-bold">No GPU satisfies these constraints.</p>
          <ul className="list-disc pl-5 text-xs text-[#A5A79B]">
            {rejected.slice(0, 4).map((r) => (
              <li key={r.offer.id}>
                {r.offer.gpuModel} · {r.offer.provider}: {r.reasons[0]}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left border-collapse">
            <thead className="bg-[#070F1C] text-[#A5A79B] uppercase tracking-wider text-[11px] font-display">
              <tr>
                <th className="p-3">GPU</th>
                <th className="p-3">Provider</th>
                <th className="p-3">Hourly</th>
                <th className="p-3">Est. duration</th>
                <th className="p-3">Est. total</th>
                <th className="p-3">Score</th>
                <th className="p-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#A5A79B]/15">
              {ranked.slice(0, MAX_ROWS).map((r) => {
                const best = r === selected;
                return (
                  <tr key={r.offer.id} className={best ? "bg-[#1E3A5F]/40" : "hover:bg-[#112540]/50"}>
                    <td className="p-3 font-bold text-[#FAF4EB]">
                      {r.offer.gpuModel} <span className="text-[#A5A79B] font-normal">×{r.gpusUsed}</span>
                      {best && (
                        <span className="ml-2 rounded-sm bg-[#E8D2B5] px-1.5 py-0.5 text-[10px] font-bold text-[#0B1728]">
                          SELECTED
                        </span>
                      )}
                    </td>
                    <td className="p-3 text-[#E8D2B5]">{r.offer.provider}</td>
                    <td className="p-3 font-mono text-[#E8D2B5]">{usd(r.hourlyPriceUsd)}/hr</td>
                    <td className="p-3 font-mono text-[#E8D2B5]" title={r.estimate.assumptions.join("\n")}>
                      ~{formatHours(r.estimatedDurationHours)}
                      {r.estimate.specBasis === "unknown-gpu-fallback" && (
                        <span className="ml-1.5 rounded-sm bg-[#1E3A5F] px-1 py-px text-[9px] text-[#E8D2B5]">
                          low confidence
                        </span>
                      )}
                    </td>
                    <td className="p-3 font-mono font-bold text-[#FAF4EB]">~{usd(r.estimatedTotalCostUsd)}</td>
                    <td className="p-3 font-mono text-[#E8D2B5]">{r.routingScore.toFixed(0)}</td>
                    <td className="p-3 text-right">
                      <button
                        type="button"
                        onClick={() => onRent(r)}
                        className="rounded-sm border border-[#E8D2B5]/40 bg-[#112540] px-2.5 py-1 font-bold text-[#E8D2B5] hover:bg-[#18335A] font-display"
                      >
                        {rentingOfferId === r.offer.id ? "Selected" : "Rent"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {ranked.length > MAX_ROWS && (
        <p className="border-t border-[#A5A79B]/20 p-3 text-center text-xs text-[#A5A79B]">
          Showing the best {MAX_ROWS} of {ranked.length} eligible offers.
        </p>
      )}
    </section>
  );
}
