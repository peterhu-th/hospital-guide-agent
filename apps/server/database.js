import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const schema = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS departments(
  department_id TEXT PRIMARY KEY, name TEXT NOT NULL, display_name TEXT NOT NULL,
  division TEXT, summary TEXT, aliases_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS patient_sessions(
  session_id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, patient_id TEXT,
  current_stage TEXT NOT NULL DEFAULT 'PRE_VISIT', created_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS patient_profiles(
  patient_id TEXT PRIMARY KEY, full_name_encrypted TEXT NOT NULL, full_name_masked TEXT NOT NULL,
  identity_encrypted TEXT NOT NULL, identity_digest TEXT NOT NULL, identity_masked TEXT NOT NULL,
  sex TEXT NOT NULL, age INTEGER NOT NULL, birth_date TEXT NOT NULL,
  verification_status TEXT NOT NULL, manually_entered INTEGER NOT NULL CHECK(manually_entered=1),
  created_at TEXT NOT NULL, last_active_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_patient_expiry ON patient_profiles(expires_at);
CREATE TABLE IF NOT EXISTS conversation_turns(
  turn_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES patient_sessions(session_id) ON DELETE CASCADE,
  role TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS doctors(
  doctor_id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
  employee_number TEXT UNIQUE NOT NULL CHECK(employee_number GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]' AND length(employee_number)=6),
  password_hash TEXT NOT NULL,
  contact_encrypted TEXT, account_status TEXT NOT NULL, verification_notice TEXT NOT NULL,
  failed_login_count INTEGER NOT NULL DEFAULT 0, locked_until TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS doctor_sessions(
  session_id TEXT PRIMARY KEY, doctor_id TEXT NOT NULL REFERENCES doctors(doctor_id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL, csrf_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL, revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS administrators(
  administrator_id TEXT PRIMARY KEY, employee_number TEXT UNIQUE NOT NULL
    CHECK(employee_number GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]' AND length(employee_number)=6),
  display_name TEXT NOT NULL, password_hash TEXT NOT NULL, account_status TEXT NOT NULL DEFAULT 'ACTIVE',
  failed_login_count INTEGER NOT NULL DEFAULT 0, locked_until TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS administrator_sessions(
  session_id TEXT PRIMARY KEY, administrator_id TEXT NOT NULL REFERENCES administrators(administrator_id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL, csrf_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL, revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS doctor_practices(
  practice_id TEXT PRIMARY KEY, doctor_id TEXT NOT NULL REFERENCES doctors(doctor_id) ON DELETE CASCADE,
  department_id TEXT NOT NULL REFERENCES departments(department_id), service_date TEXT NOT NULL,
  start_time TEXT NOT NULL, end_time TEXT NOT NULL, capacity INTEGER NOT NULL,
  booked_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(doctor_id, department_id, service_date, start_time, end_time)
);
CREATE INDEX IF NOT EXISTS idx_practice_lookup ON doctor_practices(department_id, service_date, status);
CREATE TABLE IF NOT EXISTS appointments(
  appointment_id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patient_profiles(patient_id) ON DELETE CASCADE,
  practice_id TEXT NOT NULL REFERENCES doctor_practices(practice_id), doctor_id TEXT NOT NULL,
  department_id TEXT NOT NULL, status TEXT NOT NULL, queue_number INTEGER,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS medical_records(
  record_id TEXT PRIMARY KEY, appointment_id TEXT UNIQUE NOT NULL REFERENCES appointments(appointment_id) ON DELETE CASCADE,
  patient_id TEXT NOT NULL, doctor_id TEXT NOT NULL, department_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, doctor_content_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS patient_statements(
  statement_id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES medical_records(record_id) ON DELETE CASCADE,
  source_turn_id TEXT NOT NULL, patient_words TEXT NOT NULL, normalized_value TEXT,
  category TEXT NOT NULL, certainty TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(record_id, source_turn_id)
);
CREATE TABLE IF NOT EXISTS medical_record_versions(
  version_id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES medical_records(record_id) ON DELETE CASCADE,
  version INTEGER NOT NULL, content_json TEXT NOT NULL, changed_by TEXT NOT NULL,
  change_reason TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(record_id, version)
);
CREATE TABLE IF NOT EXISTS medical_orders(
  order_id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES medical_records(record_id) ON DELETE CASCADE,
  doctor_id TEXT NOT NULL, order_type TEXT NOT NULL, title TEXT NOT NULL, details TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bills(
  bill_id TEXT PRIMARY KEY, appointment_id TEXT NOT NULL REFERENCES appointments(appointment_id) ON DELETE CASCADE,
  order_id TEXT REFERENCES medical_orders(order_id) ON DELETE CASCADE, amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status='UNPAID'), guidance TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS journey_tasks(
  task_id TEXT PRIMARY KEY, appointment_id TEXT NOT NULL REFERENCES appointments(appointment_id) ON DELETE CASCADE,
  task_type TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(appointment_id, task_type, title)
);
CREATE TABLE IF NOT EXISTS pending_actions(
  action_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES patient_sessions(session_id) ON DELETE CASCADE,
  action_type TEXT NOT NULL, parameters_json TEXT NOT NULL, summary TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PENDING','CONFIRMED','CANCELLED','EXPIRED')),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, confirmed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_actions_session ON pending_actions(session_id,status,expires_at);
CREATE TABLE IF NOT EXISTS audit_events(
  audit_id TEXT PRIMARY KEY, actor_type TEXT NOT NULL, actor_id TEXT,
  action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS simulated_results(
  result_id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES medical_orders(order_id) ON DELETE CASCADE,
  object_type TEXT NOT NULL, content_json TEXT NOT NULL, required_label TEXT NOT NULL,
  simulated INTEGER NOT NULL CHECK(simulated=1), created_at TEXT NOT NULL
);
`;

export class SqliteDatabase {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(schema);
  }
  run(sql, params = {}) { const statement = this.db.prepare(sql); return Array.isArray(params) ? statement.run(...params) : statement.run(params); }
  get(sql, params = {}) { const statement = this.db.prepare(sql); return Array.isArray(params) ? statement.get(...params) : statement.get(params); }
  all(sql, params = {}) { const statement = this.db.prepare(sql); return Array.isArray(params) ? statement.all(...params) : statement.all(params); }
  exec(sql) { return this.db.exec(sql); }
  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = callback(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  get engine() { return "sqlite"; }
  close() { this.db.close(); }
}
