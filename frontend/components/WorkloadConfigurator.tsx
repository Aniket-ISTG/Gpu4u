"use client";

import React from "react";
import { SlidersIcon } from "./icons";

interface WorkloadConfiguratorProps {
  minMemory: number;
  setMinMemory: (val: number) => void;
  maxPrice: number;
  setMaxPrice: (val: number) => void;
  gpuCount: number;
  setGpuCount: (val: number) => void;
  onReset?: () => void;
}

const MEMORY_PRESETS = [16, 24, 40, 80];
const PRICE_PRESETS = [0.5, 1.0, 2.0, 5.0];
const COUNT_PRESETS = [1, 2, 4, 8];

export default function WorkloadConfigurator({
  minMemory,
  setMinMemory,
  maxPrice,
  setMaxPrice,
  gpuCount,
  setGpuCount,
  onReset,
}: WorkloadConfiguratorProps) {
  return (
    <section className="relative overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-6 backdrop-blur-xl transition-all">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800/80 pb-4 mb-5">
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
            <SlidersIcon className="w-4 h-4" />
          </span>
          <div>
            <h2 className="text-lg font-bold tracking-tight text-white">
              Routing Constraints & Filtering
            </h2>
            <p className="text-xs text-zinc-400">
              Tune matching parameters to query the decentralized mesh in real-time.
            </p>
          </div>
        </div>

        {onReset && (
          <button
            type="button"
            onClick={onReset}
            className="text-xs text-zinc-400 hover:text-white transition-colors underline-offset-4 hover:underline"
          >
            Reset to defaults
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Min Memory */}
        <div className="space-y-3 rounded-xl border border-zinc-800/60 bg-zinc-950/40 p-4">
          <div className="flex justify-between items-center">
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              Min VRAM Memory
            </span>
            <span className="font-mono text-sm font-bold text-cyan-400 bg-cyan-950/40 px-2 py-0.5 rounded border border-cyan-800/40">
              {minMemory} GB
            </span>
          </div>

          <div className="flex items-center gap-3">
            <input
              type="range"
              min="8"
              max="96"
              step="4"
              value={minMemory}
              onChange={(e) => setMinMemory(Number(e.target.value))}
              className="w-full accent-cyan-400 cursor-pointer h-1.5 bg-zinc-800 rounded-lg appearance-none"
            />
          </div>

          <div className="flex items-center justify-between gap-1.5 pt-1">
            {MEMORY_PRESETS.map((val) => (
              <button
                key={val}
                type="button"
                onClick={() => setMinMemory(val)}
                className={`flex-1 py-1 rounded text-xs font-mono font-medium transition-all ${
                  minMemory === val
                    ? "bg-cyan-500 text-zinc-950 font-bold shadow-sm shadow-cyan-500/20"
                    : "bg-zinc-800/80 text-zinc-400 hover:text-white hover:bg-zinc-700/80"
                }`}
              >
                {val}G
              </button>
            ))}
          </div>
        </div>

        {/* Max Budget */}
        <div className="space-y-3 rounded-xl border border-zinc-800/60 bg-zinc-950/40 p-4">
          <div className="flex justify-between items-center">
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              Max Hourly Budget
            </span>
            <span className="font-mono text-sm font-bold text-emerald-400 bg-emerald-950/40 px-2 py-0.5 rounded border border-emerald-800/40">
              ${maxPrice.toFixed(2)}/hr
            </span>
          </div>

          <div className="flex items-center gap-3">
            <input
              type="range"
              min="0.20"
              max="10.00"
              step="0.10"
              value={maxPrice}
              onChange={(e) => setMaxPrice(Number(e.target.value))}
              className="w-full accent-emerald-400 cursor-pointer h-1.5 bg-zinc-800 rounded-lg appearance-none"
            />
          </div>

          <div className="flex items-center justify-between gap-1.5 pt-1">
            {PRICE_PRESETS.map((val) => (
              <button
                key={val}
                type="button"
                onClick={() => setMaxPrice(val)}
                className={`flex-1 py-1 rounded text-xs font-mono font-medium transition-all ${
                  maxPrice === val
                    ? "bg-emerald-500 text-zinc-950 font-bold shadow-sm shadow-emerald-500/20"
                    : "bg-zinc-800/80 text-zinc-400 hover:text-white hover:bg-zinc-700/80"
                }`}
              >
                ${val.toFixed(val >= 1 ? 0 : 2)}
              </button>
            ))}
          </div>
        </div>

        {/* GPU Count */}
        <div className="space-y-3 rounded-xl border border-zinc-800/60 bg-zinc-950/40 p-4">
          <div className="flex justify-between items-center">
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              Required GPU Count
            </span>
            <span className="font-mono text-sm font-bold text-purple-400 bg-purple-950/40 px-2 py-0.5 rounded border border-purple-800/40">
              {gpuCount} {gpuCount === 1 ? "GPU" : "GPUs"}
            </span>
          </div>

          <div className="flex items-center justify-between gap-2 pt-3">
            {COUNT_PRESETS.map((cnt) => (
              <button
                key={cnt}
                type="button"
                onClick={() => setGpuCount(cnt)}
                className={`flex-1 py-2 rounded-lg text-xs font-mono font-bold transition-all ${
                  gpuCount === cnt
                    ? "bg-purple-500 text-zinc-950 shadow-md shadow-purple-500/20"
                    : "bg-zinc-800/80 text-zinc-400 hover:text-white hover:bg-zinc-700/80"
                }`}
              >
                {cnt}x
              </button>
            ))}
          </div>

          <p className="text-[11px] text-zinc-500 text-center pt-1 font-mono">
            {gpuCount > 1 ? "NVLink / PCIe Peer-to-Peer Interconnect" : "Single Accelerator Node"}
          </p>
        </div>
      </div>
    </section>
  );
}
