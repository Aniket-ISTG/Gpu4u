import { z } from "zod";
import type { GPUOffer } from "../../lib/marketplace/types.ts";
import { rankOffersByEstimatedCost, type RoutingConstraints } from "../../lib/routing/cost-ranking.ts";
import { applyDifficulty } from "../../lib/estimation/difficulty.ts";
import type { WorkloadProfile } from "../../lib/estimation/workload-profile.ts";

/** The most a quote may cover, so one request cannot name an absurd job. */
export const MAX_QUOTE_HOURS = 24 * 30;
/** The default cap is the estimate plus a quarter, because the estimate is a model and not a benchmark. */
export const DEFAULT_CAP_MULTIPLIER = 1.25;
/** A user-chosen cap may not exceed this multiple of the estimate. */
export const MAX_CAP_MULTIPLIER = 3;
/** A quote is refused when the live price has moved this far from what the user saw. */
export const PRICE_DRIFT_TOLERANCE = 0.1;

const count = z.number().finite().min(0);
const positive = z.number().finite().positive();
const AccountId = z.string().regex(/^0\.0\.\d+$/, "Expected an account ID like 0.0.1234");

const PROFILE_KEYS = [
  "taskType", "modelParamsB", "numPrompts", "avgInputTokens", "avgOutputTokens", "batchSize",
  "datasetTokens", "epochs", "lora", "precisionBytes", "referenceHoursOnH100",
] as const;

const ProfileSchema = z
  .object({
    taskType: z.enum(["inference", "training", "fine-tuning", "rendering", "other"]),
    modelParamsB: count.max(5000),
    numPrompts: count.max(1e9),
    avgInputTokens: count.max(1e6),
    avgOutputTokens: count.max(1e6),
    batchSize: positive.max(1e5),
    datasetTokens: count.max(1e13),
    epochs: positive.max(1000),
    lora: z.boolean(),
    precisionBytes: positive.max(8),
    referenceHoursOnH100: count.max(10_000),
  })
  .strict();

const ConstraintsSchema = z
  .object({
    minVramGb: positive.max(2000).nullable(),
    gpuCount: z.number().int().min(1).max(64),
    maxHourlyBudgetUsd: positive.max(100_000).nullable(),
    maxTotalBudgetUsd: positive.max(1_000_000).nullable(),
    maxDurationHours: positive.max(100_000).nullable().default(null),
    cudaRequired: z.boolean().nullable(),
    optimization: z.enum(["cost", "performance", "balanced"]),
  })
  .strict();

/** What the browser sends to ask for a quote. Note that it carries no price. */
export const QuoteBuildRequestSchema = z
  .object({
    wallet: AccountId,
    offerId: z.string().min(1).max(200),
    profile: ProfileSchema,
    touched: z.array(z.enum(PROFILE_KEYS)).max(PROFILE_KEYS.length).default([]),
    difficulty: z.enum(["easy", "medium", "hard"]).nullable().default(null),
    constraints: ConstraintsSchema,
    /** Optional cap in USD. Defaults to the estimate plus a quarter. */
    capUsd: positive.max(1_000_000).optional(),
    /** The estimate the user saw. Used to refuse the quote if the live price moved. */
    expectedEstimateUsd: positive.optional(),
  })
  .strict();

export type QuoteBuildRequest = z.infer<typeof QuoteBuildRequestSchema>;

/** What the payment service accepts to create a quote. */
export interface ServiceQuoteRequest {
  wallet: string;
  offer: { id: string; provider: string; gpuModel: string; gpuCount: number; vramGb: number; region: string };
  hours: number;
  hourlyUsd: number;
  estimateUsd: number;
  capUsd: number;
}

export type QuoteBuildErrorCode = "OFFER_NOT_ELIGIBLE" | "CAP_OUT_OF_RANGE" | "PRICE_CHANGED" | "JOB_TOO_LONG";

export class QuoteBuildError extends Error {
  readonly code: QuoteBuildErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: QuoteBuildErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "QuoteBuildError";
    this.code = code;
    this.details = details;
  }
}

const ceilToCents = (usd: number) => Math.ceil(usd * 100 - 1e-9) / 100;

/**
 * Builds the quote request from the live marketplace and the user's workload. The ranking is run
 * again here, on the server, so the hours and the price come from this computation and never from
 * the browser. The chosen offer must still be eligible under the user's constraints.
 */
export function buildQuoteRequest(input: QuoteBuildRequest, offers: GPUOffer[]): ServiceQuoteRequest {
  const profile = applyDifficulty(
    input.profile as WorkloadProfile,
    new Set(input.touched) as ReadonlySet<keyof WorkloadProfile>,
    input.difficulty,
  );
  const constraints: RoutingConstraints = input.constraints;

  const { ranked } = rankOffersByEstimatedCost(offers, profile, constraints);
  const chosen = ranked.find((r) => r.offer.id === input.offerId);
  if (!chosen) {
    throw new QuoteBuildError(
      "OFFER_NOT_ELIGIBLE",
      "This GPU is no longer available or no longer fits the requirements. Refresh the ranking and choose again.",
    );
  }

  const hours = chosen.estimatedDurationHours;
  if (hours > MAX_QUOTE_HOURS) {
    throw new QuoteBuildError("JOB_TOO_LONG", "The estimated run is longer than 30 days. Reduce the workload size.", { hours });
  }
  const estimateUsd = chosen.estimatedTotalCostUsd;

  if (input.expectedEstimateUsd !== undefined) {
    const drift = Math.abs(estimateUsd - input.expectedEstimateUsd) / input.expectedEstimateUsd;
    if (drift > PRICE_DRIFT_TOLERANCE) {
      throw new QuoteBuildError(
        "PRICE_CHANGED",
        "The price changed since you last looked. Review the new estimate before continuing.",
        { estimateUsd, expectedEstimateUsd: input.expectedEstimateUsd },
      );
    }
  }

  const floor = ceilToCents(Math.max(estimateUsd, 0.01));
  let capUsd: number;
  if (input.capUsd === undefined) {
    capUsd = ceilToCents(Math.max(estimateUsd * DEFAULT_CAP_MULTIPLIER, estimateUsd + 0.01));
  } else {
    capUsd = ceilToCents(input.capUsd);
    if (capUsd < floor || capUsd > estimateUsd * MAX_CAP_MULTIPLIER + 0.01) {
      throw new QuoteBuildError(
        "CAP_OUT_OF_RANGE",
        `The spending cap must be between $${floor.toFixed(2)} and $${ceilToCents(estimateUsd * MAX_CAP_MULTIPLIER + 0.01).toFixed(2)}.`,
        { min: floor, max: ceilToCents(estimateUsd * MAX_CAP_MULTIPLIER + 0.01) },
      );
    }
  }

  return {
    wallet: input.wallet,
    offer: {
      id: chosen.offer.id,
      provider: chosen.offer.provider,
      gpuModel: chosen.offer.gpuModel,
      gpuCount: chosen.offer.gpuCount,
      vramGb: chosen.offer.vramGb,
      region: chosen.offer.region || "unknown",
    },
    hours,
    hourlyUsd: chosen.hourlyPriceUsd,
    estimateUsd,
    capUsd,
  };
}
