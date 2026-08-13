import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { buildApplication } from "../apps/server/main.js";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "hospital-doctor-record-access-"));
const apiConfigPath = join(temporaryDirectory, "APIConfigs.txt");
writeFileSync(apiConfigPath, "DeepSeek\nAPIKey：not-used\n", "utf8");

const app = buildApplication({
  host: "127.0.0.1",
  port: 0,
  dbPath: join(temporaryDirectory, "test.sqlite"),
  secretPath: join(temporaryDirectory, "test-secret"),
  apiConfigPath,
  secureCookies: false,
});

let baseUrl;
let appointmentId;
let recordId;

class Client {
  constructor() {
    this.cookies = new Map();
    this.csrf = null;
  }

  async request(path, { method = "GET", body, csrf = false } = {}) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; ");
    if (csrf && this.csrf) headers["X-CSRF-Token"] = this.csrf;
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(";");
      const separator = pair.indexOf("=");
      this.cookies.set(pair.slice(0, separator), decodeURIComponent(pair.slice(separator + 1)));
    }
    return { status: response.status, payload: await response.json() };
  }
}

const administrator = new Client();
const assignedDoctor = new Client();
const otherDoctor = new Client();
const patient = new Client();

async function registerAndActivateDoctor(client, employeeNumber, displayName) {
  const registration = await client.request("/api/doctors/register", {
    method: "POST",
    body: { displayName, employeeNumber, password: "doctor-pass-123" },
  });
  assert.equal(registration.status, 201);
  const activation = await administrator.request(`/api/administrators/doctors/${registration.payload.data.doctorId}/status`, {
    method: "PUT",
    csrf: true,
    body: { status: "ACTIVE" },
  });
  assert.equal(activation.status, 200);
  const login = await client.request("/api/doctors/login", {
    method: "POST",
    body: { employeeNumber, password: "doctor-pass-123" },
  });
  assert.equal(login.status, 200);
  client.csrf = login.payload.data.csrfToken;
  return registration.payload.data.doctorId;
}

