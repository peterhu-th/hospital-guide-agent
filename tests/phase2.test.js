import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { buildApplication } from "../apps/server/main.js";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "hospital-agent-phase2-"));
const testApiConfigPath = join(temporaryDirectory, "APIConfigs.txt");
writeFileSync(testApiConfigPath, "DeepSeek\nAPIKey：not-used\n\n蜂鸟SDK\nappName：test-map-app\nmapID：90872\nAccessKey：server-only-access\nSecretKey：server-only-secret\nAPIKey：browser-web-key\n", "utf8");
const app = buildApplication({
  host: "127.0.0.1", port: 0,
  dbPath: join(temporaryDirectory, "test.sqlite"),
  secretPath: join(temporaryDirectory, "test-secret"),
  apiConfigPath: testApiConfigPath,
  secureCookies: false,
});
let baseUrl;

class Client {
  constructor() { this.cookies = new Map(); this.csrf = null; }
  async request(path, { method = "GET", body, csrf = false } = {}) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; ");
    if (csrf && this.csrf) headers["X-CSRF-Token"] = this.csrf;
    const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = response.headers.getSetCookie?.() ?? [];
    for (const item of setCookie) {
      const [pair] = item.split(";"); const index = pair.indexOf("=");
      this.cookies.set(pair.slice(0, index), decodeURIComponent(pair.slice(index + 1)));
    }
    const payload = await response.json();
    return { status: response.status, payload };
  }
}

const patient = new Client();
const secondPatient = new Client();
const doctor = new Client();
let departmentId;
let practiceId;
let appointmentId;
let recordId;
let orderId;

before(async () => {
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  departmentId = (await patient.request("/api/departments")).payload.data[0].departmentId;
});

