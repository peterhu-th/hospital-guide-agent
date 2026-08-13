BEGIN;

SET search_path TO runtime, public;

-- Store the tool cards emitted with each Agent turn so a browser refresh can
-- reconstruct the current conversation without adding a parallel query table.
ALTER TABLE conversation_turns
  ADD COLUMN IF NOT EXISTS assistant_actions_json text NOT NULL DEFAULT '[]';

INSERT INTO app.schema_migrations(version)
VALUES ('009_persist_assistant_actions')
ON CONFLICT(version) DO NOTHING;

COMMIT;
