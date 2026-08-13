import { AppError, assert } from "./errors.js";
import {
  decryptText, encryptText, hashPassword, hmac, maskIdentityNumber, maskName,
  newId, randomToken, safeEqual, sha256, verifyPassword,
} from "./security.js";
import {
  requireInteger, requireString, validateChineseIdentityNumber, validateDate,
  validateEmployeeNumber, validatePassword, validateTime,
} from "./validation.js";
import { DoctorDirectoryService } from "./domain/doctor-directory.js";
import { PatientJourneyService } from "./domain/patient-journey.js";
import { PatientTaskManager } from "./domain/task-manager.js";
import { SafetyGuard } from "./domain/safety-guard.js";
import { AgentToolRegistry } from "./agent/tool-registry.js";
import { VisitCompletionService } from "./domain/visit-completion.js";
import { ConsultationService } from "./domain/consultation-service.js";
import { FulfillmentService } from "./domain/fulfillment-service.js";
import { ConversationRollbackService, isConversationUndoRequest } from "./domain/conversation-rollback.js";

const isoNow = () => new Date().toISOString();
const addHours = (date, hours) => new Date(date.valueOf() + hours * 3600_000).toISOString();
const chinaDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const json = (value) => JSON.stringify(value ?? {});
const parse = (value, fallback = {}) => { try { return JSON.parse(value); } catch { return fallback; } };
const redactSensitiveText = (value) => String(value ?? "").replace(/\b\d{17}[\dXx]\b/g, "[身份证号已隐藏]").replace(/\b1\d{10}\b/g, "[手机号已隐藏]");
const COMPOUND_SURNAMES = ["欧阳", "司马", "上官", "诸葛", "东方", "皇甫", "尉迟", "公孙", "慕容", "宇文", "司徒", "司空", "令狐", "夏侯"];
function virtualTestProfile(now = new Date()) {
  const birthYear = now.getUTCFullYear() - 65;
  const first17 = `510703${birthYear}0101001`;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"];
  const checkDigit = checks[weights.reduce((sum, weight, index) => sum + Number(first17[index]) * weight, 0) % 11];
  return { fullName: "测试患者", identityNumber: `${first17}${checkDigit}`, expectedAge: 65, expectedSex: "male" };
}

function rowToPractice(row) {
  return {
    practiceId: row.practice_id, doctorId: row.doctor_id, doctorName: row.doctor_name,
    departmentId: row.department_id, departmentName: row.department_name,
    serviceDate: row.service_date, startTime: row.start_time, endTime: row.end_time,
    capacity: row.capacity, bookedCount: row.booked_count,
    remaining: Math.max(0, row.capacity - row.booked_count), status: row.status,
  };
}

export function classifyPatientStatement(words) {
  let category = "other";
  if (/过敏|不耐受/.test(words)) category = "patientAllergies";
  else if (/吃药|服药|用药|药物/.test(words)) category = "patientMedications";
  else if (/既往|以前|曾经|病史|手术史/.test(words)) category = "patientHistory";
  else if (/想问|希望医生|担心|最想解决/.test(words)) category = "patientQuestions";
  else if (/多久|开始|持续|反复|天|周|月|年/.test(words)) category = "timeline";
  else if (/疼|痛|胀|晕|咳|喘|发热|发烧|恶心|呕吐|腹泻|便秘|麻木|瘙痒|红肿|出血|乏力|心慌|胸闷|不舒服|难受|感冒|流涕|鼻塞/.test(words)) category = "chiefConcern";
  const certainty = /可能|不确定|好像|大概|也许/.test(words) ? "UNCERTAIN" : "PATIENT_REPORTED";
  return { category, certainty };
}

const FACT_FIELD_ALIASES = new Map([
  ["chief_complaint", "chiefConcern"], ["chiefConcern", "chiefConcern"],
  ["symptoms", "symptoms"], ["timeline", "timeline"],
  ["vital_signs", "vitalSigns"], ["vitalSigns", "vitalSigns"],
  ["history", "patientHistory"], ["patientHistory", "patientHistory"],
  ["medications", "patientMedications"], ["patientMedications", "patientMedications"],
  ["allergies", "patientAllergies"], ["patientAllergies", "patientAllergies"],
  ["questions", "patientQuestions"], ["patientQuestions", "patientQuestions"],
]);

const WAITING_INFORMATION_SEQUENCE = [
  ["chiefConcern", "请问这次最主要的不舒服是什么？"],
  ["timeline", "这种不舒服大约从什么时候开始，持续了多久？"],
  ["symptoms", "还有没有同时出现的其他不适？"],
  ["patientAllergies", "您有没有需要医生注意的药物或食物过敏？"],
  ["patientHistory", "您以前有没有得过需要医生注意的疾病或做过手术？"],
  ["patientMedications", "您目前有没有正在使用的药物？"],
  ["patientQuestions", "这次见医生，您最希望解决什么问题？"],
];

const WAITING_NEGATIVE_VALUES = {
  symptoms: "患者否认伴随其他不适",
  patientAllergies: "患者否认已知药物或食物过敏",
  patientHistory: "患者否认需要特别说明的既往疾病或手术史",
  patientMedications: "患者否认目前正在使用药物",
  patientQuestions: "患者暂无其他问题",
};

function nextWaitingPrompt(confirmedFields, preferredField = null) {
  const fields = new Set(confirmedFields);
  if (preferredField && !fields.has(preferredField)) {
    const preferred = WAITING_INFORMATION_SEQUENCE.find(([field]) => field === preferredField);
    if (preferred) return { field: preferred[0], question: preferred[1] };
  }
  const next = WAITING_INFORMATION_SEQUENCE.find(([field]) => !fields.has(field));
  return next ? { field: next[0], question: next[1] } : null;
}

function deniedPendingFact(message, pendingField) {
  if (!pendingField || !WAITING_NEGATIVE_VALUES[pendingField]) return [];
  if (!/^(没有|无|没有了|目前没有|暂时没有|未发现|不清楚|不知道|记不清|想不起来)[。！!？?\s]*$/.test(String(message).trim())) return [];
  return [{ field: pendingField, normalizedValue: WAITING_NEGATIVE_VALUES[pendingField], certainty: "DENIED" }];
}

function normalizeModelFacts(facts) {
  if (!Array.isArray(facts)) return [];
  const normalized = [];
  for (const fact of facts) {
    const field = FACT_FIELD_ALIASES.get(fact?.field);
    const value = typeof fact?.normalizedValue === "string" ? redactSensitiveText(fact.normalizedValue).trim() : "";
    if (!field || !value || value.length > 500 || Number(fact.confidence) < 0.75) continue;
    normalized.push({ field, normalizedValue: value, certainty: "PATIENT_CONFIRMED" });
    if (normalized.length >= 4) break;
  }
  return normalized;
}

function clinicalItems(value) {
  return String(value ?? "")
    .replace(/^(?:患者(?:自述|主诉)?|主诉|主要(?:不适|症状)|伴随症状|其他不适)\s*[：:，,]?\s*/u, "")
    .split(/(?:、|，|,|；|;|并伴有|伴有|并有|同时(?:出现|有)?|以及|和|及)/u)
    .map((item) => item.replace(/^[：:，,。\s]+|[：:，,。\s]+$/gu, "").trim())
    .filter(Boolean);
}

function comparableClinicalItem(value) {
  return String(value ?? "").replace(/^(?:患者)?(?:主要)?(?:出现|感觉|不适为|症状为)/u, "").replace(/[\s，,。；;：:！？!?]/gu, "");
}

function deduplicateSymptomValue(value, chiefValues) {
  if (/否认|没有|无(?:明显|其他)?/u.test(value)) return value;
  const chiefItems = chiefValues.flatMap(clinicalItems).map(comparableClinicalItem).filter(Boolean);
  const seen = new Set();
  const symptoms = clinicalItems(value).filter((item) => {
    const comparable = comparableClinicalItem(item);
    if (!comparable || seen.has(comparable)) return false;
    seen.add(comparable);
    return !chiefItems.some((chief) => comparable === chief || (comparable.length >= 2 && chief.includes(comparable)));
  });
  return symptoms.length ? `伴随症状：${symptoms.join("、")}` : "";
}

export function deduplicateClinicalFacts(facts, existingChiefValues = []) {
  const chiefValues = [...existingChiefValues, ...facts.filter((item) => item?.field === "chiefConcern").map((item) => item.normalizedValue)];
  return facts.flatMap((fact) => {
    if (fact?.field !== "symptoms") return [fact];
    const normalizedValue = deduplicateSymptomValue(fact.normalizedValue, chiefValues);
    return normalizedValue ? [{ ...fact, normalizedValue }] : [];
  });
}

export function medicalRecordDraft(doctorContent, facts) {
  const draft = {
    chiefConcern: "", presentIllness: "", history: "", medications: "", allergies: "",
    examinationResults: "", doctorAssessment: "", plan: "", ...doctorContent,
  };
  const mapping = {
    chiefConcern: "chiefConcern", symptoms: "presentIllness", timeline: "presentIllness",
    vitalSigns: "presentIllness", patientHistory: "history", patientMedications: "medications",
    patientAllergies: "allergies", patientQuestions: "presentIllness",
  };
  const grouped = new Map();
  for (const fact of facts) {
    const target = mapping[fact.field];
    if (!target) continue;
    const value = `${fact.certainty === "UNCERTAIN" ? "[待核实] " : ""}${fact.normalized_value}`;
    if (!grouped.has(target)) grouped.set(target, []);
    if (!grouped.get(target).includes(value)) grouped.get(target).push(value);
  }
  const agentPrefilledFields = [];
  for (const [field, values] of grouped) {
    if (Object.hasOwn(doctorContent, field)) continue;
    draft[field] = values.join("\n");
    agentPrefilledFields.push(field);
  }
  return { draft, agentPrefilledFields };
}

function localFactCandidates(words) {
  const text = redactSensitiveText(words).trim();
  const uncertain = /可能|不确定|好像|大概|也许/.test(text);
  const certainty = uncertain ? "UNCERTAIN" : "PATIENT_CONFIRMED";
  const facts = [];
  const push = (field, normalizedValue) => {
    if (normalizedValue && !facts.some((item) => item.field === field && item.normalizedValue === normalizedValue)) facts.push({ field, normalizedValue, certainty });
  };
  const allergy = text.match(/(?:对)?([\u4e00-\u9fa5A-Za-z0-9-]{1,20})(?:可能)?过敏/);
  if (allergy) push("patientAllergies", `${uncertain ? "可能" : ""}对${allergy[1]}过敏`);
  const duration = text.match(/(?:约|大约|已经|持续|反复)?([一二三四五六七八九十百两\d]+(?:个)?(?:小时|天|周|月|年))/);
  if (duration) push("timeline", `持续时间：${duration[1]}`);
  const bloodPressure = text.match(/血压(?:是|为|测得|测了)?\s*(\d{2,3})\s*[/／]\s*(\d{2,3})(?:\s*mmhg)?/i)
    ?? text.match(/(?:高压|收缩压)\s*(\d{2,3})[^\d]{0,12}(?:低压|舒张压)\s*(\d{2,3})/);
  if (bloodPressure) push("vitalSigns", `血压：${bloodPressure[1]}/${bloodPressure[2]} mmHg`);
  const temperature = text.match(/(?:体温|温度)(?:是|为|测得)?\s*(\d{2}(?:\.\d)?)\s*(?:℃|度)?/);
  if (temperature) push("vitalSigns", `体温：${temperature[1]}℃`);
  const histories = ["高血压", "糖尿病", "冠心病", "哮喘", "胃炎", "肾病"].filter((term) => text.includes(term));
  if (histories.length) push("patientHistory", `既往情况：${histories.join("、")}`);
  const symptoms = ["腹胀", "胃胀", "头痛", "头晕", "胸痛", "胸闷", "心慌", "咳嗽", "咳痰", "发热", "发烧", "恶心", "呕吐", "腹泻", "便秘", "麻木", "乏力", "瘙痒", "红肿", "出血"].filter((term) => text.includes(term));
  if (symptoms.length) push("chiefConcern", `主要不适：${symptoms.join("、")}`);
  return facts.slice(0, 4);
}

export class HospitalService {
  constructor(db, knowledge, config, departmentRouter = null) {
    this.db = db;
    this.knowledge = knowledge;
    this.config = config;
    this.departmentRouter = departmentRouter;
    this.doctorDirectory = new DoctorDirectoryService(knowledge);
    this.journeyService = new PatientJourneyService(db, knowledge);
    this.taskManager = new PatientTaskManager();
    this.visitCompletion = new VisitCompletionService(db);
    this.consultationService = new ConsultationService(db, this.visitCompletion);
    this.fulfillmentService = new FulfillmentService(db, this.consultationService, this.visitCompletion);
    this.safetyGuard = new SafetyGuard(db, this.audit.bind(this));
    this.conversationRollback = new ConversationRollbackService(db, this.audit.bind(this));
    this.toolRegistry = new AgentToolRegistry({
      doctorDirectory: this.doctorDirectory,
      journeyService: this.journeyService,
      taskManager: this.taskManager,
    });
    this.knowledge.seed(db);
    this.cleanupExpiredPatients();
  }

  ensureWorkflowState(sessionId) {
    if (!this.db.get(`SELECT session_id FROM conversation_workflow_states WHERE session_id=:session`, { session: sessionId })) {
      this.db.run(`INSERT INTO conversation_workflow_states(session_id,revision,active_task_type,active_task_status,pending_field,last_question,suspended_tasks_json,recommended_departments_json,updated_at) VALUES(:session,0,'UNDERSTAND_REQUEST','READY',NULL,NULL,'[]','[]',:updated)`, { session: sessionId, updated: isoNow() });
    }
  }

  workflowState(sessionId) {
    this.ensureWorkflowState(sessionId);
    const row = this.db.get(`SELECT * FROM conversation_workflow_states WHERE session_id=:session`, { session: sessionId });
    return {
      revision: row.revision, activeTaskType: row.active_task_type, activeTaskStatus: row.active_task_status,
      pendingField: row.pending_field, lastQuestion: row.last_question,
      suspendedTasks: parse(row.suspended_tasks_json, []),
      recommendedDepartments: parse(row.recommended_departments_json, []),
    };
  }

  updateWorkflowState(sessionId, patch) {
    const current = this.workflowState(sessionId);
    this.db.run(`UPDATE conversation_workflow_states SET revision=:revision,active_task_type=:task,active_task_status=:status,pending_field=:field,last_question=:question,suspended_tasks_json=:suspended,recommended_departments_json=:recommended,updated_at=:updated WHERE session_id=:session`, {
      revision: current.revision + 1, task: patch.activeTaskType ?? current.activeTaskType, status: patch.activeTaskStatus ?? current.activeTaskStatus,
      field: Object.hasOwn(patch, "pendingField") ? patch.pendingField : current.pendingField,
      question: Object.hasOwn(patch, "lastQuestion") ? patch.lastQuestion : current.lastQuestion,
      suspended: json(patch.suspendedTasks ?? current.suspendedTasks),
      recommended: json(Object.hasOwn(patch, "recommendedDepartments") ? patch.recommendedDepartments : current.recommendedDepartments),
      updated: isoNow(), session: sessionId,
    });
  }

  validWorkflowRecommendations(workflow) {
    return (workflow.recommendedDepartments ?? []).filter((recommendation) => {
      const department = this.knowledge.departments.find((item) => item.departmentId === recommendation.departmentId);
      return department && this.knowledge.isBookingEligible(department) && Number(recommendation.confidence) >= 0.8;
    }).slice(0, 2);
  }

  confirmedFactFields(sessionId) {
    return this.db.all(`SELECT DISTINCT field FROM patient_facts WHERE session_id=:session AND status='CONFIRMED'`, { session: sessionId }).map((row) => row.field);
  }

