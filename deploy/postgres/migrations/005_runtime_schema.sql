BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SET search_path TO app, public;
SELECT pg_advisory_xact_lock(hashtext('hospital-guide-schema-migration'));

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '004_administrator_and_booking_guard') THEN RAISE EXCEPTION '004 must be applied first'; END IF;
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '005_runtime_schema') THEN RAISE EXCEPTION '005 has already been applied'; END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS runtime AUTHORIZATION hospital_app;
SET search_path TO runtime, public;

CREATE TABLE departments(department_id text PRIMARY KEY,name text NOT NULL,display_name text NOT NULL,division text,summary text,aliases_json text NOT NULL DEFAULT '[]');
CREATE TABLE patient_sessions(session_id text PRIMARY KEY,token_hash text UNIQUE NOT NULL,patient_id text,current_stage text NOT NULL DEFAULT 'PRE_VISIT',created_at timestamptz NOT NULL,last_active_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz);
CREATE TABLE patient_profiles(patient_id text PRIMARY KEY,full_name_encrypted text NOT NULL,full_name_masked text NOT NULL,identity_encrypted text NOT NULL,identity_digest text NOT NULL,identity_masked text NOT NULL,sex text NOT NULL,age integer NOT NULL,birth_date date NOT NULL,verification_status text NOT NULL,manually_entered integer NOT NULL CHECK(manually_entered=1),created_at timestamptz NOT NULL,last_active_at timestamptz NOT NULL,expires_at timestamptz NOT NULL);
CREATE TABLE conversation_turns(turn_id text PRIMARY KEY,session_id text NOT NULL REFERENCES patient_sessions(session_id) ON DELETE CASCADE,role text NOT NULL,message text NOT NULL,created_at timestamptz NOT NULL);
CREATE TABLE doctors(doctor_id text PRIMARY KEY,display_name text NOT NULL,employee_number text UNIQUE NOT NULL CHECK(employee_number ~ '^[0-9]{6}$'),password_hash text NOT NULL,contact_encrypted text,account_status text NOT NULL,verification_notice text NOT NULL,failed_login_count integer NOT NULL DEFAULT 0,locked_until timestamptz,created_at timestamptz NOT NULL);
CREATE TABLE doctor_sessions(session_id text PRIMARY KEY,doctor_id text NOT NULL REFERENCES doctors(doctor_id) ON DELETE CASCADE,token_hash text UNIQUE NOT NULL,csrf_hash text NOT NULL,created_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz);
CREATE TABLE administrators(administrator_id text PRIMARY KEY,employee_number text UNIQUE NOT NULL CHECK(employee_number ~ '^[0-9]{6}$'),display_name text NOT NULL,password_hash text NOT NULL,account_status text NOT NULL DEFAULT 'ACTIVE',failed_login_count integer NOT NULL DEFAULT 0,locked_until timestamptz,created_at timestamptz NOT NULL);
CREATE TABLE administrator_sessions(session_id text PRIMARY KEY,administrator_id text NOT NULL REFERENCES administrators(administrator_id) ON DELETE CASCADE,token_hash text UNIQUE NOT NULL,csrf_hash text NOT NULL,created_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz);
CREATE TABLE doctor_practices(practice_id text PRIMARY KEY,doctor_id text NOT NULL REFERENCES doctors(doctor_id) ON DELETE CASCADE,department_id text NOT NULL REFERENCES departments(department_id),service_date date NOT NULL,start_time time NOT NULL,end_time time NOT NULL,capacity integer NOT NULL,booked_count integer NOT NULL DEFAULT 0,status text NOT NULL,created_at timestamptz NOT NULL,UNIQUE(doctor_id,department_id,service_date,start_time,end_time));
CREATE TABLE appointments(appointment_id text PRIMARY KEY,patient_id text NOT NULL REFERENCES patient_profiles(patient_id) ON DELETE CASCADE,practice_id text NOT NULL REFERENCES doctor_practices(practice_id),doctor_id text NOT NULL,department_id text NOT NULL,status text NOT NULL,queue_number integer,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL);
CREATE TABLE medical_records(record_id text PRIMARY KEY,appointment_id text UNIQUE NOT NULL REFERENCES appointments(appointment_id) ON DELETE CASCADE,patient_id text NOT NULL,doctor_id text NOT NULL,department_id text NOT NULL,version integer NOT NULL DEFAULT 1,doctor_content_json text NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL);
CREATE TABLE patient_statements(statement_id text PRIMARY KEY,record_id text NOT NULL REFERENCES medical_records(record_id) ON DELETE CASCADE,source_turn_id text NOT NULL,patient_words text NOT NULL,normalized_value text,category text NOT NULL,certainty text NOT NULL,created_at timestamptz NOT NULL,UNIQUE(record_id,source_turn_id));
CREATE TABLE medical_record_versions(version_id text PRIMARY KEY,record_id text NOT NULL REFERENCES medical_records(record_id) ON DELETE CASCADE,version integer NOT NULL,content_json text NOT NULL,changed_by text NOT NULL,change_reason text NOT NULL,created_at timestamptz NOT NULL,UNIQUE(record_id,version));
CREATE TABLE medical_orders(order_id text PRIMARY KEY,record_id text NOT NULL REFERENCES medical_records(record_id) ON DELETE CASCADE,doctor_id text NOT NULL,order_type text NOT NULL,title text NOT NULL,details text NOT NULL,status text NOT NULL,created_at timestamptz NOT NULL);
CREATE TABLE bills(bill_id text PRIMARY KEY,appointment_id text NOT NULL REFERENCES appointments(appointment_id) ON DELETE CASCADE,order_id text REFERENCES medical_orders(order_id) ON DELETE CASCADE,amount_cents integer NOT NULL,status text NOT NULL CHECK(status='UNPAID'),guidance text NOT NULL,created_at timestamptz NOT NULL);
CREATE TABLE journey_tasks(task_id text PRIMARY KEY,appointment_id text NOT NULL REFERENCES appointments(appointment_id) ON DELETE CASCADE,task_type text NOT NULL,status text NOT NULL,title text NOT NULL,created_at timestamptz NOT NULL,UNIQUE(appointment_id,task_type,title));
CREATE TABLE pending_actions(action_id text PRIMARY KEY,session_id text NOT NULL REFERENCES patient_sessions(session_id) ON DELETE CASCADE,action_type text NOT NULL,parameters_json text NOT NULL,summary text NOT NULL,status text NOT NULL,created_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,confirmed_at timestamptz);
CREATE TABLE audit_events(audit_id text PRIMARY KEY,actor_type text NOT NULL,actor_id text,action text NOT NULL,entity_type text NOT NULL,entity_id text NOT NULL,detail_json text NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL);
CREATE TABLE simulated_results(result_id text PRIMARY KEY,order_id text NOT NULL REFERENCES medical_orders(order_id) ON DELETE CASCADE,object_type text NOT NULL,content_json text NOT NULL,required_label text NOT NULL,simulated integer NOT NULL CHECK(simulated=1),created_at timestamptz NOT NULL);

