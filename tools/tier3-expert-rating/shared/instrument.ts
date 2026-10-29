import { z } from "zod";

/**
 * The expert rating instrument: every question the survey asks, in the order it asks them. The
 * server and the browser share this module, so a rater's answers are checked by the same rules on
 * both sides. Nothing here touches Bun or Node, because the browser bundle imports it.
 */

const itemIdSchema = z.string().regex(/^[A-Z][A-Z0-9]{1,7}$/);
const markdown = z.string().min(1);

const detailSchema = z.strictObject({
  /** Label of the free-text field this option asks for, such as "Where". */
  label: z.string().min(1),
  /** What a short answer looks like, shown as the field's placeholder. */
  hint: z.string().min(1).optional(),
  required: z.boolean().default(true),
  /** A closed follow-up question, such as the direction of a scope misfit. */
  choices: z
    .array(z.strictObject({ value: z.string().min(1), label: z.string().min(1) }))
    .min(2)
    .optional(),
});

const optionSchema = z.strictObject({
  value: z.union([z.string().min(1), z.number().int()]),
  label: z.string().min(1),
  description: z.string().min(1).optional(),
  detail: detailSchema.optional(),
  /** Selecting this option of a multiple-choice item excludes every other option. */
  exclusive: z.boolean().default(false),
});

const choiceItemSchema = z.strictObject({
  kind: z.literal("choice"),
  id: itemIdSchema,
  dimension: z.string().min(1).optional(),
  prompt: markdown,
  look_for: markdown.optional(),
  note: markdown.optional(),
  layout: z.enum(["inline", "list", "scale"]).default("inline"),
  scale: z.strictObject({ low: z.string().min(1), high: z.string().min(1) }).optional(),
  options: z.array(optionSchema).min(2),
});

const multiItemSchema = z.strictObject({
  kind: z.literal("multi"),
  id: itemIdSchema,
  prompt: markdown,
  options: z.array(optionSchema).min(2),
});

const textItemSchema = z.strictObject({
  kind: z.literal("text"),
  id: itemIdSchema,
  prompt: markdown,
  hint: z.string().min(1).optional(),
  required: z.boolean(),
  /** The item becomes optional when another item of the same section has this value. */
  optional_when: z
    .strictObject({ item: itemIdSchema, value: z.union([z.string(), z.number()]) })
    .optional(),
});

export const itemSchema = z.discriminatedUnion("kind", [
  choiceItemSchema,
  multiItemSchema,
  textItemSchema,
]);

export const MATERIAL = ["brief", "statement", "template", "diff", "tests", "findings"] as const;
export const materialSchema = z.enum(MATERIAL);

const partSchema = z.strictObject({
  id: z.enum(["A", "B", "C", "D"]),
  title: z.string().min(1),
  /** The time the study design budgets for the part, shown as an estimate of the time left. */
  minutes: z.number().int().positive(),
  opens: markdown,
  /** Material this part adds, the first opening first; earlier parts' material stays open. */
  material: z.array(materialSchema).min(1),
  items: z.array(itemSchema).min(1),
});

export const instrumentSourceSchema = z.strictObject({
  schema_version: z.literal("1"),
  version: z.string().min(1),
  title: z.string().min(1),
  materiality_rule: markdown,
  onboarding: z.strictObject({
    title: z.string(),
    pages: z.array(z.strictObject({ title: z.string().min(1), body: markdown })).min(1),
  }),
  background: z.strictObject({ title: z.string(), intro: markdown, items: z.array(itemSchema) }),
  questionnaire: z.strictObject({
    title: z.string(),
    perspective: markdown,
    parts: z.array(partSchema).length(4),
  }),
  exit: z.strictObject({
    title: z.string(),
    minutes: z.number().int().positive(),
    intro: markdown,
    items: z.array(itemSchema),
  }),
  /** The last step: feedback on the briefs of the study's exercises, which raters see in full. */
  briefs: z.strictObject({
    title: z.string(),
    minutes: z.number().int().positive(),
    intro: markdown,
    items: z.array(itemSchema),
  }),
});

export type Item = z.infer<typeof itemSchema>;
export type ChoiceItem = z.infer<typeof choiceItemSchema>;
export type Option = z.infer<typeof optionSchema>;
export type Material = z.infer<typeof materialSchema>;
export type Part = z.infer<typeof partSchema>;
export type PartId = Part["id"];
export type InstrumentSource = z.infer<typeof instrumentSourceSchema>;

/** The instrument as the survey uses it: placeholders filled in. */
export type Instrument = InstrumentSource;

/**
 * Check that item IDs are unique and that every condition refers to its own section, and fill in
 * the introduction's placeholders: the materiality rule, and the minutes of one exercise.
 */
export function resolveInstrument(source: InstrumentSource): Instrument {
  const questionnaireItems = source.questionnaire.parts.flatMap((part) => part.items);
  const sections = [
    source.background.items,
    questionnaireItems,
    source.exit.items,
    source.briefs.items,
  ];
  const ids = sections.flat().map((item) => item.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) {
    throw new Error(`instrument item ${duplicate} is defined twice`);
  }
  for (const item of sections.flat()) {
    if (item.kind === "text" && item.optional_when !== undefined) {
      const condition = item.optional_when;
      const owner = sections.find((section) => section.includes(item)) ?? [];
      if (!owner.some((candidate) => candidate.id === condition.item)) {
        throw new Error(`${item.id} depends on ${condition.item}, which is not in its section`);
      }
    }
  }
  const exerciseMinutes = source.questionnaire.parts.reduce((sum, part) => sum + part.minutes, 0);
  return {
    ...source,
    onboarding: {
      ...source.onboarding,
      pages: source.onboarding.pages.map((page) => ({
        ...page,
        body: page.body
          .replaceAll("{materiality_rule}", source.materiality_rule.trim())
          .replaceAll("{exercise_minutes}", String(exerciseMinutes)),
      })),
    },
  };
}

