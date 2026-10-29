import type { Instrument, PartId } from "../../shared/instrument.ts";
import type { RaterSession } from "./step.ts";

/** Where the rater is: a short label, the parts of the current exercise done, and the time left. */
export interface Position {
  label: string;
  /** The label for a phone's header, such as "Exercise 1/3 · Part A". */
  short: string;
  /** Parts submitted in the current exercise, while rating one. */
  partsDone: number | null;
  /** Minutes the study design budgets for what is left, once the exercises have started. */
  minutesLeft: number | null;
}

// The closing steps' labels are those of their progress segments, which say whether they are done.
const LABEL: Partial<Record<RaterSession["step"]["kind"], string>> = {
  consent: "Consent",
  background: "About you",
  onboarding: "Introduction",
  exit: "Looking back",
  briefs: "Briefs",
  waiting: "Waiting for exercises",
  done: "Done",
};

function exerciseMinutes(instrument: Instrument, from: PartId | null): number {
  const parts = instrument.questionnaire.parts;
  const start = from === null ? 0 : parts.findIndex((part) => part.id === from);
  return parts.slice(Math.max(0, start)).reduce((sum, part) => sum + part.minutes, 0);
}

/**
 * Whether the rater submitted a closing step. One who is given another exercise after looking back,
 * or after the briefs, rates it without answering those again.
 */
export function submitted(session: RaterSession, kind: "exit" | "briefs"): boolean {
  return session.progress.some(
    (segment) => segment.label === LABEL[kind] && segment.state === "done",
  );
}

/** Minutes the study design budgets for the closing steps the rater has not submitted. */
function closingMinutes(session: RaterSession): number {
  const { exit, briefs } = session.instrument;
  return (
    (submitted(session, "exit") ? 0 : exit.minutes) +
    (submitted(session, "briefs") ? 0 : briefs.minutes)
  );
}

export function positionOf(session: RaterSession): Position {
  const { step, instrument } = session;
  if (step.kind === "part") {
    const done = instrument.questionnaire.parts.findIndex((part) => part.id === step.part);
    return {
      label: `Exercise ${step.position} of ${step.total} · Part ${step.part}`,
      short: `Exercise ${step.position}/${step.total} · Part ${step.part}`,
      partsDone: done,
      minutesLeft:
        exerciseMinutes(instrument, step.part) +
        (step.total - step.position) * exerciseMinutes(instrument, null) +
        closingMinutes(session),
    };
  }
  const label = LABEL[step.kind] ?? "";
  return {
    label,
    short: label,
    partsDone: null,
    minutesLeft: step.kind === "exit" || step.kind === "briefs" ? closingMinutes(session) : null,
  };
}