  nextWaitingPrompt(sessionId, preferredField = null) {
    return nextWaitingPrompt(this.confirmedFactFields(sessionId), preferredField);
  }

  doctorOrderCatalog() {
    return this.knowledge.orderCatalogForDoctor();
  }

  audit(actorType, actorId, action, entityType, entityId, detail = {}) {
    this.db.run(`INSERT INTO audit_events VALUES(:id,:actorType,:actorId,:action,:entityType,:entityId,:detail,:createdAt)`, {
      id: newId("audit"), actorType, actorId: actorId ?? null, action, entityType, entityId,
      detail: json(detail), createdAt: isoNow(),
    });
  }

  getOrCreatePatientSession(token) {
    const now = isoNow();
    if (token) {
      const row = this.db.get(`SELECT * FROM patient_sessions WHERE token_hash=:hash AND revoked_at IS NULL AND expires_at>:now`, { hash: sha256(token), now });
      if (row) {
        this.ensureWorkflowState(row.session_id);
        const expiresAt = addHours(new Date(), this.config.patientRetentionHours);
        this.db.run(`UPDATE patient_sessions SET last_active_at=:now,expires_at=:expires WHERE session_id=:id`, { now, expires: expiresAt, id: row.session_id });
        if (row.patient_id) this.db.run(`UPDATE patient_profiles SET last_active_at=:now,expires_at=:expires WHERE patient_id=:id`, { now, expires: expiresAt, id: row.patient_id });
        return { row: { ...row, last_active_at: now, expires_at: expiresAt }, token, created: false };
      }
    }
    const newToken = randomToken();
    const row = {
      session_id: newId("session"), token_hash: sha256(newToken), patient_id: null,
      current_stage: "PRE_VISIT", created_at: now, last_active_at: now,
      expires_at: addHours(new Date(), this.config.patientRetentionHours), revoked_at: null,
    };
    this.db.run(`INSERT INTO patient_sessions VALUES(:session_id,:token_hash,:patient_id,:current_stage,:created_at,:last_active_at,:expires_at,:revoked_at)`, row);
    this.ensureWorkflowState(row.session_id);
    return { row, token: newToken, created: true };
  }

  patientSummary(session) {
    if (!session.patient_id) return { hasProfile: false, currentStage: session.current_stage, retentionHours: this.config.patientRetentionHours };
    const patient = this.db.get(`SELECT * FROM patient_profiles WHERE patient_id=:id`, { id: session.patient_id });
    if (!patient) return { hasProfile: false, retentionHours: this.config.patientRetentionHours };
    return {
      hasProfile: true, expiresAt: patient.expires_at,
      currentStage: session.current_stage,
      retentionHours: this.config.patientRetentionHours,
    };
  }

  patientSalutation(session) {
    if (!session.patient_id) return "";
    const patient = this.db.get(`SELECT full_name_encrypted,sex FROM patient_profiles WHERE patient_id=:id`, { id: session.patient_id });
    if (!patient) return "";
    const fullName = decryptText(patient.full_name_encrypted, this.config.encryptionKey);
    const surname = COMPOUND_SURNAMES.find((item) => fullName.startsWith(item)) ?? [...fullName][0] ?? "";
    return surname ? `${surname}${patient.sex === "male" ? "先生" : "女士"}` : "";
  }

  createPatientProfile(session, input) {
    assert(!session.patient_id, 409, "PROFILE_ALREADY_EXISTS");
    assert(input?.manualEntry === true, 422, "MANUAL_ENTRY_REQUIRED");
    const fullName = requireString(input.fullName, "姓名", 2, 50);
    const identity = validateChineseIdentityNumber(input.identityNumber);
    return this.persistPatientProfile(session, { fullName, identity, verificationStatus: "SELF_DECLARED", virtualTestProfile: false });
  }

  createVirtualPatientProfile(session) {
    assert(!session.patient_id, 409, "PROFILE_ALREADY_EXISTS");
    const profile = virtualTestProfile();
    const identity = validateChineseIdentityNumber(profile.identityNumber, profile.expectedAge, profile.expectedSex);
    return this.persistPatientProfile(session, { fullName: profile.fullName, identity, verificationStatus: "VIRTUAL_TEST", virtualTestProfile: true });
  }

  persistPatientProfile(session, { fullName, identity, verificationStatus, virtualTestProfile }) {
    const now = isoNow();
    const patientId = newId("patient");
    const expires = addHours(new Date(), this.config.patientRetentionHours);
    this.db.transaction(() => {
      this.db.run(`INSERT INTO patient_profiles VALUES(:id,:name,:nameMask,:identity,:digest,:identityMask,:sex,:age,:birth,:verification,1,:created,:active,:expires)`, {
        id: patientId, name: encryptText(fullName, this.config.encryptionKey), nameMask: maskName(fullName),
        identity: encryptText(identity.value, this.config.encryptionKey), digest: hmac(identity.value, this.config.encryptionKey),
        identityMask: maskIdentityNumber(identity.value), sex: identity.sex, age: identity.age, birth: identity.birthDate,
        verification: verificationStatus, created: now, active: now, expires,
      });
      this.db.run(`UPDATE patient_sessions SET patient_id=:patientId,current_stage='APPOINTMENT' WHERE session_id=:sessionId`, { patientId, sessionId: session.session_id });
      this.audit("PATIENT", patientId, "PATIENT_PROFILE_CREATED", "patient_profile", patientId, { manualEntry: !virtualTestProfile, verificationStatus, virtualTestProfile });
    });
    return { ...this.patientSummary({ ...session, patient_id: patientId }), profileSource: verificationStatus, virtualTestProfile };
  }

  previewPatientIdentity(input) {
    validateChineseIdentityNumber(input.identityNumber);
    return { valid: true };
  }

  endPatientSession(session) {
    const now = isoNow();
    this.db.run(`UPDATE patient_sessions SET revoked_at=:now WHERE session_id=:id`, { now, id: session.session_id });
    if (session.patient_id) {
      this.audit("PATIENT", session.patient_id, "PATIENT_SESSION_ENDED", "patient_session", session.session_id);
      this.deletePatientData(session.patient_id);
    }
  }

  deletePatientData(patientId) {
    const releaseCounts = this.db.all(`SELECT practice_id,count(*) amount FROM appointments WHERE patient_id=:id AND status NOT IN ('CANCELLED','COMPLETED') GROUP BY practice_id`, { id: patientId });
    this.db.transaction(() => {
      for (const item of releaseCounts) this.db.run(`UPDATE doctor_practices SET booked_count=MAX(0,booked_count-:amount) WHERE practice_id=:practice`, { amount: item.amount, practice: item.practice_id });
      this.db.run(`DELETE FROM patient_sessions WHERE patient_id=:id`, { id: patientId });
      this.db.run(`DELETE FROM patient_profiles WHERE patient_id=:id`, { id: patientId });
    });
  }

  cleanupExpiredPatients() {
    const now = isoNow();
    const expired = this.db.all(`SELECT patient_id FROM patient_profiles WHERE expires_at<=:now`, { now });
    for (const patient of expired) this.deletePatientData(patient.patient_id);
    this.db.run(`DELETE FROM patient_sessions WHERE expires_at<=:now OR revoked_at IS NOT NULL`, { now });
  }

  registerDoctor(input) {
    const displayName = requireString(input.displayName, "医生姓名", 2, 50);
    const employeeNumber = validateEmployeeNumber(input.employeeNumber);
    const password = validatePassword(input.password);
    const existing = this.db.get(`SELECT doctor_id FROM doctors WHERE employee_number=:employee`, { employee: employeeNumber });
    assert(!existing, 409, "DOCTOR_ACCOUNT_EXISTS", "该工号已被注册");
    const doctorId = newId("doctor");
    const now = isoNow();
    const verificationNotice = "演示系统内账号申请，须由系统管理员审核激活";
    this.db.run(`INSERT INTO doctors(doctor_id,display_name,employee_number,password_hash,account_status,verification_notice,failed_login_count,locked_until,created_at) VALUES(:id,:name,:employee,:password,'PENDING_REVIEW',:notice,0,NULL,:created)`, {
      id: doctorId, name: displayName, employee: employeeNumber,
      password: hashPassword(password),
      notice: verificationNotice, created: now,
    });
    this.audit("DOCTOR", doctorId, "DOCTOR_REGISTERED", "doctor_account", doctorId, { status: "PENDING_REVIEW" });
    return { doctorId, accountStatus: "PENDING_REVIEW", verificationNotice };
  }

  administratorSetupStatus() {
    return { initialized: this.db.get(`SELECT count(*) total FROM administrators`).total > 0 };
  }

  initializeAdministrator(input) {
    assert(!this.administratorSetupStatus().initialized, 409, "ADMINISTRATOR_ALREADY_INITIALIZED", "管理员已初始化");
    const displayName = requireString(input.displayName, "管理员姓名", 2, 50);
    const employeeNumber = validateEmployeeNumber(input.employeeNumber);
    const password = validatePassword(input.password);
    const administratorId = newId("administrator");
    this.db.transaction(() => {
      assert(!this.administratorSetupStatus().initialized, 409, "ADMINISTRATOR_ALREADY_INITIALIZED", "管理员已经初始化");
      this.db.run(`INSERT INTO administrators VALUES(:id,:employee,:name,:password,'ACTIVE',0,NULL,:created)`, {
        id: administratorId, employee: employeeNumber, name: displayName,
        password: hashPassword(password), created: isoNow(),
      });
      this.audit("ADMINISTRATOR", administratorId, "ADMINISTRATOR_INITIALIZED", "administrator", administratorId);
    });
    return { administratorId, employeeNumber, displayName };
  }

  loginAdministrator(input) {
    const employeeNumber = validateEmployeeNumber(input.employeeNumber);
    const password = requireString(input.password, "密码", 8, 128);
    const now = isoNow();
    const administrator = this.db.get(`SELECT * FROM administrators WHERE employee_number=:employee`, { employee: employeeNumber });
    assert(administrator, 401, "INVALID_CREDENTIALS", "工号或密码错误");
    assert(!administrator.locked_until || administrator.locked_until <= now, 429, "ACCOUNT_TEMPORARILY_LOCKED", "登录失败次数过多，请稍后再试");
    if (!verifyPassword(password, administrator.password_hash)) {
      const failures = administrator.failed_login_count + 1;
      const lockedUntil = failures >= 5 ? addHours(new Date(), 0.25) : null;
      this.db.run(`UPDATE administrators SET failed_login_count=:failures,locked_until=:locked WHERE administrator_id=:id`, { failures, locked: lockedUntil, id: administrator.administrator_id });
      throw new AppError(401, "INVALID_CREDENTIALS", "工号或密码错误");
    }
    assert(administrator.account_status === "ACTIVE", 403, "ADMINISTRATOR_NOT_ACTIVE", "管理员账号已停用");
    const sessionId = newId("administrator-session");
    const token = randomToken();
    const csrfToken = hmac(sessionId, this.config.encryptionKey);
    this.db.transaction(() => {
      this.db.run(`UPDATE administrators SET failed_login_count=0,locked_until=NULL WHERE administrator_id=:id`, { id: administrator.administrator_id });
      this.db.run(`INSERT INTO administrator_sessions VALUES(:id,:administrator,:token,:csrf,:created,:expires,NULL)`, {
        id: sessionId, administrator: administrator.administrator_id, token: sha256(token), csrf: sha256(csrfToken),
        created: now, expires: addHours(new Date(), this.config.administratorSessionHours),
      });
      this.audit("ADMINISTRATOR", administrator.administrator_id, "ADMINISTRATOR_LOGIN", "administrator_session", sessionId);
    });
    return { token, csrfToken, administrator: this.administratorPublic(administrator) };
  }

  administratorPublic(row) {
    return { administratorId: row.administrator_id, employeeNumber: row.employee_number, displayName: row.display_name };
  }

  requireAdministrator(token) {
    assert(token, 401, "ADMINISTRATOR_AUTH_REQUIRED", "请先登录管理员工作台");
    const row = this.db.get(`SELECT s.*,a.* FROM administrator_sessions s JOIN administrators a ON a.administrator_id=s.administrator_id WHERE s.token_hash=:hash AND s.revoked_at IS NULL AND s.expires_at>:now`, { hash: sha256(token), now: isoNow() });
    assert(row && row.account_status === "ACTIVE", 401, "ADMINISTRATOR_SESSION_INVALID", "管理员会话已失效，请重新登录");
    return row;
  }

  csrfForAdministratorSession(session) { return hmac(session.session_id, this.config.encryptionKey); }

  listDoctorsForAdministrator() {
    return this.db.all(`SELECT doctor_id,display_name,employee_number,account_status,verification_notice,created_at FROM doctors ORDER BY created_at DESC`).map((row) => ({
      doctorId: row.doctor_id, displayName: row.display_name, employeeNumber: row.employee_number,
      accountStatus: row.account_status, verificationNotice: row.verification_notice, createdAt: row.created_at,
    }));
  }

  reviewDoctor(administrator, doctorId, status) {
    assert(["ACTIVE", "SUSPENDED"].includes(status), 422, "VALIDATION_ERROR", "审核状态无效");
    const doctor = this.db.get(`SELECT * FROM doctors WHERE doctor_id=:id`, { id: doctorId });
    assert(doctor, 404, "DOCTOR_NOT_FOUND", "医生账号不存在");
    this.db.run(`UPDATE doctors SET account_status=:status,verification_notice=:notice WHERE doctor_id=:id`, {
      status, id: doctorId, notice: status === "ACTIVE" ? "已激活的医生账号" : "已停用该医生账号",
    });
    this.audit("ADMINISTRATOR", administrator.administrator_id, "DOCTOR_ACCOUNT_REVIEWED", "doctor_account", doctorId, { from: doctor.account_status, to: status });
    return { doctorId, accountStatus: status };
  }

  logoutAdministrator(session) {
    this.db.run(`UPDATE administrator_sessions SET revoked_at=:now WHERE session_id=:id`, { now: isoNow(), id: session.session_id });
    this.audit("ADMINISTRATOR", session.administrator_id, "ADMINISTRATOR_LOGOUT", "administrator_session", session.session_id);
  }

  loginDoctor(input) {
    const employeeNumber = validateEmployeeNumber(input.employeeNumber);
    const password = requireString(input.password, "密码", 8, 128);
    const now = isoNow();
    const doctor = this.db.get(`SELECT * FROM doctors WHERE employee_number=:employee`, { employee: employeeNumber });
    assert(doctor, 401, "INVALID_CREDENTIALS", "工号或密码错误");
    assert(!doctor.locked_until || doctor.locked_until <= now, 429, "ACCOUNT_TEMPORARILY_LOCKED", "登录失败次数过多，请稍后再试");
    if (!verifyPassword(password, doctor.password_hash)) {
      const failures = doctor.failed_login_count + 1;
      const lockedUntil = failures >= 5 ? addHours(new Date(), 0.25) : null;
      this.db.run(`UPDATE doctors SET failed_login_count=:failures,locked_until=:locked WHERE doctor_id=:id`, { failures, locked: lockedUntil, id: doctor.doctor_id });
      throw new AppError(401, "INVALID_CREDENTIALS", "工号或密码错误");
    }
    assert(doctor.account_status === "ACTIVE", 403, "DOCTOR_NOT_ACTIVE", doctor.account_status === "PENDING_REVIEW" ? "账号仍在等待审核" : "账号已停用");
    const sessionId = newId("doctor-session");
    const token = randomToken();
    const csrfToken = hmac(sessionId, this.config.encryptionKey);
    this.db.transaction(() => {
      this.db.run(`UPDATE doctors SET failed_login_count=0,locked_until=NULL WHERE doctor_id=:id`, { id: doctor.doctor_id });
      this.db.run(`INSERT INTO doctor_sessions VALUES(:id,:doctor,:token,:csrf,:created,:expires,NULL)`, {
        id: sessionId, doctor: doctor.doctor_id, token: sha256(token), csrf: sha256(csrfToken),
        created: now, expires: addHours(new Date(), this.config.doctorSessionHours),
      });
      this.audit("DOCTOR", doctor.doctor_id, "DOCTOR_LOGIN", "doctor_session", sessionId);
    });
    return { token, csrfToken, doctor: this.doctorPublic(doctor) };
  }

