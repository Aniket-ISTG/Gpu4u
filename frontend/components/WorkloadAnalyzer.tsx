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
        <span className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded-sm bg-[#1E3A5F] border border-[#E8D2B5]/40 text-[#E8D2B5] font-semibold">
          User Stated
        </span>
      );
    case "estimated":
      return (
        <span className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded-sm bg-[#112540] border border-[#A5A79B]/40 text-[#FAF4EB]">
          Inferred
        </span>
      );
    case "default":
      return (
        <span className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded-sm bg-[#0B1728] border border-[#A5A79B]/20 text-[#A5A79B]">
          Default
        </span>
      );
    case "missing":
    default:
      return (
        <span className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded-sm bg-[#0E1D33] border border-[#A5A79B]/20 text-[#A5A79B]/70">
          Omitted
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
    model?: string;
    taskType?: "inference" | "training" | "fine-tuning" | "rendering" | "other";
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
      model?: string;
      taskType?: "inference" | "training" | "fine-tuning" | "rendering" | "other";
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
    if (analysis.model) {
      specs.model = analysis.model;
    }
    if (analysis.taskType) {
      specs.taskType = analysis.taskType;
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
    <section id="analyzer" className="relative rounded-md border border-[#A5A79B]/25 bg-[#0D1B2E]/80 backdrop-blur-xl p-6 shadow-2xl transition-all">
      {/* Non-AI ambient warmth */}
      <div className="absolute top-0 right-1/4 w-96 h-32 bg-[#E8D2B5]/5 blur-3xl pointer-events-none" />

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-[#A5A79B]/20">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-md bg-[#1E3A5F] border border-[#E8D2B5]/30 text-[#E8D2B5]">
            <SparklesIcon className="w-5 h-5 text-[#E8D2B5]" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-display font-bold tracking-widest text-[#E8D2B5] uppercase">
                Workload Parser
              </span>
              <span className="px-1.5 py-0.5 rounded-sm text-[10px] font-mono bg-[#1E3A5F] border border-[#A5A79B]/30 text-[#E8D2B5]">
                Schema Validated
              </span>
            </div>
            <h2 className="text-lg font-bold text-[#FAF4EB] font-display tracking-tight mt-0.5">
              Natural-Language Compute Specification
            </h2>
          </div>
        </div>

        <div className="text-xs font-mono text-[#A5A79B] hidden sm:flex items-center gap-1.5">
          <span>Press</span>
          <kbd className="px-1.5 py-0.5 rounded-sm bg-[#112540] border border-[#A5A79B]/30 text-[#E8D2B5]">⌘</kbd>
          <span>+</span>
          <kbd className="px-1.5 py-0.5 rounded-sm bg-[#112540] border border-[#A5A79B]/30 text-[#E8D2B5]">Enter</kbd>
          <span>to run</span>
        </div>
      </div>

      {/* Starter Prompt Presets */}
      <div className="pt-4 flex items-center gap-2 flex-wrap text-xs">
        <span className="text-[#A5A79B] text-[11px] font-display uppercase tracking-wider">Presets:</span>
        {samplePrompts.map((sample) => (
          <button
            key={sample.title}
            type="button"
            onClick={() => setRequest(sample.prompt)}
            className="px-2.5 py-1 rounded-sm bg-[#11243E] border border-[#A5A79B]/25 hover:border-[#E8D2B5]/60 hover:text-[#FAF4EB] text-[#E8D2B5]/90 text-xs font-mono transition"
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
          <div className="absolute bottom-3 right-3 text-[11px] font-mono text-[#A5A79B] pointer-events-none">
            {request.length} / 4000
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11px] text-[#A5A79B] font-sans">
            Structured outputs schema validated server-side. Unstated specs marked as defaults or estimates.
          </p>

          <button
            className="inline-flex items-center gap-2 rounded-md bg-[#E8D2B5] px-5 py-2.5 text-xs font-display font-bold text-[#1E3A5F] transition hover:bg-[#FAF4EB] disabled:cursor-not-allowed disabled:opacity-50 shadow-md"
            disabled={isAnalyzing || request.trim().length < 10}
            type="submit"
          >
            {isAnalyzing ? (
              <>
                <div className="w-3.5 h-3.5 border-2 border-[#1E3A5F] border-t-transparent rounded-full animate-spin" />
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
        <div className="mt-4 rounded-md border border-[#1E3A5F] bg-[#112643]/90 p-4 text-xs font-mono text-[#E8D2B5] flex items-start gap-3">
          <span className="p-1 rounded-sm bg-[#1E3A5F] text-[#FAF4EB]">✕</span>
          <div>
            <strong className="block font-semibold">Analysis Notice</strong>
            <p className="mt-0.5 text-[#E8D2B5]/90">{error}</p>
          </div>
        </div>
      )}

      {/* Analysis Results */}
      {analysis && (
        <div className="mt-6 space-y-5 border-t border-[#A5A79B]/20 pt-6 animate-in fade-in duration-300">
          {/* Action Bar: Apply to Filters */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-md bg-[#112540] border border-[#E8D2B5]/30">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-sm bg-[#E8D2B5] animate-pulse" />
              <span className="text-xs font-mono font-medium text-[#FAF4EB]">
                Specs Extracted Successfully
              </span>
            </div>

            {(onApplySpecs || onApplyRequirements) && (
              <button
                type="button"
                onClick={handleApplyToFilters}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-sm bg-[#1E3A5F] hover:bg-[#23477A] text-[#E8D2B5] border border-[#E8D2B5]/40 font-display font-bold text-xs transition shadow-sm"
              >
                {appliedFeedback ? (
                  <>
                    <CheckIcon className="w-3.5 h-3.5 text-[#E8D2B5]" />
                    <span>Applied to Router!</span>
                  </>
                ) : (
                  <>
                    <span>Apply to Router Filters</span>
                    <ArrowRightIcon className="w-3.5 h-3.5 text-[#E8D2B5]" />
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
                className="rounded-md bg-[#0E1D33]/90 border border-[#A5A79B]/25 p-3.5 hover:border-[#E8D2B5]/40 transition"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-display uppercase tracking-wider text-[#A5A79B]">{label}</span>
                  {getSourceBadge(analysis.fieldSources[key])}
                </div>
                <p className="mt-2 font-display font-bold text-[#FAF4EB] text-sm">
                  {displayValue(analysis[key], key)}
                </p>
                <p className="mt-1 text-[10px] font-mono text-[#A5A79B]/80">
                  Source: {analysis.fieldSources[key].replaceAll("_", " ")}
                </p>
              </div>
            ))}
          </div>

          {/* Clarification Questions */}
          {analysis.clarificationQuestions.length > 0 && (
            <div className="rounded-md border border-[#E8D2B5]/40 bg-[#11243E] p-4 space-y-2">
              <div className="flex items-center gap-2 text-[#E8D2B5] font-display text-xs font-bold uppercase tracking-wider">
                <span>Clarification Questions</span>
              </div>
              <ul className="list-inside list-disc space-y-1 text-xs font-sans text-[#FAF4EB]/90">
                {analysis.clarificationQuestions.map((question) => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Validated JSON Inspector */}
          <div className="rounded-md border border-[#A5A79B]/25 bg-[#0B1728]/80 overflow-hidden">
            <details className="group" open>
              <summary className="cursor-pointer flex items-center justify-between p-3.5 text-xs font-display text-[#E8D2B5] hover:text-[#FAF4EB] transition">
                <span className="flex items-center gap-2">
                  <span className="text-[#A5A79B]">{'</>'}</span>
                  <span>View Validated JSON Payload</span>
                </span>
                <span className="text-[11px] text-[#A5A79B] group-open:rotate-180 transition-transform">
                  ▼
                </span>
              </summary>

              <div className="p-4 border-t border-[#A5A79B]/20 bg-[#08111E] relative">
                <button
                  type="button"
                  onClick={handleCopyJson}
                  className="absolute top-4 right-4 inline-flex items-center gap-1 px-2.5 py-1 rounded-sm bg-[#1E3A5F] hover:bg-[#23477A] text-[11px] font-mono text-[#E8D2B5] border border-[#A5A79B]/30 transition"
                >
                  {jsonCopied ? (
                    <>
                      <CheckIcon className="w-3 h-3 text-[#E8D2B5]" />
                      <span className="text-[#E8D2B5]">Copied</span>
                    </>
                  ) : (
                    <>
                      <CopyIcon className="w-3 h-3" />
                      <span>Copy</span>
                    </>
                  )}
                </button>
                <pre className="overflow-x-auto text-xs font-mono leading-relaxed text-[#E8D2B5]">
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
