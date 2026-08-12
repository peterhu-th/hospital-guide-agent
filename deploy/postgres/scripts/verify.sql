\set ON_ERROR_STOP on

SELECT current_user, current_database(), current_setting('server_version') AS server_version;

SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole
FROM pg_roles
WHERE rolname IN ('postgres', 'hospital_app')
ORDER BY rolname;

SELECT count(*) AS app_table_count
FROM information_schema.tables
WHERE table_schema = 'app'
  AND table_type = 'BASE TABLE';

TABLE app.schema_migrations;

SELECT tablename, tableowner
FROM pg_tables
WHERE schemaname = 'app'
ORDER BY tablename;

DO $$
DECLARE
    missing_tables text[];
    forbidden_tables text[];
BEGIN
    SELECT array_agg(required_table ORDER BY required_table)
    INTO missing_tables
    FROM unnest(ARRAY[
        'patient_profiles', 'patient_sessions', 'doctors', 'doctor_accounts',
        'doctor_auth_sessions', 'doctor_practices', 'appointment_slots',
        'appointments', 'clinical_encounters', 'medical_records',
        'medical_record_statements', 'medical_record_versions', 'audit_events',
        'medical_orders', 'simulation_manifest', 'simulated_results', 'bills'
    ]) AS required_table
    WHERE to_regclass('app.' || required_table) IS NULL;

    IF missing_tables IS NOT NULL THEN
        RAISE EXCEPTION 'Missing current business tables: %', missing_tables;
    END IF;

    SELECT array_agg(forbidden_table ORDER BY forbidden_table)
    INTO forbidden_tables
    FROM unnest(ARRAY['anonymous_patients', 'payment_attempts']) AS forbidden_table
    WHERE to_regclass('app.' || forbidden_table) IS NOT NULL;

    IF forbidden_tables IS NOT NULL THEN
        RAISE EXCEPTION 'Legacy/unsupported tables still exist: %', forbidden_tables;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM app.schema_migrations
        WHERE version = '002_current_business_model'
    ) THEN
        RAISE EXCEPTION 'Migration 002_current_business_model is missing';
    END IF;
END;
$$;

BEGIN;
INSERT INTO app.patient_profiles(
    patient_id,
    full_name_ciphertext,
    full_name_masked,
    identity_number_ciphertext,
    identity_number_digest,
    identity_number_last4,
    sex,
    age,
    birth_date,
    last_active_at
) VALUES (
    'patient-retention-test',
    decode(repeat('01', 17), 'hex'),
    '测**',
    decode(repeat('02', 17), 'hex'),
    decode(repeat('03', 32), 'hex'),
    '001X',
    'male',
    30,
    DATE '1996-01-01',
    TIMESTAMPTZ '2026-08-12 12:00:00+00'
);

SELECT expires_at = last_active_at + interval '72 hours' AS retention_ok
FROM app.patient_profiles
WHERE patient_id = 'patient-retention-test';
ROLLBACK;

SELECT count(*) = 6 AS simulation_manifest_ok
FROM app.simulation_manifest
WHERE active;