  doctorPublic(doctor) {
    return { doctorId: doctor.doctor_id, displayName: doctor.display_name, employeeNumber: doctor.employee_number, accountStatus: doctor.account_status, verificationNotice: doctor.verification_notice };
  }

  requireDoctor(token) {
    assert(token, 401, "DOCTOR_AUTH_REQUIRED", "请先登录");
    const row = this.db.get(`SELECT s.*,d.* FROM doctor_sessions s JOIN doctors d ON d.doctor_id=s.doctor_id WHERE s.token_hash=:hash AND s.revoked_at IS NULL AND s.expires_at>:now`, { hash: sha256(token), now: isoNow() });
    assert(row && row.account_status === "ACTIVE", 401, "DOCTOR_SESSION_INVALID", "医生会话已失效，请重新登录");
    return row;
  }

  requireCsrf(doctorSession, token) {
    assert(token && safeEqual(sha256(token), doctorSession.csrf_hash), 403, "CSRF_CHECK_FAILED", "安全校验失败，请刷新后重试");
  }

  csrfForDoctorSession(doctorSession) {
    return hmac(doctorSession.session_id, this.config.encryptionKey);
  }

  logoutDoctor(doctorSession) {
    this.db.run(`UPDATE doctor_sessions SET revoked_at=:now WHERE session_id=:id`, { now: isoNow(), id: doctorSession.session_id });
    this.audit("DOCTOR", doctorSession.doctor_id, "DOCTOR_LOGOUT", "doctor_session", doctorSession.session_id);
  }

  createPractice(doctor, input) {
    const departmentId = requireString(input.departmentId, "科室", 1, 100);
    assert(this.db.get(`SELECT department_id FROM departments WHERE department_id=:id`, { id: departmentId }), 422, "UNKNOWN_DEPARTMENT", "科室不存在");
    const serviceDate = validateDate(input.serviceDate, "出诊日期");
    assert(serviceDate >= chinaDate(), 422, "PAST_PRACTICE_DATE", "不能发布过去日期的号源");
    const startTime = validateTime(input.startTime, "开始时间");
    const endTime = validateTime(input.endTime, "结束时间");
    assert(endTime > startTime, 422, "INVALID_TIME_RANGE", "结束时间必须晚于开始时间");
    const capacity = requireInteger(input.capacity, "号源数量", 1, 200);
    const status = input.status === "SUSPENDED" ? "SUSPENDED" : "ACTIVE";
    const id = newId("practice");
    try {
      this.db.run(`INSERT INTO doctor_practices VALUES(:id,:doctor,:department,:date,:start,:end,:capacity,0,:status,:created)`, { id, doctor: doctor.doctor_id, department: departmentId, date: serviceDate, start: startTime, end: endTime, capacity, status, created: isoNow() });
    } catch (error) {
      const uniqueViolation = error.code === "23505" || (error.code === "ERR_SQLITE_ERROR" && String(error.message).includes("UNIQUE"));
      if (uniqueViolation) throw new AppError(409, "PRACTICE_ALREADY_EXISTS", "相同科室和时段的出诊安排已存在");
      throw error;
    }
    this.audit("DOCTOR", doctor.doctor_id, "PRACTICE_CREATED", "doctor_practice", id, { departmentId, serviceDate, startTime, endTime, capacity, status });
    return { practiceId: id, departmentId, serviceDate, startTime, endTime, capacity, bookedCount: 0, remaining: capacity, status };
  }

  listPractices(filters = {}, doctorId = null) {
    const clauses = ["1=1"];
    const params = {};
    if (filters.departmentId) { clauses.push("p.department_id=:departmentId"); params.departmentId = filters.departmentId; }
    if (filters.date) { clauses.push("p.service_date=:date"); params.date = filters.date; }
    if (doctorId) { clauses.push("p.doctor_id=:doctorId"); params.doctorId = doctorId; }
    else clauses.push("p.status='ACTIVE'");
    return this.db.all(`SELECT p.*,d.display_name doctor_name,dp.display_name department_name FROM doctor_practices p JOIN doctors d ON d.doctor_id=p.doctor_id JOIN departments dp ON dp.department_id=p.department_id WHERE ${clauses.join(" AND ")} ORDER BY p.service_date,p.start_time`, params).map(rowToPractice);
  }

  updatePracticeStatus(doctor, practiceId, status) {
    assert(["ACTIVE", "SUSPENDED"].includes(status), 422, "VALIDATION_ERROR", "出诊状态无效");
    const row = this.db.get(`SELECT * FROM doctor_practices WHERE practice_id=:id AND doctor_id=:doctor`, { id: practiceId, doctor: doctor.doctor_id });
    assert(row, 404, "PRACTICE_NOT_FOUND", "出诊安排不存在或无权操作");
    this.db.run(`UPDATE doctor_practices SET status=:status WHERE practice_id=:id`, { status, id: practiceId });
    this.audit("DOCTOR", doctor.doctor_id, "PRACTICE_STATUS_CHANGED", "doctor_practice", practiceId, { from: row.status, to: status });
    return { practiceId, status };
  }

  preparePatientAction(session, input) {
    const actionType = requireString(input.actionType, "操作类型", 1, 50);
    assert(["CREATE_APPOINTMENT", "CANCEL_APPOINTMENT", "CHANGE_APPOINTMENT"].includes(actionType), 422, "UNKNOWN_ACTION", "不支持的操作类型");
    assert(session.patient_id, 422, "PATIENT_PROFILE_REQUIRED", "执行该操作前请先完成患者建档");
    const parameters = input.parameters && typeof input.parameters === "object" ? input.parameters : {};
    let summary;
    if (actionType === "CREATE_APPOINTMENT") {
      const existingAppointments = this.activePatientAppointments(session);
      if (existingAppointments.length) {
        const journey = this.patientJourney(session);
        return {
          actionType, status: "EXISTING_APPOINTMENT", requiresExplicitConfirmation: false,
          existingAppointment: existingAppointments[0],
          journey: { appointments: existingAppointments.slice(0, 3), orders: journey.orders.slice(0, 3), tasks: journey.tasks.filter((item) => item.status === "PENDING").slice(0, 3), bills: journey.bills.slice(0, 3) },
        };
      }
      const practiceId = requireString(parameters.practiceId, "号源", 1, 100);
      const practice = this.db.get(`SELECT p.*,d.display_name doctor_name,dp.display_name department_name FROM doctor_practices p JOIN doctors d ON d.doctor_id=p.doctor_id JOIN departments dp ON dp.department_id=p.department_id WHERE p.practice_id=:id`, { id: practiceId });
      assert(practice && practice.status === "ACTIVE" && practice.service_date >= chinaDate(), 409, "PRACTICE_UNAVAILABLE", "该出诊时段当前不可挂号");
      const fee = this.knowledge.orderCatalog.registration;
      summary = `确认挂号：${practice.service_date} ${practice.start_time}-${practice.end_time}，${practice.department_name}，${practice.doctor_name}医生；确认后需模拟支付挂号费 ¥${(fee.amountCents / 100).toFixed(2)}`;
    } else {
      const appointmentId = requireString(parameters.appointmentId, "挂号记录", 1, 100);
      const appointment = this.db.get(`SELECT appointment_id FROM appointments WHERE appointment_id=:id AND patient_id=:patient`, { id: appointmentId, patient: session.patient_id });
      assert(appointment, 404, "APPOINTMENT_NOT_FOUND", "挂号不存在");
      summary = actionType === "CANCEL_APPOINTMENT" ? "确认退号并释放号源" : "确认更换挂号时段";
      if (actionType === "CHANGE_APPOINTMENT") requireString(parameters.practiceId, "目标号源", 1, 100);
    }
    const actionId = newId("action");
    const now = isoNow();
    this.db.run(`INSERT INTO pending_actions VALUES(:id,:session,:type,:parameters,:summary,'PENDING',:created,:expires,NULL)`, { id: actionId, session: session.session_id, type: actionType, parameters: json(parameters), summary, created: now, expires: new Date(Date.now() + 10 * 60_000).toISOString() });
    return { actionId, actionType, summary, requiresExplicitConfirmation: true, parameters };
  }

  confirmPatientAction(session, actionId) {
    const id = requireString(actionId, "待确认操作", 1, 100);
    const action = this.db.get(`SELECT * FROM pending_actions WHERE action_id=:id AND session_id=:session`, { id, session: session.session_id });
    assert(action, 404, "PENDING_ACTION_NOT_FOUND", "待确认操作不存在");
    assert(action.status === "PENDING" && action.expires_at > isoNow(), 409, "PENDING_ACTION_EXPIRED", "该确认已失效，请重新发起操作");
    const parameters = parse(action.parameters_json);
    let result;
    if (action.action_type === "CREATE_APPOINTMENT") result = this.createAppointment(session, parameters, true);
    else if (action.action_type === "CANCEL_APPOINTMENT") result = this.cancelAppointment(session, parameters.appointmentId, true);
    else if (action.action_type === "CHANGE_APPOINTMENT") result = this.rescheduleAppointment(session, parameters.appointmentId, parameters.practiceId, true);
    else throw new AppError(422, "UNKNOWN_ACTION", "不支持的确认操作");
    this.db.run(`UPDATE pending_actions SET status='CONFIRMED',confirmed_at=:now WHERE action_id=:id`, { now: isoNow(), id });
    this.replaceLatestAssistantActions(session, [{
      type: "JOURNEY_STATUS", tool: "get_patient_journey", title: action.action_type === "CREATE_APPOINTMENT" ? "挂号成功，查看就诊安排" : "就诊安排已更新",
      journey: this.patientJourney(session),
    }]);
    return { actionId: id, actionType: action.action_type, result };
  }

  createAppointment(session, input, confirmed = false) {
    assert(confirmed, 428, "EXPLICIT_CONFIRMATION_REQUIRED", "挂号前必须先生成待确认操作并由患者明确确认");
    assert(session.patient_id, 422, "PATIENT_PROFILE_REQUIRED", "请先填写姓名和身份证号");
    const practiceId = requireString(input.practiceId, "号源", 1, 100);
    const appointmentId = newId("appointment");
    const now = isoNow();
    const result = this.db.transaction(() => {
      const practice = this.db.get(`SELECT * FROM doctor_practices WHERE practice_id=:id`, { id: practiceId });
      assert(practice && practice.status === "ACTIVE", 409, "PRACTICE_UNAVAILABLE", "该出诊时段当前不可挂号，请选择其他时段");
      assert(practice.service_date >= chinaDate(), 409, "PRACTICE_EXPIRED", "该出诊时段已过期，请选择其他时段");
      const duplicate = this.db.get(`SELECT a.appointment_id FROM appointments a JOIN doctor_practices p ON p.practice_id=a.practice_id WHERE a.patient_id=:patient AND a.department_id=:department AND p.service_date=:date AND a.status NOT IN ('CANCELLED','COMPLETED')`, { patient: session.patient_id, department: practice.department_id, date: practice.service_date });
      assert(!duplicate, 409, "DUPLICATE_DEPARTMENT_APPOINTMENT", "同一患者同一天不能重复挂同一科室；如需调整，请先退号或使用换号功能");
      const updated = this.db.run(`UPDATE doctor_practices SET booked_count=booked_count+1 WHERE practice_id=:id AND status='ACTIVE' AND booked_count<capacity`, { id: practiceId });
      assert(updated.changes === 1, 409, "SLOT_FULL", "该时段号源已满，请更换医生或时段");
      const queueNumber = practice.booked_count + 1;
      this.db.run(`INSERT INTO appointments VALUES(:id,:patient,:practice,:doctor,:department,'PENDING_PAYMENT',:queue,:created,:updated)`, { id: appointmentId, patient: session.patient_id, practice: practiceId, doctor: practice.doctor_id, department: practice.department_id, queue: queueNumber, created: now, updated: now });
      const recordId = newId("record");
      this.db.run(`INSERT INTO medical_records VALUES(:id,:appointment,:patient,:doctor,:department,1,'{}',:created,:updated)`, { id: recordId, appointment: appointmentId, patient: session.patient_id, doctor: practice.doctor_id, department: practice.department_id, created: now, updated: now });
      this.db.run(`INSERT INTO medical_record_versions VALUES(:id,:record,1,'{}','SYSTEM','初始建档',:created)`, { id: newId("record-version"), record: recordId, created: now });
      this.attachConfirmedFacts(session.session_id, recordId);
      const registration = this.knowledge.orderCatalog.registration;
      const billId = newId("bill");
      this.db.run(`INSERT INTO bills(bill_id,appointment_id,order_id,amount_cents,bill_type,title,status,guidance,created_at,paid_at) VALUES(:id,:appointment,NULL,:amount,'REGISTRATION',:title,'UNPAID','演示挂号费；可在患者对话中完成模拟支付，不会发生真实扣款。',:created,NULL)`, {
        id: billId, appointment: appointmentId, amount: registration.amountCents, title: registration.name, created: now,
      });
      this.db.run(`INSERT INTO journey_tasks(task_id,appointment_id,task_type,status,title,blocks_completion,created_at) VALUES(:id,:appointment,'REGISTRATION_PAYMENT','PENDING','完成挂号费模拟支付',1,:created)`, { id: newId("task"), appointment: appointmentId, created: now });
      this.audit("PATIENT", session.patient_id, "APPOINTMENT_CREATED", "appointment", appointmentId, { practiceId, queueNumber, status: "PENDING_PAYMENT", registrationBillId: billId });
      return { appointmentId, recordId, queueNumber, status: "PENDING_PAYMENT", registrationBillId: billId, simulationNotice: "挂号费为演示数据，支付不会产生真实扣款" };
    });
    return result;
  }

  attachConfirmedFacts(sessionId, recordId) {
    this.db.run(`UPDATE patient_facts SET record_id=:record WHERE session_id=:session AND status='CONFIRMED' AND record_id IS NULL`, { record: recordId, session: sessionId });
  }

