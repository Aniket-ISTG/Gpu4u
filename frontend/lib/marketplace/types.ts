export interface GPUOffer {
  id: string;
  provider: string;
  gpuModel: string;
  vramGb: number;
  gpuCount: number;
  pricePerHourUsd: number;
  available: boolean;
  region: string;
  cudaSupported: boolean;
  reliabilityScore?: number;
  performanceScore?: number;
}

export interface MarketplaceProvider {
  getOffers(): Promise<GPUOffer[]>;
}