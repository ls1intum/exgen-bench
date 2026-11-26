import { z } from "zod";

import {
  type Answer,
  answerIssues,
  type Item,
  normalizeAnswers,
  type SectionAnswers,
} from "../../../tier3-expert-rating/shared/instrument.ts";
import { type LocatorCatalog, locatorProblem } from "./material.ts";

/**
 * Reading a model reply. Nothing is repaired: a reply that is not exactly one valid answer per item
 * under the survey's own answer rules is invalid, and its issues are recorded.
 */

const MAXIMUM_REFS = 2;

const judgedAnswerSchema = z.strictObject({
  value: z.union([z.string().min(1), z.number().int()]).optional(),
  choice: z.string().min(1).optional(),
  text: z.string().max(4000).optional(),
  evidence_refs: z.array(z.string().min(1)).max(MAXIMUM_REFS).optional(),
  rationale: z.string().max(2000).optional(),
});

const answersReplySchema = z.strictObject({ answers: z.record(z.string(), judgedAnswerSchema) });
const readReplySchema = z.strictObject({ read_setup_files: z.array(z.string().min(1)).min(1) });

export type Reply =
  | { kind: "answers"; answers: Record<string, z.infer<typeof judgedAnswerSchema>> }
  | { kind: "read"; paths: string[] }
  | { kind: "invalid"; issues: string[] };

export function parseReply(content: string): Reply {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return { kind: "invalid", issues: ["the reply is not one JSON object"] };
  }
  const read = readReplySchema.safeParse(json);
  if (read.success) return { kind: "read", paths: read.data.read_setup_files };
  const answers = answersReplySchema.safeParse(json);
  if (answers.success) return { kind: "answers", answers: answers.data.answers };
  return {
    kind: "invalid",
    issues: answers.error.issues.map(
      (issue) => `${issue.path.join(".") || "reply"}: ${issue.message}`,
    ),
  };
}

export interface ValidatedAnswers {
  /** The answers as the survey stores them: normalized by its own rules. */
  answers: SectionAnswers;
  evidenceRefs: Record<string, string[]>;
  evidenceIssues: Record<string, string[]>;
  rationale: Record<string, string>;
  issues: string[];
}

/**
 * Check answers the way the survey checks a rater's: `answerIssues` on exactly this call's items,
 * then audit its locators separately. A citation problem does not erase valid ratings.
 */
export function validateAnswers(
  items: Item[],
  judged: Record<string, z.infer<typeof judgedAnswerSchema>>,
  catalog: LocatorCatalog,
): ValidatedAnswers {
  const canonical: SectionAnswers = {};
  const evidenceRefs: Record<string, string[]> = {};
  const rationale: Record<string, string> = {};
  for (const [id, entry] of Object.entries(judged)) {
    const answer: Answer = {};
    if (entry.value !== undefined) answer.value = entry.value;
    if (entry.choice !== undefined) answer.choice = entry.choice;
    if (entry.text !== undefined) answer.text = entry.text;
    canonical[id] = answer;
    evidenceRefs[id] = entry.evidence_refs ?? [];
    if (entry.rationale !== undefined) rationale[id] = entry.rationale;
  }
  const issues = answerIssues(items, canonical).map((issue) => `${issue.item} ${issue.message}`);
  const evidenceIssues: Record<string, string[]> = {};
  for (const item of items) {
    const problems: string[] = [];
    const refs = evidenceRefs[item.id] ?? [];
    for (const ref of refs) {
      const problem = locatorProblem(ref, catalog);
      if (problem !== null) problems.push(problem);
    }
    if (item.kind === "choice") {
      const option = item.options.find(
        (candidate) => candidate.value === canonical[item.id]?.value,
      );
      if (option?.detail?.required === true && refs.length === 0) {
        problems.push("needs at least one evidence locator");
      }
    }
    if (problems.length > 0) evidenceIssues[item.id] = problems;
  }
  return {
    answers: issues.length === 0 ? normalizeAnswers(items, canonical) : canonical,
    evidenceRefs,
    evidenceIssues,
    rationale,
    issues,
  };
}
