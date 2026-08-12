BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SET search_path TO app, public;

SELECT pg_advisory_xact_lock(hashtext('hospital-guide-schema-migration'));

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '001_initial') THEN
        RAISE EXCEPTION '001_initial must be applied before 002_current_business_model';
    END IF;

    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '002_current_business_model') THEN
        RAISE EXCEPTION '002_current_business_model has already been applied';
    END IF;

    IF (SELECT count(*) FROM doctors) <> 0
       OR (SELECT count(*) FROM appointment_slots) <> 0
       OR (SELECT count(*) FROM anonymous_patients) <> 0
       OR (SELECT count(*) FROM sessions) <> 0
       OR (SELECT count(*) FROM appointments) <> 0
       OR (SELECT count(*) FROM medical_orders) <> 0
       OR (SELECT count(*) FROM bills) <> 0 THEN
        RAISE EXCEPTION
            'Legacy business tables contain rows. Export and explicitly classify them before migration; simulated rows must not be promoted to hospital runtime records.';
    END IF;
END;
$$;

-- The legacy business model represented anonymous patients and simulated
-- doctors/appointments. The database is empty, so replace those objects while
-- retaining the official hospital, department, and map knowledge tables.
DROP TABLE IF EXISTS tool_executions CASCADE;
DROP TABLE IF EXISTS pending_actions CASCADE;
DROP TABLE IF EXISTS task_dependencies CASCADE;
DROP TABLE IF EXISTS journey_tasks CASCADE;
DROP TABLE IF EXISTS payment_attempts CASCADE;
DROP TABLE IF EXISTS bill_related_entities CASCADE;
DROP TABLE IF EXISTS bill_items CASCADE;
DROP TABLE IF EXISTS bills CASCADE;
DROP TABLE IF EXISTS medical_orders CASCADE;
DROP TABLE IF EXISTS appointments CASCADE;
DROP TABLE IF EXISTS department_routing_runs CASCADE;
DROP TABLE IF EXISTS agent_events CASCADE;
DROP TABLE IF EXISTS session_facts CASCADE;
DROP TABLE IF EXISTS conversation_turns CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;
DROP TABLE IF EXISTS anonymous_patients CASCADE;
DROP TABLE IF EXISTS appointment_slots CASCADE;
DROP TABLE IF EXISTS doctor_departments CASCADE;
DROP TABLE IF EXISTS doctors CASCADE;

DROP FUNCTION IF EXISTS cleanup_expired_demo_data();
DROP FUNCTION IF EXISTS enforce_72_hour_retention();

ALTER TABLE departments
    ADD COLUMN IF NOT EXISTS display_name text,
    ADD COLUMN IF NOT EXISTS official_summary text,
    ADD COLUMN IF NOT EXISTS official_summary_availability text;

UPDATE departments
SET display_name = COALESCE(display_name, name),
    official_summary_availability = COALESCE(
        official_summary_availability,
        CASE WHEN official_summary IS NULL THEN 'not_published' ELSE 'available' END
    );

ALTER TABLE departments
    ALTER COLUMN display_name SET NOT NULL,
    ALTER COLUMN official_summary_availability SET NOT NULL,
    ADD CONSTRAINT departments_official_summary_availability_check
        CHECK (official_summary_availability IN ('available', 'not_published')),
    ADD CONSTRAINT departments_official_summary_consistency_check
        CHECK (
            (official_summary_availability = 'available' AND official_summary IS NOT NULL)
            OR (official_summary_availability = 'not_published' AND official_summary IS NULL)
        );

CREATE TABLE doctors (
    doctor_id text PRIMARY KEY CHECK (doctor_id ~ '^doctor-[a-z0-9]+(-[a-z0-9]+)*$'),
    hospital_id text NOT NULL REFERENCES hospitals(hospital_id) ON DELETE RESTRICT,
    display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 100),
    employee_number text NOT NULL CHECK (char_length(employee_number) BETWEEN 1 AND 64),
    professional_title text,
    contact jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(contact) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (hospital_id, employee_number)
);

