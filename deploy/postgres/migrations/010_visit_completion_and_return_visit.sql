BEGIN;
SET search_path TO runtime, public;

CREATE TABLE IF NOT EXISTS consultation_rounds(
  round_id text PRIMARY KEY,
  appointment_id text NOT NULL REFERENCES appointments(appointment_id) ON DELETE CASCADE,
  round_number integer NOT NULL,
  round_type text NOT NULL CHECK(round_type IN ('INITIAL','RETURN')),
  status text NOT NULL CHECK(status IN ('SCHEDULED','WAITING','IN_CONSULTATION','COMPLETED','CANCELLED')),
  scheduled_at timestamptz, started_at timestamptz, completed_at timestamptz,
  return_visit_required integer CHECK(return_visit_required IN (0,1)), return_visit_at timestamptz,
  created_at timestamptz NOT NULL,
  UNIQUE(appointment_id,round_number)
);

ALTER TABLE medical_orders ADD COLUMN IF NOT EXISTS consultation_round_id text REFERENCES consultation_rounds(round_id);
ALTER TABLE journey_tasks ADD COLUMN IF NOT EXISTS order_id text REFERENCES medical_orders(order_id) ON DELETE CASCADE;
ALTER TABLE journey_tasks ADD COLUMN IF NOT EXISTS consultation_round_id text REFERENCES consultation_rounds(round_id) ON DELETE CASCADE;
ALTER TABLE journey_tasks ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;
ALTER TABLE journey_tasks ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE journey_tasks ADD COLUMN IF NOT EXISTS blocks_completion integer NOT NULL DEFAULT 1 CHECK(blocks_completion IN (0,1));

ALTER TABLE journey_tasks DROP CONSTRAINT IF EXISTS journey_tasks_appointment_id_task_type_title_key;

ALTER TABLE proactive_agent_events DROP CONSTRAINT IF EXISTS proactive_agent_events_event_type_check;
ALTER TABLE proactive_agent_events ADD CONSTRAINT proactive_agent_events_event_type_check
  CHECK(event_type IN ('WAITING_INTERVIEW','CALLED_NOTICE','POST_VISIT_GUIDANCE','RETURN_VISIT_READY','VISIT_COMPLETED'));

UPDATE journey_tasks t SET order_id=(
  SELECT o.order_id FROM medical_orders o JOIN medical_records r ON r.record_id=o.record_id
  WHERE r.appointment_id=t.appointment_id
    AND ((t.task_type='EXAMINATION' AND o.order_type='EXAMINATION') OR (t.task_type='PHARMACY' AND o.order_type='PRESCRIPTION'))
    AND t.title LIKE '%' || o.title
  ORDER BY o.created_at LIMIT 1
)
WHERE t.order_id IS NULL AND t.task_type IN ('EXAMINATION','PHARMACY');

CREATE UNIQUE INDEX IF NOT EXISTS journey_task_order_idx ON journey_tasks(order_id) WHERE order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS journey_task_return_round_idx ON journey_tasks(consultation_round_id) WHERE task_type='RETURN_VISIT';

INSERT INTO app.schema_migrations(version) VALUES ('010_visit_completion_and_return_visit') ON CONFLICT DO NOTHING;
COMMIT;
