import type { GPUOffer } from "./types.ts";

export interface RankedGPUOffer extends GPUOffer {
  /** Hourly price of the whole offer, USD. */
  estimatedCost: number;
  /** 0-100 browse score: cheaper per GPU-hour and more VRAM score higher. */
  score: number;
}

/** Scores every offer (including unavailable ones) against the whole market, for browsing. */
export function browseOffers(offers: GPUOffer[]): RankedGPUOffer[] {
  const cheapest = Math.min(...offers.map((o) => o.pricePerHourUsd), Infinity);
  return offers
    .map((offer) => ({
      ...offer,
      estimatedCost: offer.bundlePricePerHourUsd,
      score: (cheapest / offer.pricePerHourUsd) * 65 + Math.min(offer.vramGb / 24, 1) * 35,
    }))
    .sort((a, b) => b.score - a.score);
}
