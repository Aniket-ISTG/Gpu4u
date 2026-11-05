"use client";

import React from "react";
import { CpuIcon } from "./icons";

export default function Footer() {
  return (
    <footer className="mt-16 border-t border-zinc-800/80 bg-zinc-950/80 py-10 text-xs text-zinc-500">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col md:flex-row items-center justify-between gap-6">
        
        {/* Left: Brand info */}
        <div className="flex items-center gap-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-zinc-900 border border-zinc-800 text-cyan-400">
            <CpuIcon className="w-4 h-4" />
          </div>
          <div>
            <p className="font-semibold text-zinc-300">
              GPU4U · Compute Router Engine
            </p>
            <p className="text-[11px] text-zinc-500">
              Intelligent workload routing across decentralized compute providers.
            </p>
          </div>
        </div>

        {/* Middle: Architecture badge */}
        <div className="flex items-center gap-4 text-[11px] font-mono">
          <span className="flex items-center gap-1 text-zinc-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
            Algorithmic Scoring
          </span>
          <span className="flex items-center gap-1 text-zinc-400">
            <span className="h-1.5 w-1.5 rounded-full bg-cyan-400"></span>
            Groq Structured Schema
          </span>
          <span className="flex items-center gap-1 text-zinc-400">
            <span className="h-1.5 w-1.5 rounded-full bg-purple-400"></span>
            Multi-Provider Mesh
          </span>
        </div>

        {/* Right: Copyright */}
        <div className="text-[11px] text-zinc-500">
          Designed with Linear & Vercel tier precision.
        </div>
      </div>
    </footer>
  );
}
