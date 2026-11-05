"use client";

import React from "react";
import type { GPUOffer } from "@/lib/marketplace/types";
import { SparklesIcon, CheckIcon, CpuIcon, TerminalIcon, ZapIcon } from "./icons";

export interface RankedGPUOffer extends GPUOffer {
  estimatedCost: number;
  score: number;
}

interface OptimalMatchHeroProps {
  winner: RankedGPUOffer | undefined;
  loading: boolean;
  minMemory: number;
  maxPrice: number;
  onDeploy: (offer: RankedGPUOffer) => void;
}

export default function OptimalMatchHero({
  winner,
  loading,
  minMemory,
  maxPrice,
  onDeploy,
}: OptimalMatchHeroProps) {
  return (
    <section className="relative overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-6 backdrop-blur-xl">
      {/* Decorative top lighting */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-500/50 to-transparent" />
      
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-cyan-500/20 text-cyan-400">
              <ZapIcon className="w-3.5 h-3.5" />
            </span>
            <span className="text-xs font-semibold tracking-wider uppercase text-cyan-400">
              Router Optimization Engine
            </span>
          </div>
          <h2 className="mt-1 text-xl font-bold tracking-tight text-white">
            Top Routed Recommendation
          </h2>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-400 font-mono">
            Weighted Score: 65% Price · 35% VRAM
          </span>
        </div>
      </div>

      {loading ? (
        <div className="animate-shimmer rounded-xl border border-zinc-800 bg-zinc-900/60 p-8 space-y-4">
          <div className="h-6 w-1/3 bg-zinc-800 rounded"></div>
          <div className="h-10 w-1/2 bg-zinc-800 rounded"></div>
          <div className="grid grid-cols-4 gap-4 pt-4">
            <div className="h-16 bg-zinc-800 rounded"></div>
            <div className="h-16 bg-zinc-800 rounded"></div>
            <div className="h-16 bg-zinc-800 rounded"></div>
            <div className="h-16 bg-zinc-800 rounded"></div>
          </div>
        </div>
      ) : winner ? (
        <div className="relative overflow-hidden rounded-xl border border-cyan-500/30 bg-gradient-to-br from-cyan-950/30 via-zinc-900/80 to-zinc-900/60 p-6 shadow-[0_0_50px_-15px_rgba(6,182,212,0.15)]">
          
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 pb-6 border-b border-zinc-800/80">
            {/* Left spec info */}
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-cyan-400 text-zinc-950">
                  <SparklesIcon className="w-3 h-3" />
                  Best Match
                </span>
                <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-300 border border-zinc-700">
                  {winner.region}
                </span>
                {winner.cudaSupported && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-950/60 text-emerald-300 border border-emerald-800/60">
                    <CheckIcon className="w-3 h-3 text-emerald-400" />
                    CUDA 12.x
                  </span>
                )}
              </div>

              <h3 className="text-3xl font-extrabold tracking-tight text-white flex items-center gap-3">
                {winner.gpuModel}
                <span className="text-sm font-normal text-zinc-400">
                  by <strong className="text-zinc-200">{winner.provider}</strong>
                </span>
              </h3>

              <p className="text-xs text-zinc-400 max-w-xl">
                Satisfies workload requirements with maximum price efficiency and highest memory headroom score.
              </p>
            </div>

            {/* Right cost & action */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center lg:items-end gap-5">
              <div className="lg:text-right space-y-0.5">
                <div className="flex items-baseline gap-1 lg:justify-end">
                  <span className="text-3xl sm:text-4xl font-extrabold text-white font-mono">
                    ${winner.estimatedCost.toFixed(3)}
                  </span>
                  <span className="text-xs text-zinc-400">/ hour</span>
                </div>
                <p className="text-[11px] text-zinc-500 font-mono">
                  ~${(winner.estimatedCost * 24).toFixed(2)}/day · ~${(winner.estimatedCost * 24 * 30).toFixed(0)}/month
                </p>
              </div>

              <button
                type="button"
                onClick={() => onDeploy(winner)}
                className="inline-flex items-center gap-2 rounded-xl bg-cyan-500 px-5 py-2.5 text-sm font-bold text-zinc-950 shadow-lg shadow-cyan-500/25 transition-all duration-200 hover:bg-cyan-400 hover:shadow-cyan-500/40 active:scale-95"
              >
                <TerminalIcon className="w-4 h-4 text-zinc-950" />
                <span>Deploy Workload</span>
              </button>
            </div>
          </div>

          {/* Metrics Row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5 pt-6">
            <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/80 p-3.5">
              <span className="text-[11px] font-medium text-zinc-400">VRAM Capacity</span>
              <p className="mt-1 text-lg font-bold text-white font-mono">
                {winner.vramGb} GB
              </p>
              <span className="text-[10px] text-emerald-400">
                +{winner.vramGb - minMemory >= 0 ? `${winner.vramGb - minMemory}GB buffer` : "exact match"}
              </span>
            </div>

            <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/80 p-3.5">
              <span className="text-[11px] font-medium text-zinc-400">Allocated Nodes</span>
              <p className="mt-1 text-lg font-bold text-white font-mono">
                {winner.gpuCount} {winner.gpuCount === 1 ? "GPU" : "GPUs"}
              </p>
              <span className="text-[10px] text-zinc-400">
                Dedicated PCIe / NVLink
              </span>
            </div>

            <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/80 p-3.5">
              <span className="text-[11px] font-medium text-zinc-400">Router Score</span>
              <div className="flex items-baseline gap-1 mt-1">
                <span className="text-lg font-bold text-cyan-400 font-mono">
                  {winner.score.toFixed(1)}
                </span>
                <span className="text-xs text-zinc-500">/ 100</span>
              </div>
              <span className="text-[10px] text-cyan-400 font-medium">
                ★ Highest ranked offer
              </span>
            </div>

            <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/80 p-3.5">
              <span className="text-[11px] font-medium text-zinc-400">Provider Trust</span>
              <p className="mt-1 text-lg font-bold text-emerald-400 font-mono">
                {winner.reliabilityScore ?? 95}%
              </p>
              <span className="text-[10px] text-zinc-400">
                99.9% Historical SLA
              </span>
            </div>
          </div>

        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/20 p-8 text-center space-y-3">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-zinc-800/80 text-zinc-400">
            <CpuIcon className="w-6 h-6" />
          </div>
          <h3 className="text-base font-semibold text-zinc-200">
            No GPU offers satisfy your current criteria
          </h3>
          <p className="text-xs text-zinc-400 max-w-md mx-auto">
            Try adjusting your constraint sliders above: reduce minimum VRAM ({minMemory}GB) or increase hourly budget (${maxPrice.toFixed(2)}/hr).
          </p>
        </div>
      )}
    </section>
  );
}
