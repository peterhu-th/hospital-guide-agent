/**
 * 阶段 0 的可替换端口。
 *
 * 领域和应用层只能依赖这些端口，不能直接依赖 IndexedDB、数据库、
 * DeepSeek SDK、蜂鸟 SDK 或具体医院系统客户端。
 * DTO 的运行时有效性以 schemas/ 下的 JSON Schema 为准。
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

/** Sensitive command DTO. Callers must never log this object. */
export interface ManualPatientProfileInput extends JsonObject {
  readonly fullName: string;
  readonly identityNumber: string;
}

/** Password exists only on the registration boundary and is never returned. */
export interface DoctorRegistrationInput extends JsonObject {
  readonly displayName: string;
  readonly employeeNumber: string;
  readonly password: string;
  readonly contact: JsonObject;
}

export interface DoctorLoginInput extends JsonObject {
  readonly employeeNumber: string;
  readonly password: string;
}

export interface MedicalRecordRevisionInput extends JsonObject {
  readonly recordId: string;
  readonly expectedVersion: number;
  readonly content: JsonObject;
  readonly changeReason: string;
}

export interface VersionedSession extends JsonObject {
  readonly schemaVersion: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly lastActiveAt: string;
  readonly expiresAt: string;
}

export interface SessionStore<TSession extends VersionedSession> {
  get(sessionId: string): Promise<TSession | null>;
  save(session: TSession, expectedRevision: number): Promise<void>;
  delete(sessionId: string): Promise<void>;
  deleteExpired(now: string): Promise<number>;
}

/**
 * @deprecated 仅供阶段 0 历史契约回归。实名患者、医生账号和病历必须由
 * 后端 Repository 持久化，浏览器不得作为身份证号或病历的主存储。
 */
export type LegacyBrowserSessionStore<TSession extends VersionedSession> =
  SessionStore<TSession>;

export interface PatientRepository {
  createManualProfile(input: ManualPatientProfileInput): Promise<ToolResult>;
  get(patientId: string): Promise<JsonObject | null>;
  touchRetention(patientId: string): Promise<void>;
  deleteExpired(now: string): Promise<number>;
}

export interface DoctorAccountRepository {
  register(input: DoctorRegistrationInput): Promise<ToolResult>;
  findByEmployeeNumber(employeeNumber: string): Promise<JsonObject | null>;
  setAccountStatus(input: JsonObject): Promise<ToolResult>;
}

export interface PracticeScheduleRepository {
  listDoctorDepartments(doctorId: string): Promise<readonly JsonObject[]>;
  replaceDoctorDepartments(input: JsonObject): Promise<ToolResult>;
  publishSlots(input: JsonObject): Promise<ToolResult>;
  suspendPractice(input: JsonObject): Promise<ToolResult>;
}

export interface MedicalRecordRepository {
  getForPatient(patientId: string): Promise<JsonObject | null>;
  getForDoctor(input: JsonObject): Promise<JsonObject | null>;
  appendPatientStatement(input: JsonObject): Promise<ToolResult>;
  saveDoctorRevision(input: MedicalRecordRevisionInput): Promise<ToolResult>;
  listVersions(recordId: string): Promise<readonly JsonObject[]>;
}

export interface AuditRepository {
  append(event: JsonObject): Promise<void>;
  listForEntity(entityType: string, entityId: string): Promise<readonly JsonObject[]>;
}

export interface AuthenticationService {
  registerDoctor(input: DoctorRegistrationInput): Promise<ToolResult>;
  loginDoctor(input: DoctorLoginInput): Promise<ToolResult>;
  logoutDoctor(sessionId: string): Promise<void>;
  requireActiveDoctor(sessionId: string): Promise<JsonObject>;
}

export interface DeviceResultProvider {
  generateMarkedSimulation(input: JsonObject): Promise<ToolResult>;
}

export interface DepartmentRoutingRequest extends JsonObject {
  readonly contractType: "department_routing_request";
}

export interface DepartmentRoutingResponse extends JsonObject {
  readonly contractType: "department_routing_response";
}

export interface LlmProvider {
  recommendDepartment(
    request: DepartmentRoutingRequest,
  ): Promise<DepartmentRoutingResponse>;
}

export interface ToolResult<TData extends JsonValue = JsonValue>
  extends JsonObject {
  readonly success: boolean;
  readonly data: TData;
  readonly dataOrigin: string;
}

export interface HospitalRepository {
  listDepartments(): Promise<readonly JsonObject[]>;
  searchDoctors(departmentId: string): Promise<readonly JsonObject[]>;
  listAppointmentSlots(
    departmentId: string,
    doctorId: string,
  ): Promise<readonly JsonObject[]>;
  createAppointment(input: JsonObject): Promise<ToolResult>;
  cancelAppointment(input: JsonObject): Promise<ToolResult>;
  changeAppointment(input: JsonObject): Promise<ToolResult>;
  checkIn(input: JsonObject): Promise<ToolResult>;
  getQueueStatus(input: JsonObject): Promise<ToolResult>;
  getMedicalOrders(patientId: string): Promise<readonly JsonObject[]>;
  getBills(patientId: string): Promise<readonly JsonObject[]>;
  scheduleExamination(input: JsonObject): Promise<ToolResult>;
  getNextTasks(patientId: string): Promise<readonly JsonObject[]>;
}

export interface LocationSearchQuery extends JsonObject {
  readonly text: string;
}

export interface StaticRouteQuery extends JsonObject {
  readonly startLocationId: string;
  readonly endLocationId: string;
}

export interface MapProvider {
  searchLocations(query: LocationSearchQuery): Promise<readonly JsonObject[]>;
  calculateStaticRoute(query: StaticRouteQuery): Promise<JsonObject>;
}

export interface KnowledgeRepository {
  getHospitalProfile(): Promise<JsonObject>;
  getDepartment(departmentId: string): Promise<JsonObject | null>;
  search(query: string, limit: number): Promise<readonly JsonObject[]>;
}

export interface Clock {
  now(): string;
  addHours(isoDateTime: string, hours: number): string;
}

export interface IdGenerator {
  next(prefix: string): string;
}
