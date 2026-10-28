--liquibase formatted sql

--changeset survey:1
--comment: Everything a study collects. Answers are written once per step and never updated; drafts are the only state that changes. Links are stored as SHA-256 digests, so the database cannot reproduce a link that lets someone act as a rater.
CREATE TABLE frozen (
    key text PRIMARY KEY,
    value text NOT NULL
);
CREATE TABLE rater (
    id text PRIMARY KEY,
    ordinal integer GENERATED ALWAYS AS IDENTITY UNIQUE,
    role text NOT NULL CHECK (role IN ('main', 'reserve', 'pilot', 'test')),
    deadline date,
    declined_at timestamptz,
    withdrawn_at timestamptz
);
CREATE TABLE link (
    hash text PRIMARY KEY,
    rater_id text REFERENCES rater (id),
    created_at timestamptz NOT NULL,
    revoked_at timestamptz
);
CREATE TABLE assignment (
    rater_id text NOT NULL REFERENCES rater (id),
    position integer NOT NULL CHECK (position > 0),
    exercise text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('planned', 'backup', 'tie_breaker')),
    replaces text REFERENCES rater (id),
    created_at timestamptz NOT NULL,
    PRIMARY KEY (rater_id, position),
    UNIQUE (rater_id, exercise)
);
CREATE TABLE step (
    rater_id text NOT NULL REFERENCES rater (id),
    step text NOT NULL,
    opened_at timestamptz,
    draft json,
    draft_saved_at timestamptz,
    answers json,
    instrument_version text,
    submitted_at timestamptz,
    PRIMARY KEY (rater_id, step)
);
CREATE TABLE event (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    rater_id text NOT NULL REFERENCES rater (id),
    step text NOT NULL,
    type text NOT NULL,
    target text NOT NULL,
    at timestamptz NOT NULL
);
--rollback DROP TABLE event, step, assignment, link, rater, frozen;

--changeset survey:2
--comment: The study team manages the study from the dashboard: it adds raters, assigns and removes exercises, and every change is logged. An assignment the rater has not started is removed by marking it, so the plan in study.yaml stays recognisable.
ALTER TABLE rater ADD COLUMN added_at timestamptz;
ALTER TABLE assignment ADD COLUMN removed_at timestamptz;
ALTER TABLE assignment DROP CONSTRAINT assignment_kind_check;
ALTER TABLE assignment ADD CONSTRAINT assignment_kind_check
    CHECK (kind IN ('planned', 'additional', 'backup', 'tie_breaker'));
ALTER TABLE assignment DROP CONSTRAINT assignment_rater_id_exercise_key;
CREATE UNIQUE INDEX assignment_active_exercise ON assignment (rater_id, exercise) WHERE removed_at IS NULL;
CREATE TABLE change_log (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at timestamptz NOT NULL,
    action text NOT NULL,
    rater_id text REFERENCES rater (id),
    detail text NOT NULL
);
--rollback DROP TABLE change_log; DROP INDEX assignment_active_exercise; ALTER TABLE assignment ADD CONSTRAINT assignment_rater_id_exercise_key UNIQUE (rater_id, exercise); ALTER TABLE assignment DROP CONSTRAINT assignment_kind_check; ALTER TABLE assignment ADD CONSTRAINT assignment_kind_check CHECK (kind IN ('planned', 'backup', 'tie_breaker')); ALTER TABLE assignment DROP COLUMN removed_at; ALTER TABLE rater DROP COLUMN added_at;
