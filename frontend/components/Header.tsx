"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CpuIcon, SparklesIcon } from "./icons";

interface HeaderProps {
  offersCount: number;
}

const NAV = [
  { href: "/", label: "Home" },
  { href: "/get-started", label: "Get Started" },
];

export default function Header({ offersCount }: HeaderProps) {
  const pathname = usePathname();
  return (
    <header className="relative border-b border-[#A5A79B]/25 bg-[#0B1728]/80 backdrop-blur-xl sticky top-0 z-40 transition-all">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        
        {/* Logo and Brand */}
        <div className="flex items-center gap-3">
          <div className="relative flex items-center justify-center w-9 h-9 rounded-md bg-[#1E3A5F] border border-[#E8D2B5]/40 text-[#E8D2B5] shadow-[0_0_20px_-3px_rgba(25,55,97,0.8)]">
            <CpuIcon className="w-5 h-5 text-[#E8D2B5]" />
            <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#E8D2B5] opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#E8D2B5]"></span>
            </span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-extrabold text-xl tracking-tight text-[#FAF4EB] font-display flex items-center gap-1">
                GPU<span className="text-[#E8D2B5]">4U</span>
              </span>
              <span className="hidden sm:inline-flex items-center text-[10px] font-bold tracking-widest uppercase px-2 py-0.5 rounded-sm bg-[#1E3A5F] text-[#E8D2B5] border border-[#A5A79B]/30 font-display">
                Compute Router
              </span>
            </div>
            <p className="hidden md:block text-[11px] text-[#A5A79B] tracking-tight leading-none mt-0.5">
              Decentralized Peer-to-Peer GPU Infrastructure
            </p>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex items-center gap-1 font-display text-sm">
          {NAV.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`px-3 py-1.5 rounded-md transition-colors ${
                  item.href === "/get-started"
                    ? "bg-[#E8D2B5] text-[#0B1728] font-bold hover:bg-[#FAF4EB]"
                    : active
                      ? "text-[#E8D2B5] bg-[#1E3A5F]/70"
                      : "text-[#A5A79B] hover:text-[#FAF4EB]"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Network & Live Status */}
        <div className="flex items-center gap-3 sm:gap-4 font-sans">
          <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-md bg-[#0F213B]/90 border border-[#A5A79B]/30 text-xs">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#E8D2B5] opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-[#E8D2B5]"></span>
            </span>
            <span className="text-[#A5A79B]">Mesh Network:</span>
            <span className="font-bold text-[#E8D2B5]">Operational</span>
          </div>

          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#1E3A5F]/80 border border-[#E8D2B5]/40 text-xs text-[#E8D2B5]">
            <SparklesIcon className="w-3.5 h-3.5 text-[#E8D2B5]" />
            <span className="font-mono font-bold">{offersCount}</span>
            <span className="text-[#E8D2B5]/80">nodes synced</span>
          </div>
        </div>

      </div>
    </header>
  );
}
