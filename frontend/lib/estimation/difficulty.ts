import type { WorkloadProfile } from "./workload-profile.ts";

export type Difficulty = "easy" | "medium" | "hard";

export const DIFFICULTY_OPTIONS: { value: Difficulty; label: string }[] = [
  { value: "easy", label: "Easy" },
  { value: "medium", label: "Medium" },
  { value: "hard", label: "Hard" },
];

/**
 * ASSUMED multipliers on job volume relative to the default (medium) workload.
 * Not measured; they only make harder tasks estimate as longer and costlier.
 */
export const DIFFICULTY_SCALE: Record<Difficulty, number> = {
  easy: 0.25,
  medium: 1,
  hard: 4,
};

/**
 * Scales the job-volume fields the user has not set themselves. Values the
 * user typed are never changed, and model size is never scaled.
 */
export function applyDifficulty(
  profile: WorkloadProfile,
  touched: ReadonlySet<keyof WorkloadProfile>,
  difficulty: Difficulty | null,
): WorkloadProfile {
  if (!difficulty) return profile;
  const scale = DIFFICULTY_SCALE[difficulty];
  const scaled: WorkloadProfile = { ...profile };

  if (!touched.has("numPrompts")) scaled.numPrompts = Math.round(profile.numPrompts * scale);
  if (!touched.has("datasetTokens")) scaled.datasetTokens = Math.round(profile.datasetTokens * scale);
  if (!touched.has("referenceHoursOnH100")) scaled.referenceHoursOnH100 = profile.referenceHoursOnH100 * scale;
  return scaled;
}
