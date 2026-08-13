BEGIN;

SET search_path TO runtime, public;

CREATE TABLE IF NOT EXISTS patient_facts(
  fact_id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES patient_sessions(session_id) ON DELETE CASCADE,
  record_id text REFERENCES medical_records(record_id) ON DELETE CASCADE,
  source_turn_id text NOT NULL,
  field text NOT NULL,
  normalized_value text NOT NULL CHECK(char_length(normalized_value) BETWEEN 1 AND 500),
  certainty text NOT NULL CHECK(certainty IN ('PATIENT_CONFIRMED','UNCERTAIN','DENIED')),
  status text NOT NULL CHECK(status IN ('CANDIDATE','CONFIRMED','REJECTED')),
  created_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  UNIQUE(session_id,source_turn_id,field)
);

CREATE INDEX IF NOT EXISTS patient_facts_record_idx ON patient_facts(record_id,status,created_at);

CREATE TABLE IF NOT EXISTS conversation_workflow_states(
  session_id text PRIMARY KEY REFERENCES patient_sessions(session_id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 0,
  active_task_type text NOT NULL DEFAULT 'UNDERSTAND_REQUEST',
  active_task_status text NOT NULL DEFAULT 'READY',
  pending_field text,
  last_question text,
  suspended_tasks_json text NOT NULL DEFAULT '[]',
  updated_at timestamptz NOT NULL
);

-- Legacy query cleanup is isolated in migration 008 so this schema migration
-- remains immutable and independently auditable.

INSERT INTO app.schema_migrations(version)
VALUES ('007_workflow_and_confirmed_facts')
ON CONFLICT(version) DO NOTHING;

COMMIT;