/** Material open in a part: everything up to and including that part. */
export function materialThrough(instrument: Instrument, part: PartId): Material[] {
  const parts = instrument.questionnaire.parts;
  const index = parts.findIndex((candidate) => candidate.id === part);
  return parts.slice(0, index + 1).flatMap((candidate) => candidate.material);
}

const MAXIMUM_TEXT = 4000;

export const answerSchema = z.strictObject({
  value: z.union([z.string().min(1), z.number().int()]).optional(),
  values: z.array(z.string().min(1)).max(32).optional(),
  /** The closed follow-up of the selected option, such as `too_large`. */
  choice: z.string().min(1).optional(),
  text: z.string().max(MAXIMUM_TEXT).optional(),
});

export const sectionAnswersSchema = z.record(itemIdSchema, answerSchema);

export type Answer = z.infer<typeof answerSchema>;
export type SectionAnswers = z.infer<typeof sectionAnswersSchema>;

export interface AnswerIssue {
  item: string;
  message: string;
}

function filled(text: string | undefined): boolean {
  return text !== undefined && text.trim() !== "";
}

function optionalNow(item: Item, answers: SectionAnswers): boolean {
  if (item.kind !== "text") {
    return false;
  }
  if (!item.required) {
    return true;
  }
  const condition = item.optional_when;
  return condition !== undefined && answers[condition.item]?.value === condition.value;
}

function itemIssue(item: Item, answer: Answer | undefined, answers: SectionAnswers): string | null {
  if (item.kind === "text") {
    if (answer?.value !== undefined || answer?.values !== undefined) {
      return "takes only text";
    }
    return filled(answer?.text) || optionalNow(item, answers) ? null : "is required";
  }
  if (item.kind === "multi") {
    const selected = answer?.values ?? [];
    if (selected.length === 0) {
      return "needs at least one option";
    }
    const options = selected.map((value) => item.options.find((option) => option.value === value));
    if (options.some((option) => option === undefined)) {
      return "has an option that does not exist";
    }
    if (new Set(selected).size !== selected.length) {
      return "has an option twice";
    }
    if (selected.length > 1 && options.some((option) => option?.exclusive === true)) {
      return "combines an exclusive option with another";
    }
    const detail = options.find((option) => option?.detail?.required === true)?.detail;
    return detail !== undefined && !filled(answer?.text) ? `needs “${detail.label}”` : null;
  }
  if (answer?.value === undefined) {
    return "is required";
  }
  const option = item.options.find((candidate) => candidate.value === answer.value);
  if (option === undefined) {
    return "has an option that does not exist";
  }
  const detail = option.detail;
  if (detail?.choices !== undefined) {
    if (!detail.choices.some((choice) => choice.value === answer.choice)) {
      return "needs one of the follow-up choices";
    }
  } else if (answer.choice !== undefined) {
    return "has a follow-up choice the option does not offer";
  }
  if (detail?.required === true && !filled(answer.text)) {
    return `needs “${detail.label}”`;
  }
  return null;
}

/**
 * Every reason a section's answers cannot be submitted yet, item by item and in item order. An
 * empty list means the section is complete: every item is answered, and every answer that asks for
 * a reason has one.
 */
export function answerIssues(items: Item[], answers: SectionAnswers): AnswerIssue[] {
  const known = new Set(items.map((item) => item.id));
  const unknown = Object.keys(answers)
    .filter((id) => !known.has(id))
    .map((id) => ({ item: id, message: "is not part of this section" }));
  const issues = items.flatMap((item) => {
    const message = itemIssue(item, answers[item.id], answers);
    return message === null ? [] : [{ item: item.id, message }];
  });
  return [...unknown, ...issues];
}

/** Answers reduced to the items of a section, with text trimmed and unselected details dropped. */
export function normalizeAnswers(items: Item[], answers: SectionAnswers): SectionAnswers {
  const normalized: SectionAnswers = {};
  for (const item of items) {
    const answer = answers[item.id];
    if (answer === undefined) {
      continue;
    }
    if (item.kind === "text") {
      if (filled(answer.text)) {
        normalized[item.id] = { text: answer.text?.trim() ?? "" };
      }
      continue;
    }
    const options =
      item.kind === "multi"
        ? item.options.filter((option) => answer.values?.includes(option.value as string))
        : item.options.filter((option) => option.value === answer.value);
    const detail = options.find((option) => option.detail !== undefined)?.detail;
    normalized[item.id] = {
      ...(item.kind === "multi" ? { values: answer.values ?? [] } : { value: answer.value }),
      ...(detail?.choices !== undefined && answer.choice !== undefined
        ? { choice: answer.choice }
        : {}),
      ...(detail !== undefined && filled(answer.text) ? { text: answer.text?.trim() } : {}),
    } as Answer;
  }
  return normalized;
}
