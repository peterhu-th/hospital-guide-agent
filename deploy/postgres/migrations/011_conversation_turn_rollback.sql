BEGIN;

SET search_path TO runtime, public;

ALTER TABLE conversation_turns
  ADD COLUMN IF NOT EXISTS interaction_id text,
  ADD COLUMN IF NOT EXISTS reply_to_turn_id text REFERENCES conversation_turns(turn_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS turn_kind text NOT NULL DEFAULT 'CHAT',
  ADD COLUMN IF NOT EXISTS turn_status text NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS state_before_json text,
  ADD COLUMN IF NOT EXISTS undone_at timestamptz;

UPDATE conversation_turns SET interaction_id=turn_id WHERE interaction_id IS NULL;
ALTER TABLE conversation_turns ALTER COLUMN interaction_id SET NOT NULL;

ALTER TABLE conversation_turns DROP CONSTRAINT IF EXISTS conversation_turns_turn_kind_check;
ALTER TABLE conversation_turns ADD CONSTRAINT conversation_turns_turn_kind_check
  CHECK(turn_kind IN ('CHAT','CONTROL','PROACTIVE'));
ALTER TABLE conversation_turns DROP CONSTRAINT IF EXISTS conversation_turns_turn_status_check;
ALTER TABLE conversation_turns ADD CONSTRAINT conversation_turns_turn_status_check
  CHECK(turn_status IN ('ACTIVE','UNDONE'));

CREATE INDEX IF NOT EXISTS conversation_turns_active_idx
  ON conversation_turns(session_id,turn_status,created_at);

INSERT INTO app.schema_migrations(version)
VALUES ('011_conversation_turn_rollback')
ON CONFLICT(version) DO NOTHING;

COMMIT;