  writeStructuredFacts(session, sourceTurnId, facts) {
    if (!facts.length) return { status: "NO_FACTS", writtenCount: 0 };
    const appointment = session.patient_id ? this.db.get(`SELECT a.status,r.record_id FROM appointments a JOIN medical_records r ON r.appointment_id=a.appointment_id WHERE a.patient_id=:patient AND a.status IN ('PENDING_PAYMENT','BOOKED','CHECKED_IN','CALLED','IN_CONSULTATION','AWAITING_TASKS') ORDER BY a.updated_at DESC LIMIT 1`, { patient: session.patient_id }) : null;
    if (appointment?.status === "IN_CONSULTATION" || (!appointment && session.current_stage === "COMPLETED")) {
      return { status: "RECORD_LOCKED", writtenCount: 0 };
    }
    const recordId = appointment && ["PENDING_PAYMENT", "BOOKED", "CHECKED_IN", "CALLED", "AWAITING_TASKS"].includes(appointment.status) ? appointment.record_id : null;
    const recordClause = recordId ? "AND record_id=:record" : "AND record_id IS NULL";
    const recordParams = recordId ? { session: session.session_id, record: recordId } : { session: session.session_id };
    const existingChiefValues = this.db.all(`SELECT normalized_value FROM patient_facts WHERE session_id=:session AND field='chiefConcern' AND status='CONFIRMED' ${recordClause}`, recordParams).map((row) => row.normalized_value);
    const deduplicatedFacts = deduplicateClinicalFacts(facts, existingChiefValues);
    let writtenCount = 0;
    const seenFields = new Set();
    for (const candidate of deduplicatedFacts.slice(0, 4)) {
      const field = FACT_FIELD_ALIASES.get(candidate?.field) ?? candidate?.field;
      if (![...FACT_FIELD_ALIASES.values()].includes(field) || seenFields.has(field)) continue;
      seenFields.add(field);
      const normalizedValue = redactSensitiveText(candidate.normalizedValue).trim().slice(0, 500);
      if (!normalizedValue) continue;
      const existing = this.db.get(`SELECT fact_id FROM patient_facts WHERE session_id=:session AND field=:field AND normalized_value=:value AND status='CONFIRMED' AND ((record_id=:record) OR (record_id IS NULL AND :record IS NULL))`, { session: session.session_id, field, value: normalizedValue, record: recordId });
      if (existing) continue;
      const now = isoNow();
      this.db.run(`INSERT INTO patient_facts(fact_id,session_id,record_id,source_turn_id,field,normalized_value,certainty,status,created_at,confirmed_at) VALUES(:id,:session,:record,:turn,:field,:value,:certainty,'CONFIRMED',:created,:confirmed)`, {
        id: newId("fact"), session: session.session_id, record: recordId, turn: sourceTurnId, field, value: normalizedValue,
        certainty: candidate.certainty === "UNCERTAIN" || candidate.certainty === "DENIED" ? candidate.certainty : "PATIENT_CONFIRMED", created: now, confirmed: now,
      });
      writtenCount += 1;
    }
    const allChiefValues = this.db.all(`SELECT normalized_value FROM patient_facts WHERE session_id=:session AND field='chiefConcern' AND status='CONFIRMED' ${recordClause}`, recordParams).map((row) => row.normalized_value);
    const storedSymptoms = this.db.all(`SELECT fact_id,normalized_value FROM patient_facts WHERE session_id=:session AND field='symptoms' AND status='CONFIRMED' ${recordClause}`, recordParams);
    for (const symptom of storedSymptoms) {
      const normalizedValue = deduplicateSymptomValue(symptom.normalized_value, allChiefValues);
      if (!normalizedValue) this.db.run(`DELETE FROM patient_facts WHERE fact_id=:id`, { id: symptom.fact_id });
      else if (normalizedValue !== symptom.normalized_value) this.db.run(`UPDATE patient_facts SET normalized_value=:value WHERE fact_id=:id`, { id: symptom.fact_id, value: normalizedValue });
    }
    if (writtenCount) this.audit("AGENT", session.session_id, "STRUCTURED_FACTS_WRITTEN", "medical_record", recordId ?? session.session_id, { writtenCount, beforeConsultation: true });
    return { status: writtenCount ? "WRITTEN" : "NO_NEW_FACTS", writtenCount };
  }

  listPatientAppointments(session) {
    return this.journeyService.appointments(session);
  }

  activePatientAppointments(session) {
    return this.journeyService.activeAppointments(session);
  }

  transitionAppointment(actor, appointmentId, action, input = {}) {
    const transitions = { CHECK_IN: ["BOOKED", "CHECKED_IN"], CALL: ["CHECKED_IN", "CALLED"], START: ["CALLED", "IN_CONSULTATION"], COMPLETE: ["IN_CONSULTATION", "AWAITING_TASKS"] };
    const pair = transitions[action];
    assert(pair, 422, "UNKNOWN_TRANSITION", "未知的就诊状态操作");
    const row = this.db.get(`SELECT * FROM appointments WHERE appointment_id=:id AND doctor_id=:doctor`, { id: appointmentId, doctor: actor.doctor_id });
    assert(row, 404, "APPOINTMENT_NOT_FOUND", "挂号不存在或无权操作");
    assert(row.status === pair[0], 409, "INVALID_APPOINTMENT_STATE", `当前状态 ${row.status} 不能执行该操作`);
    let completionResult = null;
    this.db.transaction(() => {
      if (action !== "COMPLETE") this.db.run(`UPDATE appointments SET status=:status,updated_at=:now WHERE appointment_id=:id`, { status: pair[1], now: isoNow(), id: appointmentId });
      if (action === "CALL") {
        const round = this.consultationService.currentRound(appointmentId, true);
        this.db.run(`UPDATE journey_tasks SET status='COMPLETED',completed_at=:now WHERE appointment_id=:id AND task_type='WAITING' AND status='PENDING'`, { id: appointmentId, now: isoNow() });
        this.db.run(`INSERT OR IGNORE INTO journey_tasks(task_id,appointment_id,task_type,status,title,consultation_round_id,blocks_completion,created_at) VALUES(:task,:appointment,'CONSULTATION','PENDING',:title,:round,0,:created)`, { task: newId("task"), appointment: appointmentId, title: round.round_type === "RETURN" ? `第${round.round_number}轮回诊已叫号` : "初诊已叫号，请前往诊室", round: round.round_id, created: isoNow() });
        this.db.run(`UPDATE patient_sessions SET current_stage='WAITING' WHERE patient_id=:patient AND revoked_at IS NULL`, { patient: row.patient_id });
      } else if (action === "START") {
        const round = this.consultationService.start(appointmentId);
        this.db.run(`UPDATE journey_tasks SET status='COMPLETED',completed_at=:now WHERE appointment_id=:id AND consultation_round_id=:round AND task_type IN ('CONSULTATION','RETURN_VISIT')`, { id: appointmentId, round: round.round_id, now: isoNow() });
        this.db.run(`UPDATE patient_sessions SET current_stage='CONSULTATION' WHERE patient_id=:patient AND revoked_at IS NULL`, { patient: row.patient_id });
      } else if (action === "COMPLETE") {
        assert(typeof input.returnVisitRequired === "boolean", 422, "RETURN_VISIT_DECISION_REQUIRED", "结束本轮接诊前必须明确是否需要回诊");
        completionResult = this.consultationService.finish(appointmentId, input);
        this.db.run(`DELETE FROM proactive_agent_events WHERE appointment_id=:appointment AND event_type='POST_VISIT_GUIDANCE'`, { appointment: appointmentId });
        this.db.run(`UPDATE patient_sessions SET current_stage='POST_VISIT' WHERE patient_id=:patient AND revoked_at IS NULL`, { patient: row.patient_id });
        const sessions = this.db.all(`SELECT session_id FROM patient_sessions WHERE patient_id=:patient AND revoked_at IS NULL`, { patient: row.patient_id });
        for (const session of sessions) this.updateWorkflowState(session.session_id, { activeTaskType: "POST_VISIT_REVIEW", activeTaskStatus: "READY", pendingField: null, lastQuestion: null });
      }
    });
    const status = completionResult?.status ?? pair[1];
    this.audit("DOCTOR", actor.doctor_id, `APPOINTMENT_${action}`, "appointment", appointmentId, { from: pair[0], to: status, returnVisitRequired: completionResult?.returnVisitRequired ?? null, returnVisitAt: completionResult?.returnVisitAt ?? null });
    return { appointmentId, status, ...(completionResult ?? {}) };
  }

  cancelAppointment(session, appointmentId, confirmed = false) {
    assert(confirmed, 428, "EXPLICIT_CONFIRMATION_REQUIRED", "退号前必须由患者明确确认");
    assert(session.patient_id, 401, "PATIENT_SESSION_REQUIRED", "患者会话无效");
    return this.db.transaction(() => {
      const row = this.db.get(`SELECT * FROM appointments WHERE appointment_id=:id AND patient_id=:patient`, { id: appointmentId, patient: session.patient_id });
      assert(row, 404, "APPOINTMENT_NOT_FOUND", "挂号不存在");
      assert(["PENDING_PAYMENT", "BOOKED", "CHECKED_IN"].includes(row.status), 409, "CANNOT_CANCEL", "当前就诊状态不能退号");
      this.db.run(`UPDATE appointments SET status='CANCELLED',updated_at=:now WHERE appointment_id=:id`, { now: isoNow(), id: appointmentId });
      this.db.run(`DELETE FROM bills WHERE appointment_id=:id AND status='UNPAID'`, { id: appointmentId });
      this.db.run(`UPDATE journey_tasks SET status='CANCELLED' WHERE appointment_id=:id AND status IN ('PENDING','IN_PROGRESS','BLOCKED')`, { id: appointmentId });
      this.db.run(`UPDATE doctor_practices SET booked_count=MAX(0,booked_count-1) WHERE practice_id=:id`, { id: row.practice_id });
      this.audit("PATIENT", session.patient_id, "APPOINTMENT_CANCELLED", "appointment", appointmentId);
      return { appointmentId, status: "CANCELLED" };
    });
  }

  checkInPatient(session, appointmentId) {
    assert(session.patient_id, 401, "PATIENT_SESSION_REQUIRED", "患者会话无效");
    const row = this.db.get(`SELECT a.*,p.service_date FROM appointments a JOIN doctor_practices p ON p.practice_id=a.practice_id WHERE a.appointment_id=:id AND a.patient_id=:patient`, { id: appointmentId, patient: session.patient_id });
    assert(row, 404, "APPOINTMENT_NOT_FOUND", "挂号不存在");
    assert(row.status === "BOOKED", 409, "INVALID_APPOINTMENT_STATE", `当前状态 ${row.status} 不能报到`);
    assert(row.service_date === chinaDate(), 409, "CHECK_IN_DATE_MISMATCH", "只能在出诊当天报到，请核对挂号日期");
    this.db.transaction(() => {
      this.db.run(`UPDATE appointments SET status='CHECKED_IN',updated_at=:now WHERE appointment_id=:id`, { now: isoNow(), id: appointmentId });
      this.db.run(`UPDATE journey_tasks SET status='COMPLETED' WHERE appointment_id=:id AND task_type='CHECK_IN'`, { id: appointmentId });
      this.db.run(`INSERT OR IGNORE INTO journey_tasks(task_id,appointment_id,task_type,status,title,blocks_completion,created_at) VALUES(:task,:appointment,'WAITING','PENDING','在对应科室候诊，留意叫号',0,:created)`, { task: newId("task"), appointment: appointmentId, created: isoNow() });
      this.audit("PATIENT", session.patient_id, "APPOINTMENT_CHECKED_IN", "appointment", appointmentId);
    });
    return { appointmentId, status: "CHECKED_IN", queueNumber: row.queue_number };
  }

  rescheduleAppointment(session, appointmentId, targetPracticeId, confirmed = false) {
    assert(confirmed, 428, "EXPLICIT_CONFIRMATION_REQUIRED", "换号前必须由患者明确确认");
    assert(session.patient_id, 401, "PATIENT_SESSION_REQUIRED", "患者会话无效");
    const targetId = requireString(targetPracticeId, "目标号源", 1, 100);
    return this.db.transaction(() => {
      const appointment = this.db.get(`SELECT * FROM appointments WHERE appointment_id=:id AND patient_id=:patient`, { id: appointmentId, patient: session.patient_id });
      assert(appointment, 404, "APPOINTMENT_NOT_FOUND", "挂号不存在");
      assert(appointment.status === "BOOKED", 409, "CANNOT_RESCHEDULE", "只有未报到的挂号可以换号");
      assert(appointment.practice_id !== targetId, 422, "SAME_PRACTICE", "请选择不同的出诊时段");
      const target = this.db.get(`SELECT * FROM doctor_practices WHERE practice_id=:id`, { id: targetId });
      assert(target && target.status === "ACTIVE" && target.service_date >= chinaDate(), 409, "PRACTICE_UNAVAILABLE", "目标出诊时段不可用");
      const consumed = this.db.run(`UPDATE doctor_practices SET booked_count=booked_count+1 WHERE practice_id=:id AND booked_count<capacity AND status='ACTIVE'`, { id: targetId });
      assert(consumed.changes === 1, 409, "SLOT_FULL", "目标时段号源已满，请选择其他医生或时段");
      this.db.run(`UPDATE doctor_practices SET booked_count=MAX(0,booked_count-1) WHERE practice_id=:id`, { id: appointment.practice_id });
      this.db.run(`UPDATE appointments SET practice_id=:practice,doctor_id=:doctor,department_id=:department,queue_number=:queue,updated_at=:now WHERE appointment_id=:id`, { practice: targetId, doctor: target.doctor_id, department: target.department_id, queue: target.booked_count + 1, now: isoNow(), id: appointmentId });
      this.db.run(`UPDATE medical_records SET doctor_id=:doctor,department_id=:department,updated_at=:now WHERE appointment_id=:id`, { doctor: target.doctor_id, department: target.department_id, now: isoNow(), id: appointmentId });
      this.audit("PATIENT", session.patient_id, "APPOINTMENT_RESCHEDULED", "appointment", appointmentId, { fromPracticeId: appointment.practice_id, toPracticeId: targetId });
      return { appointmentId, practiceId: targetId, status: "BOOKED", queueNumber: target.booked_count + 1 };
    });
  }

  listDoctorAppointments(doctor) {
    return this.db.all(`SELECT a.*,p.service_date,p.start_time,p.end_time,dp.display_name department_name,pp.full_name_encrypted,pp.full_name_masked,pp.sex,pp.age,pp.verification_status FROM appointments a JOIN doctor_practices p ON p.practice_id=a.practice_id JOIN departments dp ON dp.department_id=a.department_id JOIN patient_profiles pp ON pp.patient_id=a.patient_id WHERE a.doctor_id=:doctor ORDER BY p.service_date,p.start_time,a.queue_number`, { doctor: doctor.doctor_id }).map((row) => {
      const currentRound = this.consultationService.currentRound(row.appointment_id, false);
      const requiresReturnVisit = currentRound ? this.db.get(`SELECT count(*) total FROM medical_orders WHERE consultation_round_id=:round AND order_type='EXAMINATION' AND status<>'REVOKED'`, { round: currentRound.round_id }).total > 0 : false;
      return ({
      appointmentId: row.appointment_id, status: row.status, queueNumber: row.queue_number,
      patient: { fullName: decryptText(row.full_name_encrypted, this.config.encryptionKey), sex: row.sex, age: row.age, virtualTestProfile: row.verification_status === "VIRTUAL_TEST" },
      departmentName: row.department_name, serviceDate: row.service_date, startTime: row.start_time, endTime: row.end_time,
      currentRound: currentRound ? { roundId: currentRound.round_id, roundNumber: currentRound.round_number, roundType: currentRound.round_type, status: currentRound.status, scheduledAt: currentRound.scheduled_at ?? null } : null,
      requiresReturnVisit,
    }); });
  }

  getRecordForDoctor(doctor, appointmentId) {
    const row = this.db.get(`SELECT r.*,a.status appointment_status,pp.full_name_encrypted,pp.sex,pp.age,pp.verification_status,dp.display_name department_name FROM medical_records r JOIN appointments a ON a.appointment_id=r.appointment_id JOIN patient_profiles pp ON pp.patient_id=r.patient_id JOIN departments dp ON dp.department_id=r.department_id WHERE r.appointment_id=:appointment AND r.doctor_id=:doctor`, { appointment: appointmentId, doctor: doctor.doctor_id });
    assert(row, 404, "MEDICAL_RECORD_NOT_FOUND", "病历不存在或无权查看");
    const facts = this.db.all(`SELECT fact_id,source_turn_id,field,normalized_value,certainty,confirmed_at FROM patient_facts WHERE record_id=:record AND status='CONFIRMED' ORDER BY confirmed_at`, { record: row.record_id });
    const versions = this.db.all(`SELECT version,changed_by,change_reason,created_at FROM medical_record_versions WHERE record_id=:record ORDER BY version DESC`, { record: row.record_id });
    const orders = this.listOrders(row.record_id);
    const currentRound = this.consultationService.currentRound(appointmentId, false);
    const doctorContent = parse(row.doctor_content_json);
    const { draft: recordDraft, agentPrefilledFields } = medicalRecordDraft(doctorContent, facts);
    this.audit("DOCTOR", doctor.doctor_id, "MEDICAL_RECORD_VIEWED", "medical_record", row.record_id, { appointmentId });
    return {
      recordId: row.record_id, appointmentId, version: row.version, appointmentStatus: row.appointment_status,
      patient: { fullName: decryptText(row.full_name_encrypted, this.config.encryptionKey), sex: row.sex, age: row.age, virtualTestProfile: row.verification_status === "VIRTUAL_TEST" },
      departmentName: row.department_name,
      doctorContent, recordDraft, agentPrefilledFields,
      patientFacts: facts.map((item) => ({ factId: item.fact_id, sourceTurnId: item.source_turn_id, field: item.field, normalizedValue: item.normalized_value, certainty: item.certainty, confirmedAt: item.confirmed_at })),
      versions: versions.map((item) => ({ version: item.version, changedBy: item.changed_by, changeReason: item.change_reason, createdAt: item.created_at })), orders,
      currentRound: currentRound ? { roundId: currentRound.round_id, roundNumber: currentRound.round_number, roundType: currentRound.round_type, status: currentRound.status, scheduledAt: currentRound.scheduled_at ?? null } : null,
      authorityNotice: "Agent 不会评价、纠正、质疑或覆盖任何医生保存的医学内容。",
    };
  }