after(async () => {
  await new Promise((resolve) => app.server.close(resolve));
  app.database.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

test("official knowledge and empty runtime are exposed", async () => {
  const health = await patient.request("/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.payload.data.hospital, "绵阳市中心医院");
  assert.equal(app.database.get("SELECT count(*) total FROM doctors").total, 0);
  assert.equal(app.database.get("SELECT count(*) total FROM patient_profiles").total, 0);
  const config = await patient.request("/api/config");
  assert.equal("insurance" in config.payload.data, false);
  assert.equal(config.payload.data.administratorInitialized, false);
  assert.equal(config.payload.data.map.sdkConfigured, true);
  assert.equal(config.payload.data.map.mapId, "90872");
  assert.equal(config.payload.data.map.appName, "test-map-app");
  assert.equal(config.payload.data.map.webApiKey, "browser-web-key");
  assert.doesNotMatch(JSON.stringify(config.payload.data), /server-only-access|server-only-secret/);
  const mapHead = await fetch(`${baseUrl}/map-data/90872/90872.fmap`, { method: "HEAD" });
  assert.equal(mapHead.status, 200);
  assert.equal(mapHead.headers.get("content-type"), "application/octet-stream");
  assert.ok(Number(mapHead.headers.get("content-length")) > 1_000_000);
});

test("patient can chat before profile and manual profile is enforced", async () => {
  const me = await patient.request("/api/patient/me");
  assert.equal(me.payload.data.hasProfile, false);
  const chat = await patient.request("/api/agent/messages", { method: "POST", body: { message: "我最近吃饭后觉得腹胀，想先了解挂号流程" } });
  assert.equal(chat.status, 201);
  assert.equal(chat.payload.data.intent, "APPOINTMENT_HELP");
  assert.match(chat.payload.data.recordCapture, /暂存/);
  const preview = await patient.request("/api/patient/identity-preview", { method: "POST", body: { identityNumber: "11010519491231002X" } });
  assert.equal(preview.payload.data.sex, "female");
  assert.ok(Number.isInteger(preview.payload.data.age));
  const rejected = await patient.request("/api/patient/profile", { method: "POST", body: { fullName: "测试患者", identityNumber: "11010519491231002X", manualEntry: false } });
  assert.equal(rejected.status, 422);
  assert.equal(rejected.payload.error.code, "MANUAL_ENTRY_REQUIRED");
  const created = await patient.request("/api/patient/profile", { method: "POST", body: { fullName: "测试患者", identityNumber: "11010519491231002X", manualEntry: true } });
  assert.equal(created.status, 201);
  assert.equal(created.payload.data.hasProfile, true);
  const stored = app.database.get("SELECT * FROM patient_profiles");
  assert.notEqual(stored.identity_encrypted, "11010519491231002X");
  assert.match(stored.identity_encrypted, /^[^.]+\.[^.]+\.[^.]+$/);
});

test("conversation can start from a later journey stage without inventing success", async () => {
  const visitor = new Client();
  await visitor.request("/api/patient/me");
  const response = await visitor.request("/api/agent/messages", { method: "POST", body: { message: "我现在准备缴费，应该去哪里？" } });
  assert.equal(response.payload.data.currentStage, "PAYMENT");
  assert.equal(response.payload.data.intent, "PAYMENT_HELP");
  assert.match(response.payload.data.text, /未接入真实支付渠道/);
  const journey = await visitor.request("/api/patient/journey");
  assert.deepEqual(journey.payload.data.bills, []);
});

test("administrator replaces CLI review and doctor uses secure session", async () => {
  const administrator = new Client();
  const setup = await administrator.request("/api/administrators/setup", { method: "POST", body: { displayName: "系统管理员", employeeNumber: "260001", password: "admin123456" } });
  assert.equal(setup.status, 201);
  const repeatedSetup = await administrator.request("/api/administrators/setup", { method: "POST", body: { displayName: "第二管理员", employeeNumber: "260002", password: "admin123456" } });
  assert.equal(repeatedSetup.status, 409);
  const adminLogin = await administrator.request("/api/administrators/login", { method: "POST", body: { employeeNumber: "260001", password: "admin123456" } });
  assert.equal(adminLogin.status, 200);
  administrator.csrf = adminLogin.payload.data.csrfToken;
  const invalidEmployeeNumber = await doctor.request("/api/doctors/register", { method: "POST", body: { displayName: "本地测试医生", employeeNumber: "26010", password: "12345678", contact: "13800000000" } });
  assert.equal(invalidEmployeeNumber.status, 422);
  const shortPassword = await doctor.request("/api/doctors/register", { method: "POST", body: { displayName: "本地测试医生", employeeNumber: "260101", password: "1234567" } });
  assert.equal(shortPassword.status, 422);
  const registration = await doctor.request("/api/doctors/register", { method: "POST", body: { displayName: "本地测试医生", employeeNumber: "260101", password: "12345678", contact: "13800000000" } });
  assert.equal(registration.status, 201);
  assert.equal(registration.payload.data.accountStatus, "PENDING_REVIEW");
  const blocked = await doctor.request("/api/doctors/login", { method: "POST", body: { employeeNumber: "260101", password: "12345678" } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.payload.error.code, "DOCTOR_NOT_ACTIVE");
  const wrongPair = await doctor.request("/api/doctors/login", { method: "POST", body: { employeeNumber: "260102", password: "12345678" } });
  assert.equal(wrongPair.status, 401);
  assert.equal(wrongPair.payload.error.code, "INVALID_CREDENTIALS");
  const activation = await administrator.request(`/api/administrators/doctors/${registration.payload.data.doctorId}/status`, { method: "PUT", csrf: true, body: { status: "ACTIVE" } });
  assert.equal(activation.payload.data.accountStatus, "ACTIVE");
  const login = await doctor.request("/api/doctors/login", { method: "POST", body: { employeeNumber: "260101", password: "12345678" } });
  assert.equal(login.status, 200);
  doctor.csrf = login.payload.data.csrfToken;
  assert.ok(doctor.cookies.get("doctor_session"));
  const storedDoctor = app.database.get("SELECT password_hash FROM doctors WHERE employee_number='260101'");
  assert.notEqual(storedDoctor.password_hash, "12345678");
  assert.match(storedDoctor.password_hash, /^scrypt\$/);
});

test("doctor publishes real runtime slot and patient booking consumes it", async () => {
  const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const missingCsrf = await doctor.request("/api/doctors/practices", { method: "POST", body: { departmentId, serviceDate: tomorrow, startTime: "08:00", endTime: "12:00", capacity: 1 } });
  assert.equal(missingCsrf.status, 403);
  const published = await doctor.request("/api/doctors/practices", { method: "POST", csrf: true, body: { departmentId, serviceDate: tomorrow, startTime: "08:00", endTime: "12:00", capacity: 1 } });
  assert.equal(published.status, 201);
  practiceId = published.payload.data.practiceId;
  const pendingBooking = await patient.request("/api/patient/actions", { method: "POST", body: { actionType: "CREATE_APPOINTMENT", parameters: { practiceId } } });
  assert.equal(pendingBooking.payload.data.requiresExplicitConfirmation, true);
  const booking = await patient.request(`/api/patient/actions/${pendingBooking.payload.data.actionId}/confirm`, { method: "POST", body: {} });
  assert.equal(booking.status, 201);
  appointmentId = booking.payload.data.result.appointmentId;
  recordId = booking.payload.data.result.recordId;
  assert.equal(app.database.get("SELECT booked_count FROM doctor_practices WHERE practice_id=?", [practiceId]).booked_count, 1);
  const recordStatements = app.database.all("SELECT patient_words FROM patient_statements WHERE record_id=?", [recordId]);
  assert.ok(recordStatements.some((row) => row.patient_words.includes("腹胀")));
});

test("same patient cannot book the same department twice on one day", async () => {
  const pendingDuplicate = await patient.request("/api/patient/actions", { method: "POST", body: { actionType: "CREATE_APPOINTMENT", parameters: { practiceId } } });
  const duplicate = await patient.request(`/api/patient/actions/${pendingDuplicate.payload.data.actionId}/confirm`, { method: "POST", body: {} });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.payload.error.code, "DUPLICATE_DEPARTMENT_APPOINTMENT");
  assert.equal(duplicate.payload.error.category, "appointment");
  assert.ok(duplicate.payload.error.recommendedActions.includes("查看已有挂号"));
});

test("full slot returns alternatives message and check-in persists", async () => {
  await secondPatient.request("/api/patient/me");
  await secondPatient.request("/api/patient/profile", { method: "POST", body: { fullName: "第二患者", identityNumber: "11010519491231002X", manualEntry: true } });
  const pendingFull = await secondPatient.request("/api/patient/actions", { method: "POST", body: { actionType: "CREATE_APPOINTMENT", parameters: { practiceId } } });
  const full = await secondPatient.request(`/api/patient/actions/${pendingFull.payload.data.actionId}/confirm`, { method: "POST", body: {} });
  assert.equal(full.status, 409);
  assert.equal(full.payload.error.code, "SLOT_FULL");
  assert.match(full.payload.error.message, /更换医生或时段/);
  const checkedIn = await patient.request(`/api/appointments/${appointmentId}/check-in`, { method: "POST", body: {} });
  assert.equal(checkedIn.payload.data.status, "CHECKED_IN");
  assert.equal(app.database.get("SELECT status FROM appointments WHERE appointment_id=?", [appointmentId]).status, "CHECKED_IN");
});

test("patient statement appends without interrupting workflow", async () => {
  const chat = await patient.request("/api/agent/messages", { method: "POST", body: { message: "我可能对青霉素过敏，但不确定" } });
  assert.equal(chat.status, 201);
  assert.match(chat.payload.data.recordCapture, /已写入/);
  const statement = app.database.get("SELECT * FROM patient_statements WHERE record_id=? AND patient_words LIKE '%青霉素%'", [recordId]);
  assert.equal(statement.patient_words, "我可能对青霉素过敏，但不确定");
  assert.equal(statement.category, "patientAllergies");
  assert.equal(statement.certainty, "UNCERTAIN");
  assert.equal(statement.normalized_value, null);
});

test("doctor views and version-edits record without changing patient words", async () => {
  const appointments = await doctor.request("/api/doctors/appointments");
  assert.equal(appointments.payload.data[0].appointmentId, appointmentId);
  const record = await doctor.request(`/api/doctors/appointments/${appointmentId}/record`);
  assert.equal(record.status, 200);
  assert.ok(record.payload.data.patientStatements.some((item) => item.patientWords.includes("青霉素")));
  const wordsBefore = app.database.all("SELECT patient_words FROM patient_statements WHERE record_id=? ORDER BY created_at", [recordId]);
  const content = { chiefConcern: "患者主诉腹胀", presentIllness: "医生接诊记录", history: "", medications: "", allergies: "待核验", doctorAssessment: "医生判断内容", plan: "医生处理计划" };
  const saved = await doctor.request(`/api/doctors/records/${recordId}`, { method: "PUT", csrf: true, body: { expectedVersion: 1, content, changeReason: "接诊后补充" } });
  assert.equal(saved.payload.data.version, 2);
  const conflict = await doctor.request(`/api/doctors/records/${recordId}`, { method: "PUT", csrf: true, body: { expectedVersion: 1, content, changeReason: "旧页面保存" } });
  assert.equal(conflict.status, 409);
  assert.deepEqual(app.database.all("SELECT patient_words FROM patient_statements WHERE record_id=? ORDER BY created_at", [recordId]), wordsBefore);
  assert.equal(app.database.get("SELECT count(*) total FROM medical_record_versions WHERE record_id=?", [recordId]).total, 2);
});

test("doctor order is real, payment stays unpaid, simulated result is marked", async () => {
  const order = await doctor.request(`/api/doctors/records/${recordId}/orders`, { method: "POST", csrf: true, body: { orderType: "EXAMINATION", title: "演示检查医嘱", details: "由当前登录医生填写的检查要求", amountCents: 1200 } });
  assert.equal(order.status, 201);
  orderId = order.payload.data.orderId;
  assert.equal(order.payload.data.billStatus, "UNPAID");
  assert.equal(app.database.get("SELECT status FROM bills WHERE order_id=?", [orderId]).status, "UNPAID");
  const simulated = await doctor.request(`/api/doctors/orders/${orderId}/simulated-result`, { method: "POST", csrf: true, body: { objectType: "examination_report" } });
  assert.equal(simulated.status, 201);
  assert.equal(simulated.payload.data.simulated, true);
  assert.match(simulated.payload.data.label, /模拟生成/);
  assert.match(simulated.payload.data.content.summary, /不包含真实检查数据或医学结论/);
});

test("patient end-session removes linked visit data but preserves doctor", async () => {
  const ended = await patient.request("/api/patient/session", { method: "DELETE" });
  assert.equal(ended.status, 200);
  assert.equal(app.database.get("SELECT count(*) total FROM patient_profiles").total, 1);
  assert.equal(app.database.get("SELECT count(*) total FROM appointments WHERE appointment_id=?", [appointmentId]).total, 0);
  assert.equal(app.database.get("SELECT count(*) total FROM medical_records WHERE record_id=?", [recordId]).total, 0);
  assert.equal(app.database.get("SELECT count(*) total FROM patient_sessions WHERE patient_id IS NOT NULL").total, 1);
  assert.equal(app.database.get("SELECT booked_count FROM doctor_practices WHERE practice_id=?", [practiceId]).booked_count, 0);
  assert.equal(app.database.get("SELECT count(*) total FROM doctors").total, 1);
});
