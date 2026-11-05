
"use client";

import { useEffect, useMemo, useState } from "react";
import WorkloadAnalyzer from "@/components/WorkloadAnalyzer";
import type { GPUOffer } from "@/lib/marketplace/types";

export default function Home() {
  const [offers, setOffers] = useState<GPUOffer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [minMemory, setMinMemory] = useState(16);
  const [maxPrice, setMaxPrice] = useState(2);
  const [gpuCount, setGpuCount] = useState(1);

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

  const rankedOffers = useMemo(() => {
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

  return (
    <main className="min-h-screen bg-zinc-950 text-white p-8">
      <div className="max-w-7xl mx-auto space-y-8">

        <header>
          <p className="text-cyan-400 text-sm font-semibold">
            DECENTRALIZED COMPUTE INFRASTRUCTURE
          </p>
          <h1 className="text-4xl font-bold mt-2">
            Compute Router
          </h1>
          <p className="text-zinc-400 mt-2">
            Discover and intelligently route GPU workloads.
          </p>
        </header>

        <WorkloadAnalyzer />

        {error && (
          <div className="bg-red-950 border border-red-800 p-4 rounded-xl">
            {error}
          </div>
        )}

        <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Stat label="Total GPU Offers" value={offers.length} />
          <Stat
            label="Available Offers"
            value={offers.filter((o) => o.available).length}
          />
          <Stat
            label="GPU Providers"
            value={new Set(offers.map((o) => o.provider)).size}
          />
        </section>

        <section className="border border-zinc-800 rounded-2xl p-6 space-y-5">
          <h2 className="text-xl font-semibold">
            Configure Workload
          </h2>

          <div className="grid md:grid-cols-3 gap-5">
            <Field label="Minimum GPU Memory (GB)">
              <input
                type="number"
                min="1"
                value={minMemory}
                onChange={(e) => setMinMemory(Number(e.target.value))}
                className="field"
              />
            </Field>

            <Field label="Maximum Budget ($ / hour)">
              <input
                type="number"
                min="0.01"
                step="0.1"
                value={maxPrice}
                onChange={(e) => setMaxPrice(Number(e.target.value))}
                className="field"
              />
            </Field>

            <Field label="Required GPU Count">
              <input
                type="number"
                min="1"
                value={gpuCount}
                onChange={(e) => setGpuCount(Number(e.target.value))}
                className="field"
              />
            </Field>
          </div>
        </section>

        <section className="border border-zinc-800 rounded-2xl p-6">
          <div className="flex justify-between items-center mb-5">
            <h2 className="text-xl font-semibold">
              Optimal Recommendation
            </h2>
            <span className="text-xs text-cyan-400">
              ROUTER ENGINE
            </span>
          </div>

          {loading ? (
            <p className="text-zinc-400">Loading marketplace...</p>
          ) : winner ? (
            <div className="bg-cyan-950/20 border border-cyan-700/40 rounded-xl p-5">
              <div className="flex justify-between flex-wrap gap-4">
                <div>
                  <p className="text-cyan-400 text-sm">
                    BEST MATCH
                  </p>
                  <h3 className="text-2xl font-bold mt-2">
                    {winner.gpuModel}
                  </h3>
                  <p className="text-zinc-400">
                    {winner.provider} · {winner.region}
                  </p>
                </div>

                <div className="text-right">
                  <p className="text-3xl font-bold">
                    ${winner.estimatedCost.toFixed(3)}
                  </p>
                  <p className="text-zinc-400 text-sm">
                    Estimated hourly cost
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
                <Metric label="GPU Memory" value={`${winner.vramGb} GB`} />
                <Metric label="GPU Count" value={winner.gpuCount} />
                <Metric label="Router Score" value={`${winner.score.toFixed(1)}/100`} />
                <Metric label="Availability" value="Available" />
              </div>

              <p className="text-sm text-zinc-300 mt-5">
                Selected because it satisfies your workload requirements
                and has the best weighted cost-memory score among eligible
                offers.
              </p>
            </div>
          ) : (
            <p className="text-zinc-400">
              No GPU offers satisfy your current requirements.
              Try adjusting your budget or memory requirements.
            </p>
          )}
        </section>

        <section className="border border-zinc-800 rounded-2xl overflow-hidden">
          <div className="p-6 flex justify-between">
            <h2 className="text-xl font-semibold">
              Marketplace Offers
            </h2>
            <span className="text-zinc-500 text-sm">
              Simulated mock data · {rankedOffers.length} matching offers
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-zinc-900 text-zinc-400">
                <tr>
                  {["GPU", "Provider", "Memory", "Count", "Region",
                    "Price / GPU / hr", "Status", "Score"].map((h) => (
                    <th key={h} className="p-4 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={8} className="p-6 text-center text-zinc-400">
                      Loading...
                    </td>
                  </tr>
                ) : rankedOffers.length ? (
                  rankedOffers.map((offer, index) => (
                    <tr
                      key={`${offer.provider}-${offer.id}-${index}`}
                      className="border-t border-zinc-800 hover:bg-zinc-900"
                    >
                      <td className="p-4 font-medium">{offer.gpuModel}</td>
                      <td className="p-4">{offer.provider}</td>
                      <td className="p-4">{offer.vramGb} GB</td>
                      <td className="p-4">{offer.gpuCount}</td>
                      <td className="p-4">{offer.region}</td>
                      <td className="p-4">
                        ${offer.pricePerHourUsd.toFixed(3)}
                      </td>
                      <td className="p-4 text-green-400">Available</td>
                      <td className="p-4 text-cyan-400 font-semibold">
                        {(offer.score).toFixed(1)}
                        {index === 0 && " ★"}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={8} className="p-6 text-center text-zinc-400">
                      No matching offers.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="border border-zinc-800 rounded-xl p-5">
      <p className="text-zinc-400 text-sm">{label}</p>
      <p className="text-3xl font-bold mt-2">{value}</p>
    </div>
  );
}

function Field({ label, children }: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="space-y-2 block">
      <span className="text-sm text-zinc-400">{label}</span>
      {children}
    </label>
  );
}

function Metric({ label, value }: {
  label: string;
  value: string | number;
}) {
  return (
    <div className="bg-zinc-900 rounded-lg p-3">
      <p className="text-zinc-500 text-xs">{label}</p>
      <p className="font-semibold mt-1">{value}</p>
    </div>
  );
}
