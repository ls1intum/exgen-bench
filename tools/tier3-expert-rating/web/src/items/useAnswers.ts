import { useEffect, useRef, useState } from "react";

import type { Session } from "../../../shared/api.ts";
import {
  type Answer,
  answerIssues,
  type Item,
  type SectionAnswers,
} from "../../../shared/instrument.ts";
import { api, ApiError } from "../api.ts";

export type SaveState =
  { state: "idle" } | { state: "saving" } | { state: "saved"; at: string } | { state: "failed" };

/**
 * A step's answers with a draft saved shortly after each change, so a closed tab loses at most the
 * last few keystrokes. Submitting checks the answers with the same rules the server applies.
 */
export function useAnswers(step: string, items: Item[], initial: SectionAnswers) {
  const [answers, setAnswers] = useState<SectionAnswers>(initial);
  const [save, setSave] = useState<SaveState>({ state: "idle" });
  // Each attempt to submit with open issues moves the focus to the error summary again.
  const [attempts, setAttempts] = useState(0);
  const attempted = attempts > 0;
  const changed = useRef(false);
  /** The draft waiting to be saved, which submitting cancels. */
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Set from the submit on: the server then refuses a draft that arrives late as out of date. */
  const submitting = useRef(false);

  useEffect(() => {
    if (!changed.current) {
      return;
    }
    const timer = setTimeout(() => {
      pending.current = undefined;
      setSave({ state: "saving" });
      api.draft(step, answers).then(
        ({ savedAt }) => setSave({ state: "saved", at: savedAt }),
        (error: unknown) => {
          // The submitted answers include the draft, so its refusal loses nothing.
          if (submitting.current && error instanceof ApiError && error.status === 409) return;
          setSave({ state: "failed" });
        },
      );
    }, 800);
    pending.current = timer;
    return () => clearTimeout(timer);
  }, [step, answers]);

  const issues = answerIssues(items, answers);
  const open = new Set(issues.map((issue) => issue.item));
  // Optional items count as neither open nor answered.
  const required = items.filter((item) => answerIssues([item], {}).length > 0);
  const errors = attempted
    ? new Map(issues.map((issue) => [issue.item, issue.message]))
    : new Map<string, string>();

  return {
    answers,
    save,
    issues,
    errors,
    attempts,
    required: required.length,
    answered: required.filter((item) => !open.has(item.id)).length,
    update: (id: string, answer: Answer) => {
      changed.current = true;
      setAnswers((previous) => ({ ...previous, [id]: answer }));
    },
    /** Show every open issue, as when the rater tries to submit. */
    reveal: () => setAttempts((count) => count + 1),
    submit: async (): Promise<Session> => {
      // A draft still waiting would reach the server after the submit, which refuses it.
      const waiting = pending.current !== undefined;
      clearTimeout(pending.current);
      pending.current = undefined;
      submitting.current = true;
      try {
        return await api.submit(step, answers);
      } catch (error) {
        submitting.current = false;
        // The draft that was waiting is saved now: an error screen may replace the page, and then
        // nothing would save it later.
        if (waiting) {
          setSave({ state: "saving" });
          api.draft(step, answers).then(
            ({ savedAt }) => setSave({ state: "saved", at: savedAt }),
            () => setSave({ state: "failed" }),
          );
        }
        if (error instanceof ApiError && error.issues.length > 0) {
          setAttempts((count) => count + 1);
        }
        throw error;
      }
    },
  };
}
