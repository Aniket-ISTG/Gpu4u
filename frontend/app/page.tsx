"use client";

import { useEffect, useMemo, useState } from "react";
import Header from "@/components/Header";
import StatsOverview from "@/components/StatsOverview";
import WorkloadAnalyzer from "@/components/WorkloadAnalyzer";
import WorkloadConfigurator from "@/components/WorkloadConfigurator";
import OptimalMatchHero, { type RankedGPUOffer } from "@/components/OptimalMatchHero";
import MarketplaceTable from "@/components/MarketplaceTable";
import DeployModal from "@/components/DeployModal";
import Footer from "@/components/Footer";
import type { GPUOffer } from "@/lib/marketplace/types";

export default function Home() {
  const [offers, setOffers] = useState<GPUOffer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [minMemory, setMinMemory] = useState(16);
  const [maxPrice, setMaxPrice] = useState(2);
  const [gpuCount, setGpuCount] = useState(1);

  const [selectedOffer, setSelectedOffer] = useState<RankedGPUOffer | null>(null);

  useEffect(() => {
    async function loadOffers() {
      try {
        const response = await fetch("/api/marketplace");
        const data = await response.json();

        if (!response.ok || !data.success) {
          throw new Error(data.error || "Failed to fetch offers");
        }

        setOffers(data.offers);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Something went wrong"
        );
      } finally {
        setLoading(false);
      }
    }

    loadOffers();
  }, []);

  const rankedOffers: RankedGPUOffer[] = useMemo(() => {
    const eligible = offers.filter(
      (offer) =>
        offer.available &&
        offer.vramGb >= minMemory &&
        offer.gpuCount >= gpuCount &&
        offer.pricePerHourUsd * gpuCount <= maxPrice
    );

    if (!eligible.length) return [];

    const cheapest = Math.min(
      ...eligible.map((o) => o.pricePerHourUsd * gpuCount)
    );

    return eligible
      .map((offer) => {
        const cost = offer.pricePerHourUsd * gpuCount;

        // Price score: lower cost gets a higher score.
        const priceScore = (cheapest / cost) * 100;

        // Memory score: reward sufficient memory.
        const memoryScore = Math.min(
          (offer.vramGb / minMemory) * 50,
          100
        );

        // Weighted MVP score.
        const score =
          priceScore * 0.65 + memoryScore * 0.35;

        return {
          ...offer,
          estimatedCost: cost,
          score,
        };
      })
      .sort((a, b) => b.score - a.score);
  }, [offers, minMemory, maxPrice, gpuCount]);

  const winner = rankedOffers[0];

  function handleResetFilters() {
    setMinMemory(16);
    setMaxPrice(2);
    setGpuCount(1);
  }

  function handleApplyRequirements(reqs: {
    minMemory?: number;
    maxPrice?: number;
    gpuCount?: number;
  }) {
    if (reqs.minMemory !== undefined && reqs.minMemory !== null) {
      setMinMemory(reqs.minMemory);
    }
    if (reqs.maxPrice !== undefined && reqs.maxPrice !== null) {
      setMaxPrice(reqs.maxPrice);
    }
    if (reqs.gpuCount !== undefined && reqs.gpuCount !== null) {
      setGpuCount(reqs.gpuCount);
    }
  }

  return (
    <div className="min-h-screen flex flex-col relative text-[#FAF4EB] selection:bg-[#E8D2B5] selection:text-[#1E3A5F]">
      {/* Non-AI Ambient background with Sage Grey, Cream Beige, and Deep Navy */}
      <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
        {/* Subtle architectural square grid */}
        <div className="absolute inset-0 square-grid opacity-70" />
        
        {/* Top ambient warm cream beige wash */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1100px] h-[450px] bg-[radial-gradient(ellipse_60%_50%_at_50%_0%,rgba(232,210,181,0.22),transparent_75%)] blur-2xl" />
        
        {/* Flank atmospheric muted sage grey wash */}
        <div className="absolute top-[20%] -left-[100px] w-[600px] h-[600px] bg-[radial-gradient(circle,rgba(165,167,155,0.18),transparent_65%)] blur-3xl" />
        
        {/* Core deep navy bloom */}
        <div className="absolute top-[35%] -right-[100px] w-[700px] h-[700px] bg-[radial-gradient(circle,rgba(25, 55, 97, 0.55),transparent_70%)] blur-3xl" />
      </div>

      {/* Top Navigation */}
      <Header offersCount={offers.length} />

      {/* Main Content Area */}
      <main className="relative z-10 flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8 font-sans">
        
        {/* Hero Section Introduction */}
        <section className="space-y-3 pt-2">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-md bg-[#1E3A5F]/70 border border-[#E8D2B5]/30 text-xs font-semibold text-[#E8D2B5] tracking-wide">
            <span className="h-2 w-2 rounded-sm bg-[#E8D2B5] animate-pulse" />
            <span className="font-display uppercase tracking-wider text-[11px]">Decentralized Compute Protocol · v1.0</span>
          </div>
          
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold tracking-tight text-[#FAF4EB] font-display leading-tight">
            Intelligent GPU Routing & Discovery
          </h1>
          
          <p className="text-[#E8D2B5]/80 text-sm sm:text-base max-w-3xl leading-relaxed">
            Specify your artificial intelligence workload in plain natural language or configure custom hardware constraints. GPU4U dynamically queries verified peer compute providers to match you with the lowest cost, highest memory headroom nodes.
          </p>
        </section>

        {/* Global Stats Overview */}
        <StatsOverview offers={offers} loading={loading} />

        {/* Natural Language Workload Analyzer */}
        <WorkloadAnalyzer onApplySpecs={handleApplyRequirements} />

        {/* Error notification if any */}
        {error && (
          <div className="rounded-md border border-[#1E3A5F] bg-[#112643]/90 p-4 text-sm text-[#E8D2B5] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-bold text-[#FAF4EB]">Error:</span>
              <span>{error}</span>
            </div>
            <button
              onClick={() => window.location.reload()}
              className="text-xs text-[#E8D2B5] underline hover:text-white"
            >
              Retry
            </button>
          </div>
        )}

        {/* Workload Configuration Sliders */}
        <WorkloadConfigurator
          minMemory={minMemory}
          setMinMemory={setMinMemory}
          maxPrice={maxPrice}
          setMaxPrice={setMaxPrice}
          gpuCount={gpuCount}
          setGpuCount={setGpuCount}
          onReset={handleResetFilters}
        />

        {/* Optimal Match Hero Card */}
        <OptimalMatchHero
          winner={winner}
          loading={loading}
          minMemory={minMemory}
          maxPrice={maxPrice}
          onDeploy={(offer) => setSelectedOffer(offer)}
        />

        {/* Full Marketplace Offers Section */}
        <MarketplaceTable
          offers={rankedOffers}
          loading={loading}
          onSelectOffer={(offer) => setSelectedOffer(offer)}
        />

      </main>

      {/* Deploy / Provisioning Modal */}
      <DeployModal
        offer={selectedOffer}
        onClose={() => setSelectedOffer(null)}
      />

      {/* Footer */}
      <Footer />
    </div>
  );
}
