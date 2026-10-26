import { ErrorSummary } from "../items/ErrorSummary.tsx";
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
    <div className="flex flex-col gap-8">
      <div className="flex max-w-prose flex-col gap-2">
        <h1 className="m-0 text-xl font-semibold">{section.title}</h1>
        <div className="text-sm text-muted-foreground">
          <Markdown compact>{section.intro}</Markdown>
        </div>
      </div>
      <ErrorSummary items={section.items} issues={form.issues} attempts={form.attempts} />
      <div className="flex flex-col gap-4">
        {section.items.map((item) => (
          <ItemField
            key={item.id}
            item={item}
            answer={form.answers[item.id]}
            onChange={(answer) => form.update(item.id, answer)}
            error={form.errors.get(item.id)}
          />
        ))}
      </div>
      {/* The footer stays in view, so the count and the submit button are always one glance away. */}
      <div className="sticky bottom-0 border-t bg-background py-3">
        <SubmitBar
          label="Submit"
          next={
            step.kind === "background"
              ? "a short introduction to the rating"
              : "the end of the study"
          }
          save={form.save}
          issues={form.issues}
          answered={form.answered}
          required={form.required}
          onReveal={form.reveal}
          onSubmit={form.submit}
          onSession={onSession}
          onError={onError}
        />
      </div>
    </div>
  );
}
