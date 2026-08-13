const ACTIVE_APPOINTMENT_STATUSES = new Set(["PENDING_PAYMENT", "BOOKED", "CHECKED_IN", "CALLED", "IN_CONSULTATION", "AWAITING_TASKS"]);

export class PatientTaskManager {
  current(journey) {
    const active = journey.appointments.find((item) => ACTIVE_APPOINTMENT_STATUSES.has(item.status));
    if (active?.status === "CALLED") return { type: "CONSULTATION", title: "已叫号，请立即前往就诊", text: `${active.departmentName}已经叫号，请携带随身物品立即前往诊室，并留意现场工作人员指引。`, journeyFilter: "APPOINTMENT" };
    const registrationBill = journey.bills.find((item) => item.billType === "REGISTRATION" && item.status === "UNPAID");
    if (registrationBill) return { type: "REGISTRATION_PAYMENT", title: "当前任务：完成模拟挂号缴费", text: "当前挂号尚未生效，请完成模拟挂号缴费。", journeyFilter: "APPOINTMENT" };
    if (active?.status === "BOOKED") return { type: "CHECK_IN", title: "当前任务：按时到院报到", text: "请按挂号时间到院，出诊当天可在这里完成模拟报到。", journeyFilter: "APPOINTMENT" };
    if (active?.status === "CHECKED_IN") return { type: "WAITING", title: "当前任务：候诊并留意叫号", text: "您已报到，请在对应科室候诊并留意叫号。", journeyFilter: "APPOINTMENT" };
    if (active?.status === "IN_CONSULTATION") return { type: "CONSULTATION", title: "当前任务：配合医生完成接诊", text: "当前正在接诊，请以医生现场安排为准。", journeyFilter: "APPOINTMENT" };
    const unpaid = journey.bills.find((item) => item.status === "UNPAID");
    if (unpaid) return { type: "PAYMENT", title: "当前任务：完成模拟缴费", text: "当前有待缴项目，请完成模拟缴费后继续。", journeyFilter: "ALL" };
    const appointmentStatus = new Map(journey.appointments.map((item) => [item.appointmentId, item.status]));
    const pending = journey.tasks.find((item) => item.status === "PENDING" && appointmentStatus.get(item.appointmentId) !== "CANCELLED");
    if (pending) return { type: pending.taskType, title: `当前任务：${pending.title}`, text: `接下来请完成：${pending.title}。`, journeyFilter: "ALL" };
    return null;
  }
}
