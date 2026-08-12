DELETE FROM runtime.patient_profiles WHERE expires_at <= now();
DELETE FROM runtime.patient_sessions WHERE expires_at <= now() OR revoked_at IS NOT NULL;
DELETE FROM runtime.pending_actions WHERE expires_at <= now() AND status = 'PENDING';
DELETE FROM runtime.doctor_sessions WHERE expires_at <= now() OR revoked_at IS NOT NULL;
DELETE FROM runtime.administrator_sessions WHERE expires_at <= now() OR revoked_at IS NOT NULL;
