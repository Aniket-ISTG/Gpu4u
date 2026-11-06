import assert from "node:assert/strict";
import test from "node:test";
import { resolveProfile } from "../lib/estimation/workload-profile.ts";
import { rankOffersByEstimatedCost, type RoutingConstraints } from "../lib/routing/cost-ranking.ts";
import { applyDifficulty } from "../lib/estimation/difficulty.ts";
import type { PaymentView } from "../lib/payments/types.ts";
import {
  DEFAULT_CAP_MULTIPLIER,
  MAX_CAP_MULTIPLIER,
  QuoteBuildError,
  QuoteBuildRequestSchema,
  buildQuoteRequest,
  type QuoteBuildRequest,
} from "../server/payments/quote-builder.ts";
import { PaymentServiceClient, PaymentServiceError, paymentServiceOptionsFromEnv } from "../server/payments/service-client.ts";
import { planLeaseRun } from "../server/payments/lease-run.ts";
import { offers } from "./fixtures/offers.ts";

const WALLET = "0.0.5000001";
const profile = resolveProfile("inference", { modelParamsB: 8, numPrompts: 5000 }).profile;
const constraints: RoutingConstraints = {
  minVramGb: 16,
  gpuCount: 1,
  maxHourlyBudgetUsd: 2,
  maxTotalBudgetUsd: null,
  maxDurationHours: null,
  cudaRequired: null,
  optimization: "cost",
};

const ranked = rankOffersByEstimatedCost(offers, profile, constraints).ranked;
const best = ranked[0];

function request(over: Partial<QuoteBuildRequest> = {}): QuoteBuildRequest {
  return QuoteBuildRequestSchema.parse({
    wallet: WALLET,
    offerId: best.offer.id,
    profile,
    touched: ["modelParamsB", "numPrompts"],
    difficulty: null,
    constraints,
    ...over,
  });
}

const ceilCents = (usd: number) => Math.ceil(usd * 100 - 1e-9) / 100;

test("a quote takes its hours and price from the server's own ranking", () => {
  const q = buildQuoteRequest(request(), offers);
  assert.equal(q.offer.id, best.offer.id);
  assert.equal(q.hours, best.estimatedDurationHours);
  assert.equal(q.hourlyUsd, best.hourlyPriceUsd);
  assert.equal(q.estimateUsd, best.estimatedTotalCostUsd);
  assert.equal(q.wallet, WALLET);
  assert.equal(q.offer.gpuModel, best.offer.gpuModel);
});

test("the default cap is the estimate plus a quarter, in whole cents", () => {
  const q = buildQuoteRequest(request(), offers);
  assert.equal(q.capUsd, ceilCents(Math.max(q.estimateUsd * DEFAULT_CAP_MULTIPLIER, q.estimateUsd + 0.01)));
  assert.ok(q.capUsd >= q.estimateUsd);
  assert.equal(Math.round(q.capUsd * 100), q.capUsd * 100 - (q.capUsd * 100 - Math.round(q.capUsd * 100)));
});

test("the browser cannot supply a price, an amount or a recipient", () => {
  for (const extra of [{ priceUsd: 0.01 }, { amountTinybars: "1" }, { payTo: "0.0.9" }, { hours: 0.001 }, { estimateUsd: 0.001 }]) {
    assert.throws(() => QuoteBuildRequestSchema.parse({ ...request(), ...extra }), /Unrecognized key/, JSON.stringify(extra));
  }
});

test("a different workload gives a different price, so the price cannot be fixed by the caller", () => {
  const bigger = resolveProfile("inference", { modelParamsB: 8, numPrompts: 50000 }).profile;
  const a = buildQuoteRequest(request(), offers);
  const b = buildQuoteRequest(request({ profile: bigger }), offers);
  assert.ok(b.estimateUsd > a.estimateUsd * 5);
  assert.ok(b.hours > a.hours);
});