  saveRecord(doctor, recordId, input) {
    const expectedVersion = requireInteger(input.expectedVersion, "期望版本", 1, 1_000_000);
    const changeReason = requireString(input.changeReason, "修改原因", 2, 200);
    assert(input.content && typeof input.content === "object" && !Array.isArray(input.content), 422, "VALIDATION_ERROR", "病历内容格式无效");
    // These final three fields are doctor-owned and are never targets of Agent fact extraction.
    const allowed = ["chiefConcern", "presentIllness", "history", "medications", "allergies", "examinationResults", "doctorAssessment", "plan"];
    const content = {};
    for (const key of allowed) content[key] = requireString(String(input.content[key] ?? ""), key, 0, 5000);
    const now = isoNow();
    const nextVersion = expectedVersion + 1;
    this.db.transaction(() => {
      const row = this.db.get(`SELECT r.*,a.status appointment_status FROM medical_records r JOIN appointments a ON a.appointment_id=r.appointment_id WHERE r.record_id=:id AND r.doctor_id=:doctor`, { id: recordId, doctor: doctor.doctor_id });
      assert(row, 404, "MEDICAL_RECORD_NOT_FOUND", "病历不存在或无权修改");
      assert(!["COMPLETED", "CANCELLED"].includes(row.appointment_status), 409, "MEDICAL_RECORD_LOCKED", "就诊已完成，病历不可再修改");
      assert(row.version === expectedVersion, 409, "MEDICAL_RECORD_VERSION_CONFLICT", "病历已被修改，请刷新后重新编辑", { currentVersion: row.version });
      this.db.run(`UPDATE medical_records SET version=:version,doctor_content_json=:content,updated_at=:now WHERE record_id=:id`, { version: nextVersion, content: json(content), now, id: recordId });
      this.db.run(`INSERT INTO medical_record_versions VALUES(:id,:record,:version,:content,:doctor,:reason,:created)`, { id: newId("record-version"), record: recordId, version: nextVersion, content: json(content), doctor: doctor.doctor_id, reason: changeReason, created: now });
      this.audit("DOCTOR", doctor.doctor_id, "MEDICAL_RECORD_EDITED", "medical_record", recordId, { fromVersion: expectedVersion, toVersion: nextVersion, changeReason, doctorAuthorityPreserved: true });
    });
    return { recordId, version: nextVersion, doctorContent: content };
  }

  createOrder(doctor, recordId, input) {
    assert(["EXAMINATION", "PRESCRIPTION"].includes(input.orderType), 422, "VALIDATION_ERROR", "医嘱类型无效");
    const catalogItemId = requireString(input.catalogItemId, "医嘱目录项目", 2, 100);
    const catalogItem = this.knowledge.findOrderCatalogItem(catalogItemId, input.orderType);
    assert(catalogItem, 422, "UNKNOWN_ORDER_CATALOG_ITEM", "请选择当前演示目录中的检查或药品");
    const quantity = requireInteger(input.quantity ?? 1, "数量", 1, 20);
    const doctorNotes = requireString(String(input.doctorNotes ?? ""), "医生补充说明", 0, 1000);
    const title = catalogItem.name;
    const details = [catalogItem.details, doctorNotes && `医生补充：${doctorNotes}`].filter(Boolean).join("\n");
    const amountCents = catalogItem.amountCents * quantity;
    const row = this.db.get(`SELECT r.*,a.status appointment_status FROM medical_records r JOIN appointments a ON a.appointment_id=r.appointment_id WHERE r.record_id=:record AND r.doctor_id=:doctor`, { record: recordId, doctor: doctor.doctor_id });
    assert(row, 404, "MEDICAL_RECORD_NOT_FOUND", "病历不存在或无权创建医嘱");
    assert(row.appointment_status === "IN_CONSULTATION", 409, "ORDER_CREATION_NOT_ALLOWED", "只有接诊进行中可以创建检查或处方");
    const orderId = newId("order");
    const now = isoNow();
    this.db.transaction(() => {
      this.db.run(`INSERT INTO medical_orders(order_id,record_id,doctor_id,order_type,title,details,catalog_item_id,quantity,location_id,data_origin,status,created_at) VALUES(:id,:record,:doctor,:type,:title,:details,:catalog,:quantity,:location,'hospital_runtime','CREATED',:created)`, { id: orderId, record: recordId, doctor: doctor.doctor_id, type: input.orderType, title, details, catalog: catalogItemId, quantity, location: catalogItem.locationId, created: now });
      const taskType = input.orderType === "EXAMINATION" ? "EXAMINATION" : "PHARMACY";
      const round = this.consultationService.currentRound(row.appointment_id, true);
      this.db.run(`UPDATE medical_orders SET consultation_round_id=:round WHERE order_id=:order`, { round: round.round_id, order: orderId });
      this.db.run(`INSERT OR IGNORE INTO journey_tasks(task_id,appointment_id,task_type,status,title,order_id,consultation_round_id,blocks_completion,created_at) VALUES(:id,:appointment,:type,'PENDING',:title,:order,:round,1,:created)`, { id: newId("task"), appointment: row.appointment_id, type: taskType, title: input.orderType === "EXAMINATION" ? `完成检查：${title}` : `取药：${title}`, order: orderId, round: round.round_id, created: now });
      if (amountCents > 0) this.db.run(`INSERT INTO bills(bill_id,appointment_id,order_id,amount_cents,bill_type,title,status,guidance,created_at,paid_at) VALUES(:id,:appointment,:order,:amount,'ORDER',:title,'UNPAID','演示费用；可在患者对话中完成模拟支付，不会发生真实扣款。',:created,NULL)`, { id: newId("bill"), appointment: row.appointment_id, order: orderId, amount: amountCents, title: `${title}费用（演示）`, created: now });
      this.audit("DOCTOR", doctor.doctor_id, "MEDICAL_ORDER_CREATED", "medical_order", orderId, { orderType: input.orderType, catalogItemId, quantity, amountCents, locationId: catalogItem.locationId });
    });
    return { orderId, orderType: input.orderType, title, details, quantity, location: this.knowledge.findLocation(catalogItem.locationId), status: "CREATED", billStatus: amountCents > 0 ? "UNPAID" : null, dataOrigin: "hospital_runtime", catalogDataOrigin: this.knowledge.orderCatalog.dataOrigin, catalogNotice: this.knowledge.orderCatalog.notice };
  }

  listOrders(recordId) {
    return this.db.all(`SELECT o.*,b.bill_id,b.amount_cents,b.status bill_status,b.guidance,b.title bill_title FROM medical_orders o LEFT JOIN bills b ON b.order_id=o.order_id WHERE o.record_id=:record ORDER BY o.created_at`, { record: recordId }).map((row) => ({
      orderId: row.order_id, orderType: row.order_type, title: row.title, details: row.details, quantity: row.quantity,
      status: row.status, createdAt: row.created_at, catalogItemId: row.catalog_item_id, dataOrigin: row.data_origin, consultationRoundId: row.consultation_round_id ?? null,
      location: row.location_id ? this.knowledge.findLocation(row.location_id) : null,
      bill: row.bill_id ? { billId: row.bill_id, title: row.bill_title, amountCents: row.amount_cents, status: row.bill_status, guidance: row.guidance } : null,
    }));
  }

  revokeOrder(doctor, orderId) {
    const order = this.db.get(`SELECT o.*,r.appointment_id,a.status appointment_status,b.bill_id,b.status bill_status
      FROM medical_orders o
      JOIN medical_records r ON r.record_id=o.record_id
      JOIN appointments a ON a.appointment_id=r.appointment_id
      LEFT JOIN bills b ON b.order_id=o.order_id
      WHERE o.order_id=:id AND o.doctor_id=:doctor`, { id: orderId, doctor: doctor.doctor_id });
    assert(order, 404, "ORDER_NOT_FOUND", "医嘱不存在或无权操作");
    assert(order.status === "CREATED", 409, "ORDER_NOT_REVOCABLE", order.status === "REVOKED" ? "该医嘱已经撤销" : "该医嘱当前不可撤销");
    assert(!["COMPLETED", "CANCELLED"].includes(order.appointment_status), 409, "ORDER_NOT_REVOCABLE", "本次就诊已结束，不能再撤销医嘱");
    assert(order.bill_status !== "PAID", 409, "ORDER_ALREADY_PAID", "该项目已经支付，不能直接撤销，请按退款流程处理");
    assert(!this.db.get(`SELECT result_id FROM simulated_results WHERE order_id=:id LIMIT 1`, { id: orderId }), 409, "ORDER_ALREADY_COMPLETED", "该检查已经产生结果，不能撤销");
    const taskType = order.order_type === "EXAMINATION" ? "EXAMINATION" : "PHARMACY";
    const taskTitle = order.order_type === "EXAMINATION" ? `完成检查：${order.title}` : `按医生处方前往药房：${order.title}`;
    const revokedAt = isoNow();
    this.db.transaction(() => {
      this.db.run(`UPDATE medical_orders SET status='REVOKED' WHERE order_id=:id`, { id: orderId });
      if (order.bill_id) this.db.run(`DELETE FROM bills WHERE bill_id=:id AND status='UNPAID'`, { id: order.bill_id });
      const remaining = this.db.get(`SELECT count(*) total FROM medical_orders o
        JOIN medical_records r ON r.record_id=o.record_id
        WHERE r.appointment_id=:appointment AND o.order_type=:type AND o.title=:title AND o.status='CREATED'`, {
        appointment: order.appointment_id, type: order.order_type, title: order.title,
      });
      if (!remaining.total) this.db.run(`UPDATE journey_tasks SET status='CANCELLED',completed_at=:now WHERE order_id=:order AND status IN ('PENDING','BLOCKED')`, { order: orderId, now: revokedAt });
      this.audit("DOCTOR", doctor.doctor_id, "MEDICAL_ORDER_REVOKED", "medical_order", orderId, {
        orderType: order.order_type, appointmentId: order.appointment_id, removedUnpaidBill: Boolean(order.bill_id), revokedAt,
      });
    });
    return { orderId, status: "REVOKED", revokedAt };
  }

  simulateOrderResult(doctor, orderId, objectType) {
    const order = this.db.get(`SELECT o.* FROM medical_orders o WHERE o.order_id=:id AND o.doctor_id=:doctor`, { id: orderId, doctor: doctor.doctor_id });
    assert(order, 404, "ORDER_NOT_FOUND", "医嘱不存在或无权操作");
    assert(["CREATED", "FULFILLED"].includes(order.status), 409, "SIMULATION_NOT_ALLOWED", "已撤销的检查不能生成演示结果");
    assert(order.order_type === "EXAMINATION", 409, "SIMULATION_NOT_ALLOWED", "只有检查医嘱可以生成设备受限的演示结果");
    const definition = this.knowledge.simulationManifest.allowedObjectTypes.find((item) => item.objectType === objectType);
    assert(definition && ["medical_image", "examination_report", "laboratory_result"].includes(objectType), 422, "SIMULATION_NOT_ALLOWED", "该对象不在允许模拟清单中");
    const resultId = newId("simulated-result");
    assert(!this.db.get(`SELECT result_id FROM simulated_results WHERE order_id=:id LIMIT 1`, { id: orderId }), 409, "SIMULATED_RESULT_EXISTS", "该检查已经生成演示结果");
    const content = { summary: "演示占位内容，不包含真实检查数据或医学结论", sourceOrderTitle: order.title };
    this.db.transaction(() => {
      this.db.run(`INSERT INTO simulated_results VALUES(:id,:order,:type,:content,:label,1,:created)`, { id: resultId, order: orderId, type: objectType, content: json(content), label: definition.requiredLabel, created: isoNow() });
      this.audit("DOCTOR", doctor.doctor_id, "SIMULATED_RESULT_CREATED", "simulated_result", resultId, { objectType, simulationManifestVersion: this.knowledge.simulationManifest.version });
    });
    return { resultId, orderId, objectType, content, simulated: true, label: definition.requiredLabel };
  }

  patientJourney(session) {
    if (session.patient_id) {
      const appointments = this.db.all(`SELECT appointment_id FROM appointments WHERE patient_id=:patient AND status='AWAITING_TASKS'`, { patient: session.patient_id });
      for (const appointment of appointments) this.consultationService.activateDue(appointment.appointment_id);
    }
    return this.journeyService.journey(session);
  }

  completePatientTask(session, taskId) {
    const result = this.db.transaction(() => this.fulfillmentService.complete(session, requireString(taskId, "任务", 1, 100)));
    this.audit("PATIENT", session.patient_id, "JOURNEY_TASK_COMPLETED", "journey_task", taskId, { taskType: result.taskType, appointmentId: result.appointmentId, idempotent: result.idempotent });
    return result;
  }

  checkInReturnVisit(session, taskId) {
    const result = this.db.transaction(() => this.consultationService.checkIn(session, requireString(taskId, "回诊任务", 1, 100)));
    this.db.run(`DELETE FROM proactive_agent_events WHERE session_id=:session AND appointment_id=:appointment AND event_type IN ('RETURN_VISIT_READY','CALLED_NOTICE')`, { session: session.session_id, appointment: result.appointmentId });
    this.audit("PATIENT", session.patient_id, "RETURN_VISIT_CHECKED_IN", "journey_task", taskId, { appointmentId: result.appointmentId });
    return result;
  }

