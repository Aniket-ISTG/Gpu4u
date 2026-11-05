"use client";

import React from "react";
import { CpuIcon, SparklesIcon } from "./icons";

interface HeaderProps {
  offersCount: number;
}

export default function Header({ offersCount }: HeaderProps) {
  return (
    <header className="relative border-b border-zinc-800/80 bg-zinc-950/70 backdrop-blur-xl sticky top-0 z-40 transition-all">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        
        {/* Logo and Brand */}
        <div className="flex items-center gap-3">
          <div className="relative flex items-center justify-center w-9 h-9 rounded-xl bg-gradient-to-br from-cyan-500/20 to-blue-600/10 border border-cyan-500/30 text-cyan-400 shadow-[0_0_15px_-3px_rgba(6,182,212,0.3)]">
            <CpuIcon className="w-5 h-5" />
            <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500"></span>
            </span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-lg tracking-tight text-white flex items-center gap-1.5">
                GPU<span className="text-cyan-400">4U</span>
              </span>
              <span className="hidden sm:inline-flex items-center gap-1 text-[10px] font-semibold tracking-wider uppercase px-2 py-0.5 rounded-full bg-zinc-800/90 text-zinc-300 border border-zinc-700/50">
                Compute Router
              </span>
            </div>
            <p className="hidden md:block text-[11px] text-zinc-400 tracking-tight leading-none">
              Decentralized Intelligent GPU Orchestrator
            </p>
          </div>
        </div>

        {/* Network & Live Status */}
        <div className="flex items-center gap-3 sm:gap-4">
          <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-900/80 border border-zinc-800/80 text-xs">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            <span className="text-zinc-400">P2P Network:</span>
            <span className="font-medium text-emerald-400">Operational</span>
          </div>

          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-950/30 border border-cyan-800/40 text-xs text-cyan-300">
            <SparklesIcon className="w-3.5 h-3.5 text-cyan-400" />
            <span className="font-mono font-medium">{offersCount}</span>
            <span className="text-cyan-400/80">nodes live</span>
          </div>
        </div>

      </div>
    </header>
  );
}
