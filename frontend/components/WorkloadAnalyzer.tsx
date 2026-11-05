"use client";

import { useState, type FormEvent } from "react";
import type { WorkloadAnalysis } from "@/lib/validation/workload.schema";

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

export default function WorkloadAnalyzer() {
  const [request, setRequest] = useState("");
  const [analysis, setAnalysis] = useState<WorkloadAnalysis | null>(null);
  const [error, setError] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setAnalysis(null);
    setIsAnalyzing(true);

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

  return (
    <section className="space-y-5 border border-zinc-800 rounded-2xl p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold tracking-widest text-cyan-400">
            AI WORKLOAD ANALYZER
          </p>
          <h2 className="mt-2 text-xl font-semibold">Describe your compute request</h2>
        </div>
        <span className="rounded border border-cyan-900 px-2 py-1 text-xs text-cyan-300">
          AI interpreted · server-side
        </span>
      </div>

      <form className="space-y-3" onSubmit={handleSubmit}>
        <label className="sr-only" htmlFor="workload-request">
          Natural-language compute request
        </label>
        <textarea
          id="workload-request"
          className="field min-h-28 resize-y"
          maxLength={4000}
          minLength={10}
          onChange={(event) => setRequest(event.target.value)}
          placeholder={'For example: Run Llama 3 8B inference with at least 16GB VRAM. My maximum budget is $2 per hour. Find the cheapest GPU.'}
          required
          value={request}
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-zinc-500">Requirements not stated will remain unspecified or be clearly marked as estimates/defaults.</p>
          <button
            className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isAnalyzing || request.trim().length < 10}
            type="submit"
          >
            {isAnalyzing ? "Analyzing..." : "Analyze workload"}
          </button>
        </div>
      </form>

      {error && (
        <p aria-live="polite" className="rounded-lg border border-red-800 bg-red-950/50 p-3 text-sm text-red-200">
          {error}
        </p>
      )}

      {analysis && (
        <div className="space-y-5 border-t border-zinc-800 pt-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {fields.map(({ key, label }) => (
              <div className="rounded-lg bg-zinc-900 p-3" key={key}>
                <p className="text-xs text-zinc-500">{label}</p>
                <p className="mt-1 font-medium">
                  {displayValue(analysis[key], key)}
                </p>
                <p className="mt-1 text-xs text-cyan-300">
                  {analysis.fieldSources[key].replaceAll("_", " ")}
                </p>
              </div>
            ))}
          </div>

          {analysis.clarificationQuestions.length > 0 && (
            <div className="border-l-2 border-amber-400 pl-4">
              <h3 className="font-semibold text-amber-200">Clarification needed</h3>
              <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-zinc-300">
                {analysis.clarificationQuestions.map((question) => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
            </div>
          )}

          <details className="group">
            <summary className="cursor-pointer text-sm font-medium text-cyan-300">
              View validated JSON
            </summary>
            <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-xs leading-5 text-zinc-300">
              {JSON.stringify(analysis, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </section>
  );
}