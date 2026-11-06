import { readFileSync } from "node:fs";
import { normalizeMarketplaceResponse } from "../../server/marketplace/aquanode.ts";
import type { GPUOffer } from "../../lib/marketplace/types.ts";

/** A recorded excerpt of the real Aquanode response (see its "message" and "timestamp"). */
export const snapshot = JSON.parse(
  readFileSync(new URL("./aquanode-marketplace.snapshot.json", import.meta.url), "utf8"),
);

export const normalized = normalizeMarketplaceResponse(snapshot);
export const offers: GPUOffer[] = normalized.offers;

/** First available offer for a GPU key and bundle size. */
export function pick(gpuKey: string, gpuCount = 1, provider?: string): GPUOffer {
  const found = offers.find(
    (o) => o.gpuKey === gpuKey && o.gpuCount === gpuCount && o.available && (!provider || o.provider === provider),
  );
  if (!found) throw new Error(`No fixture offer for ${gpuKey} x${gpuCount}`);
  return found;
}
