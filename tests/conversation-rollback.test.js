import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { buildApplication } from "../apps/server/main.js";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "hospital-agent-undo-test-"));
const app = buildApplication({
  host: "127.0.0.1", port: 0,
  dbPath: join(temporaryDirectory, "undo.sqlite"),
  secretPath: join(temporaryDirectory, "secret"),
  apiConfigPath: join(temporaryDirectory, "missing-api-config.txt"),
  deepseekApiKey: "",
  secureCookies: false,
});
let baseUrl;

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

test("direct undo requires confirmation and restores the previous workflow state", async () => {
  const patient = new Client();
  await patient.request("/api/patient/me");
  const sent = await patient.request("/api/agent/messages", { method: "POST", body: { message: "我想挂号" } });
  assert.equal(sent.status, 201);
  const session = app.database.get("SELECT * FROM patient_sessions ORDER BY created_at LIMIT 1");
  assert.equal(app.database.get("SELECT active_task_type FROM conversation_workflow_states WHERE session_id=?", [session.session_id]).active_task_type, "APPOINTMENT_HELP");

  const prepared = await patient.request("/api/patient/conversation/undo", { method: "POST", body: {} });
  assert.equal(prepared.status, 201);
  assert.equal(prepared.payload.data.available, true);
  assert.equal(prepared.payload.data.assistantActions[0].type, "UNDO_TURN_CONFIRMATION");
  assert.match(prepared.payload.data.summary, /我想挂号/);

  const confirmed = await patient.request(`/api/patient/conversation/undo/${prepared.payload.data.actionId}/confirm`, { method: "POST", body: {} });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.payload.data.undone, true);
  assert.equal(app.database.get("SELECT active_task_type FROM conversation_workflow_states WHERE session_id=?", [session.session_id]).active_task_type, "UNDERSTAND_REQUEST");
  assert.equal((await patient.request("/api/patient/messages")).payload.data.length, 0);
  assert.equal(app.database.get("SELECT count(*) total FROM conversation_turns WHERE session_id=? AND turn_status='ACTIVE'", [session.session_id]).total, 0);
  assert.equal(app.database.get("SELECT count(*) total FROM audit_events WHERE action='CONVERSATION_TURN_UNDONE'").total, 1);
});

test("undo intent uses the same confirmation card and cancel keeps the target turn", async () => {
  const patient = new Client();
  await patient.request("/api/patient/me");
  await patient.request("/api/agent/messages", { method: "POST", body: { message: "我想缴费" } });
  const requested = await patient.request("/api/agent/messages", { method: "POST", body: { message: "我刚才不小心点错点到挂号了，我没有挂号的需求" } });
  assert.equal(requested.payload.data.intent, "UNDO_LAST_TURN");
  assert.equal(requested.payload.data.undoAvailable, true);
  assert.equal(requested.payload.data.assistantActions[0].tool, "prepare_undo_last_turn");
  const actionId = requested.payload.data.assistantActions[0].actionId;
  const cancelled = await patient.request(`/api/patient/conversation/undo/${actionId}/cancel`, { method: "POST", body: {} });
  assert.equal(cancelled.payload.data.cancelled, true);
  const messages = (await patient.request("/api/patient/messages")).payload.data;
  assert.equal(messages.length, 2);
  assert.equal(messages[0].message, "我想缴费");
  assert.equal(messages[0].role, "PATIENT");
  assert.equal(messages[1].role, "AGENT");
});

test("undo removes structured facts written only by the mistaken turn", async () => {
  const patient = new Client();
  await patient.request("/api/patient/me");
  await patient.request("/api/agent/messages", { method: "POST", body: { message: "我头痛" } });
  const session = app.database.get("SELECT * FROM patient_sessions ORDER BY created_at DESC LIMIT 1");
  assert.ok(app.database.get("SELECT fact_id FROM patient_facts WHERE session_id=? AND normalized_value LIKE '%头痛%'", [session.session_id]));
  const prepared = await patient.request("/api/patient/conversation/undo", { method: "POST", body: {} });
  await patient.request(`/api/patient/conversation/undo/${prepared.payload.data.actionId}/confirm`, { method: "POST", body: {} });
  assert.equal(app.database.get("SELECT count(*) total FROM patient_facts WHERE session_id=?", [session.session_id]).total, 0);
});

test("simulated nurse calls remain auditable and cannot be undone", async () => {
  const patient = new Client();
  await patient.request("/api/patient/me");
  const emergency = await patient.request("/api/agent/messages", { method: "POST", body: { message: "我突然昏倒了，快叫护士" } });
  assert.equal(emergency.payload.data.intent, "EMERGENCY_ASSISTANCE");
  const prepared = await patient.request("/api/patient/conversation/undo", { method: "POST", body: {} });
  assert.equal(prepared.payload.data.available, false);
  assert.equal(prepared.payload.data.reasonCode, "NURSE_CALL_CANNOT_BE_UNDONE");
  assert.equal(app.database.get("SELECT count(*) total FROM audit_events WHERE action='SIMULATED_NURSE_CALL'").total, 1);
});

test("a stale confirmation cannot overwrite a newer conversation turn", async () => {
  const patient = new Client();
  await patient.request("/api/patient/me");
  await patient.request("/api/agent/messages", { method: "POST", body: { message: "我想缴费" } });
  const prepared = await patient.request("/api/patient/conversation/undo", { method: "POST", body: {} });
  await patient.request("/api/agent/messages", { method: "POST", body: { message: "我想查看地图" } });
  const stale = await patient.request(`/api/patient/conversation/undo/${prepared.payload.data.actionId}/confirm`, { method: "POST", body: {} });
  assert.equal(stale.status, 409);
  assert.equal(stale.payload.error.code, "UNDO_STATE_CHANGED");
  assert.ok((await patient.request("/api/patient/messages")).payload.data.some((item) => item.message === "我想查看地图"));
});

test("confirmed business writes are explained and never rolled back", async () => {
  const patient = new Client();
  await patient.request("/api/patient/me");
  await patient.request("/api/agent/messages", { method: "POST", body: { message: "我想挂号" } });
  const profile = await patient.request("/api/patient/profile/virtual", { method: "POST", body: {} });
  assert.equal(profile.status, 201);
  const prepared = await patient.request("/api/patient/conversation/undo", { method: "POST", body: {} });
  assert.equal(prepared.status, 201);
  assert.equal(prepared.payload.data.available, false);
  assert.equal(prepared.payload.data.reasonCode, "BUSINESS_ACTION_CANNOT_BE_UNDONE");
  assert.match(prepared.payload.data.message, /无法撤销|不能撤销/);
  assert.equal(app.database.get("SELECT count(*) total FROM patient_profiles").total, 1);
  assert.ok((await patient.request("/api/patient/messages")).payload.data.some((item) => item.message === "我想挂号"));
});

test("patient page exposes a compact direct undo entry and confirmation handlers", async () => {
  const html = await (await fetch(`${baseUrl}/user`)).text();
  const source = await (await fetch(`${baseUrl}/app.js`)).text();
  assert.match(html, /id="undoLastTurn"/);
  assert.match(source, /UNDO_TURN_CONFIRMATION/);
  assert.match(source, /data-confirm-undo/);
  assert.match(source, /data-cancel-undo/);
});
