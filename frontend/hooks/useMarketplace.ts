"use client";

import { useEffect, useState } from "react";
import type { GPUOffer, MarketplaceSnapshot } from "@/lib/marketplace/types";

/** Everything in the API response except the offers themselves. */
export type MarketplaceMeta = Omit<MarketplaceSnapshot, "offers">;

export function useMarketplace(intervalMs = 30_000) {
  const [offers, setOffers] = useState<GPUOffer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [stale, setStale] = useState(false);
  const [meta, setMeta] = useState<MarketplaceMeta | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch("/api/marketplace");
        const data = await response.json();
        if (!response.ok || !data.success) {
          throw new Error(data.error || "Failed to fetch offers");
        }
        if (cancelled) return;
        setOffers(data.offers);
        setError("");
        setStale(Boolean(data.stale));
        setMeta({
          source: data.source,
          fetchedAt: data.fetchedAt,
          apiTimestamp: data.apiTimestamp,
          servedFrom: data.servedFrom,
          upstreamMs: data.upstreamMs,
          stale: Boolean(data.stale),
          totalRaw: data.totalRaw,
          skipped: data.skipped,
          duplicatesRemoved: data.duplicatesRemoved,
        });
        setLastUpdated(new Date());
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Something went wrong");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const id = setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs]);

  return { offers, loading, error, lastUpdated, stale, meta };
}
