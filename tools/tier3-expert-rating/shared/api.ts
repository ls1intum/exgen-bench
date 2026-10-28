import type { ExerciseView } from "./exercise.ts";
import type { Answer, Instrument, PartId, SectionAnswers } from "./instrument.ts";

/**
 * The contract between the survey server (server/, Spring Boot) and its browser app. The server
 * decides which step a rater is on and sends only that step's material; the app renders what it
 * receives. The server's records in exgen.survey.rating.Views and exgen.survey.web.Requests mirror
 * these types.
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

/** A material view or file a rater opened, which the app reports for the export's events table. */
export interface ViewEvent {
  type: "view" | "file";
  target: string;
}

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

/** A legal document of the deployment; `href` is the operator's own page or one of the survey's. */
export interface LegalLink {
  id: "imprint" | "privacy" | "accessibility";
  title: string;
  href: string;
}

/** What every page shows without a personal link. */
export interface Site {
  legal: LegalLink[];
}

/** A legal document the survey shows itself, written by the operator in Markdown. */
export interface LegalDocument {
  title: string;
  markdown: string;
}
