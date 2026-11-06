import assert from "node:assert/strict";
import test from "node:test";
import { AquanodeMarketplaceProvider } from "../server/marketplace/aquanode-provider.ts";
import { handleGetMarketplace } from "../server/api/marketplace.ts";
import { parseAnalyzeRequest } from "../server/api/analyze-request.ts";
import { logUpstream, type UpstreamEvent } from "../server/logger.ts";
import { snapshot } from "./fixtures/offers.ts";

const okFetch = (async () => Response.json(snapshot)) as unknown as typeof fetch;
const failFetch = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;

test("snapshot says where it came from and how long the upstream call took", async () => {
  let t = 1000;
  const provider = new AquanodeMarketplaceProvider({
    fetchImpl: (async () => {
      t += 250;
      return Response.json(snapshot);
    }) as unknown as typeof fetch,
    ttlMs: 10_000,
    now: () => t,
  });

  const first = await provider.getSnapshot();
  assert.equal(first.servedFrom, "upstream");
  assert.equal(first.upstreamMs, 250);

  const second = await provider.getSnapshot();
  assert.equal(second.servedFrom, "cache");
  assert.equal(second.upstreamMs, 250); // the fetch that produced the cached data
  assert.equal(second.fetchedAt, first.fetchedAt);
});

test("a stale fallback is labelled stale-cache", async () => {
  let t = 0;
  let calls = 0;
  const provider = new AquanodeMarketplaceProvider({
    fetchImpl: (async () => (calls++ === 0 ? Response.json(snapshot) : new Response("x", { status: 500 }))) as unknown as typeof fetch,
    ttlMs: 10,
    now: () => t,
  });
  await provider.getSnapshot();
  t = 100;
  const stale = await provider.getSnapshot();
  assert.equal(stale.servedFrom, "stale-cache");
  assert.equal(stale.stale, true);
});

test("emits one event per upstream call and none for cache hits", async () => {
  const events: UpstreamEvent[] = [];
  const t = 0;
  const provider = new AquanodeMarketplaceProvider({
    fetchImpl: okFetch,
    ttlMs: 1000,
    now: () => t,
    onEvent: (e) => events.push(e),
  });
  await provider.getSnapshot();
  await provider.getSnapshot(); // cache hit
  assert.equal(events.length, 1);
  const fetched = events[0];
  assert.equal(fetched.outcome, "fetched");
  if (fetched.outcome === "fetched") {
    assert.equal(fetched.httpStatus, 200);
    assert.ok(fetched.offers > 100);
    assert.ok(fetched.duplicatesRemoved >= 1);
  }
});

test("emits error when nothing is cached and stale when something is", async () => {
  const errors: UpstreamEvent[] = [];
  const cold = new AquanodeMarketplaceProvider({ fetchImpl: failFetch, onEvent: (e) => errors.push(e) });
  await assert.rejects(cold.getSnapshot());
  assert.equal(errors[0].outcome, "error");
  assert.equal(errors[0].httpStatus, 503);

  const events: UpstreamEvent[] = [];
  let t = 0;
  let calls = 0;
  const warm = new AquanodeMarketplaceProvider({
    fetchImpl: (async () => (calls++ === 0 ? Response.json(snapshot) : new Response("x", { status: 502 }))) as unknown as typeof fetch,
    ttlMs: 1,
    now: () => t,
    onEvent: (e) => events.push(e),
  });
  await warm.getSnapshot();
  t = 10;
  await warm.getSnapshot();
  assert.deepEqual(events.map((e) => e.outcome), ["fetched", "stale"]);
});

test("logger writes one readable line per event", () => {
  const lines: string[] = [];
  const info = console.info;
  const warn = console.warn;
  console.info = (m: string) => lines.push(m);
  console.warn = (m: string) => lines.push(m);
  try {
    logUpstream({ outcome: "fetched", url: "u", durationMs: 12, httpStatus: 200, offers: 5, skipped: 1, duplicatesRemoved: 2 });
    logUpstream({ outcome: "stale", url: "u", durationMs: 3, httpStatus: 503, error: "HTTP 503" });
    logUpstream({ outcome: "error", url: "u", durationMs: 3, error: "timeout" });
  } finally {
    console.info = info;
    console.warn = warn;
  }
  assert.equal(lines.length, 3);
  assert.match(lines[0], /\[aquanode\] fetched 200 in 12ms offers=5 skipped=1 duplicates=2/);
  assert.match(lines[1], /stale 503.*serving last good data/);
  assert.match(lines[2], /error after 3ms.*no cached data/);
});

test("marketplace handler returns the snapshot, or 502 when the provider fails", async () => {
  const provider = new AquanodeMarketplaceProvider({ fetchImpl: okFetch });
  const ok = await handleGetMarketplace(provider);
  const body = await ok.json();
  assert.equal(ok.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.source, "aquanode");
  assert.equal(body.servedFrom, "upstream");
  assert.ok(Array.isArray(body.offers) && body.offers.length > 100);

  const bad = await handleGetMarketplace(new AquanodeMarketplaceProvider({ fetchImpl: failFetch }));
  assert.equal(bad.status, 502);
  const badBody = await bad.json();
  assert.equal(badBody.success, false);
  assert.ok(!JSON.stringify(badBody).includes("503")); // no upstream detail leaks to the client
});

test("analyze request validation accepts a request with an optional difficulty", () => {
  const ok = parseAnalyzeRequest({ request: "  Run llama 3 8b inference  " });
  assert.deepEqual(ok, { ok: true, request: "Run llama 3 8b inference", difficulty: undefined });
  const withDifficulty = parseAnalyzeRequest({ request: "Run llama 3 8b inference", difficulty: "hard" });
  assert.equal(withDifficulty.ok && withDifficulty.difficulty, "hard");
});

test("analyze request validation rejects bad input", () => {
  for (const body of [
    null,
    "text",
    {},
    { request: "short" },
    { request: "x".repeat(4001) },
    { request: "Run llama 3 8b inference", difficulty: "extreme" },
    { request: "Run llama 3 8b inference", extra: 1 },
  ]) {
    assert.equal(parseAnalyzeRequest(body).ok, false, JSON.stringify(body)?.slice(0, 40));
  }
});