test("difficulty scales the volume you did not set yourself, as in the ranking", () => {
  const defaults = resolveProfile("inference", { modelParamsB: 8 }).profile;
  const easy = buildQuoteRequest(request({ profile: defaults, touched: ["modelParamsB"], difficulty: "easy" }), offers);
  const hard = buildQuoteRequest(request({ profile: defaults, touched: ["modelParamsB"], difficulty: "hard" }), offers);
  assert.ok(hard.estimateUsd > easy.estimateUsd);

  const expected = rankOffersByEstimatedCost(offers, applyDifficulty(defaults, new Set(["modelParamsB"]), "hard"), constraints).ranked.find((r) => r.offer.id === best.offer.id)!;
  assert.equal(hard.estimateUsd, expected.estimatedTotalCostUsd);

  const pinned = buildQuoteRequest(request({ profile: defaults, touched: ["modelParamsB", "numPrompts"], difficulty: "hard" }), offers);
  const unscaled = buildQuoteRequest(request({ profile: defaults, touched: ["modelParamsB", "numPrompts"], difficulty: null }), offers);
  assert.equal(pinned.estimateUsd, unscaled.estimateUsd, "a volume the user typed is never scaled");
});

test("refuses a GPU that is unavailable, does not exist, or no longer fits the requirements", () => {
  const unavailable = offers.find((o) => !o.available)!;
  const throwsCode = (over: Partial<QuoteBuildRequest>, code: string) =>
    assert.throws(() => buildQuoteRequest(request(over), offers), (e: unknown) => e instanceof QuoteBuildError && e.code === code);

  throwsCode({ offerId: unavailable.id }, "OFFER_NOT_ELIGIBLE");
  throwsCode({ offerId: "no-such-offer" }, "OFFER_NOT_ELIGIBLE");
  throwsCode({ constraints: { ...constraints, minVramGb: 1000 } }, "OFFER_NOT_ELIGIBLE");
  throwsCode({ constraints: { ...constraints, gpuCount: 4 } }, "OFFER_NOT_ELIGIBLE");
});

test("refuses when the live price moved away from what the user saw, but tolerates small drift", () => {
  const seen = best.estimatedTotalCostUsd;
  assert.throws(
    () => buildQuoteRequest(request({ expectedEstimateUsd: seen * 2 }), offers),
    (e: unknown) => e instanceof QuoteBuildError && e.code === "PRICE_CHANGED",
  );
  assert.doesNotThrow(() => buildQuoteRequest(request({ expectedEstimateUsd: seen * 1.05 }), offers));
});

test("a chosen cap must cover the estimate and stay within three times it", () => {
  const estimate = best.estimatedTotalCostUsd;
  const code = (cap: number) => {
    try {
      buildQuoteRequest(request({ capUsd: cap }), offers);
      return "ok";
    } catch (e) {
      return e instanceof QuoteBuildError ? e.code : "other";
    }
  };
  assert.equal(code(estimate * 0.5), "CAP_OUT_OF_RANGE");
  assert.equal(code(estimate * (MAX_CAP_MULTIPLIER + 1)), "CAP_OUT_OF_RANGE");
  assert.equal(code(estimate * 1.5), "ok");
  assert.equal(buildQuoteRequest(request({ capUsd: estimate * 1.5 }), offers).capUsd, ceilCents(estimate * 1.5));
});

test("refuses a job estimated to run longer than 30 days", () => {
  const huge = resolveProfile("inference", { modelParamsB: 8, numPrompts: 1_000_000_000, avgOutputTokens: 1000 }).profile;
  assert.throws(
    () => buildQuoteRequest(request({ profile: huge }), offers),
    (e: unknown) => e instanceof QuoteBuildError && e.code === "JOB_TOO_LONG",
  );
});

test("rejects malformed requests", () => {
  const base = { wallet: WALLET, offerId: "x", profile, touched: [], difficulty: null, constraints };
  for (const bad of [
    { ...base, wallet: "alice" },
    { ...base, profile: { ...profile, numPrompts: -1 } },
    { ...base, profile: { ...profile, modelParamsB: 1e9 } },
    { ...base, constraints: { ...constraints, gpuCount: 0 } },
    { ...base, constraints: { ...constraints, optimization: "cheapest" } },
    { ...base, difficulty: "extreme" },
    { ...base, touched: ["priceUsd"] },
    { ...base, capUsd: -5 },
    { ...base, offerId: "" },
  ]) {
    assert.throws(() => QuoteBuildRequestSchema.parse(bad), JSON.stringify(bad).slice(0, 80));
  }
});

// ---- the payment service client

