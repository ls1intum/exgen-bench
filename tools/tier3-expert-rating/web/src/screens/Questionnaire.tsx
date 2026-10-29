import type { ReactNode } from "react";

import type { Session } from "../../../shared/api.ts";
import type { Item, SectionAnswers } from "../../../shared/instrument.ts";
import { ErrorSummary } from "../items/ErrorSummary.tsx";
import { ItemField } from "../items/ItemField.tsx";
import { SubmitBar } from "../items/SubmitBar.tsx";
import { useAnswers } from "../items/useAnswers.ts";
import { Markdown } from "../material/Markdown.tsx";
import { stepHeading, type StepOf, type StepProps } from "../step.ts";

/**
 * A section of questions on one page: its title and intro, anything the questions refer to, the
 * items, and a footer that submits them.
 */
export function SectionPage({
  section,
  step,
  next,
  children,
  onSession,
  onError,
}: {
  section: { title: string; intro: string; items: Item[] };
  step: { key: string; draft: SectionAnswers };
  /** What the rater sees after submitting, for the confirmation. */
  next: string;
  /** Material between the intro and the questions, such as the briefs. */
  children?: ReactNode;
  onSession: (session: Session) => void;
  onError: (error: unknown) => void;
}) {
  const form = useAnswers(step.key, section.items, step.draft);
  return (
    <div className="flex flex-col gap-8">
      <div className="flex max-w-prose flex-col gap-2">
        <h1 ref={stepHeading} tabIndex={-1} className="m-0 text-xl font-semibold outline-none">
          {section.title}
        </h1>
        <div className="text-sm text-muted-foreground">
          <Markdown compact>{section.intro}</Markdown>
        </div>
      </div>
      {children}
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
          next={next}
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

/** The rater's background before the exercises, or looking back on them after them. */
export function Questionnaire({
  session,
  step,
  onSession,
  onError,
}: StepProps<StepOf<"background" | "exit">>) {
  const { instrument } = session;
  return (
    <SectionPage
      key={step.key}
      section={step.kind === "background" ? instrument.background : instrument.exit}
      step={step}
      // Raters without assigned exercises wait after the background; most go on to an exercise.
      next={step.kind === "background" ? "your first exercise" : "a last page on the briefs"}
      onSession={onSession}
      onError={onError}
    />
  );
}
