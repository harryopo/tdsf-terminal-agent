CREATE TABLE app.learners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.attempts (
  id uuid PRIMARY KEY,
  learner_id uuid NOT NULL REFERENCES app.learners (id) ON DELETE CASCADE,
  task_id text NOT NULL,
  step_id text NOT NULL,
  task_version text NOT NULL,
  command_sha256 text NOT NULL,
  output_sha256 text NOT NULL,
  status text NOT NULL,
  evidence_matched boolean NOT NULL,
  duration_ms integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX attempts_learner_created_idx ON app.attempts (learner_id, created_at);

CREATE TABLE app.step_progress (
  learner_id uuid NOT NULL REFERENCES app.learners (id) ON DELETE CASCADE,
  task_version text NOT NULL,
  task_id text NOT NULL,
  step_id text NOT NULL,
  status text NOT NULL,
  first_completed_at timestamptz NOT NULL,
  last_completed_at timestamptz NOT NULL,
  PRIMARY KEY (learner_id, task_version, task_id, step_id)
);
