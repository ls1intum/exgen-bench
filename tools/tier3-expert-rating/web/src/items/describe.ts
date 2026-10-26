import type { Answer, Item } from "../../../shared/instrument.ts";

/** An answer as one readable line, for read-only views of submitted answers. */
export function describeAnswer(item: Item, answer: Answer | undefined): string {
  if (answer === undefined) return "No answer";
  if (item.kind === "text") return answer.text ?? "";
  const option = item.options.find((candidate) => candidate.value === answer.value);
  const label =
    option === undefined
      ? String(answer.value)
      : `${typeof option.value === "number" ? `${option.value}: ` : ""}${option.label}`;
  return answer.text === undefined ? label : `${label} — ${answer.text}`;
}
