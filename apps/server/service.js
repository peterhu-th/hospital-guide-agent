import { AppError, assert } from "./errors.js";
import {
  decryptText, encryptText, hashPassword, hmac, maskIdentityNumber, maskName,
  newId, randomToken, safeEqual, sha256, verifyPassword,
} from "./security.js";
import {
  requireInteger, requireString, validateChineseIdentityNumber, validateDate,
  validateEmployeeNumber, validatePassword, validateTime,
} from "./validation.js";

const isoNow = () => new Date().toISOString();
const addHours = (date, hours) => new Date(date.valueOf() + hours * 3600_000).toISOString();
const chinaDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const json = (value) => JSON.stringify(value ?? {});
const parse = (value, fallback = {}) => { try { return JSON.parse(value); } catch { return fallback; } };

function rowToPractice(row) {
  return {
    practiceId: row.practice_id, doctorId: row.doctor_id, doctorName: row.doctor_name,
    departmentId: row.department_id, departmentName: row.department_name,
    serviceDate: row.service_date, startTime: row.start_time, endTime: row.end_time,
    capacity: row.capacity, bookedCount: row.booked_count,
    remaining: Math.max(0, row.capacity - row.booked_count), status: row.status,
  };
}

function classifyPatientStatement(words) {
  let category = "chiefConcern";
  if (/过敏|不耐受/.test(words)) category = "patientAllergies";
  else if (/吃药|服药|用药|药物/.test(words)) category = "patientMedications";
  else if (/既往|以前|曾经|病史|手术史/.test(words)) category = "patientHistory";
  else if (/想问|希望医生|担心|最想解决/.test(words)) category = "patientQuestions";
  else if (/多久|开始|持续|反复|天|周|月|年/.test(words)) category = "timeline";
  const certainty = /可能|不确定|好像|大概|也许/.test(words) ? "UNCERTAIN" : "PATIENT_REPORTED";
  return { category, certainty };
}

export class HospitalService {
  constructor(db, knowledge, config, departmentRouter = null) {
    this.db = db;
    this.knowledge = knowledge;
    this.config = config;
    this.departmentRouter = departmentRouter;
    this.knowledge.seed(db);
    this.cleanupExpiredPatients();
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
    return { row, token: newToken, created: true };
  }

  patientSummary(session) {
    if (!session.patient_id) return { hasProfile: false, currentStage: session.current_stage, retentionHours: this.config.patientRetentionHours };
    const patient = this.db.get(`SELECT * FROM patient_profiles WHERE patient_id=:id`, { id: session.patient_id });
    if (!patient) return { hasProfile: false, retentionHours: this.config.patientRetentionHours };
    return {
      hasProfile: true, patientId: patient.patient_id, fullNameMasked: patient.full_name_masked,
      identityNumberMasked: patient.identity_masked, sex: patient.sex, age: patient.age,
      verificationStatus: patient.verification_status, expiresAt: patient.expires_at,
      currentStage: session.current_stage,
      retentionHours: this.config.patientRetentionHours,
    };
  }

  createPatientProfile(session, input) {
    assert(!session.patient_id, 409, "PROFILE_ALREADY_EXISTS", "本次会话已完成患者建档");
    assert(input?.manualEntry === true, 422, "MANUAL_ENTRY_REQUIRED", "姓名和身份证号必须由患者在表单中手工填写，性别和年龄由身份证号自动识别");
    const fullName = requireString(input.fullName, "姓名", 2, 50);
    const identity = validateChineseIdentityNumber(input.identityNumber);
    const now = isoNow();
    const patientId = newId("patient");
    const expires = addHours(new Date(), this.config.patientRetentionHours);
    this.db.transaction(() => {
      this.db.run(`INSERT INTO patient_profiles VALUES(:id,:name,:nameMask,:identity,:digest,:identityMask,:sex,:age,:birth,'SELF_DECLARED',1,:created,:active,:expires)`, {
        id: patientId, name: encryptText(fullName, this.config.encryptionKey), nameMask: maskName(fullName),
        identity: encryptText(identity.value, this.config.encryptionKey), digest: hmac(identity.value, this.config.encryptionKey),
        identityMask: maskIdentityNumber(identity.value), sex: identity.sex, age: identity.age, birth: identity.birthDate,
        created: now, active: now, expires,
      });
      this.db.run(`UPDATE patient_sessions SET patient_id=:patientId,current_stage='APPOINTMENT' WHERE session_id=:sessionId`, { patientId, sessionId: session.session_id });
      this.audit("PATIENT", patientId, "PATIENT_PROFILE_CREATED", "patient_profile", patientId, { manualEntry: true, verificationStatus: "SELF_DECLARED" });
    });
    return this.patientSummary({ ...session, patient_id: patientId });
  }

