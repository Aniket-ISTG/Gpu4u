import { mockGpuOffers } from "../../data/mock-gpus.ts";
import type { GPUOffer, MarketplaceProvider } from "@/lib/marketplace/types";

export class MockMarketplaceProvider implements MarketplaceProvider {
  async getOffers(): Promise<GPUOffer[]> {
    return mockGpuOffers.map((offer) => ({ ...offer }));
  }
}