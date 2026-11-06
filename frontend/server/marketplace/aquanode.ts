import { z } from "zod";
import type { GPUOffer } from "../../lib/marketplace/types.ts";

/**
 * Normalizes the Aquanode public marketplace feed
 * (GET https://server.aquanode.io/api/v1/marketplace) into GPUOffer.
 * See docs/marketplace-and-routing.md for the field mapping and why each rule exists.
 */

const EnvelopeSchema = z.object({
  success: z.literal(true),
  data: z.array(z.unknown()),
  timestamp: z.string().optional(),
});

// Only the fields we depend on are required; the feed adds fields over time, so extras are ignored.
const RawOfferSchema = z.object({
  address: z.string().min(1),
  provider: z.string().min(1),
  gpuCount: z.number().int().positive(),
  gpuShortName: z.string().min(1),
  gpuMemory: z.union([z.string(), z.number()]),
  price: z.number().positive().finite(),
  available: z.number().finite(),
  region: z.string().nullable().optional(),
  priceBasis: z.string().nullable().optional(),
  availabilityLevel: z.string().nullable().optional(),
  gpuVendorFamily: z.string().nullable().optional(),
});
type RawOffer = z.infer<typeof RawOfferSchema>;

export interface NormalizedMarketplace {
  offers: GPUOffer[];
  apiTimestamp: string | null;
  totalRaw: number;
  skipped: number;
  duplicatesRemoved: number;
}

/** "24", "24GB", "24Gi", "180GB", 80 -> number of GB. Null when unparseable. */
export function parseVramGb(value: string | number): number | null {
  if (typeof value === "number") return value > 0 && value <= 1024 ? value : null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(?:g|gb|gi|gib)?$/i);
  if (!match) return null;
  const gb = Number(match[1]);
  return gb > 0 && gb <= 1024 ? gb : null;
}

export function gpuKeyOf(shortName: string): string {
  return shortName.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** "RTX4090" -> "RTX 4090", "RTX4070TIS" -> "RTX 4070 Ti Super". Unrecognized names pass through. */
export function prettyGpuModel(shortName: string): string {
  const geforce = shortName.match(/^RTX(\d{4})(TIS|TI|S)?$/i);
  if (geforce) {
    const suffix = { TIS: " Ti Super", TI: " Ti", S: " Super" }[(geforce[2] ?? "").toUpperCase()] ?? "";
    return `RTX ${geforce[1]}${suffix}`;
  }
  const ada = shortName.match(/^(\d{4})ADA$/i);
  if (ada) return `RTX ${ada[1]} Ada`;
  const pro = shortName.match(/^(?:RTX)?PRO(\d{4})$/i);
  if (pro) return `RTX PRO ${pro[1]}`;
  return shortName;
}

/** Whether the GPU can run CUDA. Family is null for some providers, so fall back to the model name. */
export function isCudaCapable(family: string | null | undefined, gpuKey: string): boolean {
  if (family) return family.toLowerCase() === "nvidia";
  return /^(RTX|GTX|A\d|H\d{2,3}|L4|L40|V100|B\d{2,3}|T4|P4|P100|PRO\d)/.test(gpuKey);
}

/**
 * Per-GPU hourly price. The feed says which basis a price uses ("node" = whole
 * offer, "gpu" = already per GPU). If priceBasis is absent, fall back to the
 * documented rule: every provider except Akash prices the whole offer.
 */
export function perGpuPriceUsd(raw: Pick<RawOffer, "price" | "gpuCount" | "priceBasis" | "provider">): number {
  const basis = raw.priceBasis ?? (raw.provider === "akash" ? "gpu" : "node");
  return basis === "gpu" ? raw.price : raw.price / raw.gpuCount;
}

export function bundlePriceUsd(raw: Pick<RawOffer, "price" | "gpuCount" | "priceBasis" | "provider">): number {
  const basis = raw.priceBasis ?? (raw.provider === "akash" ? "gpu" : "node");
  return basis === "gpu" ? raw.price * raw.gpuCount : raw.price;
}

/** Rentable now: the provider reports units and has not flagged the offer as having none. */
export function isRentable(raw: Pick<RawOffer, "available" | "availabilityLevel">): boolean {
  return raw.available > 0 && raw.availabilityLevel !== "NONE";
}

export function normalizeMarketplaceResponse(body: unknown): NormalizedMarketplace {
  const envelope = EnvelopeSchema.safeParse(body);
  if (!envelope.success) {
    throw new Error("Marketplace response did not match the expected envelope");
  }

  const seenRows = new Set<string>();
  const idCounts = new Map<string, number>();
  const offers: GPUOffer[] = [];
  let skipped = 0;
  let duplicatesRemoved = 0;

  for (const item of envelope.data.data) {
    const parsed = RawOfferSchema.safeParse(item);
    const vramGb = parsed.success ? parseVramGb(parsed.data.gpuMemory) : null;
    if (!parsed.success || vramGb === null) {
      skipped++;
      continue;
    }
    const raw = parsed.data;
    const region = raw.region && raw.region.trim() ? raw.region : "unknown";

    const rowKey = JSON.stringify([raw.provider, raw.address, raw.gpuCount, region, raw.price]);
    if (seenRows.has(rowKey)) {
      duplicatesRemoved++;
      continue;
    }
    seenRows.add(rowKey);

    const baseId = `${raw.provider}:${raw.address}:${raw.gpuCount}`;
    const n = (idCounts.get(baseId) ?? 0) + 1;
    idCounts.set(baseId, n);

    const gpuKey = gpuKeyOf(raw.gpuShortName);
    offers.push({
      id: n === 1 ? baseId : `${baseId}#${n}`,
      provider: raw.provider,
      gpuModel: prettyGpuModel(raw.gpuShortName),
      gpuKey,
      vramGb,
      gpuCount: raw.gpuCount,
      pricePerHourUsd: perGpuPriceUsd(raw),
      bundlePricePerHourUsd: bundlePriceUsd(raw),
      available: isRentable(raw),
      availableUnits: Math.max(0, Math.floor(raw.available)),
      region,
      cudaSupported: isCudaCapable(raw.gpuVendorFamily, gpuKey),
    });
  }

  return {
    offers,
    apiTimestamp: envelope.data.timestamp ?? null,
    totalRaw: envelope.data.data.length,
    skipped,
    duplicatesRemoved,
  };
}
