import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { buildApplication } from "../apps/server/main.js";
import { SqliteDatabase } from "../apps/server/database.js";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "hospital-agent-system-test-"));
const testApiConfigPath = join(temporaryDirectory, "APIConfigs.txt");
writeFileSync(testApiConfigPath, "讯飞方言识别大模型\nAPPID：iat-app\nAPISecret：iat-secret\nAPIKey：iat-key\n\n讯飞超拟人语音合成大模型\nAPPID：tts-app\nAPISecret：tts-secret\nAPIKey：tts-key\nAPIPassword：tts-password\n\nDeepSeek\nAPIKey：not-used\n\n蜂鸟SDK\nappName：test-map-app\nmapID：90872\nAccessKey：server-only-access\nSecretKey：server-only-secret\nAPIKey：browser-web-key\n", "utf8");
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
  async raw(path) {
    const headers = {};
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; ");
    return fetch(`${baseUrl}${path}`, { headers });
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
let prescriptionOrderId;
let registrationBillId;

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
  assert.equal(health.payload.data.hospital, "某医院");
  assert.equal(app.database.get("SELECT count(*) total FROM doctors").total, 0);
  assert.equal(app.database.get("SELECT count(*) total FROM patient_profiles").total, 0);
  const config = await patient.request("/api/config");
  assert.equal("insurance" in config.payload.data, false);
  assert.equal(config.payload.data.administratorInitialized, false);
  assert.equal(config.payload.data.map.sdkConfigured, true);
  assert.equal(config.payload.data.map.mapId, "90872");
  assert.equal(config.payload.data.map.appName, "test-map-app");
  assert.equal(config.payload.data.map.webApiKey, "browser-web-key");
  assert.deepEqual(config.payload.data.speech, { transcription: true, synthesis: true });
  assert.doesNotMatch(JSON.stringify(config.payload.data), /server-only-access|server-only-secret|iat-secret|tts-secret|iat-key|tts-key|tts-password/);
  const mapHead = await fetch(`${baseUrl}/map-data/90872/90872.fmap`, { method: "HEAD" });
  assert.equal(mapHead.status, 200);
  assert.equal(mapHead.headers.get("content-type"), "application/octet-stream");
  assert.ok(Number(mapHead.headers.get("content-length")) > 1_000_000);
});

test("legacy local database upgrades doctor and bill structures", () => {
  const path = join(temporaryDirectory, "legacy-upgrade.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE doctors(doctor_id TEXT PRIMARY KEY,display_name TEXT,employee_number TEXT,password_hash TEXT,contact_encrypted TEXT,account_status TEXT,verification_notice TEXT,failed_login_count INTEGER,locked_until TEXT,created_at TEXT);
    CREATE TABLE bills(bill_id TEXT PRIMARY KEY,appointment_id TEXT,order_id TEXT,amount_cents INTEGER,status TEXT CHECK(status='UNPAID'),guidance TEXT,created_at TEXT);
  `);
  legacy.close();
  const upgraded = new SqliteDatabase(path);
  assert.equal(upgraded.all("PRAGMA table_info(doctors)").some((column) => column.name === "contact_encrypted"), false);
  assert.equal(upgraded.all("PRAGMA table_info(bills)").some((column) => column.name === "paid_at"), true);
  assert.equal(upgraded.all("PRAGMA table_info(conversation_turns)").some((column) => column.name === "assistant_actions_json"), true);
  assert.equal(upgraded.all("PRAGMA table_info(conversation_workflow_states)").some((column) => column.name === "recommended_departments_json"), true);
  assert.ok(upgraded.get("SELECT name FROM sqlite_master WHERE type='table' AND name='simulated_payments'"));
  upgraded.close();
});

test("FengMap v3 uses online non-tiled loading and receives its required CSP", async () => {
  const webSource = readFileSync(join(import.meta.dirname, "../apps/web/app.js"), "utf8");
  assert.match(webSource, /mapID:\s*mapId,\s*tile:\s*false/);
  assert.doesNotMatch(webSource, /mapURL(?:Absolute)?\s*:/);
  assert.match(webSource, /setFitView\(state\.map\.bound,\s*\{\s*animate:\s*false\s*\}\)/);

  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self' 'unsafe-eval'/);
  const mapPage = await fetch(`${baseUrl}/map`);
  assert.equal(mapPage.status, 200);
  assert.match(await mapPage.text(), /fengmap\.plugin\.navi\.min\.js/);
  assert.equal((await fetch(`${baseUrl}/vendor/fengmap/fengmap.analyser.min.js`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/vendor/fengmap/fengmap.plugin.navi.min.js`)).status, 200);
});

test("patient speech controls and secure transcription session are exposed", async () => {
  const page = await fetch(`${baseUrl}/`);
  assert.match(page.headers.get("permissions-policy"), /microphone=\(self\)/);
  assert.match(page.headers.get("permissions-policy"), /geolocation=\(self\)/);
  assert.match(page.headers.get("content-security-policy"), /wss:\/\/iat\.cn-huabei-1\.xf-yun\.com/);
  const html = await page.text();
  assert.match(html, /id="voiceInput"/);
  assert.match(html, /id="autoReadToggle"/);
  assert.doesNotMatch(html, /id="practiceForm"|id="recordForm"|id="orderForm"/);
  assert.match(html, /rel="icon" href="\/favicon\.svg"/);
  const favicon = await fetch(`${baseUrl}/favicon.svg`);
  assert.equal(favicon.status, 200);
  assert.equal(favicon.headers.get("content-type"), "image/svg+xml");
  const appSource = await (await fetch(`${baseUrl}/app.js`)).text();
  for (const selector of ["#practiceForm", "#recordForm", "#orderForm"]) {
    assert.match(appSource, new RegExp(`bindEvent\\(\"${selector}\", \\"submit\\"`));
    assert.doesNotMatch(appSource, new RegExp(`\\$\\(\"${selector}\"\\)\\.onsubmit\\s*=`));
  }
  const speechSource = await (await fetch(`${baseUrl}/speech.js`)).text();
  assert.match(speechSource, /ltc:\s*1/);
  assert.doesNotMatch(speechSource, /ltc:\s*0/);
  const session = await patient.request("/api/speech/transcription-session", { method: "POST", body: {} });
  assert.equal(session.status, 201);
  assert.equal(session.payload.data.appId, "iat-app");
  assert.match(session.payload.data.url, /^wss:\/\/iat\.cn-huabei-1\.xf-yun\.com\/v1\?/);
  assert.doesNotMatch(JSON.stringify(session.payload.data), /iat-secret/);
});

