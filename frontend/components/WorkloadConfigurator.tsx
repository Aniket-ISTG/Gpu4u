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
    <section className="relative overflow-hidden rounded-md border border-[#A5A79B]/25 bg-[#0D1B2E]/80 p-6 backdrop-blur-xl transition-all shadow-xl font-sans">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#A5A79B]/20 pb-4 mb-5">
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-sm bg-[#1E3A5F] text-[#E8D2B5] border border-[#E8D2B5]/30">
            <SlidersIcon className="w-4 h-4 text-[#E8D2B5]" />
          </span>
          <div>
            <h2 className="text-lg font-bold tracking-tight text-[#FAF4EB] font-display">
              Routing Constraints & Parameters
            </h2>
            <p className="text-xs text-[#A5A79B]">
              Tune matching parameters to query the decentralized mesh in real-time.
            </p>
          </div>
        </div>

        {onReset && (
          <button
            type="button"
            onClick={onReset}
            className="text-xs font-mono text-[#E8D2B5] hover:text-[#FAF4EB] transition-colors underline-offset-4 hover:underline"
          >
            Reset to defaults
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Min Memory */}
        <div className="space-y-3 rounded-sm border border-[#A5A79B]/25 bg-[#0B1627]/80 p-4">
          <div className="flex justify-between items-center">
            <span className="text-xs font-bold uppercase tracking-wider text-[#A5A79B] font-display">
              Min VRAM Memory
            </span>
            <span className="font-mono text-sm font-bold text-[#FAF4EB] bg-[#1E3A5F] px-2 py-0.5 rounded-sm border border-[#E8D2B5]/30">
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
              className="w-full accent-[#E8D2B5] cursor-pointer h-1.5 bg-[#112643] rounded-sm appearance-none"
            />
          </div>

          <div className="flex items-center justify-between gap-1.5 pt-1">
            {MEMORY_PRESETS.map((val) => (
              <button
                key={val}
                type="button"
                onClick={() => setMinMemory(val)}
                className={`flex-1 py-1 rounded-sm text-xs font-mono font-medium transition-all ${
                  minMemory === val
                    ? "bg-[#E8D2B5] text-[#1E3A5F] font-bold shadow-sm"
                    : "bg-[#0F213B] text-[#A5A79B] hover:text-[#FAF4EB] hover:bg-[#152C4D]"
                }`}
              >
                {val}G
              </button>
            ))}
          </div>
        </div>

        {/* Max Budget */}
        <div className="space-y-3 rounded-sm border border-[#A5A79B]/25 bg-[#0B1627]/80 p-4">
          <div className="flex justify-between items-center">
            <span className="text-xs font-bold uppercase tracking-wider text-[#A5A79B] font-display">
              Max Hourly Budget
            </span>
            <span className="font-mono text-sm font-bold text-[#FAF4EB] bg-[#1E3A5F] px-2 py-0.5 rounded-sm border border-[#E8D2B5]/30">
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
              className="w-full accent-[#E8D2B5] cursor-pointer h-1.5 bg-[#112643] rounded-sm appearance-none"
            />
          </div>

          <div className="flex items-center justify-between gap-1.5 pt-1">
            {PRICE_PRESETS.map((val) => (
              <button
                key={val}
                type="button"
                onClick={() => setMaxPrice(val)}
                className={`flex-1 py-1 rounded-sm text-xs font-mono font-medium transition-all ${
                  maxPrice === val
                    ? "bg-[#E8D2B5] text-[#1E3A5F] font-bold shadow-sm"
                    : "bg-[#0F213B] text-[#A5A79B] hover:text-[#FAF4EB] hover:bg-[#152C4D]"
                }`}
              >
                ${val.toFixed(val >= 1 ? 0 : 2)}
              </button>
            ))}
          </div>
        </div>

        {/* GPU Count */}
        <div className="space-y-3 rounded-sm border border-[#A5A79B]/25 bg-[#0B1627]/80 p-4">
          <div className="flex justify-between items-center">
            <span className="text-xs font-bold uppercase tracking-wider text-[#A5A79B] font-display">
              Required GPU Count
            </span>
            <span className="font-mono text-sm font-bold text-[#FAF4EB] bg-[#1E3A5F] px-2 py-0.5 rounded-sm border border-[#E8D2B5]/30">
              {gpuCount} {gpuCount === 1 ? "GPU" : "GPUs"}
            </span>
          </div>

          <div className="flex items-center justify-between gap-2 pt-3">
            {COUNT_PRESETS.map((cnt) => (
              <button
                key={cnt}
                type="button"
                onClick={() => setGpuCount(cnt)}
                className={`flex-1 py-2 rounded-sm text-xs font-mono font-bold transition-all ${
                  gpuCount === cnt
                    ? "bg-[#E8D2B5] text-[#1E3A5F] shadow-md"
                    : "bg-[#0F213B] text-[#A5A79B] hover:text-[#FAF4EB] hover:bg-[#152C4D]"
                }`}
              >
                {cnt}x
              </button>
            ))}
          </div>

          <p className="text-[11px] text-[#A5A79B] text-center pt-1 font-mono">
            {gpuCount > 1 ? "NVLink / PCIe Peer-to-Peer Fabric" : "Discrete Accelerator Host"}
          </p>
        </div>
      </div>
    </section>
  );
}
