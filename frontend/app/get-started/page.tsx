"use client";

import { useMemo, useState } from "react";
import Header from "@/components/Header";
import AmbientBackground from "@/components/AmbientBackground";
import WorkloadAnalyzer from "@/components/WorkloadAnalyzer";
import WorkloadConfigurator from "@/components/WorkloadConfigurator";
import WorkloadSizeForm from "@/components/WorkloadSizeForm";
import CostRankingTable from "@/components/CostRankingTable";
import PaymentFlow from "@/components/payments/PaymentFlow";
import Footer from "@/components/Footer";
import { useMarketplace } from "@/hooks/useMarketplace";
import { useAutoMode } from "@/hooks/useAutoMode";
import { applyDifficulty, DIFFICULTY_SCALE, type Difficulty } from "@/lib/estimation/difficulty";
import { rankOffersByEstimatedCost, type RoutedOffer, type RoutingConstraints } from "@/lib/routing/cost-ranking";
import {
  DEFAULTS,
  parseModelParamsB,
  type TaskType,
  type WorkloadProfile,
} from "@/lib/estimation/workload-profile";

export default function GetStarted() {
  const { offers, loading, error } = useMarketplace();

  const [minMemory, setMinMemory] = useState(16);
  const [maxPrice, setMaxPrice] = useState(2);
  const [gpuCount, setGpuCount] = useState(1);
  const [rentOffer, setRentOffer] = useState<RoutedOffer | null>(null);
  const [autoMode, setAutoMode] = useAutoMode();
  // Set when Auto mode has just filled in the specs: the best GPU is chosen as soon as it is ranked.
  const [autoPick, setAutoPick] = useState(false);

  const [profile, setProfile] = useState<WorkloadProfile>(DEFAULTS.inference);
  const [touched, setTouched] = useState<Set<keyof WorkloadProfile>>(new Set());
  const [optimization, setOptimization] = useState<"cost" | "performance" | "balanced">("cost");
  const [maxTotalBudgetUsd, setMaxTotalBudgetUsd] = useState<number | null>(null);

  const [difficulty, setDifficulty] = useState<Difficulty | null>(null);
  const effectiveProfile = useMemo(
    () => applyDifficulty(profile, touched, difficulty),
    [profile, touched, difficulty]
  );

  const constraints = useMemo<RoutingConstraints>(
    () => ({
      minVramGb: minMemory,
      gpuCount,
      maxHourlyBudgetUsd: maxPrice,
      maxTotalBudgetUsd,
      maxDurationHours: null,
      cudaRequired: null,
      optimization,
    }),
    [minMemory, gpuCount, maxPrice, maxTotalBudgetUsd, optimization]
  );

  const result = useMemo(
    () => rankOffersByEstimatedCost(offers, effectiveProfile, constraints),
    [offers, effectiveProfile, constraints]
  );

  // The chosen GPU follows the live ranking, so its price and duration stay current while the panel is open.
  // Auto mode: once the specs are applied and ranked, the top GPU is selected. This adjusts state while
  // rendering, which React supports for derived state, so there is no extra render with a stale choice.
  if (autoPick && autoMode) {
    if (result.selected) {
      setRentOffer(result.selected);
      setAutoPick(false);
    } else if (!loading && offers.length > 0) {
      setAutoPick(false); // nothing eligible: leave the choice to the user
    }
  }

  const renting = rentOffer ? (result.ranked.find((r) => r.offer.id === rentOffer.offer.id) ?? rentOffer) : null;

  function updateProfile<K extends keyof WorkloadProfile>(key: K, value: WorkloadProfile[K]) {
    setProfile((p) => ({ ...p, [key]: value }));
    setTouched((t) => new Set(t).add(key));
  }

  function changeTaskType(type: TaskType) {
    setProfile({ ...DEFAULTS[type] });
    setTouched(new Set());
  }

  function handleReset() {
    setMinMemory(16);
    setMaxPrice(2);
    setGpuCount(1);
  }

  function handleApplyRequirements(reqs: {
    minMemory?: number;
    maxPrice?: number;
    gpuCount?: number;
    optimization?: "cost" | "performance" | "balanced";
    model?: string;
    taskType?: TaskType;
  }) {
    if (autoMode) {
      setRentOffer(null);
      setAutoPick(true);
    }
    if (reqs.minMemory != null) setMinMemory(reqs.minMemory);
    if (reqs.maxPrice != null) setMaxPrice(reqs.maxPrice);
    if (reqs.gpuCount != null) setGpuCount(reqs.gpuCount);
    if (reqs.optimization) setOptimization(reqs.optimization);

    if (reqs.taskType || reqs.model) {
      const type = reqs.taskType ?? profile.taskType;
      const size = parseModelParamsB(reqs.model);
      const next = { ...DEFAULTS[type] };
      const nextTouched = new Set<keyof WorkloadProfile>();
      if (size !== null) {
        next.modelParamsB = size;
        nextTouched.add("modelParamsB");
      }
      setProfile(next);
      setTouched(nextTouched);
    }
  }

  return (
    <div className="min-h-screen flex flex-col relative text-[#FAF4EB] selection:bg-[#E8D2B5] selection:text-[#1E3A5F]">
      <AmbientBackground />
      <Header offersCount={offers.length} />

      <main className="relative z-10 flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 py-12 space-y-8 font-sans">
        <section className="text-center space-y-3">
          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight font-display">Get Started</h1>
          <p className="text-[#E8D2B5]/80 text-sm sm:text-base leading-relaxed">
            Describe your task and GPU4U finds the best live GPU for it. Connect a wallet, pick a GPU to rent, and an x402 agent pays for it under your spending limits.
          </p>
        </section>

        {error && (
          <div className="rounded-md border border-[#1E3A5F] bg-[#112643]/90 p-4 text-sm text-[#E8D2B5]">
            <span className="font-bold text-[#FAF4EB]">Error:</span> {error}
          </div>
        )}

        <label className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[#A5A79B]/25 bg-[#0D1B2E]/80 p-4">
          <span className="space-y-0.5">
            <span className="block font-display text-sm font-bold text-[#FAF4EB]">Auto mode</span>
            <span className="block text-xs text-[#A5A79B]">
              {autoMode
                ? "On: after Analyze Workload, the specs are filled in, the best GPU is chosen, the quote is taken and the payment is prepared automatically. Your wallet still asks you to sign, and payments above your limit still need your approval."
                : "Off: you fill in the specs, choose a GPU, take the quote and start the payment yourself."}
            </span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={autoMode}
            aria-label="Auto mode"
            onClick={() => setAutoMode(!autoMode)}
            className={`relative h-7 w-14 shrink-0 rounded-full border transition-colors ${autoMode ? "border-[#E8D2B5] bg-[#E8D2B5]" : "border-[#A5A79B]/40 bg-[#112540]"}`}
          >
            <span className={`absolute top-0.5 h-5 w-5 rounded-full transition-all ${autoMode ? "left-8 bg-[#0B1728]" : "left-1 bg-[#A5A79B]"}`} />
          </button>
        </label>

        <WorkloadAnalyzer onApplySpecs={handleApplyRequirements} onDifficulty={setDifficulty} autoApply={autoMode} />

        <WorkloadConfigurator
          minMemory={minMemory}
          setMinMemory={setMinMemory}
          maxPrice={maxPrice}
          setMaxPrice={setMaxPrice}
          gpuCount={gpuCount}
          setGpuCount={setGpuCount}
          onReset={handleReset}
        />

        <WorkloadSizeForm
          profile={profile}
          touched={touched}
          onChange={updateProfile}
          onTaskType={changeTaskType}
          optimization={optimization}
          onOptimization={setOptimization}
          maxTotalBudgetUsd={maxTotalBudgetUsd}
          onMaxTotalBudget={setMaxTotalBudgetUsd}
          difficulty={difficulty}
          difficultyScale={difficulty ? DIFFICULTY_SCALE[difficulty] : null}
        />

        <CostRankingTable
          result={result}
          loading={loading}
          optimization={optimization}
          onRent={setRentOffer}
          rentingOfferId={rentOffer?.offer.id ?? null}
        />

        {renting && (
          <PaymentFlow
            key={renting.offer.id}
            auto={autoMode}
            routed={renting}
            request={{ profile, touched: Array.from(touched), difficulty, constraints }}
          />
        )}
      </main>

      <Footer />
    </div>
  );
}
