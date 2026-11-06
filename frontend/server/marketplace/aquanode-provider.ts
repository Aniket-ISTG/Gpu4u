import { normalizeMarketplaceResponse } from "./aquanode.ts";
import type { GPUOffer, MarketplaceProvider, MarketplaceSnapshot } from "../../lib/marketplace/types.ts";
import { logUpstream, type UpstreamEvent } from "../logger.ts";

export const AQUANODE_MARKETPLACE_URL = "https://server.aquanode.io/api/v1/marketplace";

export interface AquanodeProviderOptions {
  url?: string;
  /** How long a fetched snapshot is served before refetching. The endpoint is slow and unauthenticated, so poll gently. */
  ttlMs?: number;
  /** The upstream call has taken ~13s, so allow generous time. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Called once per upstream request (not for cache hits). */
  onEvent?: (event: UpstreamEvent) => void;
}

/**
 * Reads live offers from the Aquanode public marketplace. Server-side only: the
 * endpoint sends no CORS headers, so browsers must go through our own API route.
 * Caches the snapshot, shares one in-flight request, and serves the last good
 * snapshot (marked stale) when the upstream call fails.
 */
export class AquanodeMarketplaceProvider implements MarketplaceProvider {
  private cache: { snapshot: MarketplaceSnapshot; fetchedAtMs: number } | null = null;
  private inflight: Promise<MarketplaceSnapshot> | null = null;
  private readonly url: string;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly onEvent?: (event: UpstreamEvent) => void;

  constructor(options: AquanodeProviderOptions = {}) {
    this.url = options.url ?? AQUANODE_MARKETPLACE_URL;
    this.ttlMs = options.ttlMs ?? 30_000;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.onEvent = options.onEvent;
  }

  async getOffers(): Promise<GPUOffer[]> {
    return (await this.getSnapshot()).offers;
  }

  async getSnapshot(): Promise<MarketplaceSnapshot> {
    if (this.cache && this.now() - this.cache.fetchedAtMs < this.ttlMs) {
      return { ...this.cache.snapshot, servedFrom: "cache" };
    }
    if (!this.inflight) {
      this.inflight = this.refresh().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async refresh(): Promise<MarketplaceSnapshot> {
    const started = this.now();
    let httpStatus: number | undefined;
    try {
      const response = await this.fetchImpl(this.url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
        cache: "no-store",
      });
      httpStatus = response.status;
      if (!response.ok) throw new Error(`Marketplace returned HTTP ${response.status}`);

      const normalized = normalizeMarketplaceResponse(await response.json());
      if (!normalized.offers.length) throw new Error("Marketplace returned no usable offers");

      const fetchedAtMs = this.now();
      const upstreamMs = fetchedAtMs - started;
      const snapshot: MarketplaceSnapshot = {
        offers: normalized.offers,
        source: "aquanode",
        fetchedAt: new Date(fetchedAtMs).toISOString(),
        apiTimestamp: normalized.apiTimestamp,
        servedFrom: "upstream",
        upstreamMs,
        stale: false,
        totalRaw: normalized.totalRaw,
        skipped: normalized.skipped,
        duplicatesRemoved: normalized.duplicatesRemoved,
      };
      this.cache = { snapshot, fetchedAtMs };
      this.onEvent?.({
        outcome: "fetched",
        url: this.url,
        durationMs: upstreamMs,
        httpStatus,
        offers: normalized.offers.length,
        skipped: normalized.skipped,
        duplicatesRemoved: normalized.duplicatesRemoved,
      });
      return snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const base = { url: this.url, durationMs: this.now() - started, httpStatus, error: message };
      if (this.cache) {
        this.onEvent?.({ outcome: "stale", ...base });
        return { ...this.cache.snapshot, stale: true, servedFrom: "stale-cache" };
      }
      this.onEvent?.({ outcome: "error", ...base });
      throw error;
    }
  }
}

/** Shared instance so the cache survives across requests in one server process. */
let shared: AquanodeMarketplaceProvider | undefined;
export function getMarketplaceProvider(): AquanodeMarketplaceProvider {
  shared ??= new AquanodeMarketplaceProvider({
    url: process.env.AQUANODE_MARKETPLACE_URL || AQUANODE_MARKETPLACE_URL,
    onEvent: logUpstream,
  });
  return shared;
}
