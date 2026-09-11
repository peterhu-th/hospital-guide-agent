import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { buildApplication } from "../apps/server/main.js";
import { deduplicateClinicalFacts, medicalRecordDraft } from "../apps/server/service.js";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "hospital-agent-capabilities-"));
const app = buildApplication({
  host: "127.0.0.1", port: 0, dbPath: join(temporaryDirectory, "test.sqlite"),
  secretPath: join(temporaryDirectory, "secret"), apiConfigPath: join(temporaryDirectory, "missing-config.txt"),
  secureCookies: false, deepseekApiKey: "",
});
let baseUrl;

function futureDate(days = 30) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

class Client {
  constructor() { this.cookies = new Map(); }
  async request(path, { method = "GET", body } = {}) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; ");
    const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const item of response.headers.getSetCookie?.() ?? []) {
      const [pair] = item.split(";"); const index = pair.indexOf("=");
      this.cookies.set(pair.slice(0, index), decodeURIComponent(pair.slice(index + 1)));
    }
    return { status: response.status, payload: await response.json() };
  }
}

before(async () => {
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => app.server.close(resolve));
  app.database.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

test("doctor directory searches official knowledge by name and department", async () => {
  const visitor = new Client();
  await visitor.request("/api/patient/me");
  const byName = await visitor.request("/api/agent/messages", { method: "POST", body: { message: "查询徐维国医生的信息" } });
  assert.equal(byName.payload.data.intent, "DOCTOR_QUERY");
  const nameCard = byName.payload.data.assistantActions.find((item) => item.type === "DOCTOR_RESULTS");
  assert.equal(nameCard.items[0].displayName, "徐维国");
  assert.equal(nameCard.items[0].dataOrigin, "official_public");

  const byDepartment = await visitor.request("/api/agent/messages", { method: "POST", body: { message: "呼吸与危重症医学科有哪些医生" } });
  const departmentCard = byDepartment.payload.data.assistantActions.find((item) => item.type === "DOCTOR_RESULTS");
  assert.ok(departmentCard.items.length > 0);
  assert.ok(departmentCard.items.every((item) => item.departmentName === "呼吸与危重症医学科"));
});

test("doctor schedule reference is explicitly simulated and not a realtime slot", async () => {
  const visitor = new Client();
  await visitor.request("/api/patient/me");
  const response = await visitor.request("/api/agent/messages", { method: "POST", body: { message: "徐维国医生2026年8月13日出诊吗" } });
  const card = response.payload.data.assistantActions.find((item) => item.type === "DOCTOR_RESULTS");
  assert.equal(card.tool, "list_scheduled_doctors");
  assert.equal(card.items[0].simulated, true);
  assert.match(card.items[0].notice, /模拟出诊参考/);
  assert.doesNotMatch(JSON.stringify(card), /remaining|capacity/);
});

test("patient journey query distinguishes appointment prescription and examination", async () => {
  const visitor = new Client();
  await visitor.request("/api/patient/me");
  for (const [message, tool] of [["查询我的挂号", "get_my_appointments"], ["查询我的药品", "get_my_prescriptions"], ["查询我的检查", "get_my_examinations"]]) {
    const response = await visitor.request("/api/agent/messages", { method: "POST", body: { message } });
    assert.equal(response.payload.data.intent, "PATIENT_JOURNEY_QUERY");
    assert.equal(response.payload.data.assistantActions[0].tool, tool);
  }
});

test("temporary information request returns to the current appointment task", async () => {
  const visitor = new Client();
  await visitor.request("/api/patient/me");
  await visitor.request("/api/agent/messages", { method: "POST", body: { message: "我想挂号" } });
  const response = await visitor.request("/api/agent/messages", { method: "POST", body: { message: "查询徐维国医生的信息" } });
  assert.deepEqual(response.payload.data.assistantActions.map((item) => item.type), ["DOCTOR_RESULTS", "APPOINTMENT_SERVICE"]);
});

test("emergency input triggers one idempotent simulated nurse call while negation does not", async () => {
  const visitor = new Client();
  await visitor.request("/api/patient/me");
  const first = await visitor.request("/api/agent/messages", { method: "POST", body: { message: "我现在突然剧烈胸痛" } });
  const second = await visitor.request("/api/agent/messages", { method: "POST", body: { message: "我正在剧烈胸痛，快帮我" } });
  assert.equal(first.payload.data.intent, "EMERGENCY_ASSISTANCE");
  assert.equal(first.payload.data.assistantActions[0].type, "EMERGENCY_ASSISTANCE");
  assert.equal(first.payload.data.assistantActions[0].simulated, true);
  assert.equal(second.payload.data.emergencyCall.idempotent, true);
  assert.equal(app.database.get("SELECT count(*) total FROM audit_events WHERE action='SIMULATED_NURSE_CALL'").total, 1);
  const negated = await visitor.request("/api/agent/messages", { method: "POST", body: { message: "我没有胸痛，只是查询医生" } });
  assert.notEqual(negated.payload.data.intent, "EMERGENCY_ASSISTANCE");
});

test("negative emotion uses model support boundary and restores current task", async () => {
  const visitor = new Client();
  await visitor.request("/api/patient/me");
  await visitor.request("/api/agent/messages", { method: "POST", body: { message: "我想挂号" } });
  const original = app.service.departmentRouter.emotionalSupport;
  let called = false;
  app.service.departmentRouter.emotionalSupport = async () => { called = true; return { text: "等待确实让人难受，我会陪您把下一步处理清楚。", provider: "deepseek", degraded: false }; };
  try {
    const response = await visitor.request("/api/agent/messages", { method: "POST", body: { message: "我很烦，帮我看看挂号" } });
    assert.equal(called, true);
    assert.equal(response.payload.data.intent, "EMOTIONAL_SUPPORT");
    assert.ok(response.payload.data.assistantActions.some((item) => item.type === "APPOINTMENT_SERVICE"));
  } finally { app.service.departmentRouter.emotionalSupport = original; }
});

test("conversation cancellation reuses explicit confirmation and releases the slot", async () => {
  const visitor = new Client();
  await visitor.request("/api/patient/me");
  await visitor.request("/api/patient/profile/virtual", { method: "POST", body: {} });
  const department = app.knowledge.departments.find((item) => app.knowledge.isBookingEligible(item));
  const doctorId = "doctor-cancel-test";
  const practiceId = "practice-cancel-test";
  const serviceDate = futureDate();
  app.database.run(`INSERT INTO doctors(doctor_id,display_name,employee_number,password_hash,account_status,verification_notice,failed_login_count,locked_until,created_at) VALUES(:id,'退号测试医生','269901','unused','ACTIVE','测试',0,NULL,:now)`, { id: doctorId, now: new Date().toISOString() });
  app.database.run(`INSERT INTO doctor_practices VALUES(:id,:doctor,:department,:serviceDate,'08:00','12:00',2,0,'ACTIVE',:now)`, { id: practiceId, doctor: doctorId, department: department.departmentId, serviceDate, now: new Date().toISOString() });
  const pending = await visitor.request("/api/patient/actions", { method: "POST", body: { actionType: "CREATE_APPOINTMENT", parameters: { practiceId } } });
  const booked = await visitor.request(`/api/patient/actions/${pending.payload.data.actionId}/confirm`, { method: "POST", body: {} });
  const appointmentId = booked.payload.data.result.appointmentId;
  const chat = await visitor.request("/api/agent/messages", { method: "POST", body: { message: "这个号挂错了，帮我退号" } });
  assert.equal(chat.payload.data.intent, "CANCEL_APPOINTMENT");
  assert.equal(chat.payload.data.assistantActions[0].title, "选择需要退掉的挂号");
  const cancellation = await visitor.request("/api/patient/actions", { method: "POST", body: { actionType: "CANCEL_APPOINTMENT", parameters: { appointmentId } } });
  await visitor.request(`/api/patient/actions/${cancellation.payload.data.actionId}/confirm`, { method: "POST", body: {} });
  assert.equal(app.database.get("SELECT status FROM appointments WHERE appointment_id=?", [appointmentId]).status, "CANCELLED");
  assert.equal(app.database.get("SELECT booked_count FROM doctor_practices WHERE practice_id=?", [practiceId]).booked_count, 0);
  assert.equal(app.database.get("SELECT count(*) total FROM journey_tasks WHERE appointment_id=? AND status='PENDING'", [appointmentId]).total, 0);
});

test("called appointment always restores the immediate consultation task", () => {
  const task = app.service.taskManager.current({
    appointments: [{ appointmentId: "appointment-called", status: "CALLED", departmentName: "骨科" }],
    bills: [], tasks: [], orders: [],
  });
  assert.equal(task.type, "CONSULTATION");
  assert.match(task.text, /立即前往诊室/);
});

test("accompanying symptoms exclude items already recorded as chief complaint", () => {
  const facts = deduplicateClinicalFacts([
    { field: "chiefConcern", normalizedValue: "主要不适：腹胀、恶心", certainty: "PATIENT_CONFIRMED" },
    { field: "symptoms", normalizedValue: "伴随症状：腹胀、头晕、恶心", certainty: "PATIENT_CONFIRMED" },
  ]);
  const symptoms = facts.find((item) => item.field === "symptoms");
  assert.equal(symptoms.normalizedValue, "伴随症状：头晕");
});

test("agent facts prefill record fields without overwriting doctor content", () => {
  const result = medicalRecordDraft(
    { chiefConcern: "医生已核实的主诉" },
    [
      { field: "chiefConcern", normalized_value: "患者提供的主诉", certainty: "PATIENT_CONFIRMED" },
      { field: "timeline", normalized_value: "持续两天", certainty: "PATIENT_CONFIRMED" },
      { field: "patientHistory", normalized_value: "既往高血压", certainty: "PATIENT_CONFIRMED" },
      { field: "patientAllergies", normalized_value: "可能对青霉素过敏", certainty: "UNCERTAIN" },
    ],
  );
  assert.equal(result.draft.chiefConcern, "医生已核实的主诉");
  assert.equal(result.draft.presentIllness, "持续两天");
  assert.equal(result.draft.history, "既往高血压");
  assert.equal(result.draft.allergies, "[待核实] 可能对青霉素过敏");
  assert.equal(result.draft.examinationResults, "");
  assert.deepEqual(result.agentPrefilledFields.sort(), ["allergies", "history", "presentIllness"]);
  const doctorCleared = medicalRecordDraft(
    { chiefConcern: "", presentIllness: "" },
    [{ field: "chiefConcern", normalized_value: "患者提供的主诉", certainty: "PATIENT_CONFIRMED" }],
  );
  assert.equal(doctorCleared.draft.chiefConcern, "");
  assert.deepEqual(doctorCleared.agentPrefilledFields, []);
});

test("agent facts never write the doctor-owned examination result field", () => {
  const result = medicalRecordDraft(
    { examinationResults: "医生录入的检查结果" },
    [{ field: "examinationResults", normalized_value: "Agent尝试写入", certainty: "PATIENT_CONFIRMED" }],
  );
  assert.equal(result.draft.examinationResults, "医生录入的检查结果");
  assert.equal(result.agentPrefilledFields.includes("examinationResults"), false);
});
