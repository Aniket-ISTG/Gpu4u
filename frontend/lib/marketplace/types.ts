export interface GPUOffer {
  /** Unique within one snapshot: provider:address:gpuCount (suffixed on collision). */
  id: string;
  provider: string;
  /** Display name, e.g. "RTX 4090". */
  gpuModel: string;
  /** Normalized provider short name (upper-case alphanumerics, e.g. "RTX4090"); used to look up GPU specs. */
  gpuKey: string;
  /** VRAM of one GPU, GB. */
  vramGb: number;
  /** Number of GPUs bundled in this offer. */
  gpuCount: number;
  /** USD per GPU-hour, normalized from the provider's price basis. */
  pricePerHourUsd: number;
  /** USD per hour for the whole offer (all GPUs), exactly as it would be billed. */
  bundlePricePerHourUsd: number;
  available: boolean;
  /** Units the provider reports as currently rentable. */
  availableUnits: number;
  region: string;
  cudaSupported: boolean;
}

export interface MarketplaceSnapshot {
  offers: GPUOffer[];
  source: "aquanode";
  /** When this server fetched the data. */
  fetchedAt: string;
  /** Timestamp reported by the marketplace API itself. */
  apiTimestamp: string | null;
  /**
   * Where this response came from: "upstream" (fetched just now), "cache" (a
   * recent fetch, within the TTL) or "stale-cache" (the refresh failed).
   */
  servedFrom: "upstream" | "cache" | "stale-cache";
  /** How long the upstream fetch that produced this data took, ms. */
  upstreamMs: number;
  /** True when the live fetch failed and an older cached snapshot is being served. */
  stale: boolean;
  /** Offers in the raw response. */
  totalRaw: number;
  /** Offers dropped because required fields were missing or invalid. */
  skipped: number;
  /** Exact duplicate rows removed. */
  duplicatesRemoved: number;
}

export interface MarketplaceProvider {
  getOffers(): Promise<GPUOffer[]>;
  getSnapshot(): Promise<MarketplaceSnapshot>;
}
