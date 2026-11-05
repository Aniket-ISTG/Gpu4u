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
    <div className="min-h-screen flex flex-col bg-zinc-950 text-zinc-100 selection:bg-cyan-500/20 selection:text-cyan-200">
      {/* Ambient background styling */}
      <div className="fixed inset-0 pointer-events-none z-0">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1000px] h-[400px] bg-[radial-gradient(ellipse_60%_50%_at_50%_0%,rgba(6,182,212,0.12),rgba(255,255,255,0))] blur-3xl opacity-75" />
      </div>

      {/* Top Navigation */}
      <Header offersCount={offers.length} />

      {/* Main Content Area */}
      <main className="relative z-10 flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        
        {/* Hero Section Introduction */}
        <section className="space-y-3 pt-2">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-cyan-950/40 border border-cyan-800/40 text-xs font-semibold text-cyan-300">
            <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-pulse" />
            <span>Decentralized Compute Protocol · v1.0</span>
          </div>
          
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold tracking-tight text-white leading-tight">
            Intelligent GPU Routing & Discovery
          </h1>
          
          <p className="text-zinc-400 text-sm sm:text-base max-w-3xl leading-relaxed">
            Specify your artificial intelligence workload in plain natural language or configure custom hardware constraints. GPU4U dynamically queries verified peer compute providers to match you with the lowest cost, highest memory headroom nodes.
          </p>
        </section>

        {/* Global Stats Overview */}
        <StatsOverview offers={offers} loading={loading} />

        {/* Natural Language Workload Analyzer */}
        <WorkloadAnalyzer onApplySpecs={handleApplyRequirements} />

        {/* Error notification if any */}
        {error && (
          <div className="rounded-xl border border-red-800 bg-red-950/50 p-4 text-sm text-red-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-bold">Error:</span>
              <span>{error}</span>
            </div>
            <button
              onClick={() => window.location.reload()}
              className="text-xs text-red-300 underline hover:text-white"
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
