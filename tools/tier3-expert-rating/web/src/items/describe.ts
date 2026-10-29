import type { Answer, Item } from "../../../shared/instrument.ts";

/** A submitted answer as the rater gave it: the chosen options, and the text an option asked for. */
export interface AnswerSummary {
  answer: string;
  /** The free text of the answer, under the label its field had, such as "Where". */
  detail?: { label: string; text: string };
}

/** An answer in the words of its options, for read-only views of submitted answers. */
export function describeAnswer(item: Item, answer: Answer | undefined): AnswerSummary {
  if (item.kind === "text") {
    return { answer: answer?.text ?? "No answer" };
  }
  const chosen = item.options.filter((option) =>
    item.kind === "multi"
      ? answer?.values?.includes(option.value as string) === true
      : option.value === answer?.value,
  );
  if (chosen.length === 0) {
    return { answer: "No answer" };
  }
  const labels = chosen.map((option) => {
    const followUp = option.detail?.choices?.find((choice) => choice.value === answer?.choice);
    const scale = typeof option.value === "number" ? `${option.value} · ` : "";
    return `${scale}${option.label}${followUp === undefined ? "" : ` · ${followUp.label}`}`;
  });
  const detail = chosen.find((option) => option.detail !== undefined)?.detail;
  const text = answer?.text;
  return {
    answer: labels.join(", "),
    ...(detail !== undefined && text !== undefined && text !== ""
      ? { detail: { label: detail.label, text } }
      : {}),
  };
}
