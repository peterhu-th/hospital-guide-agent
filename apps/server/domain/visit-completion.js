export class VisitCompletionService {
  constructor(db) { this.db = db; }

  evaluate(appointmentId, now = new Date().toISOString()) {
    const appointment = this.db.get(`SELECT * FROM appointments WHERE appointment_id=:id`, { id: appointmentId });
    if (!appointment || ["CANCELLED", "COMPLETED", "IN_CONSULTATION", "CALLED", "CHECKED_IN"].includes(appointment.status)) {
      return { completed: appointment?.status === "COMPLETED", appointmentId, status: appointment?.status ?? null };
    }
    const unpaidBills = this.db.get(`SELECT count(*) total FROM bills WHERE appointment_id=:id AND status='UNPAID'`, { id: appointmentId }).total;
    const unfulfilledOrders = this.db.get(`SELECT count(*) total FROM medical_orders o JOIN medical_records r ON r.record_id=o.record_id WHERE r.appointment_id=:id AND o.status NOT IN ('FULFILLED','REVOKED')`, { id: appointmentId }).total;
    const blockingTasks = this.db.get(`SELECT count(*) total FROM journey_tasks WHERE appointment_id=:id AND blocks_completion=1 AND task_type NOT IN ('REGISTRATION_PAYMENT','CHECK_IN') AND status IN ('PENDING','BLOCKED','IN_PROGRESS')`, { id: appointmentId }).total;
    const openRounds = this.db.get(`SELECT count(*) total FROM consultation_rounds WHERE appointment_id=:id AND status IN ('SCHEDULED','WAITING','IN_CONSULTATION')`, { id: appointmentId }).total;
    const completedRounds = this.db.get(`SELECT count(*) total FROM consultation_rounds WHERE appointment_id=:id AND status='COMPLETED'`, { id: appointmentId }).total;
    const completed = completedRounds > 0 && unpaidBills === 0 && unfulfilledOrders === 0 && blockingTasks === 0 && openRounds === 0;
    if (completed) {
      this.db.run(`UPDATE appointments SET status='COMPLETED',updated_at=:now WHERE appointment_id=:id AND status NOT IN ('COMPLETED','CANCELLED')`, { id: appointmentId, now });
      this.db.run(`UPDATE patient_sessions SET current_stage='COMPLETED' WHERE patient_id=:patient AND revoked_at IS NULL`, { patient: appointment.patient_id });
    }
    return { completed, appointmentId, status: completed ? "COMPLETED" : appointment.status, unpaidBills, unfulfilledOrders, blockingTasks, openRounds, completedRounds };
  }
}