  exportMedicalRecord(session, appointmentId) {
    assert(session.patient_id, 401, "PATIENT_PROFILE_REQUIRED", "请先完成患者建档");
    const row = this.db.get(`SELECT r.*,a.status appointment_status,d.display_name doctor_name,dp.display_name department_name,pp.full_name_encrypted,pp.identity_masked
      FROM medical_records r JOIN appointments a ON a.appointment_id=r.appointment_id
      JOIN doctors d ON d.doctor_id=r.doctor_id JOIN departments dp ON dp.department_id=r.department_id
      JOIN patient_profiles pp ON pp.patient_id=r.patient_id
      WHERE a.appointment_id=:appointment AND a.patient_id=:patient`, { appointment: appointmentId, patient: session.patient_id });
    assert(row, 404, "MEDICAL_RECORD_NOT_FOUND", "病历不存在或不属于当前患者");
    assert(row.appointment_status === "COMPLETED", 409, "VISIT_NOT_COMPLETED", "完成全部缴费、检查、取药和回诊后才能导出病历");
    const content = parse(row.doctor_content_json, {});
    const facts = this.db.all(`SELECT field,normalized_value,certainty FROM patient_facts WHERE record_id=:record AND status='CONFIRMED' ORDER BY confirmed_at`, { record: row.record_id });
    const orders = this.listOrders(row.record_id).filter((item) => item.status !== "REVOKED");
    const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
    const field = (label, value) => `<section><h2>${label}</h2><p>${escape(value) || "未填写"}</p></section>`;
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>病历导出</title><style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;max-width:820px;margin:40px auto;padding:0 24px;color:#18302b}header{border-bottom:2px solid #087f68;padding-bottom:16px}h1{margin:0 0 8px}h2{font-size:16px;margin-bottom:6px}p,li{line-height:1.7}.notice{background:#fff4d6;padding:12px;border-radius:8px}section{break-inside:avoid;border-bottom:1px solid #ddd}</style></head><body><header><h1>某医院导诊演示·病历摘要</h1><p class="notice">演示系统生成，非医院正式病历，不可作为诊断、处方或证明材料。</p><p>患者：${escape(decryptText(row.full_name_encrypted, this.config.encryptionKey))}　身份证：${escape(row.identity_masked)}</p><p>科室：${escape(row.department_name)}　医生：${escape(row.doctor_name)}　完成时间：${escape(row.updated_at)}</p></header>${field("主诉", content.chiefConcern)}${field("现病情况", content.presentIllness)}${field("既往情况", content.history)}${field("用药情况", content.medications)}${field("过敏情况", content.allergies)}${field("医生判断", content.doctorAssessment)}${field("处理计划", content.plan)}<section><h2>患者主动提供的结构化信息</h2><ul>${facts.map((item) => `<li>${escape(item.normalized_value)}${item.certainty === "UNCERTAIN" ? "（待核实）" : ""}</li>`).join("") || "<li>无</li>"}</ul></section><section><h2>医嘱</h2><ul>${orders.map((item) => `<li>${escape(item.title)} × ${item.quantity}（${item.status === "FULFILLED" ? "已完成" : escape(item.status)}）</li>`).join("") || "<li>无</li>"}</ul></section></body></html>`;
    const examinationResultsSection = field("检查结果（医生填写）", content.examinationResults);
    const exportHtml = html.replace(field("医生判断", content.doctorAssessment), `${examinationResultsSection}${field("医生判断", content.doctorAssessment)}`);
    this.audit("PATIENT", session.patient_id, "MEDICAL_RECORD_EXPORTED", "medical_record", row.record_id, { appointmentId, format: "printable_html" });
    return { filename: `病历摘要-${appointmentId}.html`, html: exportHtml };
  }

  patientMapContext(session) {
    const appointmentDestinations = [];
    const orderDestinations = [];
    if (session.patient_id) {
      const appointments = this.db.all(`SELECT a.appointment_id,a.department_id,a.status,dp.display_name department_name FROM appointments a JOIN departments dp ON dp.department_id=a.department_id WHERE a.patient_id=:patient AND a.status NOT IN ('CANCELLED','COMPLETED') ORDER BY a.updated_at DESC LIMIT 3`, { patient: session.patient_id });
      for (const appointment of appointments) {
        const linkedLocations = this.knowledge.locationsForDepartment(appointment.department_id);
        const locations = (linkedLocations.length ? linkedLocations : this.knowledge.searchLocations(appointment.department_name).filter((location) => location.routeEnabled)).slice(0, 3);
        for (const location of locations) appointmentDestinations.push({
          appointmentId: appointment.appointment_id, departmentId: appointment.department_id,
          departmentName: appointment.department_name, appointmentStatus: appointment.status,
          locationId: location.locationId, canonicalName: location.canonicalName, mapLabel: location.mapLabel,
          floorLabel: location.floorLabel, building: location.building,
        });
      }
      const orders = this.db.all(`SELECT o.order_id,o.order_type,o.title,o.location_id,b.status bill_status FROM medical_orders o JOIN medical_records r ON r.record_id=o.record_id JOIN appointments a ON a.appointment_id=r.appointment_id LEFT JOIN bills b ON b.order_id=o.order_id WHERE a.patient_id=:patient AND o.status<>'REVOKED' AND o.location_id IS NOT NULL ORDER BY o.created_at DESC LIMIT 6`, { patient: session.patient_id });
      for (const order of orders) {
        const location = this.knowledge.findLocation(order.location_id);
        if (!location) continue;
        orderDestinations.push({
          orderId: order.order_id, orderType: order.order_type, orderTitle: order.title, billStatus: order.bill_status,
          locationId: location.locationId, canonicalName: location.canonicalName, mapLabel: location.mapLabel,
          floorLabel: location.floorLabel, building: location.building,
        });
      }
    }
    return { appointmentDestinations: appointmentDestinations.slice(0, 6), orderDestinations, hospitalArea: this.knowledge.hospitalGeofence };
  }

  async proactivePatientUpdate(session) {
    if (!session.patient_id) return null;
    const awaiting = this.db.all(`SELECT appointment_id FROM appointments WHERE patient_id=:patient AND status='AWAITING_TASKS'`, { patient: session.patient_id });
    for (const item of awaiting) this.consultationService.activateDue(item.appointment_id);
    const appointment = this.db.get(`SELECT a.*,d.display_name doctor_name,dp.display_name department_name FROM appointments a JOIN doctors d ON d.doctor_id=a.doctor_id JOIN departments dp ON dp.department_id=a.department_id WHERE a.patient_id=:patient AND a.status IN ('CHECKED_IN','CALLED') ORDER BY CASE a.status WHEN 'CALLED' THEN 0 ELSE 1 END,a.updated_at DESC LIMIT 1`, { patient: session.patient_id })
      ?? this.db.get(`SELECT a.*,d.display_name doctor_name,dp.display_name department_name FROM appointments a JOIN doctors d ON d.doctor_id=a.doctor_id JOIN departments dp ON dp.department_id=a.department_id WHERE a.patient_id=:patient AND a.status IN ('AWAITING_TASKS','COMPLETED') ORDER BY a.updated_at DESC LIMIT 1`, { patient: session.patient_id });
    if (!appointment) return null;
    const readyReturn = appointment.status === "AWAITING_TASKS" ? this.db.get(`SELECT * FROM journey_tasks WHERE appointment_id=:appointment AND task_type='RETURN_VISIT' AND status='PENDING' ORDER BY scheduled_at LIMIT 1`, { appointment: appointment.appointment_id }) : null;
    const eventType = appointment.status === "CALLED" ? "CALLED_NOTICE" : appointment.status === "COMPLETED" ? "VISIT_COMPLETED" : readyReturn ? "RETURN_VISIT_READY" : appointment.status === "AWAITING_TASKS" ? "POST_VISIT_GUIDANCE" : "WAITING_INTERVIEW";
    if (this.db.get(`SELECT event_id FROM proactive_agent_events WHERE session_id=:session AND appointment_id=:appointment AND event_type=:type`, { session: session.session_id, appointment: appointment.appointment_id, type: eventType })) return null;
    let text;
    let assistantActions = [];
    if (eventType === "CALLED_NOTICE") {
      text = `已经叫到您的号，请携带随身物品前往${appointment.department_name}诊室，留意现场工作人员指引。`;
    } else if (eventType === "RETURN_VISIT_READY") {
      text = "检查已完成并到达医生安排的回诊时间，请在下方完成回诊报到。";
      assistantActions = [{ type: "POST_VISIT_SERVICE", tool: "check_in_return_visit", title: "回诊安排", journey: { appointments: [], orders: [], bills: [], tasks: [readyReturn].map((task) => ({ taskId: task.task_id, appointmentId: task.appointment_id, taskType: task.task_type, status: task.status, title: task.title, scheduledAt: task.scheduled_at })) } }];
    } else if (eventType === "VISIT_COMPLETED") {
      text = "本次就医的费用和待办均已完成，您可以导出病历摘要。";
      assistantActions = [{ type: "MEDICAL_RECORD_EXPORT", tool: "export_medical_record", title: "本次就医已完成", text, appointmentId: appointment.appointment_id }];
      this.updateWorkflowState(session.session_id, { activeTaskType: "COMPLETED", activeTaskStatus: "COMPLETED", pendingField: null, lastQuestion: null });
    } else if (eventType === "POST_VISIT_GUIDANCE") {
      const journey = this.patientJourney(session);
      const visitOrders = journey.orders.filter((item) => item.appointmentId === appointment.appointment_id);
      const visitBills = journey.bills.filter((item) => item.appointmentId === appointment.appointment_id);
      const unpaidCount = visitBills.filter((item) => item.status === "UNPAID").length;
      if (visitOrders.length) {
        text = unpaidCount
          ? `本次接诊已完成。医生开具了${visitOrders.length}项检查或药品，请先完成下方模拟缴费，再按卡片指引前往对应地点。`
          : `本次接诊已完成。医生开具了${visitOrders.length}项检查或药品，请按下方指引前往对应地点。`;
        assistantActions = [{ type: "POST_VISIT_SERVICE", tool: "get_post_visit_orders", title: "诊后待办", journey: { appointments: [], orders: visitOrders, bills: visitBills, tasks: journey.tasks.filter((item) => item.appointmentId === appointment.appointment_id) } }];
      } else {
        text = "本次接诊已完成，目前没有检查、处方或待缴项目。请按医生现场说明安排后续事项。";
      }
      this.updateWorkflowState(session.session_id, { activeTaskType: visitOrders.length ? "POST_VISIT_REVIEW" : "COMPLETED", activeTaskStatus: visitOrders.length ? "WAITING_FOR_USER" : "COMPLETED", pendingField: null, lastQuestion: null });
    } else {
      const context = this.structuredConversationContext({ ...session, current_stage: "WAITING" });
      const interview = await this.departmentRouter.waitingInterview({ context, initial: true });
      const prompt = this.nextWaitingPrompt(session.session_id);
      text = `${interview.result.acknowledgement}${prompt ? ` ${prompt.question}` : ""}`;
      this.updateWorkflowState(session.session_id, {
        activeTaskType: "COLLECT_VISIT_INFORMATION", activeTaskStatus: prompt ? "WAITING_FOR_USER" : "COMPLETED",
        pendingField: prompt?.field ?? null, lastQuestion: prompt?.question ?? null,
      });
    }
    const salutation = this.patientSalutation(session);
    const message = `${salutation ? `${salutation}，` : ""}${text}`.slice(0, 500);
    this.db.transaction(() => {
      this.db.run(`INSERT INTO proactive_agent_events(event_id,session_id,appointment_id,event_type,created_at) VALUES(:id,:session,:appointment,:type,:created)`, { id: newId("proactive"), session: session.session_id, appointment: appointment.appointment_id, type: eventType, created: isoNow() });
      if (["WAITING_INTERVIEW", "POST_VISIT_GUIDANCE", "RETURN_VISIT_READY", "VISIT_COMPLETED"].includes(eventType)) {
        const interactionId = newId("interaction");
        this.db.run(`INSERT INTO conversation_turns(turn_id,session_id,role,message,created_at,assistant_actions_json,interaction_id,turn_kind,turn_status) VALUES(:id,:session,'AGENT',:message,:created,:actions,:interaction,'PROACTIVE','ACTIVE')`, {
          id: newId("turn"), session: session.session_id, message, created: isoNow(), actions: json(assistantActions), interaction: interactionId,
        });
      }
    });
    return { eventType, message, assistantActions, appointmentId: appointment.appointment_id, status: appointment.status, departmentName: appointment.department_name, queueNumber: appointment.queue_number };
  }

  payBillWithSimulation(session, billId) {
    assert(session.patient_id, 401, "PATIENT_PROFILE_REQUIRED", "支付前请先完成患者建档");
    const id = requireString(billId, "账单", 1, 100);
    const bill = this.db.get(`SELECT b.* FROM bills b JOIN appointments a ON a.appointment_id=b.appointment_id WHERE b.bill_id=:id AND a.patient_id=:patient`, { id, patient: session.patient_id });
    assert(bill, 404, "BILL_NOT_FOUND", "账单不存在或不属于当前患者");
    if (bill.status === "PAID") {
      const existing = this.db.get(`SELECT * FROM simulated_payments WHERE bill_id=:bill`, { bill: id });
      return { paymentId: existing?.payment_id ?? null, billId: id, amountCents: bill.amount_cents, provider: "SIMULATED", status: "PAID", paidAt: existing?.paid_at ?? bill.paid_at, idempotent: true, simulationNotice: "模拟支付，不会产生真实扣款" };
    }
    assert(bill.status === "UNPAID", 409, "BILL_NOT_PAYABLE", "当前账单不可支付");
    const paymentId = newId("payment");
    const paidAt = isoNow();
    this.db.transaction(() => {
      const updated = this.db.run(`UPDATE bills SET status='PAID',guidance='模拟支付已完成；未发生真实扣款。',paid_at=:paidAt WHERE bill_id=:id AND status='UNPAID'`, { paidAt, id });
      assert(updated.changes === 1, 409, "BILL_ALREADY_PROCESSED", "账单状态已变化，请刷新后查看");
      this.db.run(`INSERT INTO simulated_payments(payment_id,bill_id,patient_id,amount_cents,provider,status,paid_at) VALUES(:payment,:bill,:patient,:amount,'SIMULATED','PAID',:paidAt)`, { payment: paymentId, bill: id, patient: session.patient_id, amount: bill.amount_cents, paidAt });
      if (bill.bill_type === "REGISTRATION") {
        const appointment = this.db.get(`SELECT status FROM appointments WHERE appointment_id=:id`, { id: bill.appointment_id });
        if (appointment?.status === "PENDING_PAYMENT") {
          this.db.run(`UPDATE appointments SET status='BOOKED',updated_at=:now WHERE appointment_id=:id`, { now: paidAt, id: bill.appointment_id });
          this.db.run(`UPDATE journey_tasks SET status='COMPLETED' WHERE appointment_id=:id AND task_type='REGISTRATION_PAYMENT'`, { id: bill.appointment_id });
          this.db.run(`INSERT OR IGNORE INTO journey_tasks(task_id,appointment_id,task_type,status,title,blocks_completion,created_at) VALUES(:id,:appointment,'CHECK_IN','PENDING','到院后在门诊报到',1,:created)`, { id: newId("task"), appointment: bill.appointment_id, created: paidAt });
          this.db.run(`UPDATE patient_sessions SET current_stage='APPOINTMENT' WHERE patient_id=:patient AND revoked_at IS NULL`, { patient: session.patient_id });
        }
      } else {
        const remaining = this.db.get(`SELECT count(*) total FROM bills WHERE appointment_id=:appointment AND status='UNPAID'`, { appointment: bill.appointment_id }).total;
        if (remaining === 0) this.db.run(`UPDATE patient_sessions SET current_stage='ORDER_FULFILLMENT' WHERE patient_id=:patient AND revoked_at IS NULL`, { patient: session.patient_id });
      }
      this.visitCompletion.evaluate(bill.appointment_id, paidAt);
      this.audit("PATIENT", session.patient_id, "SIMULATED_PAYMENT_COMPLETED", "bill", id, { paymentId, amountCents: bill.amount_cents, provider: "SIMULATED" });
    });
    return { paymentId, billId: id, billType: bill.bill_type, amountCents: bill.amount_cents, provider: "SIMULATED", status: "PAID", paidAt, appointmentStatus: bill.bill_type === "REGISTRATION" ? "BOOKED" : null, idempotent: false, simulationNotice: "模拟支付，不会产生真实扣款" };
  }

