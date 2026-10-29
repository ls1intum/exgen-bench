import type { Phase } from "../../../shared/exercise.ts";

/** A course phase as raters read it, such as "Middle phase". */
export function phaseLabel(phase: Phase): string {
  return `${phase[0]?.toUpperCase()}${phase.slice(1)} phase`;
}