CREATE TABLE doctor_accounts (
    doctor_account_id text PRIMARY KEY CHECK (doctor_account_id ~ '^doctor-account-[a-z0-9]+(-[a-z0-9]+)*$'),
    doctor_id text NOT NULL UNIQUE REFERENCES doctors(doctor_id) ON DELETE CASCADE,
    login_name text NOT NULL CHECK (char_length(login_name) BETWEEN 3 AND 64),
    login_name_normalized text GENERATED ALWAYS AS (lower(login_name)) STORED,
    password_hash text NOT NULL CHECK (char_length(password_hash) >= 20),
    status text NOT NULL DEFAULT 'PENDING_REVIEW'
        CHECK (status IN ('PENDING_REVIEW', 'ACTIVE', 'SUSPENDED')),
    verification_notice text NOT NULL DEFAULT '系统内账号申请，未接入医院人事系统核验',
    failed_login_count integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
    locked_until timestamptz,
    password_changed_at timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (login_name_normalized)
);

CREATE TABLE doctor_auth_sessions (
    auth_session_id text PRIMARY KEY CHECK (auth_session_id ~ '^doctor-session-[a-zA-Z0-9-]+$'),
    doctor_account_id text NOT NULL REFERENCES doctor_accounts(doctor_account_id) ON DELETE CASCADE,
    session_token_hash bytea NOT NULL UNIQUE CHECK (octet_length(session_token_hash) >= 32),
    csrf_token_hash bytea NOT NULL CHECK (octet_length(csrf_token_hash) >= 32),
    ip_address inet,
    user_agent text,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_active_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    CHECK (expires_at > created_at),
    CHECK (last_active_at >= created_at),
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX doctor_auth_sessions_account_idx
    ON doctor_auth_sessions(doctor_account_id, expires_at)
    WHERE revoked_at IS NULL;

CREATE TABLE doctor_practices (
    practice_id text PRIMARY KEY CHECK (practice_id ~ '^practice-[a-z0-9]+(-[a-z0-9]+)*$'),
    doctor_id text NOT NULL REFERENCES doctors(doctor_id) ON DELETE CASCADE,
    department_id text NOT NULL REFERENCES departments(department_id) ON DELETE RESTRICT,
    status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
    valid_from date NOT NULL DEFAULT CURRENT_DATE,
    valid_until date,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (valid_until IS NULL OR valid_until >= valid_from),
    UNIQUE (practice_id, doctor_id, department_id)
);

CREATE UNIQUE INDEX doctor_practices_current_unique_idx
    ON doctor_practices(doctor_id, department_id)
    WHERE valid_until IS NULL;

CREATE TABLE appointment_slots (
    slot_id text PRIMARY KEY CHECK (slot_id ~ '^slot-[a-z0-9]+(-[a-z0-9]+)*$'),
    practice_id text NOT NULL,
    doctor_id text NOT NULL,
    department_id text NOT NULL,
    slot_date date NOT NULL,
    period text NOT NULL CHECK (period IN ('上午', '下午')),
    start_time time NOT NULL,
    end_time time NOT NULL,
    status text NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT', 'AVAILABLE', 'FULL', 'EXPIRED', 'SUSPENDED')),
    capacity integer NOT NULL CHECK (capacity > 0),
    booked_count integer NOT NULL DEFAULT 0 CHECK (booked_count >= 0),
    fee_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (fee_amount >= 0),
    currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (end_time > start_time),
    CHECK (booked_count <= capacity),
    FOREIGN KEY (practice_id, doctor_id, department_id)
        REFERENCES doctor_practices(practice_id, doctor_id, department_id) ON DELETE RESTRICT,
    UNIQUE (slot_id, doctor_id, department_id)
);

CREATE INDEX appointment_slots_lookup_idx
    ON appointment_slots(department_id, slot_date, period, status);

CREATE TABLE patient_profiles (
    patient_id text PRIMARY KEY CHECK (patient_id ~ '^patient-[a-z0-9]+(-[a-z0-9]+)*$'),
    full_name_ciphertext bytea NOT NULL CHECK (octet_length(full_name_ciphertext) > 16),
    full_name_masked text NOT NULL CHECK (char_length(full_name_masked) BETWEEN 1 AND 100),
    identity_number_ciphertext bytea NOT NULL CHECK (octet_length(identity_number_ciphertext) > 16),
    identity_number_digest bytea NOT NULL CHECK (octet_length(identity_number_digest) >= 32),
    identity_number_last4 char(4) NOT NULL CHECK (identity_number_last4 ~ '^[0-9Xx]{4}$'),
    sex text NOT NULL CHECK (sex IN ('female', 'male', 'other')),
    age smallint NOT NULL CHECK (age BETWEEN 0 AND 130),
    birth_date date NOT NULL,
    verification_status text NOT NULL DEFAULT 'SELF_DECLARED'
        CHECK (verification_status = 'SELF_DECLARED'),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_active_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '72 hours'),
    CHECK (expires_at = last_active_at + interval '72 hours')
);

