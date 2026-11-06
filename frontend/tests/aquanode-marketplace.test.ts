import assert from "node:assert/strict";
import test from "node:test";
import {
  bundlePriceUsd,
  isCudaCapable,
  normalizeMarketplaceResponse,
  parseVramGb,
  perGpuPriceUsd,
  prettyGpuModel,
} from "../server/marketplace/aquanode.ts";
import { AquanodeMarketplaceProvider } from "../server/marketplace/aquanode-provider.ts";
import { normalized, offers, pick, snapshot } from "./fixtures/offers.ts";

const rawOffer = (over: Record<string, unknown> = {}) => ({
  address: "a1",
  provider: "vastai",
  gpuCount: 2,
  gpuShortName: "RTX4090",
  gpuMemory: "24GB",
  price: 1,
  available: 1,
  region: "Virginia, US",
  priceBasis: "node",
  ...over,
});
const envelope = (data: unknown[]) => ({ success: true, data, timestamp: "2026-11-06T00:00:00.000Z" });

test("parses every VRAM format seen in the live feed", () => {
  assert.equal(parseVramGb("24"), 24);
  assert.equal(parseVramGb("24GB"), 24);
  assert.equal(parseVramGb("24Gi"), 24);
  assert.equal(parseVramGb("180GB"), 180);
  assert.equal(parseVramGb(80), 80);
  assert.equal(parseVramGb(""), null);
  assert.equal(parseVramGb("lots"), null);
  assert.equal(parseVramGb("0GB"), null);
});

test("node-basis prices are divided by GPU count, gpu-basis prices are not", () => {
  const node = { price: 4, gpuCount: 4, priceBasis: "node", provider: "vastai" };
  assert.equal(perGpuPriceUsd(node), 1);
  assert.equal(bundlePriceUsd(node), 4);

  const gpu = { price: 0.4, gpuCount: 2, priceBasis: "gpu", provider: "akash" };
  assert.equal(perGpuPriceUsd(gpu), 0.4);
  assert.equal(bundlePriceUsd(gpu), 0.8);
});

test("without priceBasis only Akash is treated as per-GPU, as the docs state", () => {
  assert.equal(perGpuPriceUsd({ price: 4, gpuCount: 4, provider: "runpod" }), 1);
  assert.equal(perGpuPriceUsd({ price: 0.4, gpuCount: 4, provider: "akash" }), 0.4);
});

test("real fixture: per-GPU x count equals the bundle price for every offer", () => {
  assert.ok(offers.length > 100);
  for (const o of offers) {
    assert.ok(Math.abs(o.pricePerHourUsd * o.gpuCount - o.bundlePricePerHourUsd) < 1e-9, o.id);
    assert.ok(o.pricePerHourUsd > 0 && o.vramGb > 0 && o.gpuCount > 0);
  }
});

test("real fixture: Akash prices stay per GPU", () => {
  const akash = offers.filter((o) => o.provider === "akash" && o.gpuCount > 1);
  assert.ok(akash.length > 0);
  for (const o of akash) assert.ok(o.bundlePricePerHourUsd > o.pricePerHourUsd);
});

test("real fixture: ids are unique and exact duplicate rows are removed", () => {
  assert.equal(new Set(offers.map((o) => o.id)).size, offers.length);
  assert.ok(normalized.duplicatesRemoved >= 1);
  assert.equal(normalized.totalRaw, snapshot.data.length);
  assert.equal(offers.length + normalized.skipped + normalized.duplicatesRemoved, normalized.totalRaw);
});

test("availability requires units and a non-NONE level", () => {
  const out = normalizeMarketplaceResponse(
    envelope([
      rawOffer({ address: "ok" }),
      rawOffer({ address: "zero", available: 0 }),
      rawOffer({ address: "none", availabilityLevel: "NONE" }),
      rawOffer({ address: "low", availabilityLevel: "LOW" }),
    ]),
  );
  const byAddress = Object.fromEntries(out.offers.map((o) => [o.id.split(":")[1], o.available]));
  assert.deepEqual(byAddress, { ok: true, zero: false, none: false, low: true });
  assert.ok(offers.some((o) => !o.available) && offers.some((o) => o.available));
});

