export class PatientJourneyService {
  constructor(db, knowledge) { this.db = db; this.knowledge = knowledge; }

  appointments(session) {
    if (!session.patient_id) return [];
    return this.db.all(`SELECT a.*,p.service_date,p.start_time,p.end_time,d.display_name doctor_name,dp.display_name department_name FROM appointments a JOIN doctor_practices p ON p.practice_id=a.practice_id JOIN doctors d ON d.doctor_id=a.doctor_id JOIN departments dp ON dp.department_id=a.department_id WHERE a.patient_id=:patient ORDER BY a.created_at DESC`, { patient: session.patient_id }).map((row) => ({
      appointmentId: row.appointment_id, status: row.status, queueNumber: row.queue_number,
      doctorName: row.doctor_name, departmentId: row.department_id, departmentName: row.department_name,
      serviceDate: row.service_date, startTime: row.start_time, endTime: row.end_time,
      recordExportAvailable: row.status === "COMPLETED",
    }));
  }

  activeAppointments(session) { return this.appointments(session).filter((item) => !["CANCELLED", "COMPLETED"].includes(item.status)); }

  journey(session) {
    if (!session.patient_id) return { appointments: [], orders: [], tasks: [], bills: [] };
    const appointments = this.appointments(session);
    const orders = this.db.all(`SELECT o.*,b.bill_id,b.amount_cents,b.status bill_status,b.guidance,b.paid_at,a.appointment_id FROM medical_orders o JOIN medical_records r ON r.record_id=o.record_id JOIN appointments a ON a.appointment_id=r.appointment_id LEFT JOIN bills b ON b.order_id=o.order_id WHERE a.patient_id=:patient AND o.status<>'REVOKED' ORDER BY o.created_at DESC`, { patient: session.patient_id });
    const bills = this.db.all(`SELECT b.* FROM bills b JOIN appointments a ON a.appointment_id=b.appointment_id WHERE a.patient_id=:patient ORDER BY b.created_at`, { patient: session.patient_id });
    const tasks = this.db.all(`SELECT t.* FROM journey_tasks t JOIN appointments a ON a.appointment_id=t.appointment_id WHERE a.patient_id=:patient ORDER BY t.created_at`, { patient: session.patient_id });
    return {
      appointments,
      orders: orders.map((row) => ({
        orderId: row.order_id, appointmentId: row.appointment_id, orderType: row.order_type, title: row.title, details: row.details,
        quantity: row.quantity, status: row.status, billId: row.bill_id ?? null, billStatus: row.bill_status ?? null,
        destination: row.location_id ? this.knowledge.findLocation(row.location_id) : null,
      })),
      bills: bills.map((row) => ({ billId: row.bill_id, appointmentId: row.appointment_id, orderId: row.order_id ?? null, billType: row.bill_type, title: row.title, amountCents: row.amount_cents, status: row.status, guidance: row.guidance, paidAt: row.paid_at ?? null, simulated: row.status === "PAID" })),
      tasks: tasks.map((row) => ({
        taskId: row.task_id, appointmentId: row.appointment_id, taskType: row.task_type, status: row.status, title: row.title,
        orderId: row.order_id ?? null, consultationRoundId: row.consultation_round_id ?? null,
        scheduledAt: row.scheduled_at ?? null, completedAt: row.completed_at ?? null,
      })),
    };
  }

  query(session, type = "ALL") {
    const journey = this.journey(session);
    if (type === "APPOINTMENT") return { appointments: journey.appointments.slice(0, 3), orders: [], bills: journey.bills.filter((item) => item.billType === "REGISTRATION").slice(0, 3), tasks: journey.tasks.filter((item) => ["REGISTRATION_PAYMENT", "CHECK_IN", "WAITING", "CONSULTATION"].includes(item.taskType)).slice(0, 3) };
    const orderType = type === "PRESCRIPTION" ? "PRESCRIPTION" : type === "EXAMINATION" ? "EXAMINATION" : null;
    if (!orderType) return { appointments: journey.appointments.slice(0, 3), orders: journey.orders.slice(0, 3), bills: journey.bills.slice(0, 3), tasks: journey.tasks.filter((item) => item.status === "PENDING").slice(0, 3) };
    const orders = journey.orders.filter((item) => item.orderType === orderType).slice(0, 3);
    const orderIds = new Set(orders.map((item) => item.orderId));
    const taskTypes = orderType === "PRESCRIPTION" ? ["PHARMACY"] : ["EXAMINATION", "RETURN_VISIT"];
    return { appointments: [], orders, bills: journey.bills.filter((item) => orderIds.has(item.orderId)).slice(0, 3), tasks: journey.tasks.filter((item) => taskTypes.includes(item.taskType)).slice(0, 3) };
  }
}