test("patient can chat before profile and manual profile is enforced", async () => {
  const me = await patient.request("/api/patient/me");
  assert.equal(me.payload.data.hasProfile, false);
  const chat = await patient.request("/api/agent/messages", { method: "POST", body: { message: "我最近吃饭后觉得腹胀，想先了解挂号流程" } });
  assert.equal(chat.status, 201);
  assert.equal(chat.payload.data.intent, "APPOINTMENT_HELP");
  assert.deepEqual(chat.payload.data.assistantActions.map((item) => item.type), ["PATIENT_PROFILE_FORM", "APPOINTMENT_SERVICE"]);
  assert.equal(chat.payload.data.assistantActions[0].status, "AWAITING_USER_INPUT");
  assert.equal(chat.payload.data.assistantActions[1].tool, "list_appointment_slots");
  assert.equal(chat.payload.data.assistantActions[1].requiresProfile, true);
  const restoredConversation = await patient.request("/api/patient/messages");
  const restoredAgentTurn = restoredConversation.payload.data.at(-1);
  assert.equal(restoredAgentTurn.role, "AGENT");
  assert.deepEqual(restoredAgentTurn.assistantActions, chat.payload.data.assistantActions);
  assert.equal("recordCapture" in chat.payload.data, false);
  assert.ok(app.database.get("SELECT fact_id FROM patient_facts WHERE record_id IS NULL AND normalized_value LIKE '%腹胀%'"));
  const preview = await patient.request("/api/patient/identity-preview", { method: "POST", body: { identityNumber: "11010519491231002X" } });
  assert.deepEqual(preview.payload.data, { valid: true });
  const rejected = await patient.request("/api/patient/profile", { method: "POST", body: { fullName: "测试患者", identityNumber: "11010519491231002X", manualEntry: false } });
  assert.equal(rejected.status, 422);
  assert.equal(rejected.payload.error.code, "MANUAL_ENTRY_REQUIRED");
  const created = await patient.request("/api/patient/profile", { method: "POST", body: { fullName: "测试患者", identityNumber: "11010519491231002X", manualEntry: true } });
  assert.equal(created.status, 201);
  assert.equal(created.payload.data.hasProfile, true);
  assert.equal("sex" in created.payload.data, false);
  assert.equal("age" in created.payload.data, false);
  assert.equal("identityNumberMasked" in created.payload.data, false);
  const restoredAfterProfile = await patient.request("/api/patient/messages");
  assert.deepEqual(restoredAfterProfile.payload.data.at(-1).assistantActions.map((item) => item.type), ["APPOINTMENT_SERVICE"]);
  assert.equal(restoredAfterProfile.payload.data.at(-1).assistantActions[0].requiresProfile, false);
  const appointmentService = await patient.request("/api/agent/messages", { method: "POST", body: { message: "我要挂号" } });
  assert.match(appointmentService.payload.data.text, /^测女士，/);
  assert.deepEqual(appointmentService.payload.data.assistantActions.map((item) => item.type), ["APPOINTMENT_SERVICE"]);
  assert.equal(appointmentService.payload.data.assistantActions[0].requiresProfile, false);
  assert.equal(appointmentService.payload.data.assistantActions[0].selectedDepartmentId, null);
  assert.deepEqual(appointmentService.payload.data.assistantActions[0].practices, []);
  assert.ok(appointmentService.payload.data.assistantActions[0].departments.length <= 8);
  assert.ok(appointmentService.payload.data.assistantActions[0].departments.every((item) => item.division !== "行后职能科室"));
  const stored = app.database.get("SELECT * FROM patient_profiles");
  assert.notEqual(stored.identity_encrypted, "11010519491231002X");
  assert.match(stored.identity_encrypted, /^[^.]+\.[^.]+\.[^.]+$/);
});

test("patient can explicitly use a labelled 65-year-old male virtual identity", async () => {
  const visitor = new Client();
  await visitor.request("/api/patient/me");
  const created = await visitor.request("/api/patient/profile/virtual", { method: "POST", body: {} });
  assert.equal(created.status, 201);
  assert.equal(created.payload.data.virtualTestProfile, true);
  assert.equal(created.payload.data.profileSource, "VIRTUAL_TEST");
  assert.doesNotMatch(JSON.stringify(created.payload.data), /\d{17}[\dX]/);
  const stored = app.database.get("SELECT * FROM patient_profiles WHERE verification_status='VIRTUAL_TEST'");
  assert.equal(stored.age, 65);
  assert.equal(stored.sex, "male");
  assert.doesNotMatch(stored.identity_encrypted, /^\d{17}[\dX]$/);
  assert.match(stored.identity_encrypted, /^[^.]+\.[^.]+\.[^.]+$/);
  await visitor.request("/api/patient/session", { method: "DELETE" });
  assert.equal(app.database.get("SELECT count(*) total FROM patient_profiles WHERE verification_status='VIRTUAL_TEST'").total, 0);
});

