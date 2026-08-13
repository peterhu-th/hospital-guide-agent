function normalize(value) { return String(value ?? "").trim().toLowerCase(); }

function dateInChina(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function addDays(dateText, amount) {
  const date = new Date(`${dateText}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export class DoctorDirectoryService {
  constructor(knowledge) { this.knowledge = knowledge; }

  parseQuery(message) {
    const text = String(message ?? "").trim();
    const today = dateInChina();
    let date = null;
    if (text.includes("后天")) date = addDays(today, 2);
    else if (text.includes("明天")) date = addDays(today, 1);
    else if (text.includes("今天")) date = today;
    else {
      const full = text.match(/(20\d{2})[-年/.](\d{1,2})[-月/.](\d{1,2})日?/);
      const short = text.match(/(?<!\d)(\d{1,2})月(\d{1,2})日?/);
      if (full) date = `${full[1]}-${String(full[2]).padStart(2, "0")}-${String(full[3]).padStart(2, "0")}`;
      else if (short) date = `${today.slice(0, 4)}-${String(short[1]).padStart(2, "0")}-${String(short[2]).padStart(2, "0")}`;
    }
    const doctor = this.knowledge.doctorReferences.find((item) => text.includes(item.displayName));
    const department = this.knowledge.departments.find((item) => [item.displayName, item.name, ...(item.aliases ?? [])].some((name) => name && text.includes(name)));
    return {
      queryType: /出诊|坐诊|排班|哪天上班|值班/.test(text) || date ? "SCHEDULE" : "PROFILE",
      doctorName: doctor?.displayName ?? "", departmentId: department?.departmentId ?? "",
      departmentName: department?.displayName ?? "", date,
    };
  }

  search({ name = "", departmentId = "", departmentName = "", limit = 3 } = {}) {
    const nameNeedle = normalize(name);
    const departmentNeedle = normalize(departmentName);
    const matches = this.knowledge.doctorReferences.filter((doctor) => {
      if (nameNeedle && !normalize(doctor.displayName).includes(nameNeedle)) return false;
      if (departmentId && doctor.departmentId !== departmentId) return false;
      if (departmentNeedle && !normalize(doctor.departmentName).includes(departmentNeedle)) return false;
      return true;
    });
    matches.sort((left, right) => {
      const exactLeft = nameNeedle && normalize(left.displayName) === nameNeedle ? 0 : 1;
      const exactRight = nameNeedle && normalize(right.displayName) === nameNeedle ? 0 : 1;
      return exactLeft - exactRight || left.departmentName.localeCompare(right.departmentName, "zh-CN") || left.displayName.localeCompare(right.displayName, "zh-CN");
    });
    return matches.slice(0, Math.min(Math.max(Number(limit) || 3, 1), 6)).map((doctor) => ({
      referenceId: doctor.referenceId, displayName: doctor.displayName,
      professionalTitle: doctor.professionalTitle, departmentId: doctor.departmentId,
      departmentName: doctor.departmentName, profileUrl: doctor.profileUrl,
      availability: "unknown_not_realtime", dataOrigin: "official_public",
      notice: "官网公开人员资料，不代表实时出诊或号源。",
    }));
  }

  scheduled({ date = dateInChina(), departmentId = "", departmentName = "", doctorName = "", limit = 3 } = {}) {
    const targetDate = String(date);
    const parsed = new Date(`${targetDate}T00:00:00+08:00`);
    if (Number.isNaN(parsed.valueOf())) return [];
    const weekday = new Date(`${targetDate}T12:00:00Z`).getUTCDay();
    const departmentNeedle = normalize(departmentName);
    const doctorNeedle = normalize(doctorName);
    const doctors = new Map(this.knowledge.doctorReferences.map((item) => [item.referenceId, item]));
    return this.knowledge.doctorScheduleReference.rules
      .filter((rule) => targetDate >= rule.validFrom && targetDate <= rule.validUntil && rule.weekdays.includes(weekday))
      .map((rule) => ({ rule, doctor: doctors.get(rule.doctorReferenceId) }))
      .filter(({ rule, doctor }) => doctor
        && (!departmentId || doctor.departmentId === departmentId)
        && (!departmentNeedle || normalize(doctor.departmentName).includes(departmentNeedle))
        && (!doctorNeedle || normalize(doctor.displayName).includes(doctorNeedle)))
      .slice(0, Math.min(Math.max(Number(limit) || 3, 1), 6))
      .map(({ rule, doctor }) => ({
        referenceId: doctor.referenceId, displayName: doctor.displayName,
        professionalTitle: doctor.professionalTitle, departmentId: doctor.departmentId,
        departmentName: doctor.departmentName, serviceDate: targetDate,
        period: rule.period, startTime: rule.startTime, endTime: rule.endTime,
        dataOrigin: "project_demo_reference", simulated: true,
        notice: this.knowledge.doctorScheduleReference.notice,
      }));
  }

  upcoming({ fromDate = dateInChina(), departmentId = "", departmentName = "", doctorName = "", days = 14, limit = 3 } = {}) {
    const results = [];
    for (let offset = 0; offset < Math.min(Math.max(Number(days) || 14, 1), 31); offset += 1) {
      results.push(...this.scheduled({ date: addDays(fromDate, offset), departmentId, departmentName, doctorName, limit }));
      if (results.length >= limit) break;
    }
    return results.slice(0, limit);
  }
}