const options = (fetchImpl: typeof fetch) => ({ baseUrl: "http://svc/", token: "t".repeat(20), fetchImpl });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("sends the service token on authenticated calls only, and never to the config endpoint", async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, auth: new Headers(init.headers).get("authorization") });
    return json({});
  }) as unknown as typeof fetch;
  const client = new PaymentServiceClient({ ...options(fetchImpl), baseUrl: "http://svc/" });
  await client.getConfig();
  await client.getPayment("pay_x");
  assert.deepEqual(seen.map((s) => s.url), ["http://svc/v1/config", "http://svc/v1/payments/pay_x"]);
  assert.equal(seen[0].auth, null);
  assert.equal(seen[1].auth, "Bearer " + "t".repeat(20));
});

test("turns a service error into a typed error with its code and status", async () => {
  const client = new PaymentServiceClient(options((async () => json({ error: "QUOTE_EXPIRED", message: "This quote has expired" }, 410)) as unknown as typeof fetch));
  await assert.rejects(client.startPayment("q_x"), (e: unknown) => e instanceof PaymentServiceError && e.status === 410 && e.code === "QUOTE_EXPIRED" && /expired/.test(e.message));
});

test("reports an unreachable service as 503 without leaking the address", async () => {
  const client = new PaymentServiceClient(options((async () => { throw new Error("connect ECONNREFUSED 10.1.2.3:4021"); }) as unknown as typeof fetch));
  await assert.rejects(client.getPayment("p"), (e: unknown) => e instanceof PaymentServiceError && e.status === 503 && e.code === "SERVICE_UNAVAILABLE" && !/10\.1\.2\.3/.test(e.message));
});

test("an unparseable error body still produces a safe error", async () => {
  const client = new PaymentServiceClient(options((async () => new Response("<html>boom</html>", { status: 502 })) as unknown as typeof fetch));
  await assert.rejects(client.getPayment("p"), (e: unknown) => e instanceof PaymentServiceError && e.status === 502 && !/html/.test(e.message));
});

test("refuses to run without a service token", () => {
  assert.throws(() => paymentServiceOptionsFromEnv({}), (e: unknown) => e instanceof PaymentServiceError && e.code === "NOT_CONFIGURED");
  assert.throws(() => paymentServiceOptionsFromEnv({ PAYMENT_SERVICE_TOKEN: "short" }), /not configured/);
  const ok = paymentServiceOptionsFromEnv({ PAYMENT_SERVICE_TOKEN: "x".repeat(20), PAYMENT_SERVICE_URL: "http://host:9/" });
  assert.equal(ok.baseUrl, "http://host:9");
});

// ---- the simulated lease run

function view(over: { hourlyUsd?: number; hours?: number; estimateUsd?: number; capUsd?: number } = {}): PaymentView {
  const quote = { hourlyUsd: 0.22, hours: 1.54, estimateUsd: 0.3388, capUsd: 0.42, ...over };
  return { payment: { id: "pay_" + "a".repeat(24) }, quote } as unknown as PaymentView;
}

test("a simulated run never bills more than the cap that was paid", () => {
  for (const id of ["a", "b", "c", "d", "e", "f"]) {
    const v = view();
    (v.payment as { id: string }).id = "pay_" + id.repeat(24);
    const plan = planLeaseRun(v);
    assert.ok(plan.actualUsd <= v.quote.capUsd + 1e-9, id);
    assert.ok(plan.actualUsd > 0);
    assert.equal(plan.run.source, "simulated");
  }
});

test("a run that would cost more than the cap stops at the cap", () => {
  const v = view({ capUsd: 0.2, estimateUsd: 0.19 });
  (v.payment as { id: string }).id = "pay_" + "9".repeat(24);
  const results = Array.from({ length: 12 }, (_, i) => {
    const copy = view({ capUsd: 0.2, estimateUsd: 0.19 });
    (copy.payment as { id: string }).id = "pay_" + i.toString(16).repeat(24).slice(0, 24);
    return planLeaseRun(copy);
  });
  assert.ok(results.some((r) => r.status === "stopped_at_cap"), "some simulated runs overrun the estimate and are stopped");
  for (const r of results.filter((r) => r.status === "stopped_at_cap")) {
    assert.ok(r.actualUsd <= 0.2 + 1e-9);
    assert.ok(r.run.completedFraction < 1);
  }
});

test("a simulated run is repeatable for the same payment", () => {
  const v = view();
  assert.deepEqual(planLeaseRun(v), planLeaseRun(v));
});