  previewPatientIdentity(input) {
    const identity = validateChineseIdentityNumber(input.identityNumber);
    return { sex: identity.sex, age: identity.age, birthDate: identity.birthDate };
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
    const contact = input.contact ? requireString(input.contact, "联系方式", 0, 100) : "";
    const existing = this.db.get(`SELECT doctor_id FROM doctors WHERE employee_number=:employee`, { employee: employeeNumber });
    assert(!existing, 409, "DOCTOR_ACCOUNT_EXISTS", "该六位工号已被注册");
    const doctorId = newId("doctor");
    const now = isoNow();
    const verificationNotice = "系统内账号申请，未接入绵阳市中心医院人事系统核验；须由系统管理员审核激活";
    this.db.run(`INSERT INTO doctors VALUES(:id,:name,:employee,:password,:contact,'PENDING_REVIEW',:notice,0,NULL,:created)`, {
      id: doctorId, name: displayName, employee: employeeNumber,
      password: hashPassword(password), contact: contact ? encryptText(contact, this.config.encryptionKey) : null,
      notice: verificationNotice, created: now,
    });
    this.audit("DOCTOR", doctorId, "DOCTOR_REGISTERED", "doctor_account", doctorId, { status: "PENDING_REVIEW" });
    return { doctorId, accountStatus: "PENDING_REVIEW", verificationNotice };
  }

  administratorSetupStatus() {
    return { initialized: this.db.get(`SELECT count(*) total FROM administrators`).total > 0 };
  }

  initializeAdministrator(input) {
    assert(!this.administratorSetupStatus().initialized, 409, "ADMINISTRATOR_ALREADY_INITIALIZED", "管理员已经初始化");
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
      status, id: doctorId, notice: status === "ACTIVE" ? "管理员已审核激活的系统内医生账号" : "管理员已停用该系统内医生账号",
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
    assert(token, 401, "DOCTOR_AUTH_REQUIRED", "请先登录医生工作台");
    const row = this.db.get(`SELECT s.*,d.* FROM doctor_sessions s JOIN doctors d ON d.doctor_id=s.doctor_id WHERE s.token_hash=:hash AND s.revoked_at IS NULL AND s.expires_at>:now`, { hash: sha256(token), now: isoNow() });
    assert(row && row.account_status === "ACTIVE", 401, "DOCTOR_SESSION_INVALID", "医生会话已失效，请重新登录");
    return row;
  }

  requireCsrf(doctorSession, token) {
    assert(token && safeEqual(sha256(token), doctorSession.csrf_hash), 403, "CSRF_CHECK_FAILED", "安全校验失败，请刷新医生工作台后重试");
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
      if (error.code === "ERR_SQLITE_ERROR" && String(error.message).includes("UNIQUE")) throw new AppError(409, "PRACTICE_ALREADY_EXISTS", "相同科室和时段的出诊安排已存在");
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
      const practiceId = requireString(parameters.practiceId, "号源", 1, 100);
      const practice = this.db.get(`SELECT p.*,d.display_name doctor_name,dp.display_name department_name FROM doctor_practices p JOIN doctors d ON d.doctor_id=p.doctor_id JOIN departments dp ON dp.department_id=p.department_id WHERE p.practice_id=:id`, { id: practiceId });
      assert(practice && practice.status === "ACTIVE" && practice.service_date >= chinaDate(), 409, "PRACTICE_UNAVAILABLE", "该出诊时段当前不可挂号");
      summary = `确认挂号：${practice.service_date} ${practice.start_time}-${practice.end_time}，${practice.department_name}，${practice.doctor_name}医生`;
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
    else result = this.rescheduleAppointment(session, parameters.appointmentId, parameters.practiceId, true);
    this.db.run(`UPDATE pending_actions SET status='CONFIRMED',confirmed_at=:now WHERE action_id=:id`, { now: isoNow(), id });
    return { actionId: id, actionType: action.action_type, result };
  }

