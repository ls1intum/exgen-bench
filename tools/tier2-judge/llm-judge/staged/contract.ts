import type { Instrument, Item, PartId } from "../../../tier3-expert-rating/shared/instrument.ts";

/** Version of the judge's technical instructions, output format and call sequence. */
export const STAGED_JUDGE_VERSION = "staged-judge-5";

export interface CallPlan {
  id: string;
  part: PartId;
  items: Item[];
}

const QUESTIONS: Record<PartId, string[]> = {
  A: ["SPEC"],
  B: ["GOAL", "SUPPORT"],
  C: ["FEEDBACK", "RD1"],
  D: ["RD2", "FIND", "FLAG"],
};

export class InstrumentContractError extends Error {}

/** One fresh call per part. FIND, FLAG and the debrief ask about the human review itself. */
export function callPlan(instrument: Instrument): CallPlan[] {
  const parts = instrument.questionnaire.parts;
  const order = parts.map((part) => part.id).join("");
  if (order !== "ABCD") {
    throw new InstrumentContractError(
      `instrument ${instrument.version} has parts ${order}, not ABCD`,
    );
  }
  return parts.map((part) => {
    const expected = QUESTIONS[part.id];
    if (part.items.map((item) => item.id).join(",") !== expected.join(",")) {
      throw new InstrumentContractError(
        `instrument ${instrument.version} part ${part.id} asks [${part.items.map((item) => item.id).join(", ")}], ` +
          `the staged judge expects [${expected.join(", ")}]`,
      );
    }
    const items = part.id === "D" ? part.items.filter((item) => item.id === "RD2") : part.items;
    for (const item of items) {
      if (item.kind !== "choice") {
        throw new InstrumentContractError(`${item.id} must be a single-choice item`);
      }
    }
    return { id: part.id === "D" ? "D-RD2" : part.id, part: part.id, items };
  });
}
