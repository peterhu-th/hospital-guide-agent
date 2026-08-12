BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SET search_path TO app, public;

SELECT pg_advisory_xact_lock(hashtext('hospital-guide-schema-migration'));

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '002_current_business_model') THEN
        RAISE EXCEPTION '002_current_business_model must be applied before 003_doctor_employee_number_login';
    END IF;

    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '003_doctor_employee_number_login') THEN
        RAISE EXCEPTION '003_doctor_employee_number_login has already been applied';
    END IF;

    IF EXISTS (SELECT 1 FROM doctors WHERE employee_number !~ '^[0-9]{6}$') THEN
        RAISE EXCEPTION 'Existing doctor employee numbers must be converted to six digits before this migration';
    END IF;
END;
$$;

-- Employee number is the sole doctor login identifier. Keep the password and
-- account state in doctor_accounts, while the unique six-digit number remains
-- on the hospital-scoped doctor profile.
ALTER TABLE doctors
    DROP CONSTRAINT IF EXISTS doctors_employee_number_check,
    ADD CONSTRAINT doctors_employee_number_check CHECK (employee_number ~ '^[0-9]{6}$');

ALTER TABLE doctor_accounts
    DROP COLUMN login_name_normalized,
    DROP COLUMN login_name;

INSERT INTO schema_migrations(version) VALUES ('003_doctor_employee_number_login');

COMMIT;
