import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

import { digestJson, sha256 } from "../../../src/core/canonical.ts";
import { currentStep, type Progress, type Step, stepKey } from "../shared/flow.ts";
import type { SectionAnswers } from "../shared/instrument.ts";
import type { LoadedStudy, Role } from "./study.ts";

/**
 * Everything a study collects, in one SQLite database. Answers are written once per step and never
 * updated; drafts are the only mutable state. Personal links are stored as SHA-256 digests, so the
 * database cannot reproduce a link that would let someone act as a rater.
 */

const MIGRATIONS = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
   CREATE TABLE raters (
     id TEXT PRIMARY KEY,
     role TEXT NOT NULL CHECK (role IN ('main', 'reserve', 'pilot', 'test')),
     deadline TEXT,
     declined_at TEXT
   ) STRICT;
   CREATE TABLE links (
     hash TEXT PRIMARY KEY,
     rater_id TEXT REFERENCES raters (id),
     created_at TEXT NOT NULL,
     revoked_at TEXT
   ) STRICT;
   CREATE TABLE assignments (
     rater_id TEXT NOT NULL REFERENCES raters (id),
     position INTEGER NOT NULL CHECK (position > 0),
     exercise TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('planned', 'backup', 'tie_breaker')),
     replaces TEXT REFERENCES raters (id),
     created_at TEXT NOT NULL,
     PRIMARY KEY (rater_id, position),
     UNIQUE (rater_id, exercise)
   ) STRICT;
   CREATE TABLE steps (
     rater_id TEXT NOT NULL REFERENCES raters (id),
     step TEXT NOT NULL,
     opened_at TEXT,
     draft TEXT CHECK (draft IS NULL OR json_valid(draft)),
     draft_saved_at TEXT,
     answers TEXT CHECK (answers IS NULL OR json_valid(answers)),
     instrument_version TEXT,
     submitted_at TEXT,
     PRIMARY KEY (rater_id, step)
   ) STRICT;
   CREATE TABLE events (
     id INTEGER PRIMARY KEY,
     rater_id TEXT NOT NULL REFERENCES raters (id),
     step TEXT NOT NULL,
     type TEXT NOT NULL,
     target TEXT NOT NULL,
     at TEXT NOT NULL
   ) STRICT;`,
  // A rater may withdraw: their answers are deleted, and the time they withdrew is kept.
  "ALTER TABLE raters ADD COLUMN withdrawn_at TEXT;",
];

export function linkDigest(token: string): string {
  return sha256(`exgen-survey-link:${token}`);
}

export type Holder = { kind: "admin" } | { kind: "rater"; rater: RaterRow };

export interface RaterRow {
  id: string;
  role: Role;
  deadline: string | null;
  declined_at: string | null;
  withdrawn_at: string | null;
}

export interface AssignmentRow {
  rater_id: string;
  position: number;
  exercise: string;
  kind: "planned" | "backup" | "tie_breaker";
  replaces: string | null;
  created_at: string;
}

export interface StepRow {
  rater_id: string;
  step: string;
  opened_at: string | null;
  draft: string | null;
  draft_saved_at: string | null;
  answers: string | null;
  instrument_version: string | null;
  submitted_at: string | null;
}

export interface EventRow {
  rater_id: string;
  step: string;
  type: string;
  target: string;
  at: string;
}

export class SurveyStore {
  readonly #database: Database;
  readonly #clock: () => Date;

  private constructor(database: Database, clock: () => Date) {
    this.#database = database;
    this.#clock = clock;
  }

  #now(): string {
    return this.#clock().toISOString();
  }

  /**
   * Open the database for a study, creating it only when `create` is set, and bring it in line with
   * the study: raters, their planned exercises and the digest of every built exercise are recorded
   * once and are fixed from then on. A plan edited or an exercise rebuilt after the database was
   * created is refused, so every answer in it refers to the same material.
   */
  static open(
    path: string,
    loaded: Pick<LoadedStudy, "study" | "manifest" | "instrument">,
    {
      create = false,
      clock = () => new Date(),
    }: {
      create?: boolean;
      /** Where timestamps come from; a simulation passes its own. */
      clock?: () => Date;
    } = {},
  ): SurveyStore {
    if (!create && !existsSync(path)) {
      throw new Error(`no study database at ${path}`);
    }
    const database = new Database(path, { create, readwrite: true, strict: true });
    database.run("PRAGMA busy_timeout = 5000");
    database.run("PRAGMA journal_mode = WAL");
    database.run("PRAGMA synchronous = FULL");
    database.run("PRAGMA foreign_keys = ON");
    const version = database.query<{ user_version: number }, []>("PRAGMA user_version").get();
    database.transaction(() => {
      for (const [index, migration] of MIGRATIONS.entries()) {
        if (index >= (version?.user_version ?? 0)) {
          database.run(migration);
        }
      }
      database.run(`PRAGMA user_version = ${MIGRATIONS.length}`);
    })();
    const store = new SurveyStore(database, clock);
    store.#synchronize(loaded);
    return store;
  }

  close(): void {
    this.#database.close();
  }

  #synchronize({
    study,
    manifest,
    instrument,
  }: Pick<LoadedStudy, "study" | "manifest" | "instrument">): void {
    const database = this.#database;
    /** Record a value on first use; afterwards, return the value recorded then. */
    const freeze = (key: string, value: string): string => {
      database
        .query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT DO NOTHING")
        .run(key, value);
      return (
        database.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)
          ?.value ?? value
      );
    };
    database.transaction(() => {
      const studyId = freeze("study_id", study.id);
      if (studyId !== study.id) {
        throw new Error(`this database belongs to study ${studyId}, not ${study.id}`);
      }
      if (freeze("instrument", digestJson(instrument)) !== digestJson(instrument)) {
        throw new Error(
          "the instrument changed after this database was created; answers in it were given under the earlier wording",
        );
      }
      for (const entry of manifest.exercises) {
        if (freeze(`exercise:${entry.code}`, entry.sha256) !== entry.sha256) {
          throw new Error(
            `${entry.code} was rebuilt after this database was created; answers in it refer to the earlier build`,
          );
        }
      }
      for (const rater of study.raters) {
        const existing = database
          .query<{ role: string }, [string]>("SELECT role FROM raters WHERE id = ?")
          .get(rater.id);
        if (existing === null) {
          database
            .query("INSERT INTO raters (id, role, deadline) VALUES (?, ?, ?)")
            .run(rater.id, rater.role, study.deadlines[rater.role] ?? null);
        } else if (existing.role !== rater.role) {
          throw new Error(
            `${rater.id} was a ${existing.role} rater and cannot become ${rater.role}`,
          );
        }
        const planned = database
          .query<{ exercise: string }, [string]>(
            "SELECT exercise FROM assignments WHERE rater_id = ? AND kind = 'planned' ORDER BY position",
          )
          .all(rater.id)
          .map((row) => row.exercise);
        if (planned.length === 0) {
          rater.exercises.forEach((exercise, index) => {
            database
              .query(
                "INSERT INTO assignments (rater_id, position, exercise, kind, created_at) VALUES (?, ?, ?, 'planned', ?)",
              )
              .run(rater.id, index + 1, exercise, this.#now());
          });
        } else if (planned.join(",") !== rater.exercises.join(",")) {
          throw new Error(`the plan of ${rater.id} changed after the study started`);
        }
      }
    })();
  }

  /** Issue a new personal link, revoking the holder's earlier links; `null` is the study team. */
  issueLink(raterId: string | null): string {
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    this.#database.transaction(() => {
      this.#database
        .query("UPDATE links SET revoked_at = ? WHERE rater_id IS ? AND revoked_at IS NULL")
        .run(this.#now(), raterId);
      this.#database
        .query("INSERT INTO links (hash, rater_id, created_at) VALUES (?, ?, ?)")
        .run(linkDigest(token), raterId, this.#now());
    })();
    return token;
  }

  holderOf(token: string): Holder | null {
    const link = this.#database
      .query<{ rater_id: string | null }, [string]>(
        "SELECT rater_id FROM links WHERE hash = ? AND revoked_at IS NULL",
      )
      .get(linkDigest(token));
    if (link === null) {
      return null;
    }
    if (link.rater_id === null) {
      return { kind: "admin" };
    }
    const rater = this.rater(link.rater_id);
    return rater === null ? null : { kind: "rater", rater };
  }

  rater(id: string): RaterRow | null {
    return this.#database.query<RaterRow, [string]>("SELECT * FROM raters WHERE id = ?").get(id);
  }

  raters(): RaterRow[] {
    return this.#database.query<RaterRow, []>("SELECT * FROM raters ORDER BY rowid").all();
  }

  assignments(raterId?: string): AssignmentRow[] {
    return raterId === undefined
      ? this.#database
          .query<AssignmentRow, []>("SELECT * FROM assignments ORDER BY rater_id, position")
          .all()
      : this.#database
          .query<AssignmentRow, [string]>(
            "SELECT * FROM assignments WHERE rater_id = ? ORDER BY position",
          )
          .all(raterId);
  }

  steps(raterId?: string): StepRow[] {
    return raterId === undefined
      ? this.#database.query<StepRow, []>("SELECT * FROM steps ORDER BY rater_id").all()
      : this.#database
          .query<StepRow, [string]>("SELECT * FROM steps WHERE rater_id = ?")
          .all(raterId);
  }

  step(raterId: string, key: string): StepRow | null {
    return this.#database
      .query<StepRow, [string, string]>("SELECT * FROM steps WHERE rater_id = ? AND step = ?")
      .get(raterId, key);
  }

  events(): EventRow[] {
    return this.#database
      .query<EventRow, []>("SELECT rater_id, step, type, target, at FROM events ORDER BY id")
      .all();
  }

  progress(rater: RaterRow): Progress {
    const submitted = this.#database
      .query<{ step: string }, [string]>(
        "SELECT step FROM steps WHERE rater_id = ? AND submitted_at IS NOT NULL",
      )
      .all(rater.id)
      .map((row) => row.step);
    return {
      declined: rater.declined_at !== null,
      submitted: new Set(submitted),
      positions: this.assignments(rater.id).map((assignment) => assignment.position),
    };
  }

  current(rater: RaterRow): Step {
    return currentStep(this.progress(rater));
  }

  /** Record when a step's material was first shown; later calls keep the first time. */
  open(raterId: string, key: string): void {
    this.#database
      .query(
        `INSERT INTO steps (rater_id, step, opened_at) VALUES (?, ?, ?)
         ON CONFLICT (rater_id, step) DO UPDATE SET opened_at = coalesce(opened_at, excluded.opened_at)`,
      )
      .run(raterId, key, this.#now());
  }

  saveDraft(raterId: string, key: string, draft: SectionAnswers): string {
    const savedAt = this.#now();
    this.#database
      .query(
        `INSERT INTO steps (rater_id, step, draft, draft_saved_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (rater_id, step) DO UPDATE SET draft = excluded.draft, draft_saved_at = excluded.draft_saved_at
         WHERE submitted_at IS NULL`,
      )
      .run(raterId, key, JSON.stringify(draft), savedAt);
    return savedAt;
  }

  /** Store a step's final answers. A step is submitted exactly once. */
  submit(rater: RaterRow, step: Step, answers: unknown, instrumentVersion: string): void {
    const key = stepKey(step);
    this.#database.transaction(() => {
      const expected = stepKey(this.current(rater));
      if (expected !== key) {
        throw new StepConflict(`expected step ${expected}, not ${key}`);
      }
      this.#database
        .query(
          `INSERT INTO steps (rater_id, step, opened_at, answers, instrument_version, submitted_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (rater_id, step) DO UPDATE SET answers = excluded.answers,
             instrument_version = excluded.instrument_version, submitted_at = excluded.submitted_at,
             opened_at = coalesce(opened_at, excluded.opened_at), draft = NULL`,
        )
        .run(rater.id, key, this.#now(), JSON.stringify(answers), instrumentVersion, this.#now());
    })();
  }

  decline(raterId: string): void {
    this.#database
      .query("UPDATE raters SET declined_at = ? WHERE id = ? AND declined_at IS NULL")
      .run(this.#now(), raterId);
  }

  logEvents(raterId: string, key: string, events: Array<{ type: string; target: string }>): void {
    const at = this.#now();
    const insert = this.#database.query(
      "INSERT INTO events (rater_id, step, type, target, at) VALUES (?, ?, ?, ?, ?)",
    );
    this.#database.transaction(() => {
      for (const event of events) {
        insert.run(raterId, key, event.type, event.target, at);
      }
    })();
  }

  /**
   * Delete everything a rater answered, at their request, and revoke their links. The rater stays
   * in the plan with the time they withdrew, so the study team can assign a backup.
   */
  withdraw(raterId: string): void {
    this.#database.transaction(() => {
      const at = this.#now();
      this.#database.query("DELETE FROM steps WHERE rater_id = ?").run(raterId);
      this.#database.query("DELETE FROM events WHERE rater_id = ?").run(raterId);
      this.#database
        .query("UPDATE links SET revoked_at = ? WHERE rater_id = ? AND revoked_at IS NULL")
        .run(at, raterId);
      this.#database
        .query("UPDATE raters SET withdrawn_at = coalesce(withdrawn_at, ?) WHERE id = ?")
        .run(at, raterId);
    })();
  }

  /** Write a consistent copy of the database, also while the server writes to it. */
  backup(path: string): void {
    this.#database.query("VACUUM INTO ?").run(path);
  }

  setDeadline(raterId: string, deadline: string): void {
    this.#database.query("UPDATE raters SET deadline = ? WHERE id = ?").run(deadline, raterId);
  }

  /** Assign exercises to a reserve rater after their earlier assignments. */
  assign(
    raterId: string,
    exercises: string[],
    kind: "backup" | "tie_breaker",
    replaces: string | null,
  ): void {
    this.#database.transaction(() => {
      const existing = this.assignments(raterId);
      let position = Math.max(0, ...existing.map((assignment) => assignment.position));
      for (const exercise of exercises) {
        position += 1;
        this.#database
          .query(
            "INSERT INTO assignments (rater_id, position, exercise, kind, replaces, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(raterId, position, exercise, kind, replaces, this.#now());
      }
    })();
  }
}

/** A request for a step other than the rater's current one: the page is stale, not broken. */
export class StepConflict extends Error {}