  structuredConversationContext(session) {
    const patient = session.patient_id ? this.db.get(`SELECT age,sex FROM patient_profiles WHERE patient_id=:id`, { id: session.patient_id }) : null;
    const patientFacts = this.db.all(`SELECT field,normalized_value,certainty FROM patient_facts WHERE session_id=:session AND status='CONFIRMED' ORDER BY confirmed_at DESC LIMIT 16`, { session: session.session_id });
    const doctorFacts = session.patient_id ? this.db.all(`SELECT doctor_content_json FROM medical_records r JOIN appointments a ON a.appointment_id=r.appointment_id WHERE r.patient_id=:patient AND a.status NOT IN ('CANCELLED','COMPLETED') ORDER BY r.updated_at DESC LIMIT 1`, { patient: session.patient_id }) : [];
    const facts = [];
    for (const row of doctorFacts) {
      const content = parse(row.doctor_content_json);
      for (const field of ["chiefConcern", "presentIllness", "history", "medications", "allergies"]) {
        const value = redactSensitiveText(content[field]).trim();
        if (value) facts.push({ field, value: value.slice(0, 120), source: "DOCTOR_CONFIRMED" });
        if (facts.length >= 12) break;
      }
    }
    for (const fact of patientFacts) {
      const value = redactSensitiveText(fact.normalized_value).trim();
      if (!value || facts.some((item) => item.field === fact.field && item.value === value)) continue;
      facts.push({ field: fact.field, value: value.slice(0, 120), source: "PATIENT_CONFIRMED", certainty: fact.certainty });
      if (facts.length >= 12) break;
    }
    return {
      patient: patient ? { age: patient.age, sex: patient.sex } : null,
      confirmedFacts: facts,
      conversationSummary: facts.map((item) => item.value).join("；").slice(0, 240),
      currentStage: session.current_stage,
      workflowState: this.workflowState(session.session_id),
    };
  }

  async agentMessage(session, input, { onDelta = null } = {}) {
    const message = requireString(input.message, "消息", 1, 500);
    if (isConversationUndoRequest(message) && !this.safetyGuard.assess(message).emergency) return this.prepareConversationUndoFromMessage(session, message, onDelta);
    const now = isoNow();
    const turnId = newId("turn");
    const interactionId = newId("interaction");
    const stateBefore = this.conversationRollback.captureState(session);
    this.db.run(`INSERT INTO conversation_turns(turn_id,session_id,role,message,created_at,assistant_actions_json,interaction_id,turn_kind,turn_status,state_before_json) VALUES(:id,:session,'PATIENT',:message,:created,'[]',:interaction,'CHAT','ACTIVE',:stateBefore)`, {
      id: turnId, session: session.session_id, message, created: now, interaction: interactionId, stateBefore: json(stateBefore),
    });
    const workflowBefore = this.workflowState(session.session_id);
    const reply = await this.replyForMessage(session, message);
    const recommendationPatch = reply.intent === "DEPARTMENT_RECOMMENDATION"
      ? { recommendedDepartments: (reply.recommendations ?? []).filter((item) => Number(item.confidence) >= 0.8).slice(0, 2).map((item) => ({ departmentId: item.departmentId, confidence: Number(item.confidence) })) }
      : {};
    const waitingStillActive = workflowBefore.activeTaskType === "COLLECT_VISIT_INFORMATION"
      && Boolean(session.patient_id && this.db.get(`SELECT appointment_id FROM appointments WHERE patient_id=:patient AND status='CHECKED_IN' LIMIT 1`, { patient: session.patient_id }));
    const temporaryIntents = new Set(["DOCTOR_QUERY", "PATIENT_JOURNEY_QUERY", "EMOTIONAL_SUPPORT", "EMERGENCY_ASSISTANCE", "LOCATION_HELP", "HUMAN_HELP", "GENERAL_GUIDE", "INSURANCE_HISTORY"]);
    if (temporaryIntents.has(reply.intent)) {
      // A temporary request is completed in this turn; keep the durable workflow task intact.
    } else if (reply.intent !== "WAITING_INTERVIEW" && !waitingStillActive) {
      this.updateWorkflowState(session.session_id, {
        activeTaskType: reply.intent,
        activeTaskStatus: ["APPOINTMENT_HELP", "DEPARTMENT_RECOMMENDATION", "CANCEL_APPOINTMENT"].includes(reply.intent) ? "WAITING_FOR_USER" : reply.toolDecision === "REQUEST_HUMAN_SERVICE" ? "NEEDS_HUMAN" : "COMPLETED",
        pendingField: null,
        lastQuestion: null,
        ...recommendationPatch,
      });
    } else if (reply.intent !== "WAITING_INTERVIEW" && waitingStillActive) {
      this.updateWorkflowState(session.session_id, {
        suspendedTasks: [...workflowBefore.suspendedTasks.slice(-4), { taskType: reply.intent, completedAt: now }],
      });
    }
    const modelFacts = normalizeModelFacts(reply.factCandidates);
    const localFacts = localFactCandidates(message);
    const pendingFacts = deniedPendingFact(message, workflowBefore.pendingField);
    this.writeStructuredFacts(session, turnId, [...modelFacts, ...localFacts, ...pendingFacts]);
    if (reply.intent === "WAITING_INTERVIEW") {
      const previousField = reply.pendingField ?? workflowBefore.pendingField;
      const confirmedFields = this.confirmedFactFields(session.session_id);
      const captured = previousField ? confirmedFields.includes(previousField) : true;
      const prompt = nextWaitingPrompt(confirmedFields, captured ? null : previousField);
      const acknowledgement = captured ? reply.text : "我还没有确认这项信息。";
      reply.text = `${acknowledgement}${prompt ? ` ${prompt.question}` : " 候诊信息已经整理完成，请留意叫号。"}`;
      this.updateWorkflowState(session.session_id, {
        activeTaskType: "COLLECT_VISIT_INFORMATION", activeTaskStatus: prompt ? "WAITING_FOR_USER" : "COMPLETED",
        pendingField: prompt?.field ?? null, lastQuestion: prompt?.question ?? null,
      });
    }
    const salutation = this.patientSalutation(session);
    let replyBody = reply.text.length > 220 ? `${reply.text.slice(0, 217)}…` : reply.text;
    if (onDelta) {
      if (salutation) onDelta(`${salutation}，`);
      const context = this.structuredConversationContext(session);
      const streamed = reply.model?.provider === "deepseek" && reply.intent !== "EMOTIONAL_SUPPORT" ? await this.departmentRouter.streamPatientReply({ draft: replyBody, context }, onDelta) : null;
      if (streamed) replyBody = streamed;
      else for (const delta of (replyBody.match(/.{1,12}/gu) ?? [replyBody])) onDelta(delta);
    }
    reply.text = salutation ? `${salutation}，${replyBody}` : replyBody;
    const assistantActions = this.buildAssistantActions(session, message, reply);
    this.db.run(`INSERT INTO conversation_turns(turn_id,session_id,role,message,created_at,assistant_actions_json,interaction_id,reply_to_turn_id,turn_kind,turn_status) VALUES(:id,:session,'AGENT',:message,:created,:actions,:interaction,:replyTo,'CHAT','ACTIVE')`, {
      id: newId("turn"), session: session.session_id, message: reply.text, created: isoNow(), actions: json(assistantActions), interaction: interactionId, replyTo: turnId,
    });
    const { factCandidates: _internalFacts, ...publicReply } = reply;
    return { turnId, currentStage: session.current_stage, ...publicReply, assistantActions };
  }

  undoConfirmationAction(prepared) {
    return {
      type: "UNDO_TURN_CONFIRMATION", tool: "prepare_undo_last_turn", status: "AWAITING_USER_CONFIRMATION",
      title: "确认撤销上一条输入", actionId: prepared.actionId, targetPreview: prepared.targetPreview,
      summary: prepared.summary, expiresAt: prepared.expiresAt,
    };
  }

  insertUndoControlReply(session, interactionId, replyToTurnId, text, assistantActions) {
    this.db.run(`INSERT INTO conversation_turns(turn_id,session_id,role,message,created_at,assistant_actions_json,interaction_id,reply_to_turn_id,turn_kind,turn_status)
      VALUES(:id,:session,'AGENT',:message,:created,:actions,:interaction,:replyTo,'CONTROL','ACTIVE')`, {
      id: newId("turn"), session: session.session_id, message: text, created: isoNow(), actions: json(assistantActions),
      interaction: interactionId, replyTo: replyToTurnId,
    });
  }

  async prepareConversationUndoFromMessage(session, message, onDelta = null) {
    const interactionId = newId("interaction");
    const turnId = newId("turn");
    this.db.run(`INSERT INTO conversation_turns(turn_id,session_id,role,message,created_at,assistant_actions_json,interaction_id,turn_kind,turn_status)
      VALUES(:id,:session,'PATIENT',:message,:created,'[]',:interaction,'CONTROL','ACTIVE')`, {
      id: turnId, session: session.session_id, message, created: isoNow(), interaction: interactionId,
    });
    const prepared = this.conversationRollback.prepare(session, { excludedTurnId: turnId, controlInteractionId: interactionId });
    const text = prepared.available ? prepared.summary : prepared.message;
    const salutation = this.patientSalutation(session);
    const replyText = `${salutation ? `${salutation}，` : ""}${text}`.slice(0, 500);
    if (onDelta) for (const delta of (replyText.match(/.{1,12}/gu) ?? [replyText])) onDelta(delta);
    const assistantActions = prepared.available ? [this.undoConfirmationAction(prepared)] : [];
    this.insertUndoControlReply(session, interactionId, turnId, replyText, assistantActions);
    return { turnId, currentStage: session.current_stage, intent: "UNDO_LAST_TURN", text: replyText, assistantActions, undoAvailable: prepared.available, reasonCode: prepared.reasonCode ?? null };
  }

  prepareConversationUndo(session) {
    const interactionId = newId("interaction");
    const prepared = this.conversationRollback.prepare(session, { controlInteractionId: interactionId });
    const text = prepared.available ? prepared.summary : prepared.message;
    const salutation = this.patientSalutation(session);
    const replyText = `${salutation ? `${salutation}，` : ""}${text}`.slice(0, 500);
    const assistantActions = prepared.available ? [this.undoConfirmationAction(prepared)] : [];
    this.insertUndoControlReply(session, interactionId, null, replyText, assistantActions);
    return { ...prepared, message: replyText, assistantActions };
  }

  confirmConversationUndo(session, actionId) {
    const result = this.conversationRollback.confirm(session, requireString(actionId, "撤销确认", 1, 100));
    const { assistantActionsJson, ...publicResult } = result;
    return { ...publicResult, assistantActions: this.restoreAssistantActions(session, assistantActionsJson ?? "[]") };
  }

  cancelConversationUndo(session, actionId) {
    return this.conversationRollback.cancel(session, requireString(actionId, "撤销确认", 1, 100));
  }

  async replyForMessage(session, message) {
    const safety = this.safetyGuard.assess(message);
    if (safety.emergency) {
      const call = this.safetyGuard.requestNurseAssistance(session);
      return {
        intent: "EMERGENCY_ASSISTANCE", emergencyCall: call,
        text: "已发出模拟护士呼叫信号。请立即呼喊附近工作人员；如果不在医院，请立即拨打120。",
        toolDecision: "SIMULATED_NURSE_CALL",
      };
    }
    if (safety.negativeEmotion) {
      const context = this.structuredConversationContext(session);
      const support = this.departmentRouter
        ? await this.departmentRouter.emotionalSupport({ expression: message, context })
        : { text: "听起来这段过程让您很不好受。我会尽量帮您把眼前这一步处理清楚。", provider: "fallback", degraded: true };
      const businessMessage = message.replace(/烦死|太烦|很烦|烦躁|崩溃|绝望|受不了|心情不好|很难过|很焦虑|害怕|无助/g, "").trim();
      const businessIntent = this.deterministicReply(session, businessMessage);
      const hasBusinessIntent = !["GENERAL_GUIDE", "MEDICAL_INFORMATION"].includes(businessIntent.intent);
      return { intent: "EMOTIONAL_SUPPORT", text: support.text, model: support, resumeCurrentTask: true, emotionBusinessReply: hasBusinessIntent ? businessIntent : null };
    }
    const deterministic = this.deterministicReply(session, message);
    const waitingAppointment = session.patient_id ? this.db.get(`SELECT appointment_id FROM appointments WHERE patient_id=:patient AND status='CHECKED_IN' ORDER BY updated_at DESC LIMIT 1`, { patient: session.patient_id }) : null;
    const waitingStarted = waitingAppointment ? this.db.get(`SELECT event_id FROM proactive_agent_events WHERE session_id=:session AND appointment_id=:appointment AND event_type='WAITING_INTERVIEW'`, { session: session.session_id, appointment: waitingAppointment.appointment_id }) : null;
    const workflow = this.workflowState(session.session_id);
    const waitingAnswer = Boolean(waitingStarted && workflow.pendingField && ["GENERAL_GUIDE", "MEDICAL_INFORMATION"].includes(deterministic.intent));
    if (waitingAnswer && this.departmentRouter) {
      const waitingContext = this.structuredConversationContext({ ...session, current_stage: "WAITING" });
      const interview = await this.departmentRouter.waitingInterview({ expression: message, context: waitingContext, initial: false, targetField: workflow.pendingField });
      return {
        intent: "WAITING_INTERVIEW", text: interview.result.acknowledgement || "好的。", pendingField: workflow.pendingField,
        factCandidates: interview.result.extractedFacts ?? [], model: { provider: interview.provider, degraded: interview.degraded, error: interview.error ?? null },
      };
    }
    if (deterministic.intent === "APPOINTMENT_HELP") {
      const recommendations = this.validWorkflowRecommendations(workflow).map((item) => {
        const department = this.knowledge.departments.find((candidate) => candidate.departmentId === item.departmentId);
        return { ...item, departmentName: department.displayName ?? department.name };
      });
      if (recommendations.length) {
        const names = recommendations.map((item) => item.departmentName).join("、");
        return {
          ...deterministic,
          text: session.patient_id
            ? `我会继续按刚才推荐的${names}为您查询号源；挂号写入前仍需您明确确认。`
            : `我会继续按刚才推荐的${names}为您查询号源；挂号前请先填写基本信息。`,
          recommendations,
          toolDecision: "SHOW_APPOINTMENT_SERVICE",
        };
      }
    }
    if (!["GENERAL_GUIDE", "MEDICAL_INFORMATION"].includes(deterministic.intent) || !this.departmentRouter) return deterministic;
    const context = this.structuredConversationContext(session);
    const resolved = deterministic.intent === "MEDICAL_INFORMATION"
      ? { result: { intent: "MEDICAL_INFORMATION", handled: true, confidence: 1, answer: "", entities: {}, extractedFacts: [], shouldRequestHumanHelp: false }, provider: "local", degraded: false }
      : await this.departmentRouter.resolveTurn({ expression: message, context });
    const resolutionModel = { provider: resolved.provider, degraded: resolved.degraded, errorCode: resolved.errorCode ?? null, error: resolved.error ?? null };
    if (!resolved.result.handled || resolved.result.shouldRequestHumanHelp) {
      return { intent: "HUMAN_HELP", text: "我暂时无法可靠理解或完成这个请求，请前往现场导诊台寻求人工帮助。", toolDecision: "REQUEST_HUMAN_SERVICE", model: resolutionModel };
    }
    if (resolved.result.intent !== "MEDICAL_INFORMATION") {
      const intent = resolved.result.intent === "SESSION_MANAGEMENT" ? "GENERAL_GUIDE" : resolved.result.intent;
      const specialized = {};
      if (intent === "DOCTOR_QUERY") specialized.doctorQuery = this.doctorDirectory.parseQuery(message);
      if (intent === "PATIENT_JOURNEY_QUERY") specialized.journeyQueryType = ["APPOINTMENT", "PRESCRIPTION", "EXAMINATION"].includes(resolved.result.entities?.queryType) ? resolved.result.entities.queryType : "ALL";
      return { intent, text: resolved.result.answer, entities: resolved.result.entities, factCandidates: resolved.result.extractedFacts, toolDecision: resolved.result.intent === "HUMAN_HELP" ? "REQUEST_HUMAN_SERVICE" : "NONE", model: resolutionModel, ...specialized };
    }
    if (waitingStarted) {
      const waitingContext = this.structuredConversationContext({ ...session, current_stage: "WAITING" });
      const interview = await this.departmentRouter.waitingInterview({ expression: message, context: waitingContext, initial: false, targetField: workflow.pendingField });
      return { intent: "WAITING_INTERVIEW", text: interview.result.acknowledgement || "好的。", pendingField: workflow.pendingField, factCandidates: interview.result.extractedFacts ?? resolved.result.extractedFacts, model: { provider: interview.provider, degraded: interview.degraded, error: interview.error ?? null } };
    }
    const routed = await this.departmentRouter.recommend({ expression: message, patient: context.patient, confirmedFacts: context.confirmedFacts, conversationSummary: context.conversationSummary });
    const model = { provider: routed.provider, degraded: routed.degraded, errorCode: routed.errorCode ?? null, error: routed.error ?? null };
    if (routed.result.intent !== "DEPARTMENT_RECOMMENDATION") {
      return {
        intent: routed.result.intent,
        text: routed.result.clarificationQuestion ?? "我没有识别到需要科室导诊的信息，请直接说明您希望办理的事项。",
        recommendations: [],
        factCandidates: routed.result.extractedFacts,
        toolDecision: routed.result.suggestedTool,
        model,
      };
    }
    const recommendations = routed.result.recommendations.map((item) => {
      const department = this.knowledge.departments.find((candidate) => candidate.departmentId === item.departmentId);
      return { ...item, departmentName: department?.displayName ?? department?.name ?? item.departmentId };
    });
    if (!recommendations.length) return { intent: "DEPARTMENT_RECOMMENDATION", text: routed.result.clarificationQuestion ?? "目前信息不足以稳定推荐科室，请补充主要不舒服的位置和持续时间。", recommendations, factCandidates: routed.result.extractedFacts, toolDecision: routed.result.suggestedTool, model };
    const names = recommendations.map((item) => item.departmentName).join("、");
    const clarification = routed.result.shouldAskQuestion ? ` ${routed.result.clarificationQuestion}` : "";
    return { intent: "DEPARTMENT_RECOMMENDATION", text: `根据您提供的信息，可能更适合先咨询：${names}。${clarification}`, recommendations, factCandidates: routed.result.extractedFacts, toolDecision: routed.result.suggestedTool, model };
  }

