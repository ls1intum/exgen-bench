import { z } from "zod";

import type { ExerciseView } from "./exercise.ts";
import type { Answer, Instrument, PartId, SectionAnswers } from "./instrument.ts";
import { sectionAnswersSchema } from "./instrument.ts";

/**
 * The contract between the survey server and its browser app. The server decides which step a rater
 * is on and sends only that step's material; the app renders what it receives.
 */

export interface ProgressSegment {
  label: string;
  state: "done" | "current" | "todo";
}

export type StepView =
  | {
      kind: "consent";
      summary: string;
      details: string;
      statements: Array<{ id: string; text: string }>;
    }
  | { kind: "background" | "exit"; key: string; draft: SectionAnswers }
  | { kind: "onboarding"; key: string }
  | {
      kind: "calibration";
      key: string;
      opened: boolean;
      exercise?: ExerciseView;
      draft: SectionAnswers;
    }
  | {
      kind: "calibration_review";
      key: string;
      answers: SectionAnswers;
      reference: Record<string, { answer: Answer; explanation: string }>;
    }
  | {
      kind: "part";
      key: string;
      position: number;
      total: number;
      part: PartId;
      opened: boolean;
      exercise?: ExerciseView;
      /** Submitted answers of this exercise's earlier parts, shown read-only. */
      earlier: Partial<Record<PartId, SectionAnswers>>;
      draft: SectionAnswers;
    }
  | { kind: "waiting" | "done" | "declined" };

export type Session =
  | {
      kind: "rater";
      study: { title: string; contact: { name: string; email: string } };
      rater: { id: string; deadline: string | null };
      instrument: Instrument;
      progress: ProgressSegment[];
      step: StepView;
    }
  | { kind: "admin"; study: { title: string } };

export const stepRequestSchema = z.strictObject({ step: z.string().min(1).max(64) });

export const answersRequestSchema = z.strictObject({
  step: z.string().min(1).max(64),
  answers: sectionAnswersSchema,
});

export const consentRequestSchema = z.strictObject({
  accepted: z.array(z.string().min(1)).max(16),
});

export const eventsRequestSchema = z.strictObject({
  step: z.string().min(1).max(64),
  events: z
    .array(
      z.strictObject({
        type: z.enum(["view", "file"]),
        target: z.string().min(1).max(512),
      }),
    )
    .min(1)
    .max(50),
});

export type ViewEvent = z.infer<typeof eventsRequestSchema>["events"][number];

export interface AdminOverview {
  study: { id: string; title: string; ratingsPerExercise: number };
  raters: Array<{
    id: string;
    role: string;
    status: string;
    lastActivity: string | null;
    deadline: string | null;
    exercises: Array<{ code: string; kind: string; complete: boolean }>;
  }>;
  exercises: Array<{
    code: string;
    id: string;
    phase: string;
    planned: number;
    /** Readiness after the findings (RD2), one per completed rating. */
    /** RD2 of the planned ratings, including backups. */
    readiness: number[];
    /** RD2 of tie breakers. */
    tieBreaker: number[];
    agreement: "pending" | "agree" | "differ" | "resolved";
  }>;
}

export const assignRequestSchema = z.strictObject({
  rater: z.string().min(1),
  kind: z.enum(["backup", "tie_breaker"]),
  replaces: z.string().min(1).nullable(),
  exercises: z.array(z.string().min(1)).min(1).max(3),
});

export const deadlineRequestSchema = z.strictObject({
  rater: z.string().min(1),
  deadline: z.iso.date(),
});

export const linkRequestSchema = z.strictObject({ rater: z.string().min(1) });
