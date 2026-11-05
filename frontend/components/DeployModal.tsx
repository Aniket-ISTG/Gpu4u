"use client";

import React, { useState } from "react";
import type { RankedGPUOffer } from "./OptimalMatchHero";
import { XIcon, CopyIcon, CheckIcon, CpuIcon } from "./icons";

interface DeployModalProps {
  offer: RankedGPUOffer | null;
  onClose: () => void;
}

export default function DeployModal({ offer, onClose }: DeployModalProps) {
  const [activeTab, setActiveTab] = useState<"ssh" | "curl" | "docker">("ssh");
  const [copied, setCopied] = useState(false);
  const [durationHours, setDurationHours] = useState(4);

  if (!offer) return null;

  const totalCost = (offer.pricePerHourUsd * offer.gpuCount * durationHours).toFixed(2);

  const sshCommand = `ssh -p 2244 root@node-${offer.region}.gpu4u.network \\
  -i ~/.ssh/gpu4u_ed25519 \\
  -o "OfferId=${offer.id}" \\
  -o "StrictHostKeyChecking=accept-new"`;

  const curlCommand = `curl -X POST https://api.gpu4u.network/v1/allocations \\
  -H "Authorization: Bearer $GPU4U_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "offerId": "${offer.id}",
    "gpuModel": "${offer.gpuModel}",
    "durationHours": ${durationHours},
    "region": "${offer.region}"
  }'`;

  const dockerCommand = `docker run --gpus '"device=all"' --rm -it \\
  -v $(pwd):/workspace \\
  -e GPU4U_NODE="${offer.id}" \\
  ghcr.io/gpu4u/cuda-runner:12.4-runtime-ubuntu22.04`;

  const activeSnippet =
    activeTab === "ssh" ? sshCommand : activeTab === "curl" ? curlCommand : dockerCommand;

  function handleCopy() {
    navigator.clipboard.writeText(activeSnippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-black/80 backdrop-blur-md animate-fadeIn">
      <div
        className="relative w-full max-w-2xl overflow-hidden rounded-2xl border border-zinc-700/80 bg-zinc-900/95 p-6 shadow-2xl transition-all"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close Button */}
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
        >
          <XIcon className="w-5 h-5" />
        </button>

        {/* Modal Header */}
        <div className="flex items-start gap-3.5 border-b border-zinc-800 pb-5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
            <CpuIcon className="w-5 h-5" />
          </div>
          <div>
            <span className="text-[11px] font-bold uppercase tracking-wider text-cyan-400">
              Provisioning & Allocation
            </span>
            <h3 className="text-xl font-bold text-white">
              Deploy to {offer.gpuModel} ({offer.gpuCount}x)
            </h3>
            <p className="text-xs text-zinc-400">
              Provider: {offer.provider} · Region: {offer.region} · Node ID: {offer.id}
            </p>
          </div>
        </div>

        {/* Duration & Cost Simulator */}
        <div className="my-5 rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
            <span className="text-xs font-semibold text-zinc-300">
              Planned Workload Duration
            </span>
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-400 font-mono">{durationHours} hours</span>
              <span className="text-sm font-bold text-emerald-400 font-mono">
                ~${totalCost} total
              </span>
            </div>
          </div>
          <input
            type="range"
            min="1"
            max="72"
            value={durationHours}
            onChange={(e) => setDurationHours(Number(e.target.value))}
            className="w-full accent-cyan-400 cursor-pointer h-1.5 bg-zinc-800 rounded-lg appearance-none"
          />
          <div className="flex justify-between text-[10px] text-zinc-500 font-mono pt-1">
            <span>1 hour</span>
            <span>12 hrs</span>
            <span>24 hrs</span>
            <span>48 hrs</span>
            <span>72 hrs</span>
          </div>
        </div>

        {/* Snippet Tabs */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex gap-1.5 p-1 rounded-lg bg-zinc-950/80 border border-zinc-800">
              {(["ssh", "curl", "docker"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  className={`px-3 py-1 rounded-md text-xs font-medium uppercase font-mono transition-all ${
                    activeTab === tab
                      ? "bg-cyan-500 text-zinc-950 font-bold"
                      : "text-zinc-400 hover:text-white"
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/80 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:text-white hover:bg-zinc-700 transition-colors"
            >
              {copied ? (
                <>
                  <CheckIcon className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-emerald-400">Copied!</span>
                </>
              ) : (
                <>
                  <CopyIcon className="w-3.5 h-3.5" />
                  <span>Copy Snippet</span>
                </>
              )}
            </button>
          </div>

          <div className="relative rounded-xl border border-zinc-800 bg-zinc-950 p-4 font-mono text-xs text-cyan-200 overflow-x-auto leading-relaxed">
            <pre className="whitespace-pre">{activeSnippet}</pre>
          </div>
        </div>

        {/* Modal Actions */}
        <div className="mt-6 flex items-center justify-end gap-3 pt-4 border-t border-zinc-800">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-2 text-xs font-medium text-zinc-300 hover:text-white hover:bg-zinc-800 transition-colors"
          >
            Close
          </button>
          <button
            type="button"
            onClick={handleCopy}
            className="rounded-xl bg-cyan-500 px-4 py-2 text-xs font-bold text-zinc-950 hover:bg-cyan-400 transition-colors shadow-md shadow-cyan-500/20"
          >
            Copy Command & Launch
          </button>
        </div>
      </div>
    </div>
  );
}
