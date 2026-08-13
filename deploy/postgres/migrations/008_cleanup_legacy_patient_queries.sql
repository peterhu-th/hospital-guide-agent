BEGIN;

SET search_path TO runtime, public;

-- User-authorized cleanup: remove existing patient query text while retaining
-- the conversation table required for new three-day continuity sessions.
DELETE FROM conversation_turns;

-- This legacy table is superseded by patient_facts and is not read by the app.
DROP TABLE IF EXISTS patient_statements;

-- Remove obsolete confirmation actions that referred to the legacy flow.
DELETE FROM pending_actions WHERE action_type='CONFIRM_FACTS';

INSERT INTO app.schema_migrations(version)
VALUES ('008_cleanup_legacy_patient_queries')
ON CONFLICT(version) DO NOTHING;

COMMIT;
