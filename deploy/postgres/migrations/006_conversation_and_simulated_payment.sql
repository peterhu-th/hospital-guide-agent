BEGIN;
SET search_path TO runtime, public;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.schema_migrations WHERE version = '005_runtime_schema') THEN
    RAISE EXCEPTION '005_runtime_schema must be applied first';
  END IF;
END $$;

ALTER TABLE patient_profiles DROP CONSTRAINT IF EXISTS patient_profiles_sex_check;
ALTER TABLE patient_profiles ADD CONSTRAINT patient_profiles_sex_check CHECK (sex IN ('female','male'));
ALTER TABLE conversation_turns ADD CONSTRAINT conversation_turns_message_length CHECK (char_length(message) BETWEEN 1 AND 500) NOT VALID;
ALTER TABLE doctors DROP COLUMN IF EXISTS contact_encrypted;
ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_status_check;
ALTER TABLE bills ADD CONSTRAINT bills_status_check CHECK (status IN ('UNPAID','PAID'));
ALTER TABLE bills ADD COLUMN IF NOT EXISTS paid_at timestamptz;

CREATE TABLE IF NOT EXISTS simulated_payments(
  payment_id text PRIMARY KEY,
  bill_id text UNIQUE NOT NULL REFERENCES bills(bill_id) ON DELETE CASCADE,
  patient_id text NOT NULL REFERENCES patient_profiles(patient_id) ON DELETE CASCADE,
  amount_cents integer NOT NULL CHECK(amount_cents>=0),
  provider text NOT NULL CHECK(provider='SIMULATED'),
  status text NOT NULL CHECK(status='PAID'),
  paid_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS proactive_agent_events(
  event_id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES patient_sessions(session_id) ON DELETE CASCADE,
  appointment_id text NOT NULL REFERENCES appointments(appointment_id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK(event_type IN ('WAITING_INTERVIEW','CALLED_NOTICE')),
  created_at timestamptz NOT NULL,
  UNIQUE(session_id,appointment_id,event_type)
);

INSERT INTO app.schema_migrations(version) VALUES ('006_conversation_and_simulated_payment');
COMMIT;
