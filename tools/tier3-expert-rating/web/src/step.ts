import type { Session, StepView } from "../../shared/api.ts";

export type RaterSession = Extract<Session, { kind: "rater" }>;
export type StepOf<K extends StepView["kind"]> = Extract<StepView, { kind: K }>;

export interface StepProps<S> {
  session: RaterSession;
  step: S;
  onSession: (session: Session) => void;
  onError: (error: unknown) => void;
}

/** Which screen of the step the rater sees; an exercise's part has its introduction before it opens. */
export function screenOf(step: StepView): string {
  return step.kind === "part" ? `${step.key}:${step.opened}` : "key" in step ? step.key : step.kind;
}

/** Set when the rater moved on to another step, until that step's heading has taken the focus. */
let moved = false;

export function stepMoved() {
  moved = true;
}

/**
 * The ref of a step's h1, which has tabIndex -1: after a step change, the focus moves to the new
 * step's heading, so a screen reader announces it and the keyboard goes on from the top. A heading
 * in a hidden pane, the questions of a narrow screen, leaves the focus at the start of the page.
 */
export function stepHeading(heading: HTMLElement | null) {
  if (heading === null || !moved) return;
  moved = false;
  if (heading.getClientRects().length > 0) heading.focus();
  else document.getElementById("main-content")?.focus();
}
