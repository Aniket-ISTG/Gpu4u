"use client";

import React, { useState } from "react";
import type { RankedGPUOffer } from "@/lib/marketplace/ranking";
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

  const totalCost = (offer.bundlePricePerHourUsd * durationHours).toFixed(2);

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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-black/85 backdrop-blur-md animate-fadeIn font-sans">
      <div
        className="relative w-full max-w-2xl overflow-hidden rounded-md border border-[#A5A79B]/35 bg-[#0D1B2E] p-6 shadow-2xl transition-all"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close Button */}
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 p-1.5 rounded-sm text-[#A5A79B] hover:text-[#FAF4EB] hover:bg-[#112643] transition-colors"
        >
          <XIcon className="w-5 h-5" />
        </button>

        {/* Modal Header */}
        <div className="flex items-start gap-3.5 border-b border-[#A5A79B]/20 pb-5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm bg-[#1E3A5F] text-[#E8D2B5] border border-[#E8D2B5]/30">
            <CpuIcon className="w-5 h-5 text-[#E8D2B5]" />
          </div>
          <div>
            <span className="text-[11px] font-bold uppercase tracking-wider text-[#E8D2B5] font-display">
              Provisioning & Allocation
            </span>
            <h3 className="text-xl font-bold text-[#FAF4EB] font-display">
              Deploy to {offer.gpuModel} ({offer.gpuCount}x)
            </h3>
            <p className="text-xs text-[#A5A79B]">
              Provider: {offer.provider} · Region: {offer.region} · Node ID: {offer.id}
            </p>
          </div>
        </div>

        <p className="mt-4 rounded-sm border border-[#E8D2B5]/30 bg-[#112540]/60 p-3 text-xs text-[#E8D2B5]">
          Stage 0: provisioning is not connected yet. The commands below are illustrative placeholders, and no GPU is
          rented from the provider.
        </p>

        {/* Duration & Cost Simulator */}
        <div className="my-5 rounded-sm border border-[#A5A79B]/25 bg-[#091424]/90 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
            <span className="text-xs font-bold uppercase tracking-wider text-[#A5A79B] font-display">
              Planned Workload Duration
            </span>
            <div className="flex items-center gap-2">
              <span className="text-xs text-[#A5A79B] font-mono">{durationHours} hours</span>
              <span className="text-sm font-bold text-[#FAF4EB] font-display">
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
            className="w-full accent-[#E8D2B5] cursor-pointer h-1.5 bg-[#112643] rounded-sm appearance-none"
          />
          <div className="flex justify-between text-[10px] text-[#A5A79B] font-mono pt-1">
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
            <div className="flex gap-1.5 p-1 rounded-sm bg-[#070F1C] border border-[#A5A79B]/25">
              {(["ssh", "curl", "docker"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  className={`px-3 py-1 rounded-sm text-xs font-bold uppercase font-display transition-all ${
                    activeTab === tab
                      ? "bg-[#1E3A5F] text-[#E8D2B5] border border-[#E8D2B5]/30"
                      : "text-[#A5A79B] hover:text-[#FAF4EB]"
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 rounded-sm border border-[#E8D2B5]/40 bg-[#112540] px-3 py-1.5 text-xs font-bold text-[#E8D2B5] hover:text-[#FAF4EB] hover:bg-[#18335A] transition-colors font-display"
            >
              {copied ? (
                <>
                  <CheckIcon className="w-3.5 h-3.5 text-[#E8D2B5]" />
                  <span className="text-[#E8D2B5]">Copied!</span>
                </>
              ) : (
                <>
                  <CopyIcon className="w-3.5 h-3.5" />
                  <span>Copy Snippet</span>
                </>
              )}
            </button>
          </div>

          <div className="relative rounded-sm border border-[#A5A79B]/25 bg-[#07101C] p-4 font-mono text-xs text-[#E8D2B5] overflow-x-auto leading-relaxed">
            <pre className="whitespace-pre">{activeSnippet}</pre>
          </div>
        </div>

        {/* Modal Actions */}
        <div className="mt-6 flex items-center justify-end gap-3 pt-4 border-t border-[#A5A79B]/20">
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm border border-[#A5A79B]/30 bg-[#0E1F36] px-4 py-2 text-xs font-bold text-[#A5A79B] hover:text-[#FAF4EB] hover:bg-[#122745] transition-colors font-display uppercase tracking-wider"
          >
            Close
          </button>
          <button
            type="button"
            onClick={handleCopy}
            className="rounded-sm bg-[#E8D2B5] px-4 py-2 text-xs font-bold text-[#1E3A5F] hover:bg-[#FAF4EB] transition-colors shadow-md font-display uppercase tracking-wider"
          >
            Copy Command & Launch
          </button>
        </div>
      </div>
    </div>
  );
}
