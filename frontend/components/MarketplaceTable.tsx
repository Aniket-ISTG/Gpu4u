"use client";

import React, { useState, useMemo } from "react";
import type { RankedGPUOffer } from "./OptimalMatchHero";
import {
  SearchIcon,
  GridIcon,
  ListIcon,
  CpuIcon,
  GlobeIcon,
  TerminalIcon,
} from "./icons";

interface MarketplaceTableProps {
  offers: RankedGPUOffer[];
  loading: boolean;
  onSelectOffer: (offer: RankedGPUOffer) => void;
}

type SortField = "score" | "price" | "vram" | "reliability";
type ViewMode = "table" | "grid";

export default function MarketplaceTable({
  offers,
  loading,
  onSelectOffer,
}: MarketplaceTableProps) {
  const [search, setSearch] = useState("");
  const [availableOnly, setAvailableOnly] = useState(false);
  const [sortBy, setSortBy] = useState<SortField>("score");
  const [viewMode, setViewMode] = useState<ViewMode>("table");

  // Filter and sort offers
  const filteredOffers = useMemo(() => {
    let result = [...offers];

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (o) =>
          o.gpuModel.toLowerCase().includes(q) ||
          o.provider.toLowerCase().includes(q) ||
          o.region.toLowerCase().includes(q) ||
          o.id.toLowerCase().includes(q)
      );
    }

    if (availableOnly) {
      result = result.filter((o) => o.available);
    }

    result.sort((a, b) => {
      switch (sortBy) {
        case "score":
          return b.score - a.score;
        case "price":
          return a.estimatedCost - b.estimatedCost;
        case "vram":
          return b.vramGb - a.vramGb;
        case "reliability":
          return (b.reliabilityScore ?? 0) - (a.reliabilityScore ?? 0);
        default:
          return 0;
      }
    });

    return result;
  }, [offers, search, availableOnly, sortBy]);

  return (
    <section className="relative overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-900/30 backdrop-blur-xl transition-all">
      {/* Header & Controls Toolbar */}
      <div className="p-5 sm:p-6 border-b border-zinc-800/80 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-md bg-purple-500/10 text-purple-400">
                <GlobeIcon className="w-3.5 h-3.5" />
              </span>
              <h2 className="text-xl font-bold tracking-tight text-white">
                Live Compute Marketplace
              </h2>
            </div>
            <p className="mt-0.5 text-xs text-zinc-400">
              Discover and compare verified compute nodes across the decentralized network.
            </p>
          </div>

          <div className="flex items-center gap-2 self-start sm:self-auto">
            <span className="text-xs text-zinc-400 font-mono">
              {filteredOffers.length} of {offers.length} offers matching
            </span>
            <div className="flex items-center rounded-lg bg-zinc-950 p-1 border border-zinc-800">
              <button
                type="button"
                onClick={() => setViewMode("table")}
                className={`p-1.5 rounded-md transition-colors ${
                  viewMode === "table"
                    ? "bg-zinc-800 text-white"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
                title="Table View"
              >
                <ListIcon className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setViewMode("grid")}
                className={`p-1.5 rounded-md transition-colors ${
                  viewMode === "grid"
                    ? "bg-zinc-800 text-white"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
                title="Card Grid View"
              >
                <GridIcon className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Filters and search row */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          {/* Search bar */}
          <div className="relative flex-1">
            <SearchIcon className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by GPU (e.g. H100, RTX 4090), provider, or region..."
              className="field pl-10 pr-4 py-2 text-xs"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-zinc-500 hover:text-white"
              >
                ✕
              </button>
            )}
          </div>

          {/* Sort selector */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500 font-medium whitespace-nowrap hidden lg:inline">
              Sort by:
            </span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortField)}
              className="field py-2 text-xs font-medium cursor-pointer w-auto"
            >
              <option value="score">Ranked Router Score</option>
              <option value="price">Cost: Low to High</option>
              <option value="vram">VRAM: High to Low</option>
              <option value="reliability">Provider Trust</option>
            </select>
          </div>

          {/* Availability toggle */}
          <button
            type="button"
            onClick={() => setAvailableOnly(!availableOnly)}
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium border transition-all ${
              availableOnly
                ? "bg-emerald-950/40 border-emerald-700/60 text-emerald-300"
                : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-700"
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                availableOnly ? "bg-emerald-400" : "bg-zinc-600"
              }`}
            />
            <span>Available Only</span>
          </button>
        </div>
      </div>

      {/* Content: Table or Grid */}
      {loading ? (
        <div className="p-12 text-center text-zinc-400">
          <div className="mx-auto flex h-10 w-10 animate-spin items-center justify-center rounded-full border-2 border-cyan-500 border-t-transparent" />
          <p className="mt-3 text-xs">Querying marketplace provider nodes...</p>
        </div>
      ) : filteredOffers.length === 0 ? (
        <div className="p-12 text-center text-zinc-400 space-y-2">
          <p className="text-sm font-semibold text-zinc-300">
            No matching offers found
          </p>
          <p className="text-xs text-zinc-500">
            Try adjusting your search criteria, availability toggle, or router constraints.
          </p>
        </div>
      ) : viewMode === "table" ? (
        /* Table View */
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left border-collapse">
            <thead className="bg-zinc-950/80 text-zinc-400 border-b border-zinc-800/80 uppercase tracking-wider text-[11px] font-mono">
              <tr>
                <th className="p-4 font-semibold">GPU Model</th>
                <th className="p-4 font-semibold">Provider</th>
                <th className="p-4 font-semibold">Memory</th>
                <th className="p-4 font-semibold">Count</th>
                <th className="p-4 font-semibold">Region</th>
                <th className="p-4 font-semibold">Total Cost</th>
                <th className="p-4 font-semibold">Status</th>
                <th className="p-4 font-semibold">Router Score</th>
                <th className="p-4 font-semibold text-right">Action</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-zinc-800/60 font-sans">
              {filteredOffers.map((offer, index) => {
                const isBest = index === 0 && sortBy === "score";
                return (
                  <tr
                    key={`${offer.provider}-${offer.id}-${index}`}
                    className={`transition-colors hover:bg-zinc-800/40 ${
                      isBest ? "bg-cyan-950/15" : ""
                    }`}
                  >
                    {/* Model */}
                    <td className="p-4 font-medium text-white whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <span className="p-1 rounded bg-zinc-800/80 text-cyan-400">
                          <CpuIcon className="w-3.5 h-3.5" />
                        </span>
                        <div>
                          <div className="flex items-center gap-1.5 font-bold">
                            <span>{offer.gpuModel}</span>
                            {isBest && (
                              <span className="text-[10px] bg-cyan-400 text-zinc-950 font-bold px-1.5 py-0.2 rounded">
                                #1
                              </span>
                            )}
                          </div>
                          <span className="text-[10px] text-zinc-500 font-mono">
                            {offer.id}
                          </span>
                        </div>
                      </div>
                    </td>

                    {/* Provider */}
                    <td className="p-4 text-zinc-300 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <span>{offer.provider}</span>
                        {offer.reliabilityScore && (
                          <span className="text-[10px] text-emerald-400 font-mono">
                            ({offer.reliabilityScore}%)
                          </span>
                        )}
                      </div>
                    </td>

                    {/* VRAM */}
                    <td className="p-4 font-mono font-medium text-zinc-200 whitespace-nowrap">
                      {offer.vramGb} GB
                    </td>

                    {/* Count */}
                    <td className="p-4 font-mono text-zinc-300 whitespace-nowrap">
                      {offer.gpuCount}x
                    </td>

                    {/* Region */}
                    <td className="p-4 text-zinc-400 whitespace-nowrap">
                      <span className="rounded bg-zinc-950 px-2 py-0.5 border border-zinc-800 font-mono text-[11px]">
                        {offer.region}
                      </span>
                    </td>

                    {/* Price */}
                    <td className="p-4 font-mono font-bold text-white whitespace-nowrap">
                      ${offer.estimatedCost.toFixed(3)}/hr
                      <div className="text-[10px] text-zinc-500 font-normal">
                        ${offer.pricePerHourUsd.toFixed(3)}/gpu
                      </div>
                    </td>

                    {/* Status */}
                    <td className="p-4 whitespace-nowrap">
                      {offer.available ? (
                        <span className="inline-flex items-center gap-1.5 text-emerald-400 font-medium">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                          Ready
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-zinc-500">
                          <span className="h-1.5 w-1.5 rounded-full bg-zinc-600" />
                          Allocated
                        </span>
                      )}
                    </td>

                    {/* Score */}
                    <td className="p-4 font-mono whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <span
                          className={`font-bold ${
                            isBest ? "text-cyan-400" : "text-zinc-200"
                          }`}
                        >
                          {offer.score.toFixed(1)}
                        </span>
                        <div className="w-12 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                          <div
                            className={`h-full ${
                              isBest ? "bg-cyan-400" : "bg-zinc-500"
                            }`}
                            style={{ width: `${Math.min(offer.score, 100)}%` }}
                          />
                        </div>
                      </div>
                    </td>

                    {/* Action */}
                    <td className="p-4 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => onSelectOffer(offer)}
                        className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-[11px] font-medium text-zinc-200 hover:border-cyan-500/60 hover:text-white hover:bg-zinc-700 transition-colors"
                      >
                        <TerminalIcon className="w-3 h-3 text-cyan-400" />
                        <span>Deploy</span>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        /* Card Grid View (ideal for responsive mobile or cards layout) */
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 p-5 sm:p-6">
          {filteredOffers.map((offer, index) => {
            const isBest = index === 0 && sortBy === "score";
            return (
              <div
                key={`${offer.provider}-${offer.id}-${index}`}
                className={`relative overflow-hidden rounded-xl border p-4 transition-all duration-200 hover:border-zinc-700 ${
                  isBest
                    ? "border-cyan-500/40 bg-cyan-950/20"
                    : "border-zinc-800 bg-zinc-950/60"
                }`}
              >
                {isBest && (
                  <div className="absolute top-0 right-0 rounded-bl-lg bg-cyan-400 px-2 py-0.5 text-[10px] font-bold text-zinc-950">
                    ★ #1 MATCH
                  </div>
                )}

                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="p-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-cyan-400">
                      <CpuIcon className="w-4 h-4" />
                    </span>
                    <div>
                      <h4 className="font-bold text-white text-sm">
                        {offer.gpuModel}
                      </h4>
                      <p className="text-[11px] text-zinc-400">{offer.provider}</p>
                    </div>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-lg bg-zinc-900/80 p-2">
                    <span className="text-[10px] text-zinc-500">Memory</span>
                    <p className="font-mono font-bold text-zinc-200">
                      {offer.vramGb} GB
                    </p>
                  </div>
                  <div className="rounded-lg bg-zinc-900/80 p-2">
                    <span className="text-[10px] text-zinc-500">GPUs</span>
                    <p className="font-mono font-bold text-zinc-200">
                      {offer.gpuCount}x
                    </p>
                  </div>
                  <div className="rounded-lg bg-zinc-900/80 p-2">
                    <span className="text-[10px] text-zinc-500">Region</span>
                    <p className="font-mono text-zinc-300">{offer.region}</p>
                  </div>
                  <div className="rounded-lg bg-zinc-900/80 p-2">
                    <span className="text-[10px] text-zinc-500">Router Score</span>
                    <p className="font-mono font-bold text-cyan-400">
                      {offer.score.toFixed(1)}/100
                    </p>
                  </div>
                </div>

                <div className="mt-4 flex items-center justify-between border-t border-zinc-800/80 pt-3">
                  <div>
                    <span className="text-base font-extrabold text-white font-mono">
                      ${offer.estimatedCost.toFixed(3)}
                    </span>
                    <span className="text-[11px] text-zinc-400">/hr</span>
                  </div>

                  <button
                    type="button"
                    onClick={() => onSelectOffer(offer)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/30 px-3 py-1.5 text-xs font-semibold text-cyan-300 hover:bg-cyan-500 hover:text-zinc-950 transition-all active:scale-95"
                  >
                    <TerminalIcon className="w-3.5 h-3.5" />
                    <span>Deploy</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
