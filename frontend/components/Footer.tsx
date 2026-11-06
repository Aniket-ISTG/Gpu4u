"use client";

import React from "react";
import { CpuIcon } from "./icons";

export default function Footer() {
  return (
    <footer className="mt-16 border-t border-[#A5A79B]/20 bg-[#08111E]/90 py-10 text-xs text-[#A5A79B] font-sans">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col md:flex-row items-center justify-between gap-6">
        
        {/* Left: Brand info */}
        <div className="flex items-center gap-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-sm bg-[#1E3A5F] border border-[#E8D2B5]/30 text-[#E8D2B5]">
            <CpuIcon className="w-4 h-4 text-[#E8D2B5]" />
          </div>
          <div>
            <p className="font-bold text-[#FAF4EB] font-display">
              GPU4U · Compute Router Engine
            </p>
            <p className="text-[11px] text-[#A5A79B]">
              Intelligent workload routing across decentralized compute providers.
            </p>
          </div>
        </div>

        {/* Middle: Architecture badge */}
        <div className="flex items-center gap-4 text-[11px] font-mono">
          <span className="flex items-center gap-1.5 text-[#E8D2B5]">
            <span className="h-1.5 w-1.5 rounded-sm bg-[#E8D2B5]"></span>
            Weighted Scoring
          </span>
          <span className="flex items-center gap-1.5 text-[#E8D2B5]">
            <span className="h-1.5 w-1.5 rounded-sm bg-[#A5A79B]"></span>
            Structured Schema
          </span>
          <span className="flex items-center gap-1.5 text-[#E8D2B5]">
            <span className="h-1.5 w-1.5 rounded-sm bg-[#1E3A5F]"></span>
            Multi-Provider Mesh
          </span>
        </div>

        {/* Right: Copyright */}
        <div className="text-[11px] text-[#A5A79B] font-mono">
          Editorial Swiss & Bauhaus Compute Architecture
        </div>
      </div>
    </footer>
  );
}