CREATE INDEX patient_profiles_identity_digest_idx ON patient_profiles(identity_number_digest);
CREATE INDEX patient_profiles_expiry_idx ON patient_profiles(expires_at);

CREATE TABLE patient_sessions (
    session_id text PRIMARY KEY CHECK (session_id ~ '^session-[a-zA-Z0-9-]+$'),
    patient_id text REFERENCES patient_profiles(patient_id) ON DELETE CASCADE,
    session_token_hash bytea NOT NULL UNIQUE CHECK (octet_length(session_token_hash) >= 32),
    schema_version text NOT NULL DEFAULT '2.0.0',
    revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
    current_stage text NOT NULL DEFAULT 'UNKNOWN'
        CHECK (current_stage IN ('UNKNOWN','PRE_VISIT','APPOINTMENT','ARRIVAL','CHECK_IN','WAITING','CONSULTATION','AFTER_CONSULTATION','PAYMENT','EXAMINATION','RETURN_VISIT','PHARMACY','COMPLETED')),
    user_role text NOT NULL DEFAULT 'patient' CHECK (user_role IN ('patient', 'family')),
    conversation_summary text NOT NULL DEFAULT '',
    state_snapshot jsonb CHECK (state_snapshot IS NULL OR jsonb_typeof(state_snapshot) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_active_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '72 hours'),
    revoked_at timestamptz,
    CHECK (expires_at = last_active_at + interval '72 hours'),
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX patient_sessions_patient_idx ON patient_sessions(patient_id);
CREATE INDEX patient_sessions_expiry_idx ON patient_sessions(expires_at);

CREATE TABLE conversation_turns (
    turn_id text PRIMARY KEY CHECK (turn_id ~ '^turn-[a-zA-Z0-9-]+$'),
    session_id text NOT NULL REFERENCES patient_sessions(session_id) ON DELETE CASCADE,
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

CREATE INDEX conversation_turns_session_created_idx
    ON conversation_turns(session_id, created_at);

CREATE TABLE session_facts (
    fact_id text PRIMARY KEY CHECK (fact_id ~ '^fact-[a-zA-Z0-9-]+$'),
    session_id text NOT NULL REFERENCES patient_sessions(session_id) ON DELETE CASCADE,
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
    session_id text REFERENCES patient_sessions(session_id) ON DELETE SET NULL,
    patient_id text NOT NULL REFERENCES patient_profiles(patient_id) ON DELETE CASCADE,
    slot_id text NOT NULL,
    doctor_id text NOT NULL,
    department_id text NOT NULL,
    status text NOT NULL DEFAULT 'PENDING_CONFIRMATION'
        CHECK (status IN ('DRAFT','PENDING_CONFIRMATION','BOOKED','CHECKED_IN','WAITING','CONSULTING','COMPLETED','CANCELLED','DOCTOR_SUSPENDED','MISSED')),
    billing_status text NOT NULL DEFAULT 'UNBILLED'
        CHECK (billing_status IN ('UNBILLED', 'NOT_REQUIRED', 'UNPAID')),
    check_in_status text NOT NULL DEFAULT 'NOT_CHECKED_IN'
        CHECK (check_in_status IN ('NOT_CHECKED_IN','TOO_EARLY','CHECKED_IN','MISSED')),
    queue_details jsonb CHECK (queue_details IS NULL OR jsonb_typeof(queue_details) = 'object'),
    cancelled_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (slot_id, doctor_id, department_id)
        REFERENCES appointment_slots(slot_id, doctor_id, department_id) ON DELETE RESTRICT,
    UNIQUE (appointment_id, patient_id, doctor_id, department_id)
);

CREATE INDEX appointments_patient_status_idx ON appointments(patient_id, status);
CREATE INDEX appointments_doctor_status_idx ON appointments(doctor_id, status, created_at);

CREATE TABLE clinical_encounters (
    encounter_id text PRIMARY KEY CHECK (encounter_id ~ '^encounter-[a-zA-Z0-9-]+$'),
    appointment_id text UNIQUE,
    patient_id text NOT NULL REFERENCES patient_profiles(patient_id) ON DELETE CASCADE,
    doctor_id text NOT NULL REFERENCES doctors(doctor_id) ON DELETE RESTRICT,
    department_id text NOT NULL REFERENCES departments(department_id) ON DELETE RESTRICT,
    status text NOT NULL DEFAULT 'PLANNED'
        CHECK (status IN ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
    started_at timestamptz,
    ended_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at),
    FOREIGN KEY (appointment_id, patient_id, doctor_id, department_id)
        REFERENCES appointments(appointment_id, patient_id, doctor_id, department_id) ON DELETE RESTRICT,
    UNIQUE (encounter_id, patient_id),
    UNIQUE (encounter_id, patient_id, doctor_id)
);

CREATE INDEX clinical_encounters_doctor_idx ON clinical_encounters(doctor_id, status);
CREATE INDEX clinical_encounters_patient_idx ON clinical_encounters(patient_id, created_at);

CREATE TABLE medical_records (
    record_id text PRIMARY KEY CHECK (record_id ~ '^record-[a-zA-Z0-9-]+$'),
    encounter_id text NOT NULL UNIQUE,
    patient_id text NOT NULL REFERENCES patient_profiles(patient_id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'SIGNED', 'CLOSED')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (encounter_id, patient_id)
        REFERENCES clinical_encounters(encounter_id, patient_id) ON DELETE CASCADE
);

CREATE TABLE medical_record_statements (
    statement_id text PRIMARY KEY CHECK (statement_id ~ '^statement-[a-zA-Z0-9-]+$'),
    record_id text NOT NULL REFERENCES medical_records(record_id) ON DELETE CASCADE,
    source_turn_id text REFERENCES conversation_turns(turn_id) ON DELETE SET NULL,
    raw_text text NOT NULL CHECK (char_length(raw_text) BETWEEN 1 AND 4000),
    stated_by text NOT NULL CHECK (stated_by IN ('PATIENT', 'FAMILY')),
    certainty text NOT NULL CHECK (certainty IN ('ASSERTED', 'UNCERTAIN', 'DENIED', 'UNKNOWN')),
    normalized_content jsonb CHECK (normalized_content IS NULL OR jsonb_typeof(normalized_content) = 'object'),
    normalization_model text,
    doctor_verified_by text REFERENCES doctors(doctor_id) ON DELETE SET NULL,
    doctor_verified_at timestamptz,
    stated_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((doctor_verified_by IS NULL) = (doctor_verified_at IS NULL))
);

CREATE INDEX medical_record_statements_record_idx
    ON medical_record_statements(record_id, stated_at);

CREATE TABLE medical_record_versions (
    record_version_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    record_id text NOT NULL REFERENCES medical_records(record_id) ON DELETE CASCADE,
    version_no integer NOT NULL CHECK (version_no > 0),
    content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
    author_type text NOT NULL CHECK (author_type IN ('AGENT', 'DOCTOR', 'SYSTEM')),
    author_doctor_id text REFERENCES doctors(doctor_id) ON DELETE SET NULL,
    change_reason text NOT NULL CHECK (char_length(change_reason) BETWEEN 1 AND 500),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (record_id, version_no),
    CHECK (
        (author_type = 'DOCTOR' AND author_doctor_id IS NOT NULL)
        OR (author_type <> 'DOCTOR' AND author_doctor_id IS NULL)
    )
);

CREATE TABLE medical_record_links (
    record_id text NOT NULL REFERENCES medical_records(record_id) ON DELETE CASCADE,
    entity_type text NOT NULL CHECK (entity_type IN ('APPOINTMENT', 'MEDICAL_ORDER', 'BILL')),
    entity_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (record_id, entity_type, entity_id)
);

CREATE TABLE medical_orders (
    order_id text PRIMARY KEY CHECK (order_id ~ '^order-[a-zA-Z0-9-]+$'),
    encounter_id text NOT NULL,
    patient_id text NOT NULL REFERENCES patient_profiles(patient_id) ON DELETE CASCADE,
    created_by_doctor_id text NOT NULL REFERENCES doctors(doctor_id) ON DELETE RESTRICT,
    order_type text NOT NULL CHECK (order_type IN ('EXAMINATION', 'PRESCRIPTION')),
    name text NOT NULL,
    performing_department_id text REFERENCES departments(department_id) ON DELETE RESTRICT,
    location_id text REFERENCES locations(location_id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'CREATED'
        CHECK (status IN ('CREATED','PENDING_PAYMENT','PENDING_APPOINTMENT','SCHEDULED','CHECKED_IN','IN_PROGRESS','COMPLETED','REPORT_READY','CANCELLED')),
    requires_payment boolean NOT NULL,
    requires_appointment boolean NOT NULL,
    preparation_text text,
    scheduled_for timestamptz,
    doctor_instructions jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(doctor_instructions) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (encounter_id, patient_id, created_by_doctor_id)
        REFERENCES clinical_encounters(encounter_id, patient_id, doctor_id) ON DELETE CASCADE
);

CREATE INDEX medical_orders_patient_status_idx ON medical_orders(patient_id, status);
CREATE INDEX medical_orders_doctor_idx ON medical_orders(created_by_doctor_id, created_at);

CREATE TABLE medical_order_items (
    order_item_id text PRIMARY KEY CHECK (order_item_id ~ '^order-item-[a-zA-Z0-9-]+$'),
    order_id text NOT NULL REFERENCES medical_orders(order_id) ON DELETE CASCADE,
    item_name text NOT NULL,
    dosage text,
    frequency text,
    duration text,
    instructions text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE simulation_manifest (
    simulation_type text PRIMARY KEY
        CHECK (simulation_type IN ('IMAGING_FILE','EXAMINATION_REPORT','LAB_RESULT','PHARMACY_INVENTORY','DISPENSING_RESULT','DEVICE_VITAL_SIGN')),
    display_name text NOT NULL,
    unavailable_integration text NOT NULL,
    required_notice text NOT NULL,
    prohibited_claim text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE simulated_results (
    simulated_result_id text PRIMARY KEY CHECK (simulated_result_id ~ '^simulated-result-[a-zA-Z0-9-]+$'),
    order_id text NOT NULL REFERENCES medical_orders(order_id) ON DELETE CASCADE,
    simulation_type text NOT NULL REFERENCES simulation_manifest(simulation_type) ON DELETE RESTRICT,
    generated_by_doctor_action boolean NOT NULL CHECK (generated_by_doctor_action),
    simulation_notice text NOT NULL CHECK (position('模拟生成' IN simulation_notice) > 0),
    content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
    generation_rule text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bills (
    bill_id text PRIMARY KEY CHECK (bill_id ~ '^bill-[a-zA-Z0-9-]+$'),
    patient_id text NOT NULL REFERENCES patient_profiles(patient_id) ON DELETE CASCADE,
    encounter_id text,
    total_amount numeric(12,2) NOT NULL CHECK (total_amount >= 0),
    insurance_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (insurance_amount >= 0),
    personal_amount numeric(12,2) NOT NULL CHECK (personal_amount >= 0),
    currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
    status text NOT NULL DEFAULT 'UNPAID' CHECK (status IN ('UNPAID', 'CANCELLED')),
    payment_guidance text NOT NULL DEFAULT '请前往收费窗口或医保部办理缴费',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (total_amount = insurance_amount + personal_amount),
    FOREIGN KEY (encounter_id, patient_id)
        REFERENCES clinical_encounters(encounter_id, patient_id) ON DELETE CASCADE
);

CREATE INDEX bills_patient_status_idx ON bills(patient_id, status);

CREATE TABLE bill_items (
    item_id text PRIMARY KEY CHECK (item_id ~ '^bill-item-[a-zA-Z0-9-]+$'),
    bill_id text NOT NULL REFERENCES bills(bill_id) ON DELETE CASCADE,
    name text NOT NULL,
    amount numeric(12,2) NOT NULL CHECK (amount >= 0)
);

CREATE TABLE bill_related_entities (
    bill_id text NOT NULL REFERENCES bills(bill_id) ON DELETE CASCADE,
    entity_type text NOT NULL CHECK (entity_type IN ('APPOINTMENT', 'MEDICAL_ORDER')),
    entity_id text NOT NULL,
    PRIMARY KEY (bill_id, entity_type, entity_id)
);

CREATE TABLE journey_tasks (
    task_id text PRIMARY KEY CHECK (task_id ~ '^task-[a-zA-Z0-9-]+$'),
    session_id text REFERENCES patient_sessions(session_id) ON DELETE CASCADE,
    patient_id text REFERENCES patient_profiles(patient_id) ON DELETE CASCADE,
    task_type text NOT NULL CHECK (task_type IN ('DEPARTMENT_SELECTION','APPOINTMENT','PAYMENT','CHECK_IN','WAITING','CONSULTATION','EXAMINATION','RETURN_VISIT','PHARMACY','LOCATION','HUMAN_HELP')),
    title text NOT NULL,
    status text NOT NULL CHECK (status IN ('PENDING','BLOCKED','IN_PROGRESS','COMPLETED','CANCELLED','FAILED')),
    related_entity_type text,
    related_entity_id text,
    location_id text REFERENCES locations(location_id) ON DELETE SET NULL,
    data_origin text NOT NULL CHECK (data_origin IN ('official_public','map_data','project_curated','user_provided','agent_inferred','hospital_runtime')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (session_id IS NOT NULL OR patient_id IS NOT NULL)
);

CREATE INDEX journey_tasks_patient_status_idx ON journey_tasks(patient_id, status);

CREATE TABLE task_dependencies (
    task_id text NOT NULL REFERENCES journey_tasks(task_id) ON DELETE CASCADE,
    depends_on_task_id text NOT NULL REFERENCES journey_tasks(task_id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, depends_on_task_id),
    CHECK (task_id <> depends_on_task_id)
);

CREATE TABLE pending_actions (
    action_id text PRIMARY KEY CHECK (action_id ~ '^action-[a-zA-Z0-9-]+$'),
    session_id text NOT NULL REFERENCES patient_sessions(session_id) ON DELETE CASCADE,
    action_type text NOT NULL CHECK (action_type IN ('CREATE_APPOINTMENT','CANCEL_APPOINTMENT','CHANGE_APPOINTMENT')),
    status text NOT NULL CHECK (status IN ('PENDING_CONFIRMATION','CONFIRMED','REJECTED','EXECUTED','EXPIRED')),
    summary text NOT NULL,
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
    session_id text REFERENCES patient_sessions(session_id) ON DELETE CASCADE,
    doctor_auth_session_id text REFERENCES doctor_auth_sessions(auth_session_id) ON DELETE SET NULL,
    turn_id text REFERENCES conversation_turns(turn_id) ON DELETE SET NULL,
    action_id text REFERENCES pending_actions(action_id) ON DELETE SET NULL,
    tool_name text NOT NULL,
    parameters jsonb NOT NULL CHECK (jsonb_typeof(parameters) = 'object'),
    request_source text NOT NULL CHECK (request_source IN ('agent_orchestrator','user_interface','doctor_workbench')),
    user_confirmed boolean,
    idempotency_key text UNIQUE,
    success boolean,
    result_data jsonb,
    state_patch jsonb,
    next_suggested_actions jsonb,
    data_origin text CHECK (data_origin IN ('official_public','map_data','project_curated','user_provided','agent_inferred','hospital_runtime')),
    user_message text,
    error_details jsonb,
    requested_at timestamptz NOT NULL,
    executed_at timestamptz,
    CHECK (session_id IS NOT NULL OR doctor_auth_session_id IS NOT NULL)
);

CREATE INDEX tool_executions_session_requested_idx
    ON tool_executions(session_id, requested_at);

CREATE TABLE audit_events (
    audit_event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_type text NOT NULL CHECK (actor_type IN ('PATIENT_SESSION','DOCTOR','AGENT','SYSTEM')),
    actor_id text NOT NULL,
    action text NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    patient_id text REFERENCES patient_profiles(patient_id) ON DELETE CASCADE,
    doctor_id text REFERENCES doctors(doctor_id) ON DELETE SET NULL,
    reason text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
    occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_entity_idx ON audit_events(entity_type, entity_id, occurred_at);
CREATE INDEX audit_events_patient_idx ON audit_events(patient_id, occurred_at);
CREATE INDEX audit_events_doctor_idx ON audit_events(doctor_id, occurred_at);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_patient_72_hour_retention()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.expires_at := NEW.last_active_at + interval '72 hours';
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION prevent_raw_statement_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.record_id IS DISTINCT FROM OLD.record_id
       OR NEW.source_turn_id IS DISTINCT FROM OLD.source_turn_id
       OR NEW.raw_text IS DISTINCT FROM OLD.raw_text
       OR NEW.stated_by IS DISTINCT FROM OLD.stated_by
       OR NEW.stated_at IS DISTINCT FROM OLD.stated_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Patient raw statement source fields are immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION touch_patient_retention(target_patient_id text)
RETURNS timestamptz LANGUAGE plpgsql AS $$
DECLARE
    new_expiry timestamptz;
BEGIN
    UPDATE patient_profiles
    SET last_active_at = now()
    WHERE patient_id = target_patient_id
    RETURNING expires_at INTO new_expiry;
    RETURN new_expiry;
END;
$$;

CREATE OR REPLACE FUNCTION cleanup_expired_patient_data()
RETURNS TABLE(expired_sessions bigint, expired_patients bigint)
LANGUAGE plpgsql AS $$
DECLARE
    session_count bigint;
    patient_count bigint;
BEGIN
    DELETE FROM patient_sessions WHERE expires_at <= now();
    GET DIAGNOSTICS session_count = ROW_COUNT;

    DELETE FROM patient_profiles WHERE expires_at <= now();
    GET DIAGNOSTICS patient_count = ROW_COUNT;

    RETURN QUERY SELECT session_count, patient_count;
END;
$$;

CREATE TRIGGER doctors_touch_updated_at
    BEFORE UPDATE ON doctors FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER doctor_accounts_touch_updated_at
    BEFORE UPDATE ON doctor_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER doctor_practices_touch_updated_at
    BEFORE UPDATE ON doctor_practices FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER slots_touch_updated_at
    BEFORE UPDATE ON appointment_slots FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER patients_retention
    BEFORE INSERT OR UPDATE OF last_active_at ON patient_profiles
    FOR EACH ROW EXECUTE FUNCTION enforce_patient_72_hour_retention();
CREATE TRIGGER patient_sessions_retention
    BEFORE INSERT OR UPDATE OF last_active_at ON patient_sessions
    FOR EACH ROW EXECUTE FUNCTION enforce_patient_72_hour_retention();
CREATE TRIGGER appointments_touch_updated_at
    BEFORE UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER encounters_touch_updated_at
    BEFORE UPDATE ON clinical_encounters FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER medical_records_touch_updated_at
    BEFORE UPDATE ON medical_records FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER statements_prevent_raw_mutation
    BEFORE UPDATE ON medical_record_statements
    FOR EACH ROW EXECUTE FUNCTION prevent_raw_statement_mutation();
CREATE TRIGGER orders_touch_updated_at
    BEFORE UPDATE ON medical_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER simulation_manifest_touch_updated_at
    BEFORE UPDATE ON simulation_manifest FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER bills_touch_updated_at
    BEFORE UPDATE ON bills FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tasks_touch_updated_at
    BEFORE UPDATE ON journey_tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO simulation_manifest(
    simulation_type,
    display_name,
    unavailable_integration,
    required_notice,
    prohibited_claim
) VALUES
    ('IMAGING_FILE', '影像文件', '未连接影像设备和 PACS', '模拟生成：仅为演示影像占位和元数据', '不得冒充真实患者影像或生成确定诊断'),
    ('EXAMINATION_REPORT', '检查报告', '未连接检查设备及报告系统', '模拟生成：仅用于演示检查流程', '不得当作真实检查结论自动写入医生判断'),
    ('LAB_RESULT', '检验结果', '未连接 LIS 和检验设备', '模拟生成：展示参考范围和生成规则', '不得冒充真实采样结果'),
    ('PHARMACY_INVENTORY', '药房库存', '未连接真实药房和库存系统', '模拟生成：仅展示药品卡和库存状态', '不得由 Agent 生成处方、剂量或用药建议'),
    ('DISPENSING_RESULT', '发药结果', '未连接真实发药设备', '模拟生成：仅展示发药流程状态', '不得宣称真实药品已经发放'),
    ('DEVICE_VITAL_SIGN', '设备生命体征', '未连接对应医疗设备', '模拟生成：仅为演示设备读数', '不得冒充患者真实测量值');

INSERT INTO schema_migrations(version) VALUES ('002_current_business_model');

COMMIT;
