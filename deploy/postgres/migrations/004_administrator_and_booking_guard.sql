BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SET search_path TO app, public;
SELECT pg_advisory_xact_lock(hashtext('hospital-guide-schema-migration'));

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '003_doctor_employee_number_login') THEN
        RAISE EXCEPTION '003_doctor_employee_number_login must be applied first';
    END IF;
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '004_administrator_and_booking_guard') THEN
        RAISE EXCEPTION '004_administrator_and_booking_guard has already been applied';
    END IF;
END;
$$;

CREATE TABLE administrators (
    administrator_id text PRIMARY KEY,
    employee_number text NOT NULL UNIQUE CHECK (employee_number ~ '^[0-9]{6}$'),
    display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 2 AND 50),
    password_hash text NOT NULL CHECK (char_length(password_hash) >= 20),
    account_status text NOT NULL DEFAULT 'ACTIVE' CHECK (account_status IN ('ACTIVE','SUSPENDED')),
    failed_login_count integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
    locked_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE administrator_sessions (
    session_id text PRIMARY KEY,
    administrator_id text NOT NULL REFERENCES administrators(administrator_id) ON DELETE CASCADE,
    token_hash bytea NOT NULL UNIQUE,
    csrf_hash bytea NOT NULL,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    CHECK (expires_at > created_at)
);
CREATE INDEX administrator_sessions_active_idx ON administrator_sessions(administrator_id, expires_at) WHERE revoked_at IS NULL;

INSERT INTO schema_migrations(version) VALUES ('004_administrator_and_booking_guard');
COMMIT;
