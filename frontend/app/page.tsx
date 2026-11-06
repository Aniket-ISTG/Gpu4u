"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import Header from "@/components/Header";
import AmbientBackground from "@/components/AmbientBackground";
import StatsOverview from "@/components/StatsOverview";
import MarketplaceTable from "@/components/MarketplaceTable";
import DeployModal from "@/components/DeployModal";
import Footer from "@/components/Footer";
import type { RankedGPUOffer } from "@/components/OptimalMatchHero";
import { useMarketplace } from "@/hooks/useMarketplace";
import { browseOffers } from "@/lib/marketplace/ranking";

export default function Home() {
  const { offers, loading, error, lastUpdated } = useMarketplace();
  const [selectedOffer, setSelectedOffer] = useState<RankedGPUOffer | null>(null);
  const browsable = useMemo(() => browseOffers(offers), [offers]);

  return (
    <div className="min-h-screen flex flex-col relative text-[#FAF4EB] selection:bg-[#E8D2B5] selection:text-[#1E3A5F]">
      <AmbientBackground />
      <Header offersCount={offers.length} />

      <main className="relative z-10 flex-1 w-full mx-auto px-4 sm:px-6 lg:px-8 py-12 space-y-10 font-sans">
        {/* About GPU4U (centered) */}
        <section className="max-w-3xl mx-auto text-center space-y-5">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-md bg-[#1E3A5F]/70 border border-[#E8D2B5]/30 text-xs font-semibold text-[#E8D2B5] tracking-wide">
            <span className="h-2 w-2 rounded-sm bg-[#E8D2B5] animate-pulse" />
            <span className="font-display uppercase tracking-wider text-[11px]">Decentralized Compute Protocol · v1.0</span>
          </div>

          <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-[#FAF4EB] font-display leading-tight">
            About GPU4U
          </h1>

          <p className="text-[#E8D2B5]/80 text-base leading-relaxed">
            GPU4U is an intelligent GPU routing and discovery layer. Describe your AI workload in plain language or set hardware constraints, and GPU4U queries verified peer compute providers to match you with the lowest cost, highest memory headroom nodes.
          </p>

          <div className="grid gap-3 sm:grid-cols-3 text-sm text-[#A5A79B]">
            <div className="rounded-md border border-[#A5A79B]/25 bg-[#0D1B2E]/60 p-4"><span className="block font-display text-[#E8D2B5] mb-1">Describe</span>Write your task in natural language.</div>
            <div className="rounded-md border border-[#A5A79B]/25 bg-[#0D1B2E]/60 p-4"><span className="block font-display text-[#E8D2B5] mb-1">Match</span>We turn it into structured requirements.</div>
            <div className="rounded-md border border-[#A5A79B]/25 bg-[#0D1B2E]/60 p-4"><span className="block font-display text-[#E8D2B5] mb-1">Deploy</span>Pick the best-ranked live node.</div>
          </div>

          <Link
            href="/get-started"
            className="inline-flex items-center rounded-md bg-[#E8D2B5] px-6 py-2.5 font-display font-bold text-[#0B1728] hover:bg-[#FAF4EB] transition-colors"
          >
            Get Started
          </Link>
        </section>

        <div className="max-w-6xl mx-auto w-full space-y-6">
          <StatsOverview offers={offers} loading={loading} />

          {error && (
            <div className="rounded-md border border-[#1E3A5F] bg-[#112643]/90 p-4 text-sm text-[#E8D2B5]">
              <span className="font-bold text-[#FAF4EB]">Error:</span> {error}
            </div>
          )}

          <div className="flex items-center justify-center gap-2 text-[11px] font-mono text-[#A5A79B]">
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>
              Live feed · refreshes every 5s
              {lastUpdated ? ` · updated ${lastUpdated.toLocaleTimeString()}` : ""}
            </span>
          </div>

          <MarketplaceTable
            offers={browsable}
            loading={loading}
            onSelectOffer={(offer) => setSelectedOffer(offer)}
          />
        </div>
      </main>

      <DeployModal offer={selectedOffer} onClose={() => setSelectedOffer(null)} />
      <Footer />
    </div>
  );
}
