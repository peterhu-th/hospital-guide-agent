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
  sex TEXT NOT NULL CHECK(sex IN ('female','male')), age INTEGER NOT NULL, birth_date TEXT NOT NULL,
  verification_status TEXT NOT NULL, manually_entered INTEGER NOT NULL CHECK(manually_entered=1),
  created_at TEXT NOT NULL, last_active_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_patient_expiry ON patient_profiles(expires_at);
CREATE TABLE IF NOT EXISTS conversation_turns(
  turn_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES patient_sessions(session_id) ON DELETE CASCADE,
  role TEXT NOT NULL, message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 500), created_at TEXT NOT NULL,
  assistant_actions_json TEXT NOT NULL DEFAULT '[]', interaction_id TEXT NOT NULL,
  reply_to_turn_id TEXT REFERENCES conversation_turns(turn_id) ON DELETE SET NULL,
  turn_kind TEXT NOT NULL DEFAULT 'CHAT' CHECK(turn_kind IN ('CHAT','CONTROL','PROACTIVE')),
  turn_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(turn_status IN ('ACTIVE','UNDONE')),
  state_before_json TEXT, undone_at TEXT
);
CREATE TABLE IF NOT EXISTS proactive_agent_events(
  event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES patient_sessions(session_id) ON DELETE CASCADE,
  appointment_id TEXT NOT NULL REFERENCES appointments(appointment_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('WAITING_INTERVIEW','CALLED_NOTICE','POST_VISIT_GUIDANCE','RETURN_VISIT_READY','VISIT_COMPLETED')),
  created_at TEXT NOT NULL, UNIQUE(session_id,appointment_id,event_type)
);
CREATE TABLE IF NOT EXISTS doctors(
  doctor_id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
  employee_number TEXT UNIQUE NOT NULL CHECK(employee_number GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]' AND length(employee_number)=6),
  password_hash TEXT NOT NULL,
  account_status TEXT NOT NULL, verification_notice TEXT NOT NULL,
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
CREATE TABLE IF NOT EXISTS consultation_rounds(
  round_id TEXT PRIMARY KEY, appointment_id TEXT NOT NULL REFERENCES appointments(appointment_id) ON DELETE CASCADE,
  round_number INTEGER NOT NULL, round_type TEXT NOT NULL CHECK(round_type IN ('INITIAL','RETURN')),
  status TEXT NOT NULL CHECK(status IN ('SCHEDULED','WAITING','IN_CONSULTATION','COMPLETED','CANCELLED')),
  scheduled_at TEXT, started_at TEXT, completed_at TEXT,
  return_visit_required INTEGER CHECK(return_visit_required IN (0,1)), return_visit_at TEXT,
  created_at TEXT NOT NULL, UNIQUE(appointment_id,round_number)
);
CREATE TABLE IF NOT EXISTS medical_records(
  record_id TEXT PRIMARY KEY, appointment_id TEXT UNIQUE NOT NULL REFERENCES appointments(appointment_id) ON DELETE CASCADE,
  patient_id TEXT NOT NULL, doctor_id TEXT NOT NULL, department_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, doctor_content_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS patient_facts(
  fact_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES patient_sessions(session_id) ON DELETE CASCADE,
  record_id TEXT REFERENCES medical_records(record_id) ON DELETE CASCADE,
  source_turn_id TEXT NOT NULL,
  field TEXT NOT NULL,
  normalized_value TEXT NOT NULL CHECK(length(normalized_value) BETWEEN 1 AND 500),
  certainty TEXT NOT NULL CHECK(certainty IN ('PATIENT_CONFIRMED','UNCERTAIN','DENIED')),
  status TEXT NOT NULL CHECK(status IN ('CANDIDATE','CONFIRMED','REJECTED')),
  created_at TEXT NOT NULL, confirmed_at TEXT,
  UNIQUE(session_id,source_turn_id,field)
);
CREATE INDEX IF NOT EXISTS idx_patient_facts_record ON patient_facts(record_id,status,created_at);
CREATE TABLE IF NOT EXISTS conversation_workflow_states(
  session_id TEXT PRIMARY KEY REFERENCES patient_sessions(session_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0,
  active_task_type TEXT NOT NULL DEFAULT 'UNDERSTAND_REQUEST',
  active_task_status TEXT NOT NULL DEFAULT 'READY',
  pending_field TEXT,
  last_question TEXT,
  suspended_tasks_json TEXT NOT NULL DEFAULT '[]',
  recommended_departments_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS medical_record_versions(
  version_id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES medical_records(record_id) ON DELETE CASCADE,
  version INTEGER NOT NULL, content_json TEXT NOT NULL, changed_by TEXT NOT NULL,
  change_reason TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(record_id, version)
);
CREATE TABLE IF NOT EXISTS medical_orders(
  order_id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES medical_records(record_id) ON DELETE CASCADE,
  doctor_id TEXT NOT NULL, order_type TEXT NOT NULL, title TEXT NOT NULL, details TEXT NOT NULL,
  catalog_item_id TEXT, quantity INTEGER NOT NULL DEFAULT 1, location_id TEXT,
  data_origin TEXT NOT NULL DEFAULT 'hospital_runtime', consultation_round_id TEXT REFERENCES consultation_rounds(round_id),
  status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bills(
  bill_id TEXT PRIMARY KEY, appointment_id TEXT NOT NULL REFERENCES appointments(appointment_id) ON DELETE CASCADE,
  order_id TEXT REFERENCES medical_orders(order_id) ON DELETE CASCADE, amount_cents INTEGER NOT NULL,
  bill_type TEXT NOT NULL DEFAULT 'ORDER', title TEXT NOT NULL DEFAULT '医疗服务费',
  status TEXT NOT NULL CHECK(status IN ('UNPAID','PAID')), guidance TEXT NOT NULL, created_at TEXT NOT NULL,
  paid_at TEXT
);
CREATE TABLE IF NOT EXISTS simulated_payments(
  payment_id TEXT PRIMARY KEY, bill_id TEXT UNIQUE NOT NULL REFERENCES bills(bill_id) ON DELETE CASCADE,
  patient_id TEXT NOT NULL REFERENCES patient_profiles(patient_id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK(amount_cents>=0), provider TEXT NOT NULL CHECK(provider='SIMULATED'),
  status TEXT NOT NULL CHECK(status='PAID'), paid_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS journey_tasks(
  task_id TEXT PRIMARY KEY, appointment_id TEXT NOT NULL REFERENCES appointments(appointment_id) ON DELETE CASCADE,
  task_type TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL,
  order_id TEXT REFERENCES medical_orders(order_id) ON DELETE CASCADE,
  consultation_round_id TEXT REFERENCES consultation_rounds(round_id) ON DELETE CASCADE,
  scheduled_at TEXT, completed_at TEXT, blocks_completion INTEGER NOT NULL DEFAULT 1 CHECK(blocks_completion IN (0,1)),
  created_at TEXT NOT NULL
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
    this.applyRuntimeUpgrades();
  }
  applyRuntimeUpgrades() {
    this.db.exec("DROP TABLE IF EXISTS patient_statements;");
    this.db.exec("DELETE FROM pending_actions WHERE action_type='CONFIRM_FACTS';");
    if (!this.get("SELECT version FROM schema_migrations WHERE version='confirmed-structured-facts-v1'")) {
      this.db.exec(`INSERT INTO schema_migrations(version,applied_at) VALUES('confirmed-structured-facts-v1',datetime('now'));`);
    }
    const conversationColumns = this.all("PRAGMA table_info(conversation_turns)");
    if (!conversationColumns.some((column) => column.name === "assistant_actions_json")) {
      this.db.exec("ALTER TABLE conversation_turns ADD COLUMN assistant_actions_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!conversationColumns.some((column) => column.name === "interaction_id")) this.db.exec("ALTER TABLE conversation_turns ADD COLUMN interaction_id TEXT");
    if (!conversationColumns.some((column) => column.name === "reply_to_turn_id")) this.db.exec("ALTER TABLE conversation_turns ADD COLUMN reply_to_turn_id TEXT REFERENCES conversation_turns(turn_id) ON DELETE SET NULL");
    if (!conversationColumns.some((column) => column.name === "turn_kind")) this.db.exec("ALTER TABLE conversation_turns ADD COLUMN turn_kind TEXT NOT NULL DEFAULT 'CHAT' CHECK(turn_kind IN ('CHAT','CONTROL','PROACTIVE'))");
    if (!conversationColumns.some((column) => column.name === "turn_status")) this.db.exec("ALTER TABLE conversation_turns ADD COLUMN turn_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(turn_status IN ('ACTIVE','UNDONE'))");
    if (!conversationColumns.some((column) => column.name === "state_before_json")) this.db.exec("ALTER TABLE conversation_turns ADD COLUMN state_before_json TEXT");
    if (!conversationColumns.some((column) => column.name === "undone_at")) this.db.exec("ALTER TABLE conversation_turns ADD COLUMN undone_at TEXT");
    this.db.exec("UPDATE conversation_turns SET interaction_id=turn_id WHERE interaction_id IS NULL");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_conversation_active_turns ON conversation_turns(session_id,turn_status,created_at)");
    const doctorColumns = this.all("PRAGMA table_info(doctors)");
    if (doctorColumns.some((column) => column.name === "contact_encrypted")) {
      this.db.exec("ALTER TABLE doctors DROP COLUMN contact_encrypted");
    }
    const billColumns = this.all("PRAGMA table_info(bills)");
    const billSql = this.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='bills'")?.sql ?? "";
    if (!billColumns.some((column) => column.name === "paid_at") || /status\s*=\s*'UNPAID'/i.test(billSql)) {
      this.db.exec(`PRAGMA foreign_keys=OFF;
        DROP TABLE IF EXISTS simulated_payments;
        ALTER TABLE bills RENAME TO bills_legacy;
        CREATE TABLE bills(
          bill_id TEXT PRIMARY KEY, appointment_id TEXT NOT NULL REFERENCES appointments(appointment_id) ON DELETE CASCADE,
          order_id TEXT REFERENCES medical_orders(order_id) ON DELETE CASCADE, amount_cents INTEGER NOT NULL,
          bill_type TEXT NOT NULL DEFAULT 'ORDER', title TEXT NOT NULL DEFAULT '医疗服务费',
          status TEXT NOT NULL CHECK(status IN ('UNPAID','PAID')), guidance TEXT NOT NULL, created_at TEXT NOT NULL, paid_at TEXT
        );
        INSERT INTO bills(bill_id,appointment_id,order_id,amount_cents,bill_type,title,status,guidance,created_at)
          SELECT bill_id,appointment_id,order_id,amount_cents,'ORDER','医疗服务费',status,guidance,created_at FROM bills_legacy;
        DROP TABLE bills_legacy;
        CREATE TABLE simulated_payments(
          payment_id TEXT PRIMARY KEY, bill_id TEXT UNIQUE NOT NULL REFERENCES bills(bill_id) ON DELETE CASCADE,
          patient_id TEXT NOT NULL REFERENCES patient_profiles(patient_id) ON DELETE CASCADE,
          amount_cents INTEGER NOT NULL CHECK(amount_cents>=0), provider TEXT NOT NULL CHECK(provider='SIMULATED'),
          status TEXT NOT NULL CHECK(status='PAID'), paid_at TEXT NOT NULL
        );
        PRAGMA foreign_keys=ON;`);
    }
    const currentBillColumns = this.all("PRAGMA table_info(bills)");
    if (!currentBillColumns.some((column) => column.name === "bill_type")) this.db.exec("ALTER TABLE bills ADD COLUMN bill_type TEXT NOT NULL DEFAULT 'ORDER'");
    if (!currentBillColumns.some((column) => column.name === "title")) this.db.exec("ALTER TABLE bills ADD COLUMN title TEXT NOT NULL DEFAULT '医疗服务费'");
    const orderColumns = this.all("PRAGMA table_info(medical_orders)");
    if (!orderColumns.some((column) => column.name === "catalog_item_id")) this.db.exec("ALTER TABLE medical_orders ADD COLUMN catalog_item_id TEXT");
    if (!orderColumns.some((column) => column.name === "quantity")) this.db.exec("ALTER TABLE medical_orders ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1");
    if (!orderColumns.some((column) => column.name === "location_id")) this.db.exec("ALTER TABLE medical_orders ADD COLUMN location_id TEXT");
    if (!orderColumns.some((column) => column.name === "data_origin")) this.db.exec("ALTER TABLE medical_orders ADD COLUMN data_origin TEXT NOT NULL DEFAULT 'hospital_runtime'");
    this.db.exec(`CREATE TABLE IF NOT EXISTS consultation_rounds(
      round_id TEXT PRIMARY KEY, appointment_id TEXT NOT NULL REFERENCES appointments(appointment_id) ON DELETE CASCADE,
      round_number INTEGER NOT NULL, round_type TEXT NOT NULL CHECK(round_type IN ('INITIAL','RETURN')),
      status TEXT NOT NULL CHECK(status IN ('SCHEDULED','WAITING','IN_CONSULTATION','COMPLETED','CANCELLED')),
      scheduled_at TEXT, started_at TEXT, completed_at TEXT,
      return_visit_required INTEGER CHECK(return_visit_required IN (0,1)), return_visit_at TEXT,
      created_at TEXT NOT NULL, UNIQUE(appointment_id,round_number)
    );`);
    if (!orderColumns.some((column) => column.name === "consultation_round_id")) this.db.exec("ALTER TABLE medical_orders ADD COLUMN consultation_round_id TEXT REFERENCES consultation_rounds(round_id)");
    const taskColumns = this.all("PRAGMA table_info(journey_tasks)");
    if (!taskColumns.some((column) => column.name === "order_id")) this.db.exec("ALTER TABLE journey_tasks ADD COLUMN order_id TEXT REFERENCES medical_orders(order_id) ON DELETE CASCADE");
    if (!taskColumns.some((column) => column.name === "consultation_round_id")) this.db.exec("ALTER TABLE journey_tasks ADD COLUMN consultation_round_id TEXT REFERENCES consultation_rounds(round_id) ON DELETE CASCADE");
    if (!taskColumns.some((column) => column.name === "scheduled_at")) this.db.exec("ALTER TABLE journey_tasks ADD COLUMN scheduled_at TEXT");
    if (!taskColumns.some((column) => column.name === "completed_at")) this.db.exec("ALTER TABLE journey_tasks ADD COLUMN completed_at TEXT");
    if (!taskColumns.some((column) => column.name === "blocks_completion")) this.db.exec("ALTER TABLE journey_tasks ADD COLUMN blocks_completion INTEGER NOT NULL DEFAULT 1 CHECK(blocks_completion IN (0,1))");
    const taskSql = this.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='journey_tasks'")?.sql ?? "";
    if (/UNIQUE\s*\(\s*appointment_id\s*,\s*task_type\s*,\s*title\s*\)/i.test(taskSql)) {
      this.db.exec(`PRAGMA foreign_keys=OFF;
        ALTER TABLE journey_tasks RENAME TO journey_tasks_legacy;
        CREATE TABLE journey_tasks(
          task_id TEXT PRIMARY KEY, appointment_id TEXT NOT NULL REFERENCES appointments(appointment_id) ON DELETE CASCADE,
          task_type TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL,
          order_id TEXT REFERENCES medical_orders(order_id) ON DELETE CASCADE,
          consultation_round_id TEXT REFERENCES consultation_rounds(round_id) ON DELETE CASCADE,
          scheduled_at TEXT, completed_at TEXT, blocks_completion INTEGER NOT NULL DEFAULT 1 CHECK(blocks_completion IN (0,1)),
          created_at TEXT NOT NULL
        );
        INSERT INTO journey_tasks(task_id,appointment_id,task_type,status,title,order_id,consultation_round_id,scheduled_at,completed_at,blocks_completion,created_at)
          SELECT task_id,appointment_id,task_type,status,title,order_id,consultation_round_id,scheduled_at,completed_at,blocks_completion,created_at FROM journey_tasks_legacy;
        DROP TABLE journey_tasks_legacy;
        PRAGMA foreign_keys=ON;`);
    }
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_journey_task_order ON journey_tasks(order_id) WHERE order_id IS NOT NULL;");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_journey_task_return_round ON journey_tasks(consultation_round_id) WHERE task_type='RETURN_VISIT';");
    this.db.exec(`UPDATE journey_tasks SET order_id=(SELECT o.order_id FROM medical_orders o JOIN medical_records r ON r.record_id=o.record_id WHERE r.appointment_id=journey_tasks.appointment_id AND ((journey_tasks.task_type='EXAMINATION' AND o.order_type='EXAMINATION') OR (journey_tasks.task_type='PHARMACY' AND o.order_type='PRESCRIPTION')) AND journey_tasks.title LIKE '%' || o.title ORDER BY o.created_at LIMIT 1) WHERE order_id IS NULL AND task_type IN ('EXAMINATION','PHARMACY');`);
    const proactiveSql = this.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='proactive_agent_events'")?.sql ?? "";
    if (proactiveSql && !proactiveSql.includes("VISIT_COMPLETED")) {
      this.db.exec(`PRAGMA foreign_keys=OFF;
        ALTER TABLE proactive_agent_events RENAME TO proactive_agent_events_legacy;
        CREATE TABLE proactive_agent_events(
          event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES patient_sessions(session_id) ON DELETE CASCADE,
          appointment_id TEXT NOT NULL REFERENCES appointments(appointment_id) ON DELETE CASCADE,
          event_type TEXT NOT NULL CHECK(event_type IN ('WAITING_INTERVIEW','CALLED_NOTICE','POST_VISIT_GUIDANCE','RETURN_VISIT_READY','VISIT_COMPLETED')),
          created_at TEXT NOT NULL, UNIQUE(session_id,appointment_id,event_type)
        );
        INSERT INTO proactive_agent_events SELECT * FROM proactive_agent_events_legacy;
        DROP TABLE proactive_agent_events_legacy;
        PRAGMA foreign_keys=ON;`);
    }
    const workflowColumns = this.all("PRAGMA table_info(conversation_workflow_states)");
    if (!workflowColumns.some((column) => column.name === "recommended_departments_json")) {
      this.db.exec("ALTER TABLE conversation_workflow_states ADD COLUMN recommended_departments_json TEXT NOT NULL DEFAULT '[]'");
    }
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
