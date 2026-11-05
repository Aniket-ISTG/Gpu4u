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
      helper: "Synchronized across 3 networks",
      icon: ServerIcon,
      color: "text-blue-400",
      bgGlow: "from-blue-500/10 to-transparent",
    },
    {
      label: "Active Available Nodes",
      value: loading ? "..." : availableOffers.toString(),
      helper: loading
        ? "Scanning..."
        : `${Math.round((availableOffers / (totalOffers || 1)) * 100)}% online ready to bind`,
      icon: ActivityIcon,
      color: "text-emerald-400",
      bgGlow: "from-emerald-500/10 to-transparent",
    },
    {
      label: "Decentralized Providers",
      value: loading ? "..." : uniqueProviders.toString(),
      helper: "Northstar, Vector, Orbit",
      icon: GlobeIcon,
      color: "text-purple-400",
      bgGlow: "from-purple-500/10 to-transparent",
    },
    {
      label: "Floor Compute Rate",
      value: loading ? "..." : `$${lowestRate.toFixed(2)}/hr`,
      helper: "Starting at RTX 3090 / L4 tiers",
      icon: DollarIcon,
      color: "text-cyan-400",
      bgGlow: "from-cyan-500/10 to-transparent",
    },
  ];

  return (
    <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
      {stats.map((stat) => {
        const Icon = stat.icon;
        return (
          <div
            key={stat.label}
            className="group relative overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-4 transition-all duration-200 hover:border-zinc-700/80 hover:bg-zinc-900/70"
          >
            <div
              className={`absolute -right-4 -top-4 w-20 h-20 rounded-full bg-gradient-to-br ${stat.bgGlow} blur-xl opacity-60 group-hover:opacity-100 transition-opacity`}
            />
            <div className="relative flex items-center justify-between">
              <span className="text-xs font-medium text-zinc-400">{stat.label}</span>
              <span className={`p-1.5 rounded-lg bg-zinc-800/60 border border-zinc-700/40 ${stat.color}`}>
                <Icon className="w-3.5 h-3.5" />
              </span>
            </div>
            <div className="relative mt-2">
              <span className="text-2xl font-bold tracking-tight text-white font-mono tabular-nums">
                {stat.value}
              </span>
              <p className="mt-1 text-[11px] text-zinc-500 truncate">{stat.helper}</p>
            </div>
          </div>
        );
      })}
    </section>
  );
}
