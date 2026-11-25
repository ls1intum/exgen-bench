import type { Instrument, Item, PartId } from "../../../tier3-expert-rating/shared/instrument.ts";

/**
 * The staged Expert Study judge: the same questionnaire as the Tier 3 survey, answered by a language
 * model with the material released in the same order. This module fixes the call sequence and checks
 * that the canonical instrument still has the shape the judge was written for.
 */

/** Version of the judge's own technical instructions, output format and call sequence. */
export const STAGED_JUDGE_VERSION = "staged-judge-4";

/** One model call: a part's material, the items it answers, and whether it sees earlier answers. */
export interface CallPlan {
  /** Stable name of the call in records: `A`, `B`, `C`, `D-RD2`, `D-FIND`. */
  id: string;
  part: PartId;
  items: Item[];
  /** Item IDs of the judge's own earlier answers this call shows, after its fresh answers exist. */
  prior: string[];
}

/**
 * The choice items each part must ask, in order. Extra items are accepted only as optional text
 * items (such as D's FLAG), which the judge may leave empty like a rater.
 */
export const EXPECTED_CHOICE_ITEMS: Record<PartId, string[]> = {
  A: ["SPEC"],
  B: ["GOAL", "SUPPORT"],
  C: ["FIT", "FEEDBACK", "RD1"],
  D: ["RD2", "GRADE", "FIND"],
};

/** RD2 and GRADE are answered fresh from D's evidence; FIND then sees the judge's own RD1, RD2 and GRADE. */
const FRESH_D_ITEMS = ["RD2", "GRADE"];
const FIND_PRIOR = ["RD1", "RD2", "GRADE"];

export class InstrumentContractError extends Error {}

/**
 * The five calls for one exercise: A, B and C each answer their part; D first answers RD2 and GRADE without
 * any earlier answer, then FIND (and D's optional text items) with its own RD1, RD2 and GRADE visible.
 */
export function callPlan(instrument: Instrument): CallPlan[] {
  const parts = instrument.questionnaire.parts;
  const order = parts.map((part) => part.id).join("");
  if (order !== "ABCD") {
    throw new InstrumentContractError(
      `instrument ${instrument.version} has parts ${order}, not ABCD`,
    );
  }
  const plans: CallPlan[] = [];
  for (const part of parts) {
    const choices = part.items.filter((item) => item.kind !== "text").map((item) => item.id);
    const expected = EXPECTED_CHOICE_ITEMS[part.id];
    if (choices.join(",") !== expected.join(",")) {
      throw new InstrumentContractError(
        `instrument ${instrument.version} part ${part.id} asks [${choices.join(", ")}], ` +
          `the staged judge expects [${expected.join(", ")}]`,
      );
    }
    for (const item of part.items) {
      if (item.kind === "multi") {
        throw new InstrumentContractError(`${item.id} is a multiple-choice item`);
      }
      if (item.kind === "text" && item.required) {
        throw new InstrumentContractError(
          `${item.id} is a required text item; the judge only supports optional ones`,
        );
      }
    }
    if (part.id !== "D") {
      plans.push({ id: part.id, part: part.id, items: part.items, prior: [] });
      continue;
    }
    const fresh = part.items.filter((item) => FRESH_D_ITEMS.includes(item.id));
    const rest = part.items.filter((item) => !FRESH_D_ITEMS.includes(item.id));
    plans.push({ id: "D-RD2", part: "D", items: fresh, prior: [] });
    plans.push({ id: "D-FIND", part: "D", items: rest, prior: FIND_PRIOR });
  }
  return plans;
}
