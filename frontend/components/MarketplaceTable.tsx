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
    <section className="relative overflow-hidden rounded-md border border-[#A5A79B]/25 bg-[#0D1B2E]/80 backdrop-blur-xl transition-all shadow-2xl font-sans">
      {/* Header & Controls Toolbar */}
      <div className="p-5 sm:p-6 border-b border-[#A5A79B]/20 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-sm bg-[#1E3A5F] text-[#E8D2B5] border border-[#E8D2B5]/30">
                <GlobeIcon className="w-3.5 h-3.5 text-[#E8D2B5]" />
              </span>
              <h2 className="text-xl font-bold tracking-tight text-[#FAF4EB] font-display">
                Live Compute Marketplace
              </h2>
            </div>
            <p className="mt-0.5 text-xs text-[#A5A79B]">
              Discover and compare verified compute nodes across the decentralized network.
            </p>
          </div>

          <div className="flex items-center gap-2 self-start sm:self-auto">
            <span className="text-xs text-[#A5A79B] font-mono">
              {filteredOffers.length} of {offers.length} offers matching
            </span>
            <div className="flex items-center rounded-sm bg-[#070F1C] p-1 border border-[#A5A79B]/30">
              <button
                type="button"
                onClick={() => setViewMode("table")}
                className={`p-1.5 rounded-sm transition-colors ${
                  viewMode === "table"
                    ? "bg-[#1E3A5F] text-[#E8D2B5]"
                    : "text-[#A5A79B] hover:text-[#FAF4EB]"
                }`}
                title="Table View"
              >
                <ListIcon className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setViewMode("grid")}
                className={`p-1.5 rounded-sm transition-colors ${
                  viewMode === "grid"
                    ? "bg-[#1E3A5F] text-[#E8D2B5]"
                    : "text-[#A5A79B] hover:text-[#FAF4EB]"
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
            <SearchIcon className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#A5A79B]" />
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
                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[#A5A79B] hover:text-[#FAF4EB]"
              >
                ✕
              </button>
            )}
          </div>

          {/* Sort selector */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-[#A5A79B] font-display uppercase tracking-wider hidden lg:inline">
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
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-sm text-xs font-display uppercase tracking-wider border transition-all ${
              availableOnly
                ? "bg-[#1E3A5F] border-[#E8D2B5]/50 text-[#E8D2B5]"
                : "bg-[#0A1424] border-[#A5A79B]/30 text-[#A5A79B] hover:text-[#FAF4EB] hover:border-[#E8D2B5]/40"
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                availableOnly ? "bg-[#E8D2B5]" : "bg-[#A5A79B]/50"
              }`}
            />
            <span>Available Only</span>
          </button>
        </div>
      </div>

      {/* Content: Table or Grid */}
      {loading ? (
        <div className="p-12 text-center text-[#A5A79B]">
          <div className="mx-auto flex h-10 w-10 animate-spin items-center justify-center rounded-full border-2 border-[#E8D2B5] border-t-transparent" />
          <p className="mt-3 text-xs font-mono">Querying marketplace provider nodes...</p>
        </div>
      ) : filteredOffers.length === 0 ? (
        <div className="p-12 text-center text-[#A5A79B] space-y-2">
          <p className="text-sm font-bold text-[#FAF4EB] font-display">
            No matching offers found
          </p>
          <p className="text-xs text-[#A5A79B]">
            Try adjusting your search criteria, availability toggle, or router constraints.
          </p>
        </div>
      ) : viewMode === "table" ? (
        /* Table View */
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left border-collapse">
            <thead className="bg-[#070F1C]/90 text-[#A5A79B] border-b border-[#A5A79B]/25 uppercase tracking-wider text-[11px] font-display">
              <tr>
                <th className="p-4 font-bold">GPU Model</th>
                <th className="p-4 font-bold">Provider</th>
                <th className="p-4 font-bold">Memory</th>
                <th className="p-4 font-bold">Count</th>
                <th className="p-4 font-bold">Region</th>
                <th className="p-4 font-bold">Total Cost</th>
                <th className="p-4 font-bold">Status</th>
                <th className="p-4 font-bold">Router Score</th>
                <th className="p-4 font-bold text-right">Action</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-[#A5A79B]/15 font-sans">
              {filteredOffers.map((offer, index) => {
                const isBest = index === 0 && sortBy === "score";
                return (
                  <tr
                    key={`${offer.provider}-${offer.id}-${index}`}
                    className={`transition-colors hover:bg-[#112540]/60 ${
                      isBest ? "bg-[#122745]/50" : ""
                    }`}
                  >
                    {/* Model */}
                    <td className="p-4 font-medium text-[#FAF4EB] whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <span className="p-1.5 rounded-sm bg-[#1E3A5F] text-[#E8D2B5] border border-[#E8D2B5]/25">
                          <CpuIcon className="w-3.5 h-3.5 text-[#E8D2B5]" />
                        </span>
                        <div>
                          <div className="flex items-center gap-1.5 font-bold font-display text-sm">
                            <span>{offer.gpuModel}</span>
                            {isBest && (
                              <span className="text-[10px] bg-[#E8D2B5] text-[#1E3A5F] font-bold px-1.5 py-0.2 rounded-sm font-display">
                                #1
                              </span>
                            )}
                          </div>
                          <span className="text-[10px] text-[#A5A79B] font-mono">
                            {offer.id}
                          </span>
                        </div>
                      </div>
                    </td>

                    {/* Provider */}
                    <td className="p-4 text-[#E8D2B5]/90 whitespace-nowrap font-sans">
                      <div className="flex items-center gap-1.5">
                        <span>{offer.provider}</span>
                        {offer.reliabilityScore && (
                          <span className="text-[10px] text-[#A5A79B] font-mono">
                            ({offer.reliabilityScore}%)
                          </span>
                        )}
                      </div>
                    </td>

                    {/* VRAM */}
                    <td className="p-4 font-mono font-medium text-[#FAF4EB] whitespace-nowrap">
                      {offer.vramGb} GB
                    </td>

                    {/* Count */}
                    <td className="p-4 font-mono text-[#E8D2B5] whitespace-nowrap">
                      {offer.gpuCount}x
                    </td>

                    {/* Region */}
                    <td className="p-4 text-[#A5A79B] whitespace-nowrap">
                      <span className="rounded-sm bg-[#070F1C] px-2 py-0.5 border border-[#A5A79B]/25 font-mono text-[11px] text-[#FAF4EB]">
                        {offer.region}
                      </span>
                    </td>

                    {/* Price */}
                    <td className="p-4 font-display font-bold text-[#FAF4EB] whitespace-nowrap">
                      ${offer.estimatedCost.toFixed(3)}/hr
                      <div className="text-[10px] text-[#A5A79B] font-normal font-mono">
                        ${offer.pricePerHourUsd.toFixed(3)}/gpu
                      </div>
                    </td>

                    {/* Status */}
                    <td className="p-4 whitespace-nowrap font-display uppercase tracking-wider text-[11px]">
                      {offer.available ? (
                        <span className="inline-flex items-center gap-1.5 text-[#E8D2B5] font-bold">
                          <span className="h-1.5 w-1.5 rounded-full bg-[#E8D2B5] animate-pulse" />
                          Ready
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-[#A5A79B]">
                          <span className="h-1.5 w-1.5 rounded-full bg-[#A5A79B]/50" />
                          Allocated
                        </span>
                      )}
                    </td>

                    {/* Score */}
                    <td className="p-4 font-mono whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <span
                          className={`font-bold font-display ${
                            isBest ? "text-[#E8D2B5]" : "text-[#FAF4EB]"
                          }`}
                        >
                          {offer.score.toFixed(1)}
                        </span>
                        <div className="w-12 h-1.5 rounded-sm bg-[#070F1C] overflow-hidden border border-[#A5A79B]/20">
                          <div
                            className={`h-full ${
                              isBest ? "bg-[#E8D2B5]" : "bg-[#A5A79B]"
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
                        className="inline-flex items-center gap-1 rounded-sm border border-[#E8D2B5]/40 bg-[#1E3A5F] px-2.5 py-1 text-[11px] font-bold text-[#E8D2B5] hover:border-[#E8D2B5] hover:text-[#FAF4EB] hover:bg-[#22477B] transition-colors font-display uppercase tracking-wider"
                      >
                        <TerminalIcon className="w-3 h-3 text-[#E8D2B5]" />
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
                className={`relative overflow-hidden rounded-sm border p-4 transition-all duration-200 hover:border-[#E8D2B5]/50 ${
                  isBest
                    ? "border-[#E8D2B5]/50 bg-[#122643]"
                    : "border-[#A5A79B]/25 bg-[#0B1627]/90"
                }`}
              >
                {isBest && (
                  <div className="absolute top-0 right-0 rounded-bl-sm bg-[#E8D2B5] px-2 py-0.5 text-[10px] font-bold text-[#1E3A5F] font-display">
                    ★ #1 MATCH
                  </div>
                )}

                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="p-1.5 rounded-sm bg-[#1E3A5F] border border-[#E8D2B5]/30 text-[#E8D2B5]">
                      <CpuIcon className="w-4 h-4 text-[#E8D2B5]" />
                    </span>
                    <div>
                      <h4 className="font-bold text-[#FAF4EB] text-sm font-display">
                        {offer.gpuModel}
                      </h4>
                      <p className="text-[11px] text-[#A5A79B] font-sans">{offer.provider}</p>
                    </div>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-sm bg-[#0C1A2E] p-2 border border-[#A5A79B]/15">
                    <span className="text-[10px] font-display uppercase tracking-wider text-[#A5A79B]">Memory</span>
                    <p className="font-mono font-bold text-[#FAF4EB]">
                      {offer.vramGb} GB
                    </p>
                  </div>
                  <div className="rounded-sm bg-[#0C1A2E] p-2 border border-[#A5A79B]/15">
                    <span className="text-[10px] font-display uppercase tracking-wider text-[#A5A79B]">GPUs</span>
                    <p className="font-mono font-bold text-[#FAF4EB]">
                      {offer.gpuCount}x
                    </p>
                  </div>
                  <div className="rounded-sm bg-[#0C1A2E] p-2 border border-[#A5A79B]/15">
                    <span className="text-[10px] font-display uppercase tracking-wider text-[#A5A79B]">Region</span>
                    <p className="font-mono text-[#E8D2B5]">{offer.region}</p>
                  </div>
                  <div className="rounded-sm bg-[#0C1A2E] p-2 border border-[#A5A79B]/15">
                    <span className="text-[10px] font-display uppercase tracking-wider text-[#A5A79B]">Router Score</span>
                    <p className="font-display font-bold text-[#E8D2B5]">
                      {offer.score.toFixed(1)}/100
                    </p>
                  </div>
                </div>

                <div className="mt-4 flex items-center justify-between border-t border-[#A5A79B]/20 pt-3">
                  <div>
                    <span className="text-base font-extrabold text-[#FAF4EB] font-display">
                      ${offer.estimatedCost.toFixed(3)}
                    </span>
                    <span className="text-[11px] text-[#A5A79B]">/hr</span>
                  </div>

                  <button
                    type="button"
                    onClick={() => onSelectOffer(offer)}
                    className="inline-flex items-center gap-1.5 rounded-sm bg-[#1E3A5F] border border-[#E8D2B5]/40 px-3 py-1.5 text-xs font-bold text-[#E8D2B5] hover:bg-[#E8D2B5] hover:text-[#1E3A5F] transition-all font-display uppercase tracking-wider active:scale-95"
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
