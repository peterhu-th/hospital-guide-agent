BEGIN;

CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION hospital_app;
SET search_path TO app, public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

CREATE TABLE schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hospitals (
    hospital_id text PRIMARY KEY CHECK (hospital_id ~ '^hospital-[a-z0-9]+(-[a-z0-9]+)*$'),
    map_id text NOT NULL CHECK (map_id ~ '^[0-9]+$'),
    name text NOT NULL,
    hospital_type text NOT NULL,
    address text NOT NULL,
    contacts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(contacts) = 'array'),
    campuses jsonb NOT NULL CHECK (jsonb_typeof(campuses) = 'array'),
    sources jsonb NOT NULL CHECK (jsonb_typeof(sources) = 'array'),
    data_origin text NOT NULL DEFAULT 'official_public' CHECK (data_origin = 'official_public'),
    data_version text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE departments (
    department_id text PRIMARY KEY CHECK (department_id ~ '^dept-[a-z0-9]+(-[a-z0-9]+)*$'),
    hospital_id text NOT NULL REFERENCES hospitals(hospital_id) ON DELETE CASCADE,
    name text NOT NULL,
    division text NOT NULL CHECK (division IN ('内科部','外科部','综合部','门诊部','医技部','手麻平台部','行后职能科室','其他')),
    aliases text[] NOT NULL DEFAULT '{}',
    summary text NOT NULL,
    routing_hints text[] NOT NULL DEFAULT '{}',
    differentiation_hints text[] NOT NULL DEFAULT '{}',
    clarifying_questions text[] NOT NULL DEFAULT '{}',
    routing_enabled boolean NOT NULL DEFAULT true,
    sources jsonb NOT NULL CHECK (jsonb_typeof(sources) = 'array'),
    data_origin text NOT NULL CHECK (data_origin IN ('official_public','project_curated')),
    routing_review_status text NOT NULL CHECK (routing_review_status IN ('unreviewed','official_public','project_reviewed','hospital_reviewed','requires_current_confirmation')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX departments_hospital_idx ON departments(hospital_id);
CREATE INDEX departments_name_trgm_idx ON departments USING gin (name gin_trgm_ops);
CREATE INDEX departments_aliases_idx ON departments USING gin (aliases);

CREATE TABLE doctors (
    doctor_id text PRIMARY KEY CHECK (doctor_id ~ '^doctor-[a-z0-9]+(-[a-z0-9]+)*$'),
    display_name text NOT NULL,
    availability_policy text NOT NULL CHECK (availability_policy IN ('AVAILABLE','FULL')),
    data_origin text NOT NULL DEFAULT 'simulated' CHECK (data_origin = 'simulated'),
    simulation jsonb NOT NULL CHECK (jsonb_typeof(simulation) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE doctor_departments (
    doctor_id text NOT NULL REFERENCES doctors(doctor_id) ON DELETE CASCADE,
    department_id text NOT NULL REFERENCES departments(department_id) ON DELETE CASCADE,
    PRIMARY KEY (doctor_id, department_id)
);

CREATE TABLE locations (
    location_id text PRIMARY KEY CHECK (location_id ~ '^location-[a-z0-9]+(-[a-z0-9]+)*$'),
    hospital_id text NOT NULL REFERENCES hospitals(hospital_id) ON DELETE CASCADE,
    map_id text NOT NULL CHECK (map_id = '90872'),
    map_feature_id text,
    canonical_name text NOT NULL,
    map_label text,
    aliases text[] NOT NULL DEFAULT '{}',
    building text,
    floor_id text NOT NULL CHECK (floor_id IN ('B1','F1','F2','F3','F4','UNKNOWN')),
    floor_label text NOT NULL CHECK (floor_label IN ('地下1层','1层','2层','3层','4层','未知')),
    category text NOT NULL CHECK (category IN ('department','registration','payment','insurance','examination','pharmacy','service','entrance','elevator','escalator','stairs','restroom','parking','other')),
    route_enabled boolean NOT NULL DEFAULT false,
    map_status text NOT NULL CHECK (map_status IN ('mapped','not_found','ambiguous','unverified')),
    coordinate_x double precision,
    coordinate_y double precision,
    sources jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sources) = 'array'),
    data_origin text NOT NULL DEFAULT 'map_data' CHECK (data_origin = 'map_data'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((coordinate_x IS NULL) = (coordinate_y IS NULL))
);

CREATE INDEX locations_hospital_floor_idx ON locations(hospital_id, floor_id);
CREATE INDEX locations_name_trgm_idx ON locations USING gin (canonical_name gin_trgm_ops);
CREATE INDEX locations_aliases_idx ON locations USING gin (aliases);

CREATE TABLE department_locations (
    department_id text NOT NULL REFERENCES departments(department_id) ON DELETE CASCADE,
    location_id text NOT NULL REFERENCES locations(location_id) ON DELETE CASCADE,
    PRIMARY KEY (department_id, location_id)
);

CREATE TABLE appointment_slots (
    slot_id text PRIMARY KEY CHECK (slot_id ~ '^slot-[a-z0-9]+(-[a-z0-9]+)*$'),
    doctor_id text NOT NULL REFERENCES doctors(doctor_id),
    department_id text NOT NULL REFERENCES departments(department_id),
    slot_date date NOT NULL,
    period text NOT NULL CHECK (period IN ('上午','下午')),
    start_time time,
    end_time time,
    status text NOT NULL CHECK (status IN ('AVAILABLE','FULL','EXPIRED','SUSPENDED')),
    remaining integer NOT NULL CHECK (remaining >= 0),
    fee_amount numeric(12,2) NOT NULL CHECK (fee_amount >= 0),
    currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
    data_origin text NOT NULL DEFAULT 'simulated' CHECK (data_origin = 'simulated'),
    simulation jsonb NOT NULL CHECK (jsonb_typeof(simulation) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (end_time IS NULL OR start_time IS NULL OR end_time > start_time)
);

CREATE INDEX appointment_slots_lookup_idx ON appointment_slots(department_id, slot_date, period, status);

CREATE TABLE anonymous_patients (
    patient_id text PRIMARY KEY CHECK (patient_id ~ '^patient-[a-z0-9]+(-[a-z0-9]+)*$'),
    age_range text NOT NULL DEFAULT 'unknown' CHECK (age_range IN ('unknown','0-17','18-49','50-59','60-69','70+')),
    sex text NOT NULL DEFAULT 'unknown' CHECK (sex IN ('unknown','female','male','other','unwilling')),
    user_role text NOT NULL DEFAULT 'patient' CHECK (user_role IN ('patient','family')),
    literacy_preference text NOT NULL DEFAULT 'simple' CHECK (literacy_preference IN ('simple','standard')),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_active_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '72 hours'),
    CHECK (expires_at >= last_active_at)
);

CREATE INDEX anonymous_patients_expiry_idx ON anonymous_patients(expires_at);

CREATE TABLE sessions (
    session_id text PRIMARY KEY CHECK (session_id ~ '^session-[a-zA-Z0-9-]+$'),
    patient_id text NOT NULL REFERENCES anonymous_patients(patient_id) ON DELETE CASCADE,
    schema_version text NOT NULL DEFAULT '1.0.0',
    revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
    current_stage text NOT NULL DEFAULT 'UNKNOWN' CHECK (current_stage IN ('UNKNOWN','PRE_VISIT','APPOINTMENT','ARRIVAL','CHECK_IN','WAITING','CONSULTATION','AFTER_CONSULTATION','PAYMENT','EXAMINATION','RETURN_VISIT','PHARMACY','COMPLETED')),
    conversation_summary text NOT NULL DEFAULT '',
    state_snapshot jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_active_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '72 hours'),
    CHECK (state_snapshot IS NULL OR jsonb_typeof(state_snapshot) = 'object'),
    CHECK (expires_at >= last_active_at)
);

CREATE INDEX sessions_patient_idx ON sessions(patient_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE conversation_turns (
    turn_id text PRIMARY KEY CHECK (turn_id ~ '^turn-[a-zA-Z0-9-]+$'),
    session_id text NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    request_id text UNIQUE CHECK (request_id IS NULL OR request_id ~ '^request-[a-zA-Z0-9-]+$'),
    base_revision integer NOT NULL DEFAULT 0 CHECK (base_revision >= 0),
    entry_context text CHECK (entry_context IN ('CHAT','APPOINTMENT','ARRIVAL','PAYMENT_OR_EXAMINATION','LOCATION_SEARCH','MAP_BROWSER')),
    user_message text NOT NULL CHECK (char_length(user_message) BETWEEN 1 AND 4000),
    assistant_message text,
    locale text NOT NULL DEFAULT 'zh-CN' CHECK (locale = 'zh-CN'),
    model_name text,
    request_payload jsonb,
    response_payload jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
);

CREATE INDEX conversation_turns_session_created_idx ON conversation_turns(session_id, created_at);

CREATE TABLE session_facts (
    fact_id text PRIMARY KEY CHECK (fact_id ~ '^fact-[a-zA-Z0-9-]+$'),
    session_id text NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    field text NOT NULL,
    raw_value jsonb NOT NULL,
    normalized_value jsonb,
    status text NOT NULL CHECK (status IN ('candidate','confirmed','rejected','unknown','conflicted','not_applicable','unwilling')),
    source_type text NOT NULL CHECK (source_type IN ('user_message','agent_inference','business_tool')),
    source_turn_id text REFERENCES conversation_turns(turn_id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX session_facts_session_idx ON session_facts(session_id, created_at);

CREATE TABLE agent_events (
    event_id text PRIMARY KEY CHECK (event_id ~ '^event-[a-zA-Z0-9-]+$'),
    turn_id text NOT NULL REFERENCES conversation_turns(turn_id) ON DELETE CASCADE,
    sequence integer NOT NULL CHECK (sequence >= 0),
    event_type text NOT NULL CHECK (event_type IN ('assistant_text_delta','fact_candidate','clarification_required','department_recommendation','knowledge_answer','pending_action','tool_result','state_patch','location_result','route_result','human_handoff','done')),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (turn_id, sequence)
);

CREATE TABLE department_routing_runs (
    routing_run_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    turn_id text REFERENCES conversation_turns(turn_id) ON DELETE CASCADE,
    user_expression text NOT NULL,
    request_payload jsonb NOT NULL CHECK (jsonb_typeof(request_payload) = 'object'),
    response_payload jsonb,
    validation_status text NOT NULL CHECK (validation_status IN ('PENDING','VALID','INVALID','FALLBACK')),
    validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(validation_errors) = 'array'),
    latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
    model_name text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX department_routing_runs_turn_idx ON department_routing_runs(turn_id);

CREATE TABLE appointments (
    appointment_id text PRIMARY KEY CHECK (appointment_id ~ '^appointment-[a-zA-Z0-9-]+$'),
    session_id text NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    patient_id text NOT NULL REFERENCES anonymous_patients(patient_id) ON DELETE CASCADE,
    department_id text NOT NULL REFERENCES departments(department_id),
    doctor_id text NOT NULL REFERENCES doctors(doctor_id),
    slot_id text NOT NULL REFERENCES appointment_slots(slot_id),
    status text NOT NULL CHECK (status IN ('DRAFT','PENDING_CONFIRMATION','PENDING_PAYMENT','BOOKED','CHECKED_IN','WAITING','CONSULTING','COMPLETED','CANCELLED','DOCTOR_SUSPENDED','MISSED')),
    payment_status text NOT NULL CHECK (payment_status IN ('NOT_REQUIRED','UNPAID','PAYMENT_PENDING','PAID','PAYMENT_FAILED','PAYMENT_UNKNOWN','REFUND_PENDING','REFUNDED')),
    check_in_status text NOT NULL CHECK (check_in_status IN ('NOT_CHECKED_IN','TOO_EARLY','CHECKED_IN','MISSED')),
    queue_details jsonb,
    data_origin text NOT NULL DEFAULT 'simulated' CHECK (data_origin = 'simulated'),
    simulation jsonb NOT NULL CHECK (jsonb_typeof(simulation) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX appointments_session_idx ON appointments(session_id, created_at);
CREATE INDEX appointments_patient_status_idx ON appointments(patient_id, status);

CREATE TABLE medical_orders (
    order_id text PRIMARY KEY CHECK (order_id ~ '^order-[a-zA-Z0-9-]+$'),
    session_id text NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    patient_id text NOT NULL REFERENCES anonymous_patients(patient_id) ON DELETE CASCADE,
    encounter_id text CHECK (encounter_id IS NULL OR encounter_id ~ '^encounter-[a-zA-Z0-9-]+$'),
    order_type text NOT NULL CHECK (order_type IN ('EXAMINATION','PRESCRIPTION')),
    name text NOT NULL,
    performing_department_id text REFERENCES departments(department_id),
    location_id text REFERENCES locations(location_id),
    status text NOT NULL CHECK (status IN ('CREATED','PENDING_PAYMENT','PENDING_APPOINTMENT','SCHEDULED','CHECKED_IN','IN_PROGRESS','COMPLETED','REPORT_READY','CANCELLED')),
    requires_payment boolean NOT NULL,
    requires_appointment boolean NOT NULL,
    preparation_text text,
    scheduled_for timestamptz,
    details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
    data_origin text NOT NULL DEFAULT 'simulated' CHECK (data_origin = 'simulated'),
    simulation jsonb NOT NULL CHECK (jsonb_typeof(simulation) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX medical_orders_session_status_idx ON medical_orders(session_id, status);

CREATE TABLE bills (
    bill_id text PRIMARY KEY CHECK (bill_id ~ '^bill-[a-zA-Z0-9-]+$'),
    session_id text NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    patient_id text NOT NULL REFERENCES anonymous_patients(patient_id) ON DELETE CASCADE,
    total_amount numeric(12,2) NOT NULL CHECK (total_amount >= 0),
    insurance_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (insurance_amount >= 0),
    personal_amount numeric(12,2) NOT NULL CHECK (personal_amount >= 0),
    currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
    status text NOT NULL CHECK (status IN ('UNPAID','PENDING_CONFIRMATION','PAYMENT_PENDING','PAID','PAYMENT_FAILED','PAYMENT_UNKNOWN','REFUND_PENDING','REFUNDED','CANCELLED')),
    data_origin text NOT NULL DEFAULT 'simulated' CHECK (data_origin = 'simulated'),
    simulation jsonb NOT NULL CHECK (jsonb_typeof(simulation) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (total_amount = insurance_amount + personal_amount)
);

CREATE INDEX bills_session_status_idx ON bills(session_id, status);

CREATE TABLE bill_items (
    item_id text PRIMARY KEY CHECK (item_id ~ '^bill-item-[a-zA-Z0-9-]+$'),
    bill_id text NOT NULL REFERENCES bills(bill_id) ON DELETE CASCADE,
    name text NOT NULL,
    amount numeric(12,2) NOT NULL CHECK (amount >= 0)
);

CREATE TABLE bill_related_entities (
    bill_id text NOT NULL REFERENCES bills(bill_id) ON DELETE CASCADE,
    entity_id text NOT NULL,
    PRIMARY KEY (bill_id, entity_id)
);

CREATE TABLE payment_attempts (
    payment_attempt_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    bill_id text NOT NULL REFERENCES bills(bill_id) ON DELETE CASCADE,
    idempotency_key text NOT NULL UNIQUE CHECK (char_length(idempotency_key) >= 8),
    status text NOT NULL CHECK (status IN ('PENDING','SUCCEEDED','FAILED','UNKNOWN','REFUNDED')),
    amount numeric(12,2) NOT NULL CHECK (amount >= 0),
    provider_reference text,
    error_details jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE journey_tasks (
    task_id text PRIMARY KEY CHECK (task_id ~ '^task-[a-zA-Z0-9-]+$'),
    session_id text NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    task_type text NOT NULL CHECK (task_type IN ('DEPARTMENT_SELECTION','APPOINTMENT','PAYMENT','CHECK_IN','WAITING','CONSULTATION','EXAMINATION','RETURN_VISIT','PHARMACY','LOCATION','HUMAN_HELP')),
    title text NOT NULL,
    status text NOT NULL CHECK (status IN ('PENDING','BLOCKED','IN_PROGRESS','COMPLETED','CANCELLED','FAILED')),
    related_entity_type text,
    related_entity_id text,
    location_id text REFERENCES locations(location_id),
    data_origin text NOT NULL CHECK (data_origin IN ('official_public','map_data','project_curated','simulated','user_provided','agent_inferred','hospital_runtime')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX journey_tasks_session_status_idx ON journey_tasks(session_id, status);

CREATE TABLE task_dependencies (
    task_id text NOT NULL REFERENCES journey_tasks(task_id) ON DELETE CASCADE,
    depends_on_task_id text NOT NULL REFERENCES journey_tasks(task_id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, depends_on_task_id),
    CHECK (task_id <> depends_on_task_id)
);

CREATE TABLE pending_actions (
    action_id text PRIMARY KEY CHECK (action_id ~ '^action-[a-zA-Z0-9-]+$'),
    session_id text NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    action_type text NOT NULL CHECK (action_type IN ('CREATE_APPOINTMENT','CANCEL_APPOINTMENT','CHANGE_APPOINTMENT','PAY_BILL','REQUEST_REFUND')),
    status text NOT NULL CHECK (status IN ('PENDING_CONFIRMATION','CONFIRMED','REJECTED','EXECUTED','EXPIRED')),
    summary text,
    parameters jsonb NOT NULL CHECK (jsonb_typeof(parameters) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    executed_at timestamptz,
    CHECK (expires_at >= created_at)
);

CREATE INDEX pending_actions_session_status_idx ON pending_actions(session_id, status);
CREATE INDEX pending_actions_expiry_idx ON pending_actions(expires_at);

CREATE TABLE tool_executions (
    tool_call_id text PRIMARY KEY CHECK (tool_call_id ~ '^tool-call-[a-zA-Z0-9-]+$'),
    session_id text NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    turn_id text REFERENCES conversation_turns(turn_id) ON DELETE SET NULL,
    action_id text REFERENCES pending_actions(action_id) ON DELETE SET NULL,
    tool_name text NOT NULL,
    parameters jsonb NOT NULL CHECK (jsonb_typeof(parameters) = 'object'),
    request_source text NOT NULL CHECK (request_source IN ('agent_orchestrator','user_interface','simulator_console')),
    user_confirmed boolean,
    idempotency_key text UNIQUE,
    success boolean,
    result_data jsonb,
    state_patch jsonb,
    next_suggested_actions jsonb,
    data_origin text CHECK (data_origin IN ('official_public','map_data','project_curated','simulated','user_provided','agent_inferred','hospital_runtime')),
    user_message text,
    error_details jsonb,
    requested_at timestamptz NOT NULL,
    executed_at timestamptz
);

CREATE INDEX tool_executions_session_requested_idx ON tool_executions(session_id, requested_at);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_72_hour_retention()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.expires_at := NEW.last_active_at + interval '72 hours';
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION cleanup_expired_demo_data()
RETURNS TABLE(expired_sessions bigint, expired_patients bigint)
LANGUAGE plpgsql AS $$
DECLARE
    session_count bigint;
    patient_count bigint;
BEGIN
    DELETE FROM sessions WHERE expires_at <= now();
    GET DIAGNOSTICS session_count = ROW_COUNT;

    DELETE FROM anonymous_patients p
    WHERE p.expires_at <= now()
       OR NOT EXISTS (SELECT 1 FROM sessions s WHERE s.patient_id = p.patient_id);
    GET DIAGNOSTICS patient_count = ROW_COUNT;

    RETURN QUERY SELECT session_count, patient_count;
END;
$$;

CREATE TRIGGER hospitals_touch_updated_at BEFORE UPDATE ON hospitals FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER departments_touch_updated_at BEFORE UPDATE ON departments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER doctors_touch_updated_at BEFORE UPDATE ON doctors FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER locations_touch_updated_at BEFORE UPDATE ON locations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER slots_touch_updated_at BEFORE UPDATE ON appointment_slots FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER appointments_touch_updated_at BEFORE UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER orders_touch_updated_at BEFORE UPDATE ON medical_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER bills_touch_updated_at BEFORE UPDATE ON bills FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER payments_touch_updated_at BEFORE UPDATE ON payment_attempts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tasks_touch_updated_at BEFORE UPDATE ON journey_tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER patients_retention BEFORE INSERT OR UPDATE OF last_active_at ON anonymous_patients FOR EACH ROW EXECUTE FUNCTION enforce_72_hour_retention();
CREATE TRIGGER sessions_retention BEFORE INSERT OR UPDATE OF last_active_at ON sessions FOR EACH ROW EXECUTE FUNCTION enforce_72_hour_retention();

INSERT INTO schema_migrations(version) VALUES ('001_initial');

COMMIT;
