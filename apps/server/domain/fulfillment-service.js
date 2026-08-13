import { assert } from "../errors.js";

export class FulfillmentService {
  constructor(db, consultationService, visitCompletion) { this.db = db; this.consultationService = consultationService; this.visitCompletion = visitCompletion; }

  complete(session, taskId, now = new Date().toISOString()) {
    assert(session.patient_id, 401, "PATIENT_PROFILE_REQUIRED", "请先完成患者建档");
    const task = this.db.get(`SELECT t.*,a.patient_id,b.status bill_status,o.status order_status FROM journey_tasks t JOIN appointments a ON a.appointment_id=t.appointment_id JOIN medical_orders o ON o.order_id=t.order_id LEFT JOIN bills b ON b.order_id=o.order_id WHERE t.task_id=:task AND a.patient_id=:patient`, { task: taskId, patient: session.patient_id });
    assert(task && ["EXAMINATION", "PHARMACY"].includes(task.task_type), 404, "FULFILLMENT_TASK_NOT_FOUND", "检查或取药任务不存在");
    if (task.status === "COMPLETED") return { taskId, appointmentId: task.appointment_id, status: "COMPLETED", idempotent: true, completion: this.visitCompletion.evaluate(task.appointment_id, now) };
    assert(task.status === "PENDING", 409, "TASK_NOT_COMPLETABLE", "当前任务不能确认完成");
    assert(!task.bill_status || task.bill_status === "PAID", 409, "PAYMENT_REQUIRED", "请先完成该项目的模拟支付");
    assert(task.order_status !== "REVOKED", 409, "ORDER_REVOKED", "该医嘱已经撤销");
    this.db.run(`UPDATE journey_tasks SET status='COMPLETED',completed_at=:now WHERE task_id=:id AND status='PENDING'`, { id: taskId, now });
    this.db.run(`UPDATE medical_orders SET status='FULFILLED' WHERE order_id=:id AND status='CREATED'`, { id: task.order_id });
    this.consultationService.activateDue(task.appointment_id, now);
    return { taskId, appointmentId: task.appointment_id, orderId: task.order_id, taskType: task.task_type, status: "COMPLETED", idempotent: false, completion: this.visitCompletion.evaluate(task.appointment_id, now) };
  }
}
