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
  const [attempted, setAttempted] = useState(false);
  const changed = useRef(false);

  useEffect(() => {
    if (!changed.current) {
      return;
    }
    const timer = setTimeout(() => {
      setSave({ state: "saving" });
      api.draft(step, answers).then(
        ({ savedAt }) => setSave({ state: "saved", at: savedAt }),
        () => setSave({ state: "failed" }),
      );
    }, 800);
    return () => clearTimeout(timer);
  }, [step, answers]);

  const issues = answerIssues(items, answers);
  const errors = attempted
    ? new Map(issues.map((issue) => [issue.item, issue.message]))
    : new Map<string, string>();

  return {
    answers,
    save,
    issues,
    errors,
    update: (id: string, answer: Answer) => {
      changed.current = true;
      setAnswers((previous) => ({ ...previous, [id]: answer }));
    },
    /** Show every open issue, as when the rater tries to submit. */
    reveal: () => setAttempted(true),
    submit: async (): Promise<Session> => {
      try {
        return await api.submit(step, answers);
      } catch (error) {
        if (error instanceof ApiError && error.issues.length > 0) {
          setAttempted(true);
        }
        throw error;
      }
    },
  };
}
