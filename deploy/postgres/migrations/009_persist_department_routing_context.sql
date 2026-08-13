BEGIN;

SET search_path TO runtime, public;

ALTER TABLE conversation_workflow_states
  ADD COLUMN IF NOT EXISTS recommended_departments_json text NOT NULL DEFAULT '[]';

INSERT INTO app.schema_migrations(version)
VALUES ('009_persist_department_routing_context')
ON CONFLICT(version) DO NOTHING;

COMMIT;