before(async () => {
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${app.server.address().port}`;

  const setup = await administrator.request("/api/administrators/setup", {
    method: "POST",
    body: { displayName: "测试管理员", employeeNumber: "269001", password: "admin-pass-123" },
  });
  assert.equal(setup.status, 201);
  const adminLogin = await administrator.request("/api/administrators/login", {
    method: "POST",
    body: { employeeNumber: "269001", password: "admin-pass-123" },
  });
  assert.equal(adminLogin.status, 200);
  administrator.csrf = adminLogin.payload.data.csrfToken;

  await registerAndActivateDoctor(assignedDoctor, "269101", "接诊医生");
  await registerAndActivateDoctor(otherDoctor, "269102", "其他医生");

  const departments = await patient.request("/api/departments");
  const departmentId = departments.payload.data[0].departmentId;
  const serviceDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const practice = await assignedDoctor.request("/api/doctors/practices", {
    method: "POST",
    csrf: true,
    body: { departmentId, serviceDate, startTime: "08:00", endTime: "12:00", capacity: 2 },
  });
  assert.equal(practice.status, 201);

  await patient.request("/api/patient/me");
  const profile = await patient.request("/api/patient/profile/virtual", { method: "POST", body: {} });
  assert.equal(profile.status, 201);
  const pending = await patient.request("/api/patient/actions", {
    method: "POST",
    body: { actionType: "CREATE_APPOINTMENT", parameters: { practiceId: practice.payload.data.practiceId } },
  });
  assert.equal(pending.status, 201);
  const booked = await patient.request(`/api/patient/actions/${pending.payload.data.actionId}/confirm`, { method: "POST", body: {} });
  assert.equal(booked.status, 201);
  appointmentId = booked.payload.data.result.appointmentId;
  recordId = booked.payload.data.result.recordId;
});

after(async () => {
  await new Promise((resolve) => app.server.close(resolve));
  app.database.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

test("only the assigned doctor can discover and read a patient's record", async () => {
  const assignedAppointments = await assignedDoctor.request("/api/doctors/appointments");
  assert.equal(assignedAppointments.status, 200);
  assert.deepEqual(assignedAppointments.payload.data.map((item) => item.appointmentId), [appointmentId]);

  const otherAppointments = await otherDoctor.request("/api/doctors/appointments");
  assert.equal(otherAppointments.status, 200);
  assert.deepEqual(otherAppointments.payload.data, []);

  const assignedRead = await assignedDoctor.request(`/api/doctors/appointments/${appointmentId}/record`);
  assert.equal(assignedRead.status, 200);
  assert.equal(assignedRead.payload.data.recordId, recordId);

  const otherRead = await otherDoctor.request(`/api/doctors/appointments/${appointmentId}/record`);
  assert.equal(otherRead.status, 404);
  assert.equal(otherRead.payload.error.code, "MEDICAL_RECORD_NOT_FOUND");

  const unauthenticatedRead = await new Client().request(`/api/doctors/appointments/${appointmentId}/record`);
  assert.equal(unauthenticatedRead.status, 401);
});

test("record mutations and appointment transitions enforce the same doctor ownership", async () => {
  const content = {
    chiefConcern: "无",
    presentIllness: "",
    history: "",
    medications: "",
    allergies: "",
    examinationResults: "",
    doctorAssessment: "",
    plan: "",
  };
  const unauthorizedSave = await otherDoctor.request(`/api/doctors/records/${recordId}`, {
    method: "PUT",
    csrf: true,
    body: { expectedVersion: 1, content, changeReason: "越权测试" },
  });
  assert.equal(unauthorizedSave.status, 404);
  assert.equal(unauthorizedSave.payload.error.code, "MEDICAL_RECORD_NOT_FOUND");

  const unauthorizedOrder = await otherDoctor.request(`/api/doctors/records/${recordId}/orders`, {
    method: "POST",
    csrf: true,
    body: { orderType: "EXAMINATION", catalogItemId: "exam-blood-routine", quantity: 1 },
  });
  assert.equal(unauthorizedOrder.status, 404);
  assert.equal(unauthorizedOrder.payload.error.code, "MEDICAL_RECORD_NOT_FOUND");

  const unauthorizedTransition = await otherDoctor.request(`/api/doctors/appointments/${appointmentId}/transition`, {
    method: "POST",
    csrf: true,
    body: { action: "CALL" },
  });
  assert.equal(unauthorizedTransition.status, 404);
  assert.equal(unauthorizedTransition.payload.error.code, "APPOINTMENT_NOT_FOUND");
});

test("the record editor starts collapsed and is only opened from the assigned-patient list", () => {
  const page = readFileSync(join(import.meta.dirname, "../apps/web/doctor.html"), "utf8");
  const source = readFileSync(join(import.meta.dirname, "../apps/web/app.js"), "utf8");
  assert.match(page, /<h2>我的接诊患者<\/h2>[\s\S]*id="doctorAppointments"/);
  assert.match(page, /id="recordEditor" class="card wide hidden" aria-hidden="true"/);
  assert.match(page, /id="closeRecordEditor"/);
  assert.match(source, /async function restoreDoctor\(\) \{\s*resetDoctorRecordWorkspace\(\);/);
  assert.match(source, /\$\("#doctorAppointments"\)\.innerHTML[\s\S]*data-record=/);
  assert.match(source, /!items\.some\(\(item\) => item\.appointmentId === state\.record\.appointmentId\)\) resetDoctorRecordWorkspace\(\)/);
  assert.match(source, /\$\$\('\[data-record\]'\)[\s\S]*openRecord\(button\.dataset\.record\)/);
  assert.equal((source.match(/editor\.classList\.remove\("hidden"\)/g) ?? []).length, 1);
  assert.match(source, /bindEvent\("#closeRecordEditor", "click", resetDoctorRecordWorkspace\)/);
});
