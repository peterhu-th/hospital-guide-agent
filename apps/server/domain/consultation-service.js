import { assert } from "../errors.js";
import { newId } from "../security.js";

export class ConsultationService {
  constructor(db, visitCompletion) { this.db = db; this.visitCompletion = visitCompletion; }

  currentRound(appointmentId, create = false) {
    let round = this.db.get(`SELECT * FROM consultation_rounds WHERE appointment_id=:id AND status<>'CANCELLED' ORDER BY round_number DESC LIMIT 1`, { id: appointmentId });
    if (!round && create) {
      const appointment = this.db.get(`SELECT created_at FROM appointments WHERE appointment_id=:id`, { id: appointmentId });
      const roundId = newId("round");
      this.db.run(`INSERT INTO consultation_rounds(round_id,appointment_id,round_number,round_type,status,created_at) VALUES(:round,:appointment,1,'INITIAL','WAITING',:created)`, { round: roundId, appointment: appointmentId, created: appointment?.created_at ?? new Date().toISOString() });
      this.db.run(`UPDATE medical_orders SET consultation_round_id=:round WHERE consultation_round_id IS NULL AND record_id=(SELECT record_id FROM medical_records WHERE appointment_id=:appointment)`, { round: roundId, appointment: appointmentId });
      this.db.run(`UPDATE journey_tasks SET consultation_round_id=:round WHERE consultation_round_id IS NULL AND appointment_id=:appointment AND task_type IN ('EXAMINATION','PHARMACY')`, { round: roundId, appointment: appointmentId });
      round = this.db.get(`SELECT * FROM consultation_rounds WHERE round_id=:id`, { id: roundId });
    }
    return round;
  }

  start(appointmentId, now = new Date().toISOString()) {
    const round = this.currentRound(appointmentId, true);
    assert(["WAITING", "SCHEDULED"].includes(round.status), 409, "INVALID_CONSULTATION_ROUND", "当前接诊轮次不能开始");
    this.db.run(`UPDATE consultation_rounds SET status='IN_CONSULTATION',started_at=COALESCE(started_at,:now) WHERE round_id=:id`, { id: round.round_id, now });
    return { ...round, status: "IN_CONSULTATION", started_at: round.started_at ?? now };
  }

  finish(appointmentId, input = {}, now = new Date().toISOString()) {
    let round = this.currentRound(appointmentId, true);
    const appointment = this.db.get(`SELECT status FROM appointments WHERE appointment_id=:id`, { id: appointmentId });
    if (round.status === "WAITING" && appointment?.status === "IN_CONSULTATION") round = this.start(appointmentId, now);
    assert(round.status === "IN_CONSULTATION", 409, "INVALID_CONSULTATION_ROUND", "当前没有进行中的接诊");
    const examinationCount = this.db.get(`SELECT count(*) total FROM medical_orders WHERE consultation_round_id=:round AND order_type='EXAMINATION' AND status<>'REVOKED'`, { round: round.round_id }).total;
    const required = Boolean(input.returnVisitRequired) || examinationCount > 0;
    assert(!(examinationCount > 0 && input.returnVisitRequired === false), 409, "EXAMINATION_REQUIRES_RETURN_VISIT", "本轮已开具检查，必须设置回诊");
    let returnVisitAt = null;
    if (required) {
      returnVisitAt = input.returnVisitAt ? new Date(input.returnVisitAt).toISOString() : new Date(Date.now() + 120_000).toISOString();
      assert(Number.isFinite(new Date(returnVisitAt).valueOf()) && returnVisitAt > now, 422, "INVALID_RETURN_VISIT_TIME", "回诊时间必须晚于当前时间");
    }
    this.db.run(`UPDATE consultation_rounds SET status='COMPLETED',completed_at=:now,return_visit_required=:required,return_visit_at=:at WHERE round_id=:id`, { id: round.round_id, now, required: required ? 1 : 0, at: returnVisitAt });
    this.db.run(`UPDATE appointments SET status='AWAITING_TASKS',updated_at=:now WHERE appointment_id=:id`, { id: appointmentId, now });
    let returnTaskId = null;
    if (required) {
      const nextNumber = Number(round.round_number) + 1;
      const nextRoundId = newId("round");
      returnTaskId = newId("task");
      this.db.run(`INSERT INTO consultation_rounds(round_id,appointment_id,round_number,round_type,status,scheduled_at,created_at) VALUES(:round,:appointment,:number,'RETURN','SCHEDULED',:scheduled,:created)`, { round: nextRoundId, appointment: appointmentId, number: nextNumber, scheduled: returnVisitAt, created: now });
      this.db.run(`INSERT INTO journey_tasks(task_id,appointment_id,task_type,status,title,consultation_round_id,scheduled_at,blocks_completion,created_at) VALUES(:task,:appointment,'RETURN_VISIT','BLOCKED',:title,:round,:scheduled,1,:created)`, { task: returnTaskId, appointment: appointmentId, title: `第${nextNumber}轮按医生安排回诊`, round: nextRoundId, scheduled: returnVisitAt, created: now });
    }
    this.db.run(`UPDATE journey_tasks SET status='COMPLETED',completed_at=COALESCE(completed_at,:now) WHERE appointment_id=:id AND task_type IN ('REGISTRATION_PAYMENT','CHECK_IN') AND status='PENDING'`, { id: appointmentId, now });
    const completion = this.visitCompletion.evaluate(appointmentId, now);
    return { appointmentId, roundId: round.round_id, status: completion.status, returnVisitRequired: required, returnVisitAt, returnTaskId, completion };
  }