CREATE INDEX patient_expiry_idx ON patient_profiles(expires_at);
CREATE INDEX practice_lookup_idx ON doctor_practices(department_id,service_date,status);
CREATE INDEX pending_actions_session_idx ON pending_actions(session_id,status,expires_at);

CREATE FUNCTION prevent_duplicate_department_appointment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE target_date date;
BEGIN
    SELECT service_date INTO target_date FROM doctor_practices WHERE practice_id = NEW.practice_id;
    PERFORM pg_advisory_xact_lock(hashtext(NEW.patient_id || ':' || NEW.department_id || ':' || target_date::text));
    IF EXISTS (
        SELECT 1 FROM appointments a JOIN doctor_practices p ON p.practice_id = a.practice_id
        WHERE a.patient_id = NEW.patient_id AND a.department_id = NEW.department_id
          AND p.service_date = target_date AND a.status NOT IN ('CANCELLED','COMPLETED')
          AND a.appointment_id <> NEW.appointment_id
    ) THEN RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'DUPLICATE_DEPARTMENT_APPOINTMENT'; END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER appointments_prevent_department_duplicate
    BEFORE INSERT OR UPDATE OF practice_id,department_id,status ON appointments
    FOR EACH ROW EXECUTE FUNCTION prevent_duplicate_department_appointment();

SET search_path TO app, public;
INSERT INTO schema_migrations(version) VALUES ('005_runtime_schema');
COMMIT;
