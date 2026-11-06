"use client";

import { useEffect, useState } from "react";
import type { GPUOffer } from "@/lib/marketplace/types";

export function useMarketplace(intervalMs = 5000) {
  const [offers, setOffers] = useState<GPUOffer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

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

  return { offers, loading, error, lastUpdated };
}