test("appointment shortcut reuses the latest high-confidence department recommendation", async () => {
  const visitor = new Client();
  await visitor.request("/api/patient/me");
  await visitor.request("/api/patient/profile/virtual", { method: "POST", body: {} });
  const orthopedics = app.knowledge.departments.find((item) => item.displayName === "骨科");
  assert.ok(orthopedics, "骨科必须存在于完整科室目录");
  const originalRecommend = app.service.departmentRouter.recommend;
  app.service.departmentRouter.recommend = async () => ({
    provider: "test", degraded: false,
    result: {
      intent: "DEPARTMENT_RECOMMENDATION",
      extractedFacts: [{ field: "symptoms", rawValue: "脚踝肿痛", normalizedValue: "脚踝肿痛，不能行走", confidence: 0.96 }],
      recommendations: [{ departmentId: orthopedics.departmentId, confidence: 0.96, reason: "外伤后踝部肿痛" }],
      shouldAskQuestion: false, clarificationQuestion: null, shouldRequestHumanHelp: false,
      suggestedTool: "SHOW_APPOINTMENT_SERVICE", containsDiagnosis: false,
    },
  });
  try {
    const routed = await visitor.request("/api/agent/messages", { method: "POST", body: { message: "我上个月扭伤脚踝，现在肿痛不能走路" } });
    assert.equal(routed.status, 201);
    assert.equal(routed.payload.data.recommendations[0].departmentId, orthopedics.departmentId);
    const workflow = app.database.get(`SELECT w.recommended_departments_json FROM conversation_workflow_states w
      JOIN patient_sessions s ON s.session_id=w.session_id
      JOIN patient_profiles p ON p.patient_id=s.patient_id
      WHERE p.verification_status='VIRTUAL_TEST' LIMIT 1`);
    assert.deepEqual(JSON.parse(workflow.recommended_departments_json), [{ departmentId: orthopedics.departmentId, confidence: 0.96 }]);

    const appointment = await visitor.request("/api/agent/messages", { method: "POST", body: { message: "我想挂号" } });
    assert.equal(appointment.status, 201);
    assert.match(appointment.payload.data.text, /刚才推荐的骨科/);
    assert.equal(appointment.payload.data.assistantActions[0].type, "APPOINTMENT_SERVICE");
    assert.equal(appointment.payload.data.assistantActions[0].selectedDepartmentId, orthopedics.departmentId);
    assert.deepEqual(appointment.payload.data.assistantActions[0].departments.map((item) => item.departmentId), [orthopedics.departmentId]);
  } finally {
    app.service.departmentRouter.recommend = originalRecommend;
    await visitor.request("/api/patient/session", { method: "DELETE" });
  }
});

test("conversation can start from a later journey stage without inventing success", async () => {
  const visitor = new Client();
  await visitor.request("/api/patient/me");
  const response = await visitor.request("/api/agent/messages", { method: "POST", body: { message: "我现在准备缴费，应该去哪里？" } });
  assert.equal(response.payload.data.currentStage, "PRE_VISIT");
  assert.equal(response.payload.data.intent, "PAYMENT_HELP");
  assert.match(response.payload.data.text, /模拟支付/);
  assert.equal(response.payload.data.assistantActions[0].type, "JOURNEY_STATUS");
  assert.equal(response.payload.data.assistantActions[0].status, "READ_COMPLETED");
  const journey = await visitor.request("/api/patient/journey");
  assert.deepEqual(journey.payload.data.bills, []);
});

test("patient input is limited to 500 characters", async () => {
  const visitor = new Client();
  await visitor.request("/api/patient/me");
  const rejected = await visitor.request("/api/agent/messages", { method: "POST", body: { message: "症".repeat(501) } });
  assert.equal(rejected.status, 422);
  assert.equal(rejected.payload.error.code, "VALIDATION_ERROR");
});

