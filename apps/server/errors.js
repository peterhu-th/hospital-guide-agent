export class AppError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function assert(condition, status, code, message, details) {
  if (!condition) throw new AppError(status, code, message, details);
}

const ERROR_CATEGORIES = {
  VALIDATION_ERROR: "input", INVALID_EMPLOYEE_NUMBER: "input", INVALID_IDENTITY_NUMBER: "identity",
  DUPLICATE_DEPARTMENT_APPOINTMENT: "appointment", SLOT_FULL: "appointment", PRACTICE_UNAVAILABLE: "appointment",
  ACCOUNT_TEMPORARILY_LOCKED: "authentication", INVALID_CREDENTIALS: "authentication",
  MEDICAL_RECORD_VERSION_CONFLICT: "record", MEDICAL_RECORD_NOT_FOUND: "authorization",
  APPOINTMENT_NOT_FOUND: "business_state", INVALID_APPOINTMENT_STATE: "business_state",
  NOT_FOUND: "resource", INTERNAL_ERROR: "system",
};

const ERROR_ACTIONS = {
  DUPLICATE_DEPARTMENT_APPOINTMENT: ["查看已有挂号", "退号后重试", "使用换号功能"],
  SLOT_FULL: ["更换医生", "更换时段"], PRACTICE_UNAVAILABLE: ["刷新号源", "选择其他时段"],
  MEDICAL_RECORD_VERSION_CONFLICT: ["刷新病历", "核对后重新保存"],
  ACCOUNT_TEMPORARILY_LOCKED: ["稍后重试"], INVALID_CREDENTIALS: ["核对工号和密码"],
  INVALID_IDENTITY_NUMBER: ["核对身份证号码"],
};

export function errorEnvelope(error) {
  const code = error.code ?? "INTERNAL_ERROR";
  return {
    code, message: error.message, category: ERROR_CATEGORIES[code] ?? "business_state",
    recoverable: code !== "INTERNAL_ERROR",
    recommendedActions: ERROR_ACTIONS[code] ?? ["返回上一步", "咨询工作人员"],
    ...(error.details ? { details: error.details } : {}),
  };
}
