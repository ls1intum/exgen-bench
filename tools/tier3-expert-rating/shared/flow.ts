import type { PartId } from "./instrument.ts";

/**
 * The parts of an exercise's rating, in the order a rater answers them. The server derives which
 * step a rater is on (exgen.survey.rating.Step); the app only lays out the parts.
 */
export const PARTS: readonly PartId[] = ["A", "B", "C", "D"];
