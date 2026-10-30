import type { ExerciseView, Phase } from "./exercise.ts";
import type { Instrument, PartId, SectionAnswers } from "./instrument.ts";

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
  | {
      kind: "briefs";
      key: string;
      draft: SectionAnswers;
      /** Only assigned briefs in rating order; `rated` is always true. */
      briefs: Array<{ number: number; phase: Phase; brief: string; rated: boolean }>;
    }
  | { kind: "waiting" | "done" | "declined" };

export type Session =
  | {
      kind: "rater";
      study: { title: string; contact: { name: string; email: string } };
      rater: { id: string };
      instrument: Instrument;
      progress: ProgressSegment[];
      step: StepView;
    }
  | { kind: "admin"; study: { title: string } };

/**
 * A material view or file a rater opened, which the app reports for the export's events table. The
 * guided tour is a view too: `tour` when it starts and `tour-end` when it ends, so that analysts can
 * take its time out of the part it ran in.
 */
export interface ViewEvent {
  type: "view" | "file";
  target: string;
}

export type Role = "main" | "reserve" | "pilot" | "test";

/**
 * Why a rater rates an exercise: the study's plan, an extra rating (such as a pilot rating a
 * study exercise), a backup that stands in for another rater's planned rating, or a tie breaker.
 */
export type AssignmentKind = "planned" | "additional" | "backup" | "tie_breaker";

export interface AdminOverview {
  study: { id: string; title: string; ratingsPerExercise: number };
  raters: Array<{
    id: string;
    role: Role;
    status: string;
    lastActivity: string | null;
    deadline: string | null;
    /** Added from the dashboard during the study, not planned in study.yaml. */
    added: boolean;
    withdrawn: boolean;
    /** Whether the rater has submitted “Looking back”; exercises assigned now come after it. */
    lookedBack: boolean;
    /** Whether a personal link of the rater works now. */
    link: boolean;
    /** Steps submitted, of all the rater's steps. */
    progress: { done: number; total: number };
    /** Minutes between opening and submitting the rater's submitted parts. */
    minutes: number;
    exercises: Array<{
      code: string;
      kind: AssignmentKind;
      replaces: string | null;
      /** Parts submitted, of four. */
      parts: number;
      /** Whether the rater has opened or drafted any of its parts; a started assignment stays. */
      started: boolean;
      complete: boolean;
    }>;
  }>;
  exercises: Array<{
    code: string;
    id: string;
    phase: string;
    planned: number;
    /** RD2 of the planned ratings of main raters, including backups. */
    readiness: number[];
    /** RD2 of tie breakers. */
    tieBreaker: number[];
    agreement: "pending" | "agree" | "differ" | "resolved";
    /** Completed ratings of any kind and role, and assignments under way. */
    ratings: number;
    inProgress: number;
  }>;
  /** Minutes per part of the submitted parts of every rater, against the design's budget. */
  timing: Array<{
    part: string;
    title: string;
    budget: number;
    median: number | null;
    count: number;
  }>;
  /** Free-text answers of the closing steps: the raters' comments on the survey and the briefs. */
  feedback: Array<{
    rater: string;
    role: Role;
    /** The title of the step the text was given in. */
    section: string;
    item: string;
    prompt: string;
    text: string;
    at: string;
  }>;
  /** What the study team changed during the study, newest first. */
  changes: Array<{ at: string; action: string; rater: string | null; detail: string }>;
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
