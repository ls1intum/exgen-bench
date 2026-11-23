import type { Instrument } from "../../shared/instrument.ts";

export const MATERIALITY_HEADING = "Which problems count?";

export function usesMainGuidance(instrument: Instrument): boolean {
  return Number(instrument.version) >= 6;
}