test("drops invalid rows instead of failing the whole feed", () => {
  const out = normalizeMarketplaceResponse(
    envelope([
      rawOffer(),
      rawOffer({ address: "bad-vram", gpuMemory: "" }),
      rawOffer({ address: "bad-price", price: 0 }),
      rawOffer({ address: "bad-count", gpuCount: 0 }),
      { nonsense: true },
    ]),
  );
  assert.equal(out.offers.length, 1);
  assert.equal(out.skipped, 4);
});

test("rejects a response that is not the documented envelope", () => {
  assert.throws(() => normalizeMarketplaceResponse({ success: false, data: [] }));
  assert.throws(() => normalizeMarketplaceResponse({ success: true }));
  assert.throws(() => normalizeMarketplaceResponse("html error page"));
});

test("empty region becomes unknown and CUDA falls back to the model name", () => {
  const out = normalizeMarketplaceResponse(envelope([rawOffer({ region: "", gpuVendorFamily: null })]));
  assert.equal(out.offers[0].region, "unknown");
  assert.equal(out.offers[0].cudaSupported, true);
  assert.equal(isCudaCapable("amd", "MI300X"), false);
  assert.equal(isCudaCapable(null, "MI300X"), false);
  assert.equal(isCudaCapable("nvidia", "ANYTHING"), true);
});

test("prettifies common model names", () => {
  assert.equal(prettyGpuModel("RTX4090"), "RTX 4090");
  assert.equal(prettyGpuModel("RTX4070TIS"), "RTX 4070 Ti Super");
  assert.equal(prettyGpuModel("6000ADA"), "RTX 6000 Ada");
  assert.equal(prettyGpuModel("H100"), "H100");
  assert.equal(pick("RTX4090", 1).gpuModel, "RTX 4090");
});

function fakeFetch(responses: Array<() => Response | Promise<Response>>) {
  let calls = 0;
  const impl = (async () => responses[Math.min(calls++, responses.length - 1)]()) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}
const ok = () => Response.json(snapshot);

test("provider caches within the TTL and refetches after it", async () => {
  let t = 0;
  const f = fakeFetch([ok]);
  const provider = new AquanodeMarketplaceProvider({ fetchImpl: f.impl, ttlMs: 1000, now: () => t });

  await provider.getSnapshot();
  t = 500;
  await provider.getSnapshot();
  assert.equal(f.calls(), 1);
  t = 1500;
  await provider.getSnapshot();
  assert.equal(f.calls(), 2);
});

test("concurrent callers share one upstream request", async () => {
  const f = fakeFetch([ok]);
  const provider = new AquanodeMarketplaceProvider({ fetchImpl: f.impl });
  await Promise.all([provider.getSnapshot(), provider.getSnapshot(), provider.getSnapshot()]);
  assert.equal(f.calls(), 1);
});

test("serves the last good snapshot, marked stale, when the upstream fails", async () => {
  let t = 0;
  const f = fakeFetch([ok, () => new Response("boom", { status: 500 })]);
  const provider = new AquanodeMarketplaceProvider({ fetchImpl: f.impl, ttlMs: 10, now: () => t });

  const fresh = await provider.getSnapshot();
  assert.equal(fresh.stale, false);
  assert.equal(fresh.source, "aquanode");
  t = 100;
  const stale = await provider.getSnapshot();
  assert.equal(stale.stale, true);
  assert.equal(stale.offers.length, fresh.offers.length);
});

test("throws when the upstream fails and nothing is cached", async () => {
  const f = fakeFetch([() => new Response("down", { status: 503 })]);
  const provider = new AquanodeMarketplaceProvider({ fetchImpl: f.impl });
  await assert.rejects(provider.getSnapshot(), /HTTP 503/);
});

test("a malformed upstream body is treated as a failure", async () => {
  const f = fakeFetch([() => Response.json({ success: true, data: "nope" })]);
  const provider = new AquanodeMarketplaceProvider({ fetchImpl: f.impl });
  await assert.rejects(provider.getSnapshot());
});