test("appointment picker keeps recommendations and exposes a two-page full department path", () => {
  const appSource = readFileSync(join(import.meta.dirname, "../apps/web/app.js"), "utf8");
  assert.match(appSource, /show-all-departments[^>]*data-open-department-picker>其他科室/);
  assert.match(appSource, /data-picker-page="divisions"/);
  assert.match(appSource, /data-picker-page="departments"/);
  assert.match(appSource, /data-pick-division/);
  assert.match(appSource, /showPage\("divisions"\)/);
  assert.match(appSource, /showPage\("departments"\)/);
  assert.match(appSource, /await api\("\/api\/departments\?bookingEligible=true&limit=100"\)/);
  assert.match(appSource, /data-division-menu-list/);
  assert.match(appSource, /type="hidden" name="departmentId"/);
  assert.doesNotMatch(appSource, /<select name="departmentId"/);
  assert.doesNotMatch(appSource, /department-current|已选：/);
  assert.match(appSource, /if \(!data\.departmentId\) throw new Error\("请选择科室"\)/);
  assert.match(appSource, /action\.practices\.length > 0/);
  assert.doesNotMatch(appSource, /· \{escapeHtml\(item\.doctorName\)|<\/p>\$<div class="actions"|<button data-pay-bill="\$\{bill\.billId\}">模拟支付<\/button><small>`/);
  assert.match(appSource, /journey\.bills\.filter\(\(item\) => item\.status === "UNPAID"\)/);
  assert.doesNotMatch(appSource, /模拟支付已完成<\/small>/);
});

test("identity portals are isolated by path with no identity switcher", async () => {
  const pageSource = readFileSync(join(import.meta.dirname, "../apps/web/index.html"), "utf8");
  const doctorSource = readFileSync(join(import.meta.dirname, "../apps/web/doctor.html"), "utf8");
  const adminSource = readFileSync(join(import.meta.dirname, "../apps/web/admin.html"), "utf8");
  const mapSource = readFileSync(join(import.meta.dirname, "../apps/web/map.html"), "utf8");
  const appSource = readFileSync(join(import.meta.dirname, "../apps/web/app.js"), "utf8");
  assert.match(pageSource, /id="chatMessages"/);
  assert.match(pageSource, /非官方声明/);
  assert.match(pageSource, /某医院导诊演示/);
  assert.match(pageSource, />模拟</);
  assert.doesNotMatch(pageSource, /<header[\s\S]*?<strong>绵阳市中心医院<\/strong>/);
  assert.doesNotMatch(pageSource, /data-view=|id="profileCard"|id="practiceSearchForm"|id="journeyResults"|id="view-map"|id="doctorLoginForm"|id="adminLoginForm"/);
  assert.match(doctorSource, /data-portal="doctor"/);
  assert.match(doctorSource, /id="doctorDepartmentDivision"/);
  assert.doesNotMatch(doctorSource, /id="chatMessages"|id="adminLoginForm"|fengmap\.map\.min\.js/);
  assert.match(adminSource, /data-portal="admin"/);
  assert.match(adminSource, /id="adminLoginForm"/);
  assert.doesNotMatch(adminSource, /id="chatMessages"|id="doctorLoginForm"|fengmap\.map\.min\.js/);
  assert.match(mapSource, /data-portal="map"/);
  assert.match(mapSource, /id="exitMap"/);
  assert.match(mapSource, /fengmap\.analyser\.min\.js/);
  assert.match(mapSource, /fengmap\.plugin\.navi\.min\.js/);
  assert.doesNotMatch(mapSource, /id="chatMessages"|id="doctorLoginForm"|id="adminLoginForm"/);
  assert.doesNotMatch(appSource, /derivedSex|derivedAge|自动识别性别|自动识别年龄/);
  assert.match(appSource, /FMNavigationWalk/);
  assert.match(appSource, /drawNaviLine\(\)/);
  assert.match(appSource, /FMViewMode\.MODE_2D/);
  assert.match(appSource, /setTilt\(\{ tilt: 0, animate \}\)/);
  assert.match(appSource, /enableTilt = false/);
  assert.match(appSource, /viewModeControl: false/);
  assert.match(appSource, /portal === "map"/);
  assert.match(appSource, /initializeDoctorDepartmentIndex/);
  assert.match(appSource, /PATIENT_PROFILE_FORM/);
  assert.match(appSource, /使用虚拟信息/);
  assert.match(appSource, /identitySecrets = new WeakMap/);
  assert.match(appSource, /"\*"\.repeat\(secret\.length\)/);
  assert.match(appSource, /addEventListener\("beforeinput"/);
  assert.match(appSource, /setTimeout\(\(\) => \{[\s\S]*?600\)/);
  assert.match(appSource, /\["pointerup", "pointercancel", "pointerleave", "blur"\]/);
  assert.doesNotMatch(appSource, /<input[^>]+name="identityNumber"/);
  assert.match(appSource, /APPOINTMENT_SERVICE/);
  assert.match(appSource, /JOURNEY_STATUS/);
  assert.match(appSource, /LOCATION_SERVICE/);
  assert.doesNotMatch(appSource, /已调用 \$\{escapeHtml\(action\.tool\)\}/);
  assert.match(appSource, /confirm\("确认已经到院并完成报到吗/);
  assert.match(pageSource, /id="calledAlert"/);
  assert.match(mapSource, /value="current-location" selected/);
  assert.match(pageSource, /<html[^>]+translate="no"[^>]+notranslate/);
  assert.match(appSource, /function setHidden\(selector, hidden\)/);
  assert.doesNotMatch(appSource, /event\.currentTarget\.reset\(\)/);
  assert.match(appSource, /const form = event\.currentTarget;[\s\S]*?form\.reset\(\)/);
  const portalResponses = await Promise.all(["/user", "/doctor", "/admin", "/map"].map(async (path) => {
    const response = await fetch(`${baseUrl}${path}`);
    return { path, status: response.status, html: await response.text() };
  }));
  for (const response of portalResponses) assert.equal(response.status, 200, response.path);
  assert.match(portalResponses[0].html, /data-portal="patient"/);
  assert.match(portalResponses[1].html, /data-portal="doctor"/);
  assert.match(portalResponses[2].html, /data-portal="admin"/);
  assert.match(portalResponses[3].html, /data-portal="map"/);
  const root = await fetch(`${baseUrl}/`, { redirect: "manual" });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "/user");
  for (const path of ["/user?view=doctor", "/doctor?view=user", "/map?q=门诊"]) {
    const canonical = await fetch(`${baseUrl}${path}`, { redirect: "manual" });
    assert.equal(canonical.status, 302);
    assert.equal(canonical.headers.get("location"), path.split("?")[0]);
  }
  assert.doesNotMatch(appSource, /new URLSearchParams\(location\.search\)/);
  assert.match(appSource, /sessionStorage\.setItem\("hospital-map-query"/);
});

test("agent proactively opens location and human-service cards", async () => {
  const visitor = new Client();
  await visitor.request("/api/patient/me");
  const location = await visitor.request("/api/agent/messages", { method: "POST", body: { message: "请打开院内地图，我要找门诊" } });
  assert.equal(location.payload.data.intent, "LOCATION_HELP");
  assert.equal(location.payload.data.assistantActions[0].type, "LOCATION_SERVICE");
  assert.equal(location.payload.data.assistantActions[0].tool, "open_indoor_map");
  assert.equal(location.payload.data.assistantActions[0].mapPage, "map");
  const human = await visitor.request("/api/agent/messages", { method: "POST", body: { message: "请告诉我去哪里找工作人员" } });
  assert.equal(human.payload.data.intent, "HUMAN_HELP");
  assert.equal(human.payload.data.assistantActions[0].type, "HUMAN_SERVICE");
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
  const invalidEmployeeNumber = await doctor.request("/api/doctors/register", { method: "POST", body: { displayName: "本地测试医生", employeeNumber: "26010", password: "12345678" } });
  assert.equal(invalidEmployeeNumber.status, 422);
  const shortPassword = await doctor.request("/api/doctors/register", { method: "POST", body: { displayName: "本地测试医生", employeeNumber: "260101", password: "1234567" } });
  assert.equal(shortPassword.status, 422);
  const registration = await doctor.request("/api/doctors/register", { method: "POST", body: { displayName: "本地测试医生", employeeNumber: "260101", password: "12345678" } });
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
  assert.equal(app.database.all("PRAGMA table_info(doctors)").some((column) => column.name === "contact_encrypted"), false);
});

test("doctor publishes real runtime slot and patient booking consumes it", async () => {
  const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const missingCsrf = await doctor.request("/api/doctors/practices", { method: "POST", body: { departmentId, serviceDate: tomorrow, startTime: "08:00", endTime: "12:00", capacity: 1 } });
  assert.equal(missingCsrf.status, 403);
  const published = await doctor.request("/api/doctors/practices", { method: "POST", csrf: true, body: { departmentId, serviceDate: tomorrow, startTime: "08:00", endTime: "12:00", capacity: 1 } });
  assert.equal(published.status, 201);
  const duplicatePractice = await doctor.request("/api/doctors/practices", { method: "POST", csrf: true, body: { departmentId, serviceDate: tomorrow, startTime: "08:00", endTime: "12:00", capacity: 2 } });
  assert.equal(duplicatePractice.status, 409);
  assert.equal(duplicatePractice.payload.error.code, "PRACTICE_ALREADY_EXISTS");
  practiceId = published.payload.data.practiceId;
  const pendingBooking = await patient.request("/api/patient/actions", { method: "POST", body: { actionType: "CREATE_APPOINTMENT", parameters: { practiceId } } });
  assert.equal(pendingBooking.status, 201, JSON.stringify(pendingBooking.payload));
  assert.equal(pendingBooking.payload.data.requiresExplicitConfirmation, true);
  const booking = await patient.request(`/api/patient/actions/${pendingBooking.payload.data.actionId}/confirm`, { method: "POST", body: {} });
  assert.equal(booking.status, 201);
  appointmentId = booking.payload.data.result.appointmentId;
  recordId = booking.payload.data.result.recordId;
  registrationBillId = booking.payload.data.result.registrationBillId;
  assert.equal(booking.payload.data.result.status, "PENDING_PAYMENT");
  assert.equal(app.database.get("SELECT status FROM appointments WHERE appointment_id=?", [appointmentId]).status, "PENDING_PAYMENT");
  assert.equal(app.database.get("SELECT bill_type FROM bills WHERE bill_id=?", [registrationBillId]).bill_type, "REGISTRATION");
  assert.equal(app.database.get("SELECT booked_count FROM doctor_practices WHERE practice_id=?", [practiceId]).booked_count, 1);
  assert.equal(app.database.get("SELECT count(*) total FROM sqlite_master WHERE type='table' AND name='patient_statements'").total, 0);
  const recordFacts = app.database.all("SELECT field,normalized_value FROM patient_facts WHERE record_id=? AND status='CONFIRMED'", [recordId]);
  assert.ok(recordFacts.some((row) => row.field === "chiefConcern" && row.normalized_value.includes("腹胀")));
});

test("existing patient appointment intercepts another booking and returns its information", async () => {
  const interceptedChat = await patient.request("/api/agent/messages", { method: "POST", body: { message: "我还要挂号" } });
  assert.equal(interceptedChat.payload.data.intent, "JOURNEY_HELP");
  assert.equal(interceptedChat.payload.data.assistantActions[0].type, "JOURNEY_STATUS");
  assert.equal(interceptedChat.payload.data.assistantActions[0].title, "已有挂号");
  assert.equal(interceptedChat.payload.data.assistantActions[0].journey.appointments[0].appointmentId, appointmentId);
  const pendingDuplicate = await patient.request("/api/patient/actions", { method: "POST", body: { actionType: "CREATE_APPOINTMENT", parameters: { practiceId } } });
  assert.equal(pendingDuplicate.status, 201);
  assert.equal(pendingDuplicate.payload.data.status, "EXISTING_APPOINTMENT");
  assert.equal(pendingDuplicate.payload.data.requiresExplicitConfirmation, false);
  assert.equal(pendingDuplicate.payload.data.existingAppointment.appointmentId, appointmentId);
  assert.equal("actionId" in pendingDuplicate.payload.data, false);
});

test("map context suggests booked department without selecting it", async () => {
  const context = await patient.request("/api/patient/map-context");
  assert.equal(context.status, 200);
  assert.equal(context.payload.data.hospitalArea.dataOrigin, "open_map_reference");
  assert.ok(context.payload.data.appointmentDestinations.some((item) => item.appointmentId === appointmentId && item.departmentId === departmentId));
  const source = readFileSync(join(import.meta.dirname, "../apps/web/app.js"), "utf8");
  assert.match(source, /renderMapDestinations/);
  assert.match(source, /data-appointment-destination/);
  assert.match(source, /浏览器定位无法识别院内楼层/);
});

test("full slot returns alternatives message and check-in persists", async () => {
  await secondPatient.request("/api/patient/me");
  await secondPatient.request("/api/patient/profile", { method: "POST", body: { fullName: "第二患者", identityNumber: "11010519491231002X", manualEntry: true } });
  const pendingFull = await secondPatient.request("/api/patient/actions", { method: "POST", body: { actionType: "CREATE_APPOINTMENT", parameters: { practiceId } } });
  const full = await secondPatient.request(`/api/patient/actions/${pendingFull.payload.data.actionId}/confirm`, { method: "POST", body: {} });
  assert.equal(full.status, 409);
  assert.equal(full.payload.error.code, "SLOT_FULL");
  assert.match(full.payload.error.message, /更换医生或时段/);
  const beforePayment = await patient.request(`/api/appointments/${appointmentId}/check-in`, { method: "POST", body: {} });
  assert.equal(beforePayment.status, 409);
  const registrationPayment = await patient.request(`/api/patient/bills/${registrationBillId}/simulated-payment`, { method: "POST", body: {} });
  assert.equal(registrationPayment.payload.data.billType, "REGISTRATION");
  assert.equal(registrationPayment.payload.data.appointmentStatus, "BOOKED");
  const checkedIn = await patient.request(`/api/appointments/${appointmentId}/check-in`, { method: "POST", body: {} });
  assert.equal(checkedIn.payload.data.status, "CHECKED_IN");
  assert.equal(app.database.get("SELECT status FROM appointments WHERE appointment_id=?", [appointmentId]).status, "CHECKED_IN");
});

test("waiting patient receives one proactive interview and doctor can call", async () => {
  const proactive = await patient.request("/api/patient/proactive-update");
  assert.equal(proactive.status, 200);
  assert.equal(proactive.payload.data.eventType, "WAITING_INTERVIEW");
  assert.match(proactive.payload.data.message, /^测女士，/);
  const repeated = await patient.request("/api/patient/proactive-update");
  assert.equal(repeated.payload.data, null);

  const answer = await patient.request("/api/agent/messages", { method: "POST", body: { message: "主要是饭后上腹胀，大约持续两周，血压是150/95" } });
  assert.equal(answer.payload.data.intent, "WAITING_INTERVIEW");
  assert.equal("recordCapture" in answer.payload.data, false);
  assert.equal(answer.payload.data.assistantActions.some((item) => item.type === "FACT_CONFIRMATION"), false);
  assert.ok(app.database.get("SELECT fact_id FROM patient_facts WHERE record_id=? AND normalized_value LIKE '%两周%'", [recordId]));
  assert.ok(app.database.get("SELECT fact_id FROM patient_facts WHERE record_id=? AND field='vitalSigns' AND normalized_value='血压：150/95 mmHg'", [recordId]));
  assert.match(answer.payload.data.text, /同时出现的其他不适/);
  const noOtherSymptoms = await patient.request("/api/agent/messages", { method: "POST", body: { message: "没有" } });
  assert.equal(noOtherSymptoms.payload.data.intent, "WAITING_INTERVIEW");
  assert.match(noOtherSymptoms.payload.data.text, /过敏/);
  assert.ok(app.database.get("SELECT fact_id FROM patient_facts WHERE record_id=? AND field='symptoms' AND certainty='DENIED'", [recordId]));

  const called = await doctor.request(`/api/doctors/appointments/${appointmentId}/transition`, { method: "POST", csrf: true, body: { action: "CALL" } });
  assert.equal(called.payload.data.status, "CALLED");
  const notice = await patient.request("/api/patient/proactive-update");
  assert.equal(notice.payload.data.eventType, "CALLED_NOTICE");
  assert.match(notice.payload.data.message, /已经叫到您的号/);
  assert.equal(notice.payload.data.queueNumber, 1);
  assert.equal(app.database.get("SELECT count(*) total FROM conversation_turns WHERE message LIKE '%已经叫到您的号%'").total, 0);
});

test("patient words remain in chat while only confirmed structured facts enter record", async () => {
  const chat = await patient.request("/api/agent/messages", { method: "POST", body: { message: "我可能对青霉素过敏，但不确定" } });
  assert.equal(chat.status, 201);
  assert.equal("recordCapture" in chat.payload.data, false);
  assert.equal(app.database.get("SELECT count(*) total FROM sqlite_master WHERE type='table' AND name='patient_statements'").total, 0);
  assert.equal(chat.payload.data.assistantActions.some((item) => item.type === "FACT_CONFIRMATION"), false);
  const fact = app.database.get("SELECT * FROM patient_facts WHERE record_id=? AND normalized_value LIKE '%青霉素%'", [recordId]);
  assert.equal(fact.field, "patientAllergies");
  assert.equal(fact.certainty, "UNCERTAIN");
});

test("doctor views confirmed facts and version-edits record without patient words", async () => {
  const appointments = await doctor.request("/api/doctors/appointments");
  assert.equal(appointments.payload.data[0].appointmentId, appointmentId);
  const record = await doctor.request(`/api/doctors/appointments/${appointmentId}/record`);
  assert.equal(record.status, 200);
  assert.ok(record.payload.data.patientFacts.some((item) => item.normalizedValue.includes("青霉素")));
  assert.ok(record.payload.data.patientFacts.every((item) => item.sourceTurnId));
  assert.equal("patientStatements" in record.payload.data, false);
  assert.doesNotMatch(JSON.stringify(record.payload.data), /但不确定/);
  const factsBefore = app.database.all("SELECT field,normalized_value,certainty FROM patient_facts WHERE record_id=? ORDER BY confirmed_at", [recordId]);
  const content = { chiefConcern: "患者主诉腹胀", presentIllness: "医生接诊记录", history: "", medications: "", allergies: "待核验", doctorAssessment: "医生判断内容", plan: "医生处理计划" };
  const saved = await doctor.request(`/api/doctors/records/${recordId}`, { method: "PUT", csrf: true, body: { expectedVersion: 1, content, changeReason: "接诊后补充" } });
  assert.equal(saved.payload.data.version, 2);
  const conflict = await doctor.request(`/api/doctors/records/${recordId}`, { method: "PUT", csrf: true, body: { expectedVersion: 1, content, changeReason: "旧页面保存" } });
  assert.equal(conflict.status, 409);
  assert.deepEqual(app.database.all("SELECT field,normalized_value,certainty FROM patient_facts WHERE record_id=? ORDER BY confirmed_at", [recordId]), factsBefore);
  assert.equal(app.database.get("SELECT count(*) total FROM medical_record_versions WHERE record_id=?", [recordId]).total, 2);
});

test("doctor record integrates agent facts into editable medical fields", () => {
  const source = readFileSync(join(import.meta.dirname, "../apps/web/app.js"), "utf8");
  const doctorSource = readFileSync(join(import.meta.dirname, "../apps/web/doctor.html"), "utf8");
  assert.match(source, /state\.record\.recordDraft \?\? state\.record\.doctorContent/);
  assert.match(source, /agentPrefilledFields\?\.includes\(key\)/);
  assert.doesNotMatch(source, /patientFactsHtml|groupPatientFacts/);
  assert.doesNotMatch(doctorSource, /id="patientFacts"/);
});

test("doctor order is real, payment stays unpaid, simulated result is marked", async () => {
  const catalog = await doctor.request("/api/doctors/order-catalog");
  assert.equal(catalog.status, 200);
  assert.match(catalog.payload.data.notice, /演示/);
  const beforeConsultation = await doctor.request(`/api/doctors/records/${recordId}/orders`, { method: "POST", csrf: true, body: { orderType: "EXAMINATION", catalogItemId: "exam-blood-routine", quantity: 1 } });
  assert.equal(beforeConsultation.status, 409);
  const started = await doctor.request(`/api/doctors/appointments/${appointmentId}/transition`, { method: "POST", csrf: true, body: { action: "START" } });
  assert.equal(started.payload.data.status, "IN_CONSULTATION");
  const order = await doctor.request(`/api/doctors/records/${recordId}/orders`, { method: "POST", csrf: true, body: { orderType: "EXAMINATION", catalogItemId: "exam-blood-routine", quantity: 1, doctorNotes: "按现场流程采样" } });
  assert.equal(order.status, 201);
  orderId = order.payload.data.orderId;
  assert.equal(order.payload.data.billStatus, "UNPAID");
  assert.equal(order.payload.data.location.locationId, "location-map-907230201192");
  assert.equal(app.database.get("SELECT status FROM bills WHERE order_id=?", [orderId]).status, "UNPAID");
  const prescription = await doctor.request(`/api/doctors/records/${recordId}/orders`, { method: "POST", csrf: true, body: { orderType: "PRESCRIPTION", catalogItemId: "med-loratadine", quantity: 2, doctorNotes: "用法用量以本次医生说明为准" } });
  assert.equal(prescription.status, 201);
  prescriptionOrderId = prescription.payload.data.orderId;
  assert.equal(prescription.payload.data.location.locationId, "location-map-907230101452");
  const secondPrescription = await doctor.request(`/api/doctors/records/${recordId}/orders`, { method: "POST", csrf: true, body: { orderType: "PRESCRIPTION", catalogItemId: "med-omeprazole", quantity: 1 } });
  assert.equal(secondPrescription.status, 201);
  const revoked = await doctor.request(`/api/doctors/orders/${secondPrescription.payload.data.orderId}/revoke`, { method: "POST", csrf: true, body: {} });
  assert.equal(revoked.payload.data.status, "REVOKED");
  assert.equal(app.database.get("SELECT status FROM medical_orders WHERE order_id=?", [secondPrescription.payload.data.orderId]).status, "REVOKED");
  assert.equal(app.database.get("SELECT count(*) total FROM bills WHERE order_id=?", [secondPrescription.payload.data.orderId]).total, 0);
  const patientJourney = await patient.request("/api/patient/journey");
  assert.equal(patientJourney.payload.data.orders.some((item) => item.orderId === secondPrescription.payload.data.orderId), false);
  const repeatedRevoke = await doctor.request(`/api/doctors/orders/${secondPrescription.payload.data.orderId}/revoke`, { method: "POST", csrf: true, body: {} });
  assert.equal(repeatedRevoke.status, 409);
  assert.equal(repeatedRevoke.payload.error.code, "ORDER_NOT_REVOCABLE");
  const simulated = await doctor.request(`/api/doctors/orders/${orderId}/simulated-result`, { method: "POST", csrf: true, body: { objectType: "examination_report" } });
  assert.equal(simulated.status, 201);
  assert.equal(simulated.payload.data.simulated, true);
  assert.match(simulated.payload.data.label, /模拟生成/);
  assert.match(simulated.payload.data.content.summary, /不包含真实检查数据或医学结论/);
});

test("patient completes idempotent simulated payment without real provider", async () => {
  const journey = await patient.request("/api/patient/journey");
  const bill = journey.payload.data.bills.find((item) => item.orderId === orderId && item.status === "UNPAID");
  assert.ok(bill);
  const paid = await patient.request(`/api/patient/bills/${bill.billId}/simulated-payment`, { method: "POST", body: {} });
  assert.equal(paid.status, 201);
  assert.equal(paid.payload.data.provider, "SIMULATED");
  assert.equal(paid.payload.data.status, "PAID");
  assert.match(paid.payload.data.simulationNotice, /不会产生真实扣款/);
  const repeated = await patient.request(`/api/patient/bills/${bill.billId}/simulated-payment`, { method: "POST", body: {} });
  assert.equal(repeated.payload.data.idempotent, true);
  assert.equal(app.database.get("SELECT status FROM bills WHERE bill_id=?", [bill.billId]).status, "PAID");
  assert.equal(app.database.get("SELECT count(*) total FROM simulated_payments WHERE bill_id=?", [bill.billId]).total, 1);
  const paidRevoke = await doctor.request(`/api/doctors/orders/${orderId}/revoke`, { method: "POST", csrf: true, body: {} });
  assert.equal(paidRevoke.status, 409);
  assert.equal(paidRevoke.payload.error.code, "ORDER_ALREADY_PAID");
});

test("examination forces a timed return visit that reuses the same editable record", async () => {
  const missingDecision = await doctor.request(`/api/doctors/appointments/${appointmentId}/transition`, { method: "POST", csrf: true, body: { action: "COMPLETE" } });
  assert.equal(missingDecision.payload.error.code, "RETURN_VISIT_DECISION_REQUIRED");
  const rejectedNoReturn = await doctor.request(`/api/doctors/appointments/${appointmentId}/transition`, { method: "POST", csrf: true, body: { action: "COMPLETE", returnVisitRequired: false } });
  assert.equal(rejectedNoReturn.payload.error.code, "EXAMINATION_REQUIRES_RETURN_VISIT");
  const returnVisitAt = new Date(Date.now() + 100).toISOString();
  const endedRound = await doctor.request(`/api/doctors/appointments/${appointmentId}/transition`, { method: "POST", csrf: true, body: { action: "COMPLETE", returnVisitRequired: true, returnVisitAt } });
  assert.equal(endedRound.payload.data.status, "AWAITING_TASKS");
  assert.equal(app.database.get("SELECT count(*) total FROM medical_records WHERE appointment_id=?", [appointmentId]).total, 1);
  const postVisit = await patient.request("/api/patient/proactive-update");
  assert.equal(postVisit.payload.data.eventType, "POST_VISIT_GUIDANCE");
  assert.equal(postVisit.payload.data.assistantActions[0].type, "POST_VISIT_SERVICE");
  assert.ok(postVisit.payload.data.assistantActions[0].journey.orders[0].destination);
  assert.match(postVisit.payload.data.message, /模拟缴费/);
  const remainingBill = postVisit.payload.data.assistantActions[0].journey.bills.find((item) => item.orderId === prescriptionOrderId);
  assert.equal(remainingBill.status, "UNPAID");
  await patient.request(`/api/patient/bills/${remainingBill.billId}/simulated-payment`, { method: "POST", body: {} });
  const examinationTask = app.database.get("SELECT task_id FROM journey_tasks WHERE order_id=?", [orderId]);
  const pharmacyTask = app.database.get("SELECT task_id FROM journey_tasks WHERE order_id=?", [prescriptionOrderId]);
  assert.equal((await patient.request(`/api/patient/tasks/${examinationTask.task_id}/complete`, { method: "POST", body: {} })).status, 200);
  assert.equal((await patient.request(`/api/patient/tasks/${pharmacyTask.task_id}/complete`, { method: "POST", body: {} })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const returnReady = await patient.request("/api/patient/proactive-update");
  assert.equal(returnReady.payload.data.eventType, "RETURN_VISIT_READY");
  const returnTask = app.database.get("SELECT task_id FROM journey_tasks WHERE appointment_id=? AND task_type='RETURN_VISIT'", [appointmentId]);
  assert.equal((await patient.request(`/api/patient/return-visits/${returnTask.task_id}/check-in`, { method: "POST", body: {} })).payload.data.status, "CHECKED_IN");
  await doctor.request(`/api/doctors/appointments/${appointmentId}/transition`, { method: "POST", csrf: true, body: { action: "CALL" } });
  await doctor.request(`/api/doctors/appointments/${appointmentId}/transition`, { method: "POST", csrf: true, body: { action: "START" } });
  const returnRecord = await doctor.request(`/api/doctors/appointments/${appointmentId}/record`);
  assert.equal(returnRecord.payload.data.recordId, recordId);
  assert.equal(returnRecord.payload.data.currentRound.roundType, "RETURN");
  const returnContent = { ...returnRecord.payload.data.doctorContent, examinationResults: "医生核对后的检查结果", chiefConcern: "患者主诉腹胀", presentIllness: "医生接诊记录", history: "", medications: "", allergies: "待核验", doctorAssessment: "医生判断内容", plan: "医生处理计划" };
  const savedReturn = await doctor.request(`/api/doctors/records/${recordId}`, { method: "PUT", csrf: true, body: { expectedVersion: returnRecord.payload.data.version, content: returnContent, changeReason: "回诊补充检查结果" } });
  assert.equal(savedReturn.payload.data.doctorContent.examinationResults, "医生核对后的检查结果");
  const completed = await doctor.request(`/api/doctors/appointments/${appointmentId}/transition`, { method: "POST", csrf: true, body: { action: "COMPLETE", returnVisitRequired: false } });
  assert.equal(completed.payload.data.status, "COMPLETED");
  const postPaymentJourney = await patient.request("/api/patient/journey");
  assert.equal(postPaymentJourney.payload.data.bills.find((item) => item.billId === remainingBill.billId).status, "PAID");
  const mapContext = await patient.request("/api/patient/map-context");
  assert.ok(mapContext.payload.data.orderDestinations.some((item) => item.orderId === prescriptionOrderId && item.locationId === "location-map-907230101452"));
  const factCount = app.database.get("SELECT count(*) total FROM patient_facts WHERE record_id=?", [recordId]).total;
  await patient.request("/api/agent/messages", { method: "POST", body: { message: "刚测量血压是160/100" } });
  assert.equal(app.database.get("SELECT count(*) total FROM patient_facts WHERE record_id=?", [recordId]).total, factCount);
  const completionNotice = await patient.request("/api/patient/proactive-update");
  assert.equal(completionNotice.payload.data.eventType, "VISIT_COMPLETED");
  assert.equal(completionNotice.payload.data.assistantActions[0].type, "MEDICAL_RECORD_EXPORT");
  const exportedRecord = await patient.raw(`/api/patient/appointments/${appointmentId}/record-export`);
  assert.equal(exportedRecord.status, 200);
  assert.match(exportedRecord.headers.get("content-disposition"), /attachment/);
  const exportedHtml = await exportedRecord.text();
  assert.match(exportedHtml, /医生核对后的检查结果/);
  assert.match(exportedHtml, /非医院正式病历/);
  const content = { chiefConcern: "腹胀", presentIllness: "", history: "", medications: "", allergies: "", examinationResults: "Agent不可编辑", doctorAssessment: "", plan: "" };
  const locked = await doctor.request(`/api/doctors/records/${recordId}`, { method: "PUT", csrf: true, body: { expectedVersion: savedReturn.payload.data.version, content, changeReason: "完成后修改" } });
  assert.equal(locked.status, 409);
  assert.equal(locked.payload.error.code, "MEDICAL_RECORD_LOCKED");
});

test("stream sends reply before end-of-turn tool cards", async () => {
  const visitor = new Client();
  await visitor.request("/api/patient/me");
  const cookieHeader = [...visitor.cookies].map(([key, value]) => `${key}=${value}`).join("; ");
  const stream = await fetch(`${baseUrl}/api/agent/messages/stream`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookieHeader }, body: JSON.stringify({ message: "我想挂号" }) });
  const body = await stream.text();
  assert.ok(body.indexOf("event: assistant.delta") > body.indexOf("event: message.accepted"));
  assert.ok(body.indexOf("event: assistant.completed") > body.indexOf("event: assistant.delta"));
  assert.ok(body.indexOf("event: assistant.actions") > body.indexOf("event: assistant.completed"));
});

test("patient end-session removes linked visit data but preserves doctor", async () => {
  const ended = await patient.request("/api/patient/session", { method: "DELETE" });
  assert.equal(ended.status, 200);
  assert.equal(app.database.get("SELECT count(*) total FROM patient_profiles").total, 1);
  assert.equal(app.database.get("SELECT count(*) total FROM appointments WHERE appointment_id=?", [appointmentId]).total, 0);
  assert.equal(app.database.get("SELECT count(*) total FROM medical_records WHERE record_id=?", [recordId]).total, 0);
  assert.equal(app.database.get("SELECT count(*) total FROM patient_sessions WHERE patient_id IS NOT NULL").total, 1);
  assert.equal(app.database.get("SELECT booked_count FROM doctor_practices WHERE practice_id=?", [practiceId]).booked_count, 1);
  assert.equal(app.database.get("SELECT count(*) total FROM doctors").total, 1);
});