  activateDue(appointmentId, now = new Date().toISOString()) {
    const incompleteExaminations = this.db.get(`SELECT count(*) total FROM journey_tasks WHERE appointment_id=:id AND task_type='EXAMINATION' AND status NOT IN ('COMPLETED','CANCELLED')`, { id: appointmentId }).total;
    if (incompleteExaminations) return null;
    this.db.run(`UPDATE journey_tasks SET status='PENDING' WHERE appointment_id=:id AND task_type='RETURN_VISIT' AND status='BLOCKED' AND scheduled_at<=:now`, { id: appointmentId, now });
    return this.db.get(`SELECT * FROM journey_tasks WHERE appointment_id=:id AND task_type='RETURN_VISIT' AND status='PENDING' ORDER BY scheduled_at LIMIT 1`, { id: appointmentId });
  }

  checkIn(session, taskId, now = new Date().toISOString()) {
    const task = this.db.get(`SELECT t.*,a.patient_id FROM journey_tasks t JOIN appointments a ON a.appointment_id=t.appointment_id WHERE t.task_id=:task AND a.patient_id=:patient AND t.task_type='RETURN_VISIT'`, { task: taskId, patient: session.patient_id });
    assert(task, 404, "RETURN_VISIT_NOT_FOUND", "回诊任务不存在或不属于当前患者");
    this.activateDue(task.appointment_id, now);
    const current = this.db.get(`SELECT * FROM journey_tasks WHERE task_id=:id`, { id: taskId });
    assert(current.status === "PENDING", 409, "RETURN_VISIT_NOT_READY", "检查尚未完成或还没有到回诊时间");
    this.db.run(`UPDATE journey_tasks SET status='IN_PROGRESS' WHERE task_id=:id`, { id: taskId });
    this.db.run(`UPDATE consultation_rounds SET status='WAITING' WHERE round_id=:id`, { id: current.consultation_round_id });
    this.db.run(`UPDATE appointments SET status='CHECKED_IN',updated_at=:now WHERE appointment_id=:id`, { id: current.appointment_id, now });
    this.db.run(`INSERT OR IGNORE INTO journey_tasks(task_id,appointment_id,task_type,status,title,consultation_round_id,blocks_completion,created_at) VALUES(:task,:appointment,'WAITING','PENDING','回诊候诊，留意叫号',:round,0,:created)`, { task: newId("task"), appointment: current.appointment_id, round: current.consultation_round_id, created: now });
    return { taskId, appointmentId: current.appointment_id, status: "CHECKED_IN" };
  }
}
