import type { GPUOffer } from "@/lib/marketplace/types";
import type { RankedGPUOffer } from "@/components/OptimalMatchHero";

export interface Filters {
  minMemory: number;
  maxPrice: number;
  gpuCount: number;
}

export function rankOffers(offers: GPUOffer[], f: Filters): RankedGPUOffer[] {
  const eligible = offers.filter(
    (o) =>
      o.available &&
      o.vramGb >= f.minMemory &&
      o.gpuCount >= f.gpuCount &&
      o.pricePerHourUsd * f.gpuCount <= f.maxPrice
  );
  if (!eligible.length) return [];

  const cheapest = Math.min(...eligible.map((o) => o.pricePerHourUsd * f.gpuCount));

  return eligible
    .map((offer) => {
      const cost = offer.pricePerHourUsd * f.gpuCount;
      const priceScore = (cheapest / cost) * 100;
      const memoryScore = Math.min((offer.vramGb / f.minMemory) * 50, 100);
      return { ...offer, estimatedCost: cost, score: priceScore * 0.65 + memoryScore * 0.35 };
    })
    .sort((a, b) => b.score - a.score);
}

/** All offers (including unavailable) scored against the whole market, for browsing. */
export function browseOffers(offers: GPUOffer[]): RankedGPUOffer[] {
  const cheapest = Math.min(...offers.map((o) => o.pricePerHourUsd), Infinity);
  return offers
    .map((offer) => ({
      ...offer,
      estimatedCost: offer.pricePerHourUsd,
      score: (cheapest / offer.pricePerHourUsd) * 65 + Math.min(offer.vramGb / 24, 1) * 35,
    }))
    .sort((a, b) => b.score - a.score);
}
