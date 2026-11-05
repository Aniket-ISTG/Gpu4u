import assert from "node:assert/strict";
import test from "node:test";
import { MockMarketplaceProvider } from "../lib/marketplace/mock-provider.ts";

test("mock marketplace returns 10 to 15 uniquely identified GPU offers", async () => {
  const offers = await new MockMarketplaceProvider().getOffers();

  assert.ok(offers.length >= 10 && offers.length <= 15);
  assert.equal(new Set(offers.map((offer) => offer.id)).size, offers.length);
  assert.ok(offers.every((offer) => offer.pricePerHourUsd > 0));
  assert.ok(offers.every((offer) => offer.vramGb > 0 && offer.gpuCount > 0));
  assert.ok(offers.some((offer) => offer.gpuModel === "H100"));
  assert.ok(offers.some((offer) => offer.gpuModel === "RTX A6000"));
});

test("provider returns copies rather than exposing the mock catalog", async () => {
  const provider = new MockMarketplaceProvider();
  const firstResult = await provider.getOffers();
  firstResult[0].available = !firstResult[0].available;

  const secondResult = await provider.getOffers();
  assert.notEqual(firstResult[0].available, secondResult[0].available);
});