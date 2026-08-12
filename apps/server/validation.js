import { assert } from "./errors.js";

export function requireString(value, field, min = 1, max = 200) {
  assert(typeof value === "string", 422, "VALIDATION_ERROR", `${field} 必须是文本`);
  const trimmed = value.trim();
  assert(trimmed.length >= min && trimmed.length <= max, 422, "VALIDATION_ERROR", `${field} 长度应为 ${min}-${max} 个字符`);
  return trimmed;
}

export function requireInteger(value, field, min, max) {
  assert(Number.isInteger(value) && value >= min && value <= max, 422, "VALIDATION_ERROR", `${field} 应为 ${min}-${max} 的整数`);
  return value;
}

export function validateEmployeeNumber(value) {
  const employeeNumber = requireString(value, "院内工号", 6, 6);
  assert(/^\d{6}$/.test(employeeNumber), 422, "INVALID_EMPLOYEE_NUMBER", "院内工号必须为六位数字，例如 260101");
  return employeeNumber;
}

export function validatePassword(value) {
  return requireString(value, "密码", 8, 128);
}

export function validateDate(value, field = "日期") {
  const text = requireString(value, field, 10, 10);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`)), 422, "VALIDATION_ERROR", `${field} 格式无效`);
  return text;
}

export function validateTime(value, field) {
  const text = requireString(value, field, 5, 5);
  assert(/^([01]\d|2[0-3]):[0-5]\d$/.test(text), 422, "VALIDATION_ERROR", `${field} 格式应为 HH:mm`);
  return text;
}

export function validateChineseIdentityNumber(raw, statedAge = undefined, statedSex = undefined, now = new Date()) {
  const value = requireString(raw, "身份证号", 18, 18).toUpperCase();
  assert(/^\d{17}[\dX]$/.test(value), 422, "INVALID_IDENTITY_NUMBER", "身份证号格式无效");
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"];
  const sum = weights.reduce((total, weight, index) => total + Number(value[index]) * weight, 0);
  assert(checks[sum % 11] === value[17], 422, "INVALID_IDENTITY_NUMBER", "身份证号校验位无效");
  const birthText = value.slice(6, 14);
  const birthDate = `${birthText.slice(0, 4)}-${birthText.slice(4, 6)}-${birthText.slice(6, 8)}`;
  const birthday = new Date(`${birthDate}T00:00:00Z`);
  assert(!Number.isNaN(birthday.valueOf()) && birthday.toISOString().slice(0, 10) === birthDate && birthday <= now, 422, "INVALID_IDENTITY_NUMBER", "身份证出生日期无效");
  let age = now.getUTCFullYear() - birthday.getUTCFullYear();
  const birthdayThisYear = `${now.getUTCFullYear()}-${birthDate.slice(5)}`;
  if (now.toISOString().slice(0, 10) < birthdayThisYear) age -= 1;
  if (statedAge !== undefined) assert(age === statedAge, 422, "IDENTITY_AGE_MISMATCH", `年龄与身份证出生日期不一致，按当前日期应为 ${age} 岁`);
  const sex = Number(value[16]) % 2 === 1 ? "male" : "female";
  if (statedSex !== undefined) assert(statedSex === sex, 422, "IDENTITY_SEX_MISMATCH", "性别与身份证编码不一致");
  return { value, birthDate, age, sex };
}