  buildAssistantActions(session, message, reply) {
    const actions = [];
    const addProfile = () => {
      if (!session.patient_id && !actions.some((item) => item.type === "PATIENT_PROFILE_FORM")) {
        actions.push({
          type: "PATIENT_PROFILE_FORM", tool: "create_patient_profile", status: "AWAITING_USER_INPUT",
          title: "填写基本信息", manualEntryRequired: true,
          fields: ["fullName", "identityNumber"], retentionHours: this.config.patientRetentionHours,
          virtualProfile: { available: true, age: 65, sex: "male", explicitUserActionRequired: true },
        });
      }
    };
    const addAppointment = () => {
      const recommendedIds = (reply.recommendations ?? this.validWorkflowRecommendations(this.workflowState(session.session_id))).map((item) => item.departmentId);
      const departments = (recommendedIds.length
        ? recommendedIds.map((id) => this.knowledge.departments.find((item) => item.departmentId === id)).filter(Boolean)
        : this.knowledge.listDepartments({ bookingOnly: true, limit: 8 })
      ).filter((item) => this.knowledge.isBookingEligible(item)).slice(0, recommendedIds.length ? 2 : 8).map(({ departmentId, displayName, division }) => ({ departmentId, displayName, division }));
      const selectedDepartmentId = recommendedIds.length ? departments[0]?.departmentId ?? null : null;
      const date = chinaDate();
      actions.push({
        type: "APPOINTMENT_SERVICE", tool: "list_appointment_slots", status: "READ_COMPLETED",
        title: recommendedIds.length ? "查看推荐科室号源" : "查询并挂号",
        requiresProfile: !session.patient_id, departments, selectedDepartmentId, date,
        practices: selectedDepartmentId ? this.listPractices({ departmentId: selectedDepartmentId, date }) : [],
        mutationPolicy: "挂号写入前必须由患者明确确认",
      });
    };
    const addCurrentTask = () => {
      if (actions.some((action) => ["CURRENT_TASK", "APPOINTMENT_SERVICE"].includes(action.type))) return;
      const current = this.toolRegistry.execute("show_current_task", {}, { session });
      if (current) {
        actions.push({ type: "CURRENT_TASK", tool: "show_current_task", status: "READ_COMPLETED", title: current.task.title, text: current.task.text, journey: current.journey });
        return;
      }
      const workflow = this.workflowState(session.session_id);
      if (["APPOINTMENT_HELP", "DEPARTMENT_RECOMMENDATION"].includes(workflow.activeTaskType) && workflow.activeTaskStatus === "WAITING_FOR_USER") addAppointment();
      else if (workflow.activeTaskType === "COLLECT_VISIT_INFORMATION" && workflow.activeTaskStatus === "WAITING_FOR_USER") {
        actions.push({ type: "CURRENT_TASK", tool: "show_current_task", status: "AWAITING_USER_INPUT", title: "当前任务：完善候诊信息", text: workflow.lastQuestion ?? "请继续补充本次就诊信息。", journey: { appointments: [], orders: [], bills: [], tasks: [] } });
      }
    };

    if (reply.intent === "EMERGENCY_ASSISTANCE") {
      actions.push({
        type: "EMERGENCY_ASSISTANCE", tool: "request_nurse_assistance_simulated", status: reply.emergencyCall.status,
        title: "已发出模拟护士呼叫", callId: reply.emergencyCall.callId,
        text: "这是演示信号，不会联系真实护士。请立即呼喊附近工作人员；如果不在医院，请拨打120。",
        simulated: true,
      });
    } else if (reply.intent === "EMOTIONAL_SUPPORT" && reply.emotionBusinessReply) {
      const businessActions = this.buildAssistantActions(session, message, reply.emotionBusinessReply);
      actions.push(...businessActions.filter((action) => action.type !== "CURRENT_TASK"));
    } else if (reply.intent === "DOCTOR_QUERY") {
      const query = reply.doctorQuery;
      const tool = query.queryType === "SCHEDULE" ? "list_scheduled_doctors" : "search_doctors";
      const toolInput = query.queryType === "SCHEDULE"
        ? { ...query, fromDate: chinaDate() }
        : { name: query.doctorName, departmentId: query.departmentId, departmentName: query.departmentName };
      const items = this.toolRegistry.execute(tool, toolInput);
      actions.push({ type: "DOCTOR_RESULTS", tool: query.queryType === "SCHEDULE" ? "list_scheduled_doctors" : "search_doctors", status: "READ_COMPLETED", title: query.queryType === "SCHEDULE" ? "医生出诊参考" : "医生公开资料", query, items });
    } else if (reply.intent === "PATIENT_JOURNEY_QUERY") {
      const titles = { APPOINTMENT: "我的挂号", PRESCRIPTION: "我的药品", EXAMINATION: "我的检查", ALL: "我的就诊与下一步" };
      const tools = { APPOINTMENT: "get_my_appointments", PRESCRIPTION: "get_my_prescriptions", EXAMINATION: "get_my_examinations", ALL: "get_my_all" };
      const tool = tools[reply.journeyQueryType];
      const filteredJourney = this.toolRegistry.execute(tool, {}, { session });
      actions.push({ type: "JOURNEY_STATUS", tool, queryType: reply.journeyQueryType, status: "READ_COMPLETED", title: titles[reply.journeyQueryType], journey: filteredJourney });
    } else if (reply.intent === "CANCEL_APPOINTMENT") {
      const journey = this.journeyService.query(session, "APPOINTMENT");
      actions.push({ type: "JOURNEY_STATUS", tool: "get_my_appointments", status: "READ_COMPLETED", title: "选择需要退掉的挂号", journey });
    } else if (reply.intent === "APPOINTMENT_HELP") {
      addProfile();
      addAppointment();
    } else if (reply.intent === "DEPARTMENT_RECOMMENDATION" && reply.toolDecision === "SHOW_APPOINTMENT_SERVICE" && reply.recommendations?.length) {
      addProfile();
      addAppointment();
    } else if (["PAYMENT_HELP", "QUEUE_HELP", "JOURNEY_HELP"].includes(reply.intent)) {
      const journey = this.patientJourney(session);
      const appointments = reply.existingAppointmentIntercept ? this.activePatientAppointments(session) : journey.appointments;
      actions.push({ type: "JOURNEY_STATUS", tool: "get_patient_journey", status: "READ_COMPLETED", title: reply.existingAppointmentIntercept ? "已有挂号" : "我的就诊与下一步", journey: { appointments: appointments.slice(0, 3), orders: journey.orders.slice(0, 3), tasks: journey.tasks.filter((item) => item.status === "PENDING").slice(0, 3), bills: journey.bills.slice(0, 3) } });
    } else if (reply.intent === "LOCATION_HELP") {
      const query = String(reply.entities?.destination ?? message).replace(/请|帮我|告诉我|我想|我要|前往|院内|地图|在哪儿?|哪里|怎么走|怎么去|位置|路线|浏览|打开/g, "").trim();
      actions.push({ type: "LOCATION_SERVICE", tool: "open_indoor_map", status: "READ_COMPLETED", title: "院内地图与导航", query, mapPage: "map", mapAvailable: true });
    }
    if (reply.toolDecision === "REQUEST_HUMAN_SERVICE" || /工作人员|人工|导诊台/.test(message)) {
      actions.push({ type: "HUMAN_SERVICE", tool: "show_human_service_guidance", status: "READ_COMPLETED", title: "联系现场工作人员", text: "请前往医院现场导诊台，向佩戴工牌的工作人员说明您需要协助。" });
    }
    const temporaryResolved = ["DOCTOR_QUERY", "PATIENT_JOURNEY_QUERY", "EMOTIONAL_SUPPORT", "LOCATION_HELP", "HUMAN_HELP", "GENERAL_GUIDE", "INSURANCE_HISTORY"].includes(reply.intent);
    if ((temporaryResolved || !actions.length) && reply.intent !== "EMERGENCY_ASSISTANCE") addCurrentTask();
    return actions;
  }

  deterministicReply(session, message) {
    const text = message.toLowerCase();
    if (/退号|取消挂号|挂错了|这个号不要了|挂号错了/.test(text)) return { intent: "CANCEL_APPOINTMENT", text: session.patient_id ? "我已查询可以处理的挂号，请选择并确认退号。" : "当前还没有可关联的患者挂号。" };
    if (/(?:我的|给我|医生开).{0,8}(?:药|处方)|(?:药品|处方).{0,8}(?:哪里|什么|哪些|查看|查询|缴费)/.test(text)) return { intent: "PATIENT_JOURNEY_QUERY", journeyQueryType: "PRESCRIPTION", text: "我已查询您本次就诊的药品和相关缴费信息。" };
    if (/(?:我的|给我|医生开).{0,8}(?:检查|检验)|(?:检查|检验).{0,8}(?:哪里|什么|哪些|查看|查询|缴费|做了吗)/.test(text)) return { intent: "PATIENT_JOURNEY_QUERY", journeyQueryType: "EXAMINATION", text: "我已查询您本次就诊的检查和相关缴费信息。" };
    if (/(?:我的|我有|我挂|挂的).{0,8}(?:挂号|预约|哪个科|哪天|医生)/.test(text)) return { intent: "PATIENT_JOURNEY_QUERY", journeyQueryType: "APPOINTMENT", text: "我已查询您的挂号信息。" };
    if (/医生|大夫|专家|出诊|坐诊|排班/.test(text) && !/医生开/.test(text)) {
      const doctorQuery = this.doctorDirectory.parseQuery(text);
      return { intent: "DOCTOR_QUERY", doctorQuery, text: doctorQuery.queryType === "SCHEDULE" ? "我已查询离线出诊参考；它不是实时号源，请以挂号服务显示为准。" : "我已查询官网公开的医生资料。" };
    }
    if (text.includes("工作人员") || text.includes("人工") || text.includes("导诊台")) return { intent: "HUMAN_HELP", text: "我已为您显示现场人工协助方式。" };
    if (text.includes("医保") || text.includes("报销")) return { intent: "INSURANCE_HISTORY", text: `${this.knowledge.insurance.displayNotice} 具体办理条件和材料请向医院医保部确认。` };
    if (text.includes("挂号") || text.includes("预约")) {
      if (session.patient_id && this.activePatientAppointments(session).length) return { intent: "JOURNEY_HELP", text: "您已经有有效挂号，信息如下。", existingAppointmentIntercept: true };
      return { intent: "APPOINTMENT_HELP", text: session.patient_id ? "请选择科室和日期。" : "请填写基本信息。" };
    }
    if (text.includes("缴费") || text.includes("付款")) return { intent: "PAYMENT_HELP", text: "我已查询账单。若有待缴项目，可在下方完成模拟支付。" };
    if (text.includes("报到") || text.includes("候诊") || text.includes("叫号") || text.includes("下一步") || text.includes("就诊状态")) return { intent: "QUEUE_HELP", text: "您的挂号状态、排队号和下一步任务如下。" };
    if (text.includes("地图") || text.includes("在哪") || text.includes("哪里") || text.includes("怎么走") || text.includes("怎么去")) return { intent: "LOCATION_HELP", text: "我已打开地点搜索和院内地图服务。" };
    if (/疼|痛|胀|晕|咳|喘|发热|发烧|恶心|呕吐|腹泻|便秘|麻木|瘙痒|红肿|出血|乏力|心慌|胸闷|不舒服|难受|过敏/.test(text)) return { intent: "MEDICAL_INFORMATION", text: "我会根据您提供的信息协助科室导诊。" };
    return { intent: "GENERAL_GUIDE", text: "我已记录您的情况，并会给出导诊建议。" };
  }

  replaceLatestAssistantActions(session, actions) {
    this.db.run(`UPDATE conversation_turns SET assistant_actions_json=:actions WHERE turn_id=(SELECT turn_id FROM conversation_turns WHERE session_id=:session AND role='AGENT' AND turn_status='ACTIVE' ORDER BY created_at DESC LIMIT 1)`, {
      session: session.session_id, actions: json(actions),
    });
  }

  restoreAssistantActions(session, serializedActions) {
    const actions = parse(serializedActions, []);
    if (!Array.isArray(actions)) return [];
    return actions
      .filter((action) => action?.type !== "PATIENT_PROFILE_FORM" || !session.patient_id)
      .map((action) => {
        if (action?.type === "UNDO_TURN_CONFIRMATION") {
          const pending = this.db.get(`SELECT status,expires_at FROM pending_actions WHERE action_id=:action AND session_id=:session`, { action: action.actionId, session: session.session_id });
          return pending?.status === "PENDING" && pending.expires_at > isoNow() ? action : null;
        }
        if (action?.type === "APPOINTMENT_SERVICE") return { ...action, requiresProfile: !session.patient_id };
        if (action?.type === "JOURNEY_STATUS" && action.queryType) return { ...action, journey: this.journeyService.query(session, action.queryType) };
        if (["JOURNEY_STATUS", "POST_VISIT_SERVICE"].includes(action?.type)) return { ...action, journey: this.patientJourney(session) };
        if (action?.type === "CURRENT_TASK") {
          const currentTask = this.taskManager.current(this.patientJourney(session));
          return currentTask ? { ...action, title: currentTask.title, text: currentTask.text, journey: this.journeyService.query(session, currentTask.journeyFilter) } : null;
        }
        return action;
      }).filter(Boolean);
  }

  conversation(session) {
    this.conversationRollback.expirePending(session.session_id);
    return this.db.all(`SELECT turn_id,role,message,created_at,assistant_actions_json FROM conversation_turns WHERE session_id=:session AND turn_status='ACTIVE' ORDER BY created_at`, { session: session.session_id }).map((row) => ({
      turnId: row.turn_id, role: row.role, message: row.message, createdAt: row.created_at,
      assistantActions: row.role === "AGENT" ? this.restoreAssistantActions(session, row.assistant_actions_json) : [],
    }));
  }
}
