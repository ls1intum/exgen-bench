import { FieldGroup, FieldSeparator } from "@/components/ui/field";

import { ItemField } from "../items/ItemField.tsx";
import { SubmitBar } from "../items/SubmitBar.tsx";
import { useAnswers } from "../items/useAnswers.ts";
import { Markdown } from "../material/Markdown.tsx";
import type { StepOf, StepProps } from "../step.ts";

/** A questionnaire on one page: the rater background before the exercises, or the final survey. */
export function Questionnaire({
  session,
  step,
  onSession,
  onError,
}: StepProps<StepOf<"background" | "exit">>) {
  const section =
    step.kind === "background" ? session.instrument.background : session.instrument.exit;
  const form = useAnswers(step.key, section.items, step.draft);
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="mt-0 mb-2 text-2xl font-semibold">{section.title}</h1>
        <Markdown>{section.intro}</Markdown>
      </div>
      <FieldGroup>
        {section.items.map((item, index) => (
          <div key={item.id} className="flex flex-col gap-5">
            {index > 0 && <FieldSeparator />}
            <ItemField
              item={item}
              answer={form.answers[item.id]}
              onChange={(answer) => form.update(item.id, answer)}
              error={form.errors.get(item.id)}
            />
          </div>
        ))}
      </FieldGroup>
      <SubmitBar
        label="Submit"
        next={
          step.kind === "background" ? "a short introduction to the rating" : "the end of the study"
        }
        save={form.save}
        issues={form.issues}
        onReveal={form.reveal}
        onSubmit={form.submit}
        onSession={onSession}
        onError={onError}
      />
    </div>
  );
}
