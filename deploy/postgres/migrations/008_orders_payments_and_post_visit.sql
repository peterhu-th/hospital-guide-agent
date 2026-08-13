BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SET search_path TO runtime, public;

ALTER TABLE medical_orders ADD COLUMN IF NOT EXISTS catalog_item_id text;
ALTER TABLE medical_orders ADD COLUMN IF NOT EXISTS quantity integer NOT NULL DEFAULT 1;
ALTER TABLE medical_orders ADD COLUMN IF NOT EXISTS location_id text;
ALTER TABLE medical_orders ADD COLUMN IF NOT EXISTS data_origin text NOT NULL DEFAULT 'hospital_runtime';

ALTER TABLE bills ADD COLUMN IF NOT EXISTS bill_type text NOT NULL DEFAULT 'ORDER';
ALTER TABLE bills ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '医疗服务费';

ALTER TABLE proactive_agent_events DROP CONSTRAINT IF EXISTS proactive_agent_events_event_type_check;
ALTER TABLE proactive_agent_events ADD CONSTRAINT proactive_agent_events_event_type_check
  CHECK(event_type IN ('WAITING_INTERVIEW','CALLED_NOTICE','POST_VISIT_GUIDANCE'));

INSERT INTO app.schema_migrations(version) VALUES ('007_workflow_and_confirmed_facts') ON CONFLICT DO NOTHING;
INSERT INTO app.schema_migrations(version) VALUES ('008_orders_payments_and_post_visit') ON CONFLICT DO NOTHING;
COMMIT;