  createAppointment(session, input, confirmed = false) {
    assert(confirmed, 428, "EXPLICIT_CONFIRMATION_REQUIRED", "挂号前必须先生成待确认操作并由患者明确确认");
    assert(session.patient_id, 422, "PATIENT_PROFILE_REQUIRED", "挂号前请先手工填写姓名、身份证号、性别和年龄");
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
      assert(updated.changes === 1, 409, "SLOT_FULL", "该时段号源已满，请更换医生或时段，也可暂不挂号");
      const queueNumber = practice.booked_count + 1;
      this.db.run(`INSERT INTO appointments VALUES(:id,:patient,:practice,:doctor,:department,'BOOKED',:queue,:created,:updated)`, { id: appointmentId, patient: session.patient_id, practice: practiceId, doctor: practice.doctor_id, department: practice.department_id, queue: queueNumber, created: now, updated: now });
      const recordId = newId("record");
      this.db.run(`INSERT INTO medical_records VALUES(:id,:appointment,:patient,:doctor,:department,1,'{}',:created,:updated)`, { id: recordId, appointment: appointmentId, patient: session.patient_id, doctor: practice.doctor_id, department: practice.department_id, created: now, updated: now });
      this.db.run(`INSERT INTO medical_record_versions VALUES(:id,:record,1,'{}','SYSTEM','初始建档',:created)`, { id: newId("record-version"), record: recordId, created: now });
      this.copyPatientStatements(session.session_id, recordId);
      this.db.run(`INSERT INTO journey_tasks VALUES(:id,:appointment,'CHECK_IN','PENDING','到院后在门诊报到',:created)`, { id: newId("task"), appointment: appointmentId, created: now });
      this.audit("PATIENT", session.patient_id, "APPOINTMENT_CREATED", "appointment", appointmentId, { practiceId, queueNumber });
      return { appointmentId, recordId, queueNumber };
    });
    return result;
  }

  copyPatientStatements(sessionId, recordId) {
    const rows = this.db.all(`SELECT * FROM conversation_turns WHERE session_id=:session AND role='PATIENT' ORDER BY created_at`, { session: sessionId });
    for (const turn of rows) {
      const classification = classifyPatientStatement(turn.message);
      this.db.run(`INSERT OR IGNORE INTO patient_statements VALUES(:id,:record,:turn,:words,NULL,:category,:certainty,:created)`, { id: newId("statement"), record: recordId, turn: turn.turn_id, words: turn.message, category: classification.category, certainty: classification.certainty, created: turn.created_at });
    }
  }

  appendStatementToOpenRecords(sessionId, turnId, words, createdAt) {
    const session = this.db.get(`SELECT patient_id FROM patient_sessions WHERE session_id=:id`, { id: sessionId });
    if (!session?.patient_id) return;
    const records = this.db.all(`SELECT r.record_id FROM medical_records r JOIN appointments a ON a.appointment_id=r.appointment_id WHERE r.patient_id=:patient AND a.status NOT IN ('CANCELLED','COMPLETED')`, { patient: session.patient_id });
    const classification = classifyPatientStatement(words);
    for (const record of records) this.db.run(`INSERT OR IGNORE INTO patient_statements VALUES(:id,:record,:turn,:words,NULL,:category,:certainty,:created)`, { id: newId("statement"), record: record.record_id, turn: turnId, words, category: classification.category, certainty: classification.certainty, created: createdAt });
  }

  listPatientAppointments(session) {
    if (!session.patient_id) return [];
    return this.db.all(`SELECT a.*,p.service_date,p.start_time,p.end_time,d.display_name doctor_name,dp.display_name department_name FROM appointments a JOIN doctor_practices p ON p.practice_id=a.practice_id JOIN doctors d ON d.doctor_id=a.doctor_id JOIN departments dp ON dp.department_id=a.department_id WHERE a.patient_id=:patient ORDER BY a.created_at DESC`, { patient: session.patient_id }).map((row) => ({
      appointmentId: row.appointment_id, status: row.status, queueNumber: row.queue_number,
      doctorName: row.doctor_name, departmentName: row.department_name,
      serviceDate: row.service_date, startTime: row.start_time, endTime: row.end_time,
    }));
  }

  transitionAppointment(actor, appointmentId, action) {
    const transitions = { CHECK_IN: ["BOOKED", "CHECKED_IN"], CALL: ["CHECKED_IN", "WAITING"], START: ["WAITING", "IN_CONSULTATION"], COMPLETE: ["IN_CONSULTATION", "COMPLETED"] };
    const pair = transitions[action];
    assert(pair, 422, "UNKNOWN_TRANSITION", "未知的就诊状态操作");
    const row = this.db.get(`SELECT * FROM appointments WHERE appointment_id=:id AND doctor_id=:doctor`, { id: appointmentId, doctor: actor.doctor_id });
    assert(row, 404, "APPOINTMENT_NOT_FOUND", "挂号不存在或无权操作");
    assert(row.status === pair[0], 409, "INVALID_APPOINTMENT_STATE", `当前状态 ${row.status} 不能执行该操作`);
    this.db.run(`UPDATE appointments SET status=:status,updated_at=:now WHERE appointment_id=:id`, { status: pair[1], now: isoNow(), id: appointmentId });
    this.audit("DOCTOR", actor.doctor_id, `APPOINTMENT_${action}`, "appointment", appointmentId, { from: pair[0], to: pair[1] });
    return { appointmentId, status: pair[1] };
  }

  cancelAppointment(session, appointmentId, confirmed = false) {
    assert(confirmed, 428, "EXPLICIT_CONFIRMATION_REQUIRED", "退号前必须由患者明确确认");
    assert(session.patient_id, 401, "PATIENT_SESSION_REQUIRED", "患者会话无效");
    return this.db.transaction(() => {
      const row = this.db.get(`SELECT * FROM appointments WHERE appointment_id=:id AND patient_id=:patient`, { id: appointmentId, patient: session.patient_id });
      assert(row, 404, "APPOINTMENT_NOT_FOUND", "挂号不存在");
      assert(["BOOKED", "CHECKED_IN"].includes(row.status), 409, "CANNOT_CANCEL", "当前就诊状态不能退号");
      this.db.run(`UPDATE appointments SET status='CANCELLED',updated_at=:now WHERE appointment_id=:id`, { now: isoNow(), id: appointmentId });
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
      this.db.run(`INSERT OR IGNORE INTO journey_tasks VALUES(:task,:appointment,'WAITING','PENDING','在对应科室候诊，留意叫号',:created)`, { task: newId("task"), appointment: appointmentId, created: isoNow() });
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
    return this.db.all(`SELECT a.*,p.service_date,p.start_time,p.end_time,dp.display_name department_name,pp.full_name_encrypted,pp.full_name_masked,pp.sex,pp.age FROM appointments a JOIN doctor_practices p ON p.practice_id=a.practice_id JOIN departments dp ON dp.department_id=a.department_id JOIN patient_profiles pp ON pp.patient_id=a.patient_id WHERE a.doctor_id=:doctor ORDER BY p.service_date,p.start_time,a.queue_number`, { doctor: doctor.doctor_id }).map((row) => ({
      appointmentId: row.appointment_id, status: row.status, queueNumber: row.queue_number,
      patient: { fullName: decryptText(row.full_name_encrypted, this.config.encryptionKey), sex: row.sex, age: row.age },
      departmentName: row.department_name, serviceDate: row.service_date, startTime: row.start_time, endTime: row.end_time,
    }));
  }

  getRecordForDoctor(doctor, appointmentId) {
    const row = this.db.get(`SELECT r.*,a.status appointment_status,pp.full_name_encrypted,pp.sex,pp.age,dp.display_name department_name FROM medical_records r JOIN appointments a ON a.appointment_id=r.appointment_id JOIN patient_profiles pp ON pp.patient_id=r.patient_id JOIN departments dp ON dp.department_id=r.department_id WHERE r.appointment_id=:appointment AND r.doctor_id=:doctor`, { appointment: appointmentId, doctor: doctor.doctor_id });
    assert(row, 404, "MEDICAL_RECORD_NOT_FOUND", "病历不存在或无权查看");
    const statements = this.db.all(`SELECT statement_id,source_turn_id,patient_words,normalized_value,category,certainty,created_at FROM patient_statements WHERE record_id=:record ORDER BY created_at`, { record: row.record_id });
    const versions = this.db.all(`SELECT version,changed_by,change_reason,created_at FROM medical_record_versions WHERE record_id=:record ORDER BY version DESC`, { record: row.record_id });
    const orders = this.listOrders(row.record_id);
    this.audit("DOCTOR", doctor.doctor_id, "MEDICAL_RECORD_VIEWED", "medical_record", row.record_id, { appointmentId });
    return {
      recordId: row.record_id, appointmentId, version: row.version, appointmentStatus: row.appointment_status,
      patient: { fullName: decryptText(row.full_name_encrypted, this.config.encryptionKey), sex: row.sex, age: row.age },
      departmentName: row.department_name, patientStatements: statements.map((item) => ({ statementId: item.statement_id, sourceTurnId: item.source_turn_id, patientWords: item.patient_words, normalizedValue: item.normalized_value, category: item.category, certainty: item.certainty, createdAt: item.created_at })),
      doctorContent: parse(row.doctor_content_json), versions: versions.map((item) => ({ version: item.version, changedBy: item.changed_by, changeReason: item.change_reason, createdAt: item.created_at })), orders,
      authorityNotice: "医生保存的医学内容保持原样；Agent 不会评价、纠正、质疑或覆盖。",
    };
  }

  saveRecord(doctor, recordId, input) {
    const expectedVersion = requireInteger(input.expectedVersion, "期望版本", 1, 1_000_000);
    const changeReason = requireString(input.changeReason, "修改原因", 2, 200);
    assert(input.content && typeof input.content === "object" && !Array.isArray(input.content), 422, "VALIDATION_ERROR", "病历内容格式无效");
    const allowed = ["chiefConcern", "presentIllness", "history", "medications", "allergies", "doctorAssessment", "plan"];
    const content = {};
    for (const key of allowed) content[key] = requireString(String(input.content[key] ?? ""), key, 0, 5000);
    const now = isoNow();
    const nextVersion = expectedVersion + 1;
    this.db.transaction(() => {
      const row = this.db.get(`SELECT * FROM medical_records WHERE record_id=:id AND doctor_id=:doctor`, { id: recordId, doctor: doctor.doctor_id });
      assert(row, 404, "MEDICAL_RECORD_NOT_FOUND", "病历不存在或无权修改");
      assert(row.version === expectedVersion, 409, "MEDICAL_RECORD_VERSION_CONFLICT", "病历已被修改，请刷新后重新编辑", { currentVersion: row.version });
      this.db.run(`UPDATE medical_records SET version=:version,doctor_content_json=:content,updated_at=:now WHERE record_id=:id`, { version: nextVersion, content: json(content), now, id: recordId });
      this.db.run(`INSERT INTO medical_record_versions VALUES(:id,:record,:version,:content,:doctor,:reason,:created)`, { id: newId("record-version"), record: recordId, version: nextVersion, content: json(content), doctor: doctor.doctor_id, reason: changeReason, created: now });
      this.audit("DOCTOR", doctor.doctor_id, "MEDICAL_RECORD_EDITED", "medical_record", recordId, { fromVersion: expectedVersion, toVersion: nextVersion, changeReason, doctorAuthorityPreserved: true });
    });
    return { recordId, version: nextVersion, doctorContent: content };
  }

  createOrder(doctor, recordId, input) {
    assert(["EXAMINATION", "PRESCRIPTION"].includes(input.orderType), 422, "VALIDATION_ERROR", "医嘱类型无效");
    const title = requireString(input.title, "医嘱名称", 2, 200);
    const details = requireString(input.details, "医嘱内容", 1, 3000);
    const amountCents = requireInteger(input.amountCents ?? 0, "费用（分）", 0, 10_000_000);
    const row = this.db.get(`SELECT * FROM medical_records WHERE record_id=:record AND doctor_id=:doctor`, { record: recordId, doctor: doctor.doctor_id });
    assert(row, 404, "MEDICAL_RECORD_NOT_FOUND", "病历不存在或无权创建医嘱");
    const orderId = newId("order");
    const now = isoNow();
    this.db.transaction(() => {
      this.db.run(`INSERT INTO medical_orders VALUES(:id,:record,:doctor,:type,:title,:details,'CREATED',:created)`, { id: orderId, record: recordId, doctor: doctor.doctor_id, type: input.orderType, title, details, created: now });
      const taskType = input.orderType === "EXAMINATION" ? "EXAMINATION" : "PHARMACY";
      this.db.run(`INSERT OR IGNORE INTO journey_tasks VALUES(:id,:appointment,:type,'PENDING',:title,:created)`, { id: newId("task"), appointment: row.appointment_id, type: taskType, title: input.orderType === "EXAMINATION" ? `完成检查：${title}` : `按医生处方前往药房：${title}`, created: now });
      if (amountCents > 0) this.db.run(`INSERT INTO bills VALUES(:id,:appointment,:order,:amount,'UNPAID','请前往收费窗口或医保部确认并缴费；本系统未接入真实支付渠道。',:created)`, { id: newId("bill"), appointment: row.appointment_id, order: orderId, amount: amountCents, created: now });
      this.audit("DOCTOR", doctor.doctor_id, "MEDICAL_ORDER_CREATED", "medical_order", orderId, { orderType: input.orderType, amountCents });
    });
    return { orderId, orderType: input.orderType, title, details, status: "CREATED", billStatus: amountCents > 0 ? "UNPAID" : null };
  }

  listOrders(recordId) {
    return this.db.all(`SELECT o.*,b.bill_id,b.amount_cents,b.status bill_status,b.guidance FROM medical_orders o LEFT JOIN bills b ON b.order_id=o.order_id WHERE o.record_id=:record ORDER BY o.created_at`, { record: recordId }).map((row) => ({ orderId: row.order_id, orderType: row.order_type, title: row.title, details: row.details, status: row.status, createdAt: row.created_at, bill: row.bill_id ? { billId: row.bill_id, amountCents: row.amount_cents, status: row.bill_status, guidance: row.guidance } : null }));
  }

  simulateOrderResult(doctor, orderId, objectType) {
    const order = this.db.get(`SELECT o.* FROM medical_orders o WHERE o.order_id=:id AND o.doctor_id=:doctor`, { id: orderId, doctor: doctor.doctor_id });
    assert(order, 404, "ORDER_NOT_FOUND", "医嘱不存在或无权操作");
    assert(order.order_type === "EXAMINATION", 409, "SIMULATION_NOT_ALLOWED", "只有检查医嘱可以生成设备受限的演示结果");
    const definition = this.knowledge.simulationManifest.allowedObjectTypes.find((item) => item.objectType === objectType);
    assert(definition && ["medical_image", "examination_report", "laboratory_result"].includes(objectType), 422, "SIMULATION_NOT_ALLOWED", "该对象不在允许模拟清单中");
    const resultId = newId("simulated-result");
    const content = { summary: "演示占位内容，不包含真实检查数据或医学结论", sourceOrderTitle: order.title };
    this.db.transaction(() => {
      this.db.run(`INSERT INTO simulated_results VALUES(:id,:order,:type,:content,:label,1,:created)`, { id: resultId, order: orderId, type: objectType, content: json(content), label: definition.requiredLabel, created: isoNow() });
      const linked = this.db.get(`SELECT r.appointment_id FROM medical_orders o JOIN medical_records r ON r.record_id=o.record_id WHERE o.order_id=:id`, { id: orderId });
      this.db.run(`INSERT OR IGNORE INTO journey_tasks VALUES(:id,:appointment,'RETURN_VISIT','PENDING','检查后按医生安排回诊',:created)`, { id: newId("task"), appointment: linked.appointment_id, created: isoNow() });
      this.audit("DOCTOR", doctor.doctor_id, "SIMULATED_RESULT_CREATED", "simulated_result", resultId, { objectType, simulationManifestVersion: this.knowledge.simulationManifest.version });
    });
    return { resultId, orderId, objectType, content, simulated: true, label: definition.requiredLabel };
  }

  patientJourney(session) {
    if (!session.patient_id) return { appointments: [], orders: [], tasks: [], bills: [] };
    const appointments = this.listPatientAppointments(session);
    const orders = this.db.all(`SELECT o.*,b.bill_id,b.amount_cents,b.status bill_status,b.guidance,a.appointment_id FROM medical_orders o JOIN medical_records r ON r.record_id=o.record_id JOIN appointments a ON a.appointment_id=r.appointment_id LEFT JOIN bills b ON b.order_id=o.order_id WHERE a.patient_id=:patient ORDER BY o.created_at DESC`, { patient: session.patient_id });
    const tasks = this.db.all(`SELECT t.* FROM journey_tasks t JOIN appointments a ON a.appointment_id=t.appointment_id WHERE a.patient_id=:patient ORDER BY t.created_at`, { patient: session.patient_id });
    return {
      appointments,
      orders: orders.map((row) => ({ orderId: row.order_id, appointmentId: row.appointment_id, orderType: row.order_type, title: row.title, details: row.details, status: row.status })),
      bills: orders.filter((row) => row.bill_id).map((row) => ({ billId: row.bill_id, orderId: row.order_id, amountCents: row.amount_cents, status: row.bill_status, guidance: row.guidance })),
      tasks: tasks.map((row) => ({ taskId: row.task_id, appointmentId: row.appointment_id, taskType: row.task_type, status: row.status, title: row.title })),
    };
  }

  async agentMessage(session, input) {
    const message = requireString(input.message, "消息", 1, 4000);
    const now = isoNow();
    const turnId = newId("turn");
    this.db.run(`INSERT INTO conversation_turns VALUES(:id,:session,'PATIENT',:message,:created)`, { id: turnId, session: session.session_id, message, created: now });
    const detectedStage = this.detectJourneyStage(message);
    if (detectedStage) {
      this.db.run(`UPDATE patient_sessions SET current_stage=:stage WHERE session_id=:id`, { stage: detectedStage, id: session.session_id });
      session.current_stage = detectedStage;
    }
    this.appendStatementToOpenRecords(session.session_id, turnId, message, now);
    const reply = await this.replyForMessage(session, message);
    this.db.run(`INSERT INTO conversation_turns VALUES(:id,:session,'AGENT',:message,:created)`, { id: newId("turn"), session: session.session_id, message: reply.text, created: isoNow() });
    return { turnId, currentStage: session.current_stage, ...reply, recordCapture: session.patient_id ? "患者原话已写入当前未结束就诊的病历；未生成诊断。" : "患者原话已暂存于本次会话，挂号建档后将写入病历；未生成诊断。" };
  }

  async replyForMessage(session, message) {
    const deterministic = this.deterministicReply(session, message);
    if (deterministic.intent !== "GENERAL_GUIDE" || !this.departmentRouter) return deterministic;
    const patient = session.patient_id ? this.db.get(`SELECT age,sex FROM patient_profiles WHERE patient_id=:id`, { id: session.patient_id }) : null;
    const routed = await this.departmentRouter.recommend({ expression: message, patient });
    const recommendations = routed.result.recommendations.map((item) => {
      const department = this.knowledge.departments.find((candidate) => candidate.departmentId === item.departmentId);
      return { ...item, departmentName: department?.displayName ?? department?.name ?? item.departmentId };
    });
    if (!recommendations.length) return { intent: "DEPARTMENT_RECOMMENDATION", text: routed.result.clarificationQuestion ?? "目前信息不足以稳定推荐科室，请补充主要不舒服的位置和持续时间，或咨询现场导诊台。", recommendations, model: { provider: routed.provider, degraded: routed.degraded, errorCode: routed.errorCode ?? null } };
    const names = recommendations.map((item) => item.departmentName).join("、");
    const clarification = routed.result.shouldAskQuestion ? ` ${routed.result.clarificationQuestion}` : "";
    return { intent: "DEPARTMENT_RECOMMENDATION", text: `根据您提供的信息，可能更适合先咨询：${names}。这只是科室导诊建议，不是诊断。${clarification}`, recommendations, model: { provider: routed.provider, degraded: routed.degraded, errorCode: routed.errorCode ?? null } };
  }

  detectJourneyStage(message) {
    const rules = [
      ["PHARMACY", /取药|药房/], ["RETURN_VISIT", /回诊|复诊/],
      ["EXAMINATION", /检查|检验|ct|核磁|超声/i], ["PAYMENT", /缴费|付款|收费/],
      ["WAITING", /候诊|叫号|排队/], ["CHECK_IN", /报到/], ["APPOINTMENT", /挂号|预约/],
    ];
    return rules.find(([, pattern]) => pattern.test(message))?.[0] ?? null;
  }

  deterministicReply(session, message) {
    const text = message.toLowerCase();
    if (text.includes("医保") || text.includes("报销")) return { intent: "INSURANCE_HISTORY", text: `${this.knowledge.insurance.displayNotice} 具体办理条件和材料请向绵阳市中心医院医保部确认。` };
    if (text.includes("挂号") || text.includes("预约")) return { intent: "APPOINTMENT_HELP", text: session.patient_id ? "您已完成建档。请在“挂号”区域选择科室、日期和医生出诊时段；提交前请核对信息。" : "您可以先查科室和号源；正式挂号前，请在独立表单中手工填写姓名、身份证号、性别和年龄。" };
    if (text.includes("缴费") || text.includes("付款")) return { intent: "PAYMENT_HELP", text: "本阶段未接入真实支付渠道，页面只会显示待缴费账单，不会模拟扣款成功。请按账单指引前往收费窗口或医保部确认。" };
    if (text.includes("报到") || text.includes("候诊") || text.includes("叫号")) return { intent: "QUEUE_HELP", text: "请查看“我的就诊”中的挂号状态与排队号。医生工作台完成报到/候诊状态更新后，这里会同步显示下一步。" };
    if (text.includes("地图") || text.includes("在哪") || text.includes("哪里") || text.includes("怎么走")) return { intent: "LOCATION_HELP", text: "请打开“院内地图”直接浏览 90872 地图，也可搜索地点并选择起点和终点生成静态文字路线。当前不提供实时定位和精确导航。" };
    return { intent: "GENERAL_GUIDE", text: "我已记录您主动说明的情况，并会根据完整科室目录给出结构化导诊建议；建议只用于选择科室，不是诊断。" };
  }

  conversation(session) {
    return this.db.all(`SELECT turn_id,role,message,created_at FROM conversation_turns WHERE session_id=:session ORDER BY created_at`, { session: session.session_id }).map((row) => ({ turnId: row.turn_id, role: row.role, message: row.message, createdAt: row.created_at }));
  }
}
