"use client";

import React from "react";
import type { MarketplaceMeta } from "@/hooks/useMarketplace";

const SERVED_FROM: Record<MarketplaceMeta["servedFrom"], string> = {
  upstream: "fetched from Aquanode just now",
  cache: "served from the server cache",
  "stale-cache": "Aquanode failed, serving last good data",
};

function Step({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex-1 rounded-sm border border-[#A5A79B]/25 bg-[#091424]/90 p-3">
      <p className="text-[11px] font-bold uppercase tracking-wider text-[#E8D2B5] font-display">{title}</p>
      <p className="mt-1 font-mono text-[11px] text-[#A5A79B] break-all">{detail}</p>
    </div>
  );
}

/** Shows the path a marketplace request takes and what the server did with the data. */
export default function DataPathPanel({ meta }: { meta: MarketplaceMeta | null }) {
  if (!meta) return null;
  const kept = meta.totalRaw - meta.skipped - meta.duplicatesRemoved;

  return (
    <details className="rounded-md border border-[#A5A79B]/25 bg-[#0D1B2E]/80 font-sans">
      <summary className="cursor-pointer p-4 text-xs font-bold uppercase tracking-wider text-[#E8D2B5] font-display">
        Data path · how this marketplace data reached your browser
      </summary>
      <div className="space-y-3 border-t border-[#A5A79B]/20 p-4">
        <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
          <Step title="Your browser" detail="GET /api/marketplace" />
          <span className="text-center text-[#A5A79B]">→</span>
          <Step title="GPU4U server" detail="validate, normalize, de-duplicate, cache 30s" />
          <span className="text-center text-[#A5A79B]">→</span>
          <Step title="Aquanode" detail="GET server.aquanode.io/api/v1/marketplace" />
        </div>

        <dl className="grid gap-x-6 gap-y-1 text-xs text-[#A5A79B] sm:grid-cols-2">
          <div className="flex justify-between gap-3"><dt>Served</dt><dd className="font-mono text-[#E8D2B5]">{SERVED_FROM[meta.servedFrom]}</dd></div>
          <div className="flex justify-between gap-3"><dt>Aquanode fetch time</dt><dd className="font-mono text-[#E8D2B5]">{meta.upstreamMs} ms</dd></div>
          <div className="flex justify-between gap-3"><dt>Fetched at</dt><dd className="font-mono text-[#E8D2B5]">{new Date(meta.fetchedAt).toLocaleTimeString()}</dd></div>
          <div className="flex justify-between gap-3"><dt>Aquanode timestamp</dt><dd className="font-mono text-[#E8D2B5]">{meta.apiTimestamp ? new Date(meta.apiTimestamp).toLocaleTimeString() : "none"}</dd></div>
          <div className="flex justify-between gap-3"><dt>Rows received</dt><dd className="font-mono text-[#E8D2B5]">{meta.totalRaw}</dd></div>
          <div className="flex justify-between gap-3"><dt>Duplicates removed</dt><dd className="font-mono text-[#E8D2B5]">{meta.duplicatesRemoved}</dd></div>
          <div className="flex justify-between gap-3"><dt>Invalid rows skipped</dt><dd className="font-mono text-[#E8D2B5]">{meta.skipped}</dd></div>
          <div className="flex justify-between gap-3"><dt>Offers kept</dt><dd className="font-mono text-[#E8D2B5]">{kept}</dd></div>
        </dl>

        {meta.stale && (
          <p className="text-xs text-[#E8D2B5]">
            The last refresh failed, so these offers may be out of date.
          </p>
        )}
      </div>
    </details>
  );
}
