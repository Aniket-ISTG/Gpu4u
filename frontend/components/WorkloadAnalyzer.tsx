"use client";

import { useState, type FormEvent, type KeyboardEvent } from "react";
import type { WorkloadAnalysis } from "@/lib/validation/workload.schema";
import { SparklesIcon, ZapIcon, CopyIcon, CheckIcon, ArrowRightIcon } from "./icons";

const fields: Array<{
  key: keyof WorkloadAnalysis["fieldSources"];
  label: string;
}> = [
  { key: "taskType", label: "Task type" },
  { key: "model", label: "Model" },
  { key: "minimumVramGb", label: "Minimum VRAM" },
  { key: "gpuCount", label: "GPU count" },
  { key: "maxHourlyBudgetUsd", label: "Hourly budget" },
  { key: "optimization", label: "Optimization" },
  { key: "cudaRequired", label: "CUDA required" },
];

function displayValue(value: unknown, key: string) {
  if (value === null) return "Not specified";
  if (key === "minimumVramGb") return `${value} GB`;
  if (key === "maxHourlyBudgetUsd") return `$${value} / hour`;
  if (key === "cudaRequired") return value ? "Yes" : "No";
  return String(value);
}

function getSourceBadge(source: string) {
  switch (source) {
    case "user_provided":
      return (
        <span className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">
          User Stated
        </span>
      );
    case "estimated":
      return (
        <span className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-cyan-500/15 border border-cyan-500/30 text-cyan-300">
          AI Inferred
        </span>
      );
    case "default":
      return (
        <span className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800 border border-white/[0.08] text-zinc-400">
          Default
        </span>
      );
    case "missing":
    default:
      return (
        <span className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-amber-400">
          Missing
        </span>
      );
  }
}

interface WorkloadAnalyzerProps {
  onApplyRequirements?: (specs: {
    minMemory?: number;
    maxPrice?: number;
    gpuCount?: number;
  }) => void;
  onApplySpecs?: (specs: {
    minMemory?: number;
    maxPrice?: number;
    gpuCount?: number;
    optimization?: "balanced" | "cost" | "performance";
  }) => void;
}

