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
  submitLabel = "Submit",
  showCodes = true,
  showProgress = true,
  children,
  onSession,
  onError,
}: {
  section: { title: string; intro: string; items: Item[] };
  step: { key: string; draft: SectionAnswers };
  /** What comes after submission, when a confirmation is shown. */
  next?: string | undefined;
  submitLabel?: string | undefined;
  showCodes?: boolean;
  showProgress?: boolean;
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
      <ErrorSummary
        items={section.items}
        issues={form.issues}
        attempts={form.attempts}
        showCodes={showCodes}
      />
      <div className="flex flex-col gap-4">
        {section.items.map((item) => (
          <ItemField
            key={item.id}
            item={item}
            showCode={showCodes}
            answer={form.answers[item.id]}
            onChange={(answer) => form.update(item.id, answer)}
            error={form.errors.get(item.id)}
          />
        ))}
      </div>
      {/* The footer stays in view, so the count and the submit button are always one glance away. */}
      <div className="sticky bottom-0 border-t bg-background py-3">
        <SubmitBar
          label={submitLabel}
          next={next}
          save={form.save}
          issues={form.issues}
          answered={form.answered}
          required={form.required}
          showProgress={showProgress}
          onReveal={form.reveal}
          onSubmit={form.submit}
          onSession={onSession}
          onError={onError}
        />
      </div>
    </div>
  );
}

/** The background and closing pages share the same question layout. */
export function Questionnaire({
  session,
  step,
  onSession,
  onError,
}: StepProps<StepOf<"background" | "exit">>) {
  const { instrument } = session;
  const studyRubric = instrument.rating_example !== undefined;
  return (
    <SectionPage
      key={step.key}
      section={step.kind === "background" ? instrument.background : instrument.exit}
      step={step}
      showCodes={!studyRubric}
      showProgress={!studyRubric || step.kind !== "exit"}
      submitLabel={
        studyRubric ? (step.kind === "background" ? "Continue" : "Finish survey") : undefined
      }
      next={
        studyRubric
          ? undefined
          : step.kind === "background"
            ? "your first exercise"
            : instrument.briefs.items.length > 0
              ? "a last page on the briefs"
              : "the end of the study"
      }
      onSession={onSession}
      onError={onError}
    />
  );
}
