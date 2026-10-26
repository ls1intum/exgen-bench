import type { PartId } from "./instrument.ts";

/**
 * The fixed sequence a rater moves through. The server derives the current step from what it has
 * stored, so a rater who reopens the link always resumes exactly where they stopped, and no step
 * can be skipped or revisited.
 */

export const PARTS: readonly PartId[] = ["A", "B", "C", "D"];

export type Step =
  | { kind: "consent" }
  | { kind: "background" }
  | { kind: "onboarding" }
  | { kind: "calibration" }
  | { kind: "calibration_review" }
  | { kind: "part"; position: number; part: PartId }
  | { kind: "waiting" }
  | { kind: "exit" }
  | { kind: "done" }
  | { kind: "declined" };

export const ONCE_STEPS = [
  "consent",
  "background",
  "onboarding",
  "calibration",
  "calibration_review",
] as const;

/** The key a step's answers and timestamps are stored under. */
export function stepKey(step: Step): string {
  return step.kind === "part" ? `exercise-${step.position}-${step.part}` : step.kind;
}

export interface Progress {
  declined: boolean;
  submitted: ReadonlySet<string>;
  /** Positions of the rater's assigned exercises, in the order they are rated. */
  positions: readonly number[];
}

export function currentStep(progress: Progress): Step {
  if (progress.declined) {
    return { kind: "declined" };
  }
  for (const kind of ONCE_STEPS) {
    if (!progress.submitted.has(kind)) {
      return { kind };
    }
  }
  for (const position of progress.positions) {
    for (const part of PARTS) {
      const step: Step = { kind: "part", position, part };
      if (!progress.submitted.has(stepKey(step))) {
        return step;
      }
    }
  }
  // A reserve rater finishes the introduction early and waits until the study team assigns work.
  if (progress.positions.length === 0) {
    return { kind: "waiting" };
  }
  return progress.submitted.has("exit") ? { kind: "done" } : { kind: "exit" };
}