export default function WorkloadAnalyzer({ onApplyRequirements, onApplySpecs }: WorkloadAnalyzerProps) {
  const [request, setRequest] = useState("");
  const [analysis, setAnalysis] = useState<WorkloadAnalysis | null>(null);
  const [error, setError] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [jsonCopied, setJsonCopied] = useState(false);
  const [appliedFeedback, setAppliedFeedback] = useState(false);

  const samplePrompts = [
    {
      title: "Llama 3 8B Inference",
      prompt: "Run Llama 3 8B inference with at least 16GB VRAM. My maximum budget is $2 per hour. Find the cheapest GPU.",
    },
    {
      title: "LoRA Multi-GPU Fine-Tuning",
      prompt: "Fine-tune Mistral 7B using 2 GPUs with at least 24GB VRAM each. Maximum budget $1.80/hr.",
    },
    {
      title: "High VRAM DeepSeek R1",
      prompt: "Deploy DeepSeek R1 32B model requiring 40GB+ VRAM with CUDA required. Prioritize cost.",
    },
  ];

  async function handleSubmit(event?: FormEvent<HTMLFormElement>) {
    if (event) event.preventDefault();
    if (isAnalyzing || request.trim().length < 10) return;

    setError("");
    setAnalysis(null);
    setIsAnalyzing(true);
    setAppliedFeedback(false);

    try {
      const response = await fetch("/api/workloads/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request }),
      });
      const result = (await response.json()) as {
        analysis?: WorkloadAnalysis;
        error?: string;
      };

      if (!response.ok || !result.analysis) {
        throw new Error(result.error || "Analysis could not be completed.");
      }

      setAnalysis(result.analysis);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Analysis could not be completed.",
      );
    } finally {
      setIsAnalyzing(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    }
  }

  function handleCopyJson() {
    if (!analysis) return;
    navigator.clipboard.writeText(JSON.stringify(analysis, null, 2));
    setJsonCopied(true);
    setTimeout(() => setJsonCopied(false), 2000);
  }

  function handleApplyToFilters() {
    if (!analysis) return;

    const specs: {
      minMemory?: number;
      maxPrice?: number;
      gpuCount?: number;
      optimization?: "balanced" | "cost" | "performance";
    } = {};

    if (analysis.minimumVramGb !== null && analysis.minimumVramGb > 0) {
      specs.minMemory = analysis.minimumVramGb;
    }
    if (analysis.maxHourlyBudgetUsd !== null && analysis.maxHourlyBudgetUsd > 0) {
      specs.maxPrice = analysis.maxHourlyBudgetUsd;
    }
    if (analysis.gpuCount !== null && analysis.gpuCount > 0) {
      specs.gpuCount = analysis.gpuCount;
    }
    if (analysis.optimization) {
      specs.optimization = analysis.optimization;
    }

    if (onApplyRequirements) {
      onApplyRequirements(specs);
    }
    if (onApplySpecs) {
      onApplySpecs(specs);
    }

    setAppliedFeedback(true);
    setTimeout(() => setAppliedFeedback(false), 3000);
  }

  return (
    <section id="analyzer" className="relative rounded-2xl border border-white/[0.08] bg-zinc-950/80 backdrop-blur-xl p-6 shadow-2xl transition-all">
      {/* Glow accent */}
      <div className="absolute top-0 right-1/4 w-96 h-32 bg-cyan-500/5 blur-3xl pointer-events-none" />

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-white/[0.06]">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
            <SparklesIcon className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono font-semibold tracking-widest text-cyan-400 uppercase">
                AI Workload Parser
              </span>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-cyan-950/60 border border-cyan-800/40 text-cyan-300">
                LLM Grounded
              </span>
            </div>
            <h2 className="text-lg font-bold text-white tracking-tight mt-0.5">
              Natural-Language Compute Specification
            </h2>
          </div>
        </div>

        <div className="text-xs font-mono text-zinc-500 hidden sm:flex items-center gap-1.5">
          <span>Press</span>
          <kbd className="px-1.5 py-0.5 rounded bg-zinc-900 border border-white/[0.1] text-zinc-300">⌘</kbd>
          <span>+</span>
          <kbd className="px-1.5 py-0.5 rounded bg-zinc-900 border border-white/[0.1] text-zinc-300">Enter</kbd>
          <span>to run</span>
        </div>
      </div>

      {/* Starter Prompt Presets */}
      <div className="pt-4 flex items-center gap-2 flex-wrap text-xs">
        <span className="text-zinc-500 text-[11px] font-mono">Example Presets:</span>
        {samplePrompts.map((sample) => (
          <button
            key={sample.title}
            type="button"
            onClick={() => setRequest(sample.prompt)}
            className="px-2.5 py-1 rounded-lg bg-zinc-900/90 border border-white/[0.06] hover:border-cyan-500/40 hover:text-cyan-300 text-zinc-400 text-xs font-mono transition"
          >
            {sample.title}
          </button>
        ))}
      </div>

      {/* Form */}
      <form className="space-y-3 pt-3" onSubmit={handleSubmit}>
        <label className="sr-only" htmlFor="workload-request">
          Natural-language compute request
        </label>
        <div className="relative">
          <textarea
            id="workload-request"
            className="field min-h-28 resize-y font-mono text-xs leading-relaxed"
            maxLength={4000}
            minLength={10}
            onKeyDown={handleKeyDown}
            onChange={(event) => setRequest(event.target.value)}
            placeholder={'For example: "Run Llama 3 8B inference with at least 16GB VRAM. My maximum budget is $2 per hour. Find the cheapest GPU."'}
            required
            value={request}
          />
          <div className="absolute bottom-3 right-3 text-[11px] font-mono text-zinc-500 pointer-events-none">
            {request.length} / 4000
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11px] text-zinc-500 font-mono">
            Structured outputs schema validated server-side. Unstated specs marked as defaults/estimates.
          </p>

          <button
            className="inline-flex items-center gap-2 rounded-xl bg-cyan-500 px-5 py-2.5 text-xs font-mono font-bold text-zinc-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50 shadow-[0_0_15px_-3px_rgba(6,182,212,0.3)]"
            disabled={isAnalyzing || request.trim().length < 10}
            type="submit"
          >
            {isAnalyzing ? (
              <>
                <div className="w-3.5 h-3.5 border-2 border-zinc-950 border-t-transparent rounded-full animate-spin" />
                <span>Extracting Specs...</span>
              </>
            ) : (
              <>
                <ZapIcon className="w-3.5 h-3.5" />
                <span>Analyze Workload</span>
              </>
            )}
          </button>
        </div>
      </form>

      {/* Error Callout */}
      {error && (
        <div className="mt-4 rounded-xl border border-red-500/30 bg-red-950/40 p-4 text-xs font-mono text-red-200 flex items-start gap-3">
          <span className="p-1 rounded bg-red-500/20 text-red-400">✕</span>
          <div>
            <strong className="block font-semibold">Analysis Failed</strong>
            <p className="mt-0.5 text-zinc-300">{error}</p>
          </div>
        </div>
      )}

      {/* Analysis Results */}
      {analysis && (
        <div className="mt-6 space-y-5 border-t border-white/[0.08] pt-6 animate-in fade-in duration-300">
          {/* Action Bar: Apply to Filters */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-xl bg-cyan-950/20 border border-cyan-700/30">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping" />
              <span className="text-xs font-mono font-medium text-cyan-200">
                Specs Extracted Successfully
              </span>
            </div>

            {(onApplySpecs || onApplyRequirements) && (
              <button
                type="button"
                onClick={handleApplyToFilters}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-zinc-950 font-mono font-bold text-xs transition shadow-sm"
              >
                {appliedFeedback ? (
                  <>
                    <CheckIcon className="w-3.5 h-3.5" />
                    <span>Applied to Router!</span>
                  </>
                ) : (
                  <>
                    <span>Apply to Router Filters</span>
                    <ArrowRightIcon className="w-3.5 h-3.5" />
                  </>
                )}
              </button>
            )}
          </div>

          {/* Grid of parameters */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {fields.map(({ key, label }) => (
              <div
                key={key}
                className="rounded-xl bg-zinc-900/60 border border-white/[0.06] p-3.5 hover:border-white/[0.12] transition"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-mono text-zinc-400">{label}</span>
                  {getSourceBadge(analysis.fieldSources[key])}
                </div>
                <p className="mt-2 font-mono font-bold text-white text-sm">
                  {displayValue(analysis[key], key)}
                </p>
                <p className="mt-1 text-[10px] font-mono text-zinc-500">
                  Source: {analysis.fieldSources[key].replaceAll("_", " ")}
                </p>
              </div>
            ))}
          </div>

          {/* Clarification Questions */}
          {analysis.clarificationQuestions.length > 0 && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-4 space-y-2">
              <div className="flex items-center gap-2 text-amber-300 font-mono text-xs font-bold">
                <span>⚠ Clarification Questions</span>
              </div>
              <ul className="list-inside list-disc space-y-1 text-xs font-mono text-zinc-300">
                {analysis.clarificationQuestions.map((question) => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Validated JSON Inspector */}
          <div className="rounded-xl border border-white/[0.06] bg-zinc-900/40 overflow-hidden">
            <details className="group">
              <summary className="cursor-pointer flex items-center justify-between p-3.5 text-xs font-mono text-zinc-400 hover:text-white transition">
                <span className="flex items-center gap-2">
                  <span className="text-cyan-400">{'</>'}</span>
                  <span>View Validated JSON Payload</span>
                </span>
                <span className="text-[11px] text-zinc-500 group-open:rotate-180 transition-transform">
                  ▼
                </span>
              </summary>

              <div className="p-4 border-t border-white/[0.06] bg-black/60 relative">
                <button
                  type="button"
                  onClick={handleCopyJson}
                  className="absolute top-4 right-4 inline-flex items-center gap-1 px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-[11px] font-mono text-zinc-300 transition"
                >
                  {jsonCopied ? (
                    <>
                      <CheckIcon className="w-3 h-3 text-emerald-400" />
                      <span className="text-emerald-400">Copied</span>
                    </>
                  ) : (
                    <>
                      <CopyIcon className="w-3 h-3" />
                      <span>Copy</span>
                    </>
                  )}
                </button>
                <pre className="overflow-x-auto text-xs font-mono leading-relaxed text-cyan-200">
                  {JSON.stringify(analysis, null, 2)}
                </pre>
              </div>
            </details>
          </div>
        </div>
      )}
    </section>
  );
}
