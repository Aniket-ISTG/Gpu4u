"use client";

import React from "react";
import type { GPUOffer } from "@/lib/marketplace/types";
import { ServerIcon, ActivityIcon, GlobeIcon, DollarIcon } from "./icons";

interface StatsOverviewProps {
  offers: GPUOffer[];
  loading: boolean;
}

export default function StatsOverview({ offers, loading }: StatsOverviewProps) {
  const totalOffers = offers.length;
  const availableOffers = offers.filter((o) => o.available).length;
  const uniqueProviders = new Set(offers.map((o) => o.provider)).size;
  const lowestRate = offers.length
    ? Math.min(...offers.map((o) => o.pricePerHourUsd))
    : 0;

  const stats = [
    {
      label: "Total Marketplace Offers",
      value: loading ? "..." : totalOffers.toString(),
      helper: "Synchronized across 3 providers",
      icon: ServerIcon,
      accent: "text-[#E8D2B5]",
      border: "border-[#A5A79B]/30",
    },
    {
      label: "Active Available Nodes",
      value: loading ? "..." : availableOffers.toString(),
      helper: loading
        ? "Scanning..."
        : `${Math.round((availableOffers / (totalOffers || 1)) * 100)}% online ready to bind`,
      icon: ActivityIcon,
      accent: "text-[#E8D2B5]",
      border: "border-[#A5A79B]/30",
    },
    {
      label: "Decentralized Providers",
      value: loading ? "..." : uniqueProviders.toString(),
      helper: "Northstar, Vector, Orbit",
      icon: GlobeIcon,
      accent: "text-[#A5A79B]",
      border: "border-[#A5A79B]/30",
    },
    {
      label: "Floor Compute Rate",
      value: loading ? "..." : `$${lowestRate.toFixed(2)}/hr`,
      helper: "Starting at RTX 3090 / L4 tiers",
      icon: DollarIcon,
      accent: "text-[#E8D2B5]",
      border: "border-[#E8D2B5]/35",
    },
  ];

  return (
    <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
      {stats.map((stat) => {
        const Icon = stat.icon;
        return (
          <div
            key={stat.label}
            className="group relative overflow-hidden rounded-md border border-[#A5A79B]/25 bg-[#0E1D33]/75 p-4.5 transition-all duration-200 hover:border-[#E8D2B5]/50 hover:bg-[#112540]/85 shadow-lg"
          >
            {/* Square top accent line */}
            <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-transparent via-[#E8D2B5]/30 to-transparent group-hover:via-[#E8D2B5]/80 transition-all" />

            <div className="relative flex items-center justify-between">
              <span className="text-xs font-semibold text-[#A5A79B] font-display uppercase tracking-wider">
                {stat.label}
              </span>
              <span className="p-1.5 rounded-sm bg-[#1E3A5F] border border-[#A5A79B]/30 text-[#E8D2B5]">
                <Icon className="w-3.5 h-3.5" />
              </span>
            </div>
            <div className="relative mt-2.5">
              <span className="text-2xl font-bold tracking-tight text-[#FAF4EB] font-display tabular-nums">
                {stat.value}
              </span>
              <p className="mt-1 text-[11px] text-[#A5A79B] truncate font-sans">
                {stat.helper}
              </p>
            </div>
          </div>
        );
      })}
    </section>
  );
}
