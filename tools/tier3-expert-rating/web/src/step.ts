import type { Session, StepView } from "../../shared/api.ts";

export type RaterSession = Extract<Session, { kind: "rater" }>;
export type StepOf<K extends StepView["kind"]> = Extract<StepView, { kind: K }>;

export interface StepProps<S> {
  session: RaterSession;
  step: S;
  onSession: (session: Session) => void;
  onError: (error: unknown) => void;
}
