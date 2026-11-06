"use client";

import React from "react";
import type { TaskType, WorkloadProfile } from "@/lib/estimation/workload-profile";

type Optimization = "cost" | "performance" | "balanced";

interface Props {
  profile: WorkloadProfile;
  touched: Set<keyof WorkloadProfile>;
  onChange: <K extends keyof WorkloadProfile>(key: K, value: WorkloadProfile[K]) => void;
  onTaskType: (type: TaskType) => void;
  optimization: Optimization;
  onOptimization: (o: Optimization) => void;
  maxTotalBudgetUsd: number | null;
  onMaxTotalBudget: (v: number | null) => void;
}

const TASKS: TaskType[] = ["inference", "training", "fine-tuning", "rendering", "other"];

export default function WorkloadSizeForm(props: Props) {
  const { profile, touched, onChange, onTaskType } = props;
  const isInference = profile.taskType === "inference";
  const isTraining = profile.taskType === "training" || profile.taskType === "fine-tuning";
  const hasModel = isInference || isTraining;

  function num(key: keyof WorkloadProfile, label: string, step = 1) {
    return (
      <label className="block space-y-1">
        <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-[#A5A79B] font-display">
          {label}
          {!touched.has(key) && (
            <span className="rounded-sm bg-[#1E3A5F] px-1 py-px text-[9px] normal-case tracking-normal text-[#E8D2B5]">
              default
            </span>
          )}
        </span>
        <input
          type="number"
          min={0}
          step={step}
          className="field"
          value={profile[key] as number}
          onChange={(e) => onChange(key, Number(e.target.value) as never)}
        />
      </label>
    );
  }

  return (
    <section className="rounded-md border border-[#A5A79B]/25 bg-[#0D1B2E]/80 p-6 backdrop-blur-xl shadow-xl font-sans space-y-5">
      <div>
        <h2 className="text-lg font-bold text-[#FAF4EB] font-display">Workload Size</h2>
        <p className="text-xs text-[#A5A79B]">
          Used to estimate how long each GPU would take. Fields marked default are placeholders until you edit them.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="block space-y-1">
          <span className="text-[11px] uppercase tracking-wider text-[#A5A79B] font-display">Task type</span>
          <select className="field" value={profile.taskType} onChange={(e) => onTaskType(e.target.value as TaskType)}>
            {TASKS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-[11px] uppercase tracking-wider text-[#A5A79B] font-display">Optimize for</span>
          <select
            className="field"
            value={props.optimization}
            onChange={(e) => props.onOptimization(e.target.value as Optimization)}
          >
            <option value="cost">Lowest total cost</option>
            <option value="balanced">Balanced</option>
            <option value="performance">Fastest</option>
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-[11px] uppercase tracking-wider text-[#A5A79B] font-display">Max total budget (USD)</span>
          <input
            type="number"
            min={0}
            step={0.5}
            placeholder="No limit"
            className="field"
            value={props.maxTotalBudgetUsd ?? ""}
            onChange={(e) => props.onMaxTotalBudget(e.target.value === "" ? null : Number(e.target.value))}
          />
        </label>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {hasModel && num("modelParamsB", "Model size (B params)", 0.5)}
        {isInference && (
          <>
            {num("numPrompts", "Number of prompts")}
            {num("avgInputTokens", "Avg input tokens")}
            {num("avgOutputTokens", "Avg output tokens")}
            {num("batchSize", "Batch size")}
          </>
        )}
        {isTraining && (
          <>
            {num("datasetTokens", "Dataset tokens / epoch", 1_000_000)}
            {num("epochs", "Epochs")}
          </>
        )}
        {profile.taskType === "fine-tuning" && (
          <label className="flex items-center gap-2 pt-6 text-sm text-[#E8D2B5]">
            <input type="checkbox" checked={profile.lora} onChange={(e) => onChange("lora", e.target.checked)} />
            LoRA fine-tune
          </label>
        )}
        {!hasModel && num("referenceHoursOnH100", "Hours on one H100", 0.5)}
      </div>
    </section>
  );
}
