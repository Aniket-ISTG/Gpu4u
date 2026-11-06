import { mockGpuOffers } from "../../data/mock-gpus.ts";
import type { GPUOffer, MarketplaceProvider } from "@/lib/marketplace/types";

// Simulates a live market: prices drift and nodes go on/offline every few seconds.
const TICK_MS = 5000;

function noise(seed: number) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

export class MockMarketplaceProvider implements MarketplaceProvider {
  async getOffers(): Promise<GPUOffer[]> {
    const tick = Math.floor(Date.now() / TICK_MS);

    return mockGpuOffers.map((offer, i) => {
      const drift = 1 + (noise(tick * 31 + i) - 0.5) * 0.12; // +/-6%
      const flips = noise(tick * 17 + i * 7) > 0.93; // ~7% toggle availability
      return {
        ...offer,
        pricePerHourUsd: Math.round(offer.pricePerHourUsd * drift * 100) / 100,
        available: flips ? !offer.available : offer.available,
      };
    });
  }
}
