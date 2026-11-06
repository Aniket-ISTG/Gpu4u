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
    <section className="relative overflow-hidden rounded-md border border-[#A5A79B]/25 bg-[#0D1B2E]/80 p-6 backdrop-blur-xl font-sans shadow-2xl">
      {/* Decorative top lighting */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-transparent via-[#E8D2B5]/50 to-transparent" />
      
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-sm bg-[#1E3A5F] text-[#E8D2B5] border border-[#E8D2B5]/30">
              <ZapIcon className="w-3.5 h-3.5 text-[#E8D2B5]" />
            </span>
            <span className="text-xs font-bold tracking-widest uppercase text-[#E8D2B5] font-display">
              Router Optimization Engine
            </span>
          </div>
          <h2 className="mt-1 text-xl font-bold tracking-tight text-[#FAF4EB] font-display">
            Optimal Match Recommendation
          </h2>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-[#A5A79B] font-mono">
            Weighted Score: 65% Cost · 35% VRAM
          </span>
        </div>
      </div>

      {loading ? (
        <div className="animate-shimmer rounded-md border border-[#A5A79B]/20 bg-[#0B1627]/60 p-8 space-y-4">
          <div className="h-6 w-1/3 bg-[#112540] rounded-sm"></div>
          <div className="h-10 w-1/2 bg-[#112540] rounded-sm"></div>
          <div className="grid grid-cols-4 gap-4 pt-4">
            <div className="h-16 bg-[#112540] rounded-sm"></div>
            <div className="h-16 bg-[#112540] rounded-sm"></div>
            <div className="h-16 bg-[#112540] rounded-sm"></div>
            <div className="h-16 bg-[#112540] rounded-sm"></div>
          </div>
        </div>
      ) : winner ? (
        <div className="relative overflow-hidden rounded-md border border-[#E8D2B5]/35 bg-gradient-to-br from-[#122643] via-[#0E1D32] to-[#091424] p-6 shadow-[0_0_50px_-15px_rgba(25, 55, 97, 0.7)]">
          
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 pb-6 border-b border-[#A5A79B]/20">
            {/* Left spec info */}
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-sm bg-[#E8D2B5] text-[#1E3A5F] font-display">
                  <SparklesIcon className="w-3 h-3 text-[#1E3A5F]" />
                  Best Match
                </span>
                <span className="inline-flex items-center gap-1 text-[11px] font-mono font-medium px-2 py-0.5 rounded-sm bg-[#1E3A5F] text-[#FAF4EB] border border-[#A5A79B]/30">
                  {winner.region}
                </span>
                {winner.cudaSupported && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-mono font-medium px-2 py-0.5 rounded-sm bg-[#0C192A] text-[#E8D2B5] border border-[#E8D2B5]/30">
                    <CheckIcon className="w-3 h-3 text-[#E8D2B5]" />
                    CUDA 12.x
                  </span>
                )}
              </div>

              <h3 className="text-3xl font-extrabold tracking-tight text-[#FAF4EB] font-display flex items-center gap-3">
                {winner.gpuModel}
                <span className="text-sm font-normal text-[#A5A79B] font-sans">
                  hosted by <strong className="text-[#E8D2B5]">{winner.provider}</strong>
                </span>
              </h3>

              <p className="text-xs text-[#A5A79B] max-w-xl font-sans">
                Satisfies workload requirements with maximum price efficiency and highest memory headroom score.
              </p>
            </div>

            {/* Right cost & action */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center lg:items-end gap-5">
              <div className="lg:text-right space-y-0.5">
                <div className="flex items-baseline gap-1 lg:justify-end">
                  <span className="text-3xl sm:text-4xl font-extrabold text-[#FAF4EB] font-display tabular-nums">
                    ${winner.estimatedCost.toFixed(3)}
                  </span>
                  <span className="text-xs text-[#A5A79B]">/ hour</span>
                </div>
                <p className="text-[11px] text-[#A5A79B] font-mono">
                  ~${(winner.estimatedCost * 24).toFixed(2)}/day · ~${(winner.estimatedCost * 24 * 30).toFixed(0)}/month
                </p>
              </div>

              <button
                type="button"
                onClick={() => onDeploy(winner)}
                className="inline-flex items-center gap-2 rounded-sm bg-[#E8D2B5] px-5 py-2.5 text-sm font-bold text-[#1E3A5F] font-display shadow-lg transition-all duration-200 hover:bg-[#FAF4EB] active:scale-95"
              >
                <TerminalIcon className="w-4 h-4 text-[#1E3A5F]" />
                <span>Deploy Workload</span>
              </button>
            </div>
          </div>

          {/* Metrics Row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5 pt-6">
            <div className="rounded-sm border border-[#A5A79B]/20 bg-[#0B1627]/80 p-3.5">
              <span className="text-[11px] font-bold text-[#A5A79B] font-display uppercase tracking-wider">VRAM Capacity</span>
              <p className="mt-1 text-lg font-bold text-[#FAF4EB] font-display">
                {winner.vramGb} GB
              </p>
              <span className="text-[10px] text-[#E8D2B5] font-mono">
                +{winner.vramGb - minMemory >= 0 ? `${winner.vramGb - minMemory}GB buffer` : "exact match"}
              </span>
            </div>

            <div className="rounded-sm border border-[#A5A79B]/20 bg-[#0B1627]/80 p-3.5">
              <span className="text-[11px] font-bold text-[#A5A79B] font-display uppercase tracking-wider">Allocated Nodes</span>
              <p className="mt-1 text-lg font-bold text-[#FAF4EB] font-display">
                {winner.gpuCount} {winner.gpuCount === 1 ? "GPU" : "GPUs"}
              </p>
              <span className="text-[10px] text-[#A5A79B] font-mono">
                Dedicated PCIe / NVLink
              </span>
            </div>

            <div className="rounded-sm border border-[#A5A79B]/20 bg-[#0B1627]/80 p-3.5">
              <span className="text-[11px] font-bold text-[#A5A79B] font-display uppercase tracking-wider">Router Score</span>
              <div className="flex items-baseline gap-1 mt-1">
                <span className="text-lg font-bold text-[#E8D2B5] font-display">
                  {winner.score.toFixed(1)}
                </span>
                <span className="text-xs text-[#A5A79B]">/ 100</span>
              </div>
              <span className="text-[10px] text-[#E8D2B5] font-mono">
                ★ Highest ranked offer
              </span>
            </div>

            <div className="rounded-sm border border-[#A5A79B]/20 bg-[#0B1627]/80 p-3.5">
              <span className="text-[11px] font-bold text-[#A5A79B] font-display uppercase tracking-wider">Provider Trust</span>
              <p className="mt-1 text-lg font-bold text-[#FAF4EB] font-display">
                {winner.reliabilityScore ?? 95}%
              </p>
              <span className="text-[10px] text-[#A5A79B] font-mono">
                99.9% Historical SLA
              </span>
            </div>
          </div>

        </div>
      ) : (
        <div className="rounded-sm border border-dashed border-[#A5A79B]/30 bg-[#0C192A]/50 p-8 text-center space-y-3">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-sm bg-[#1E3A5F] text-[#E8D2B5]">
            <CpuIcon className="w-6 h-6 text-[#E8D2B5]" />
          </div>
          <h3 className="text-base font-bold text-[#FAF4EB] font-display">
            No GPU offers satisfy your current criteria
          </h3>
          <p className="text-xs text-[#A5A79B] max-w-md mx-auto">
            Try adjusting your constraint sliders above: reduce minimum VRAM ({minMemory}GB) or increase hourly budget (${maxPrice.toFixed(2)}/hr).
          </p>
        </div>
      )}
    </section>
  );
}
