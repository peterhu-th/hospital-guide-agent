import { AppError } from "../errors.js";
import { newId } from "../security.js";

const IRREVERSIBLE_PATIENT_ACTIONS = new Set([
  "PATIENT_PROFILE_CREATED",
  "APPOINTMENT_CREATED",
  "APPOINTMENT_CANCELLED",
  "APPOINTMENT_CHECKED_IN",
  "APPOINTMENT_RESCHEDULED",
  "SIMULATED_PAYMENT_COMPLETED",
  "JOURNEY_TASK_COMPLETED",
  "RETURN_VISIT_CHECKED_IN",
]);

const IRREVERSIBLE_CLINICAL_ACTIONS = new Set([
  "APPOINTMENT_CALL",
  "APPOINTMENT_START",
  "APPOINTMENT_COMPLETE",
  "MEDICAL_RECORD_EDITED",
  "MEDICAL_ORDER_CREATED",
  "MEDICAL_ORDER_REVOKED",
  "SIMULATED_RESULT_CREATED",
]);

const json = (value) => JSON.stringify(value ?? {});
const parse = (value, fallback = {}) => { try { return JSON.parse(value); } catch { return fallback; } };
const nowIso = () => new Date().toISOString();
const preview = (value) => String(value ?? "")
  .replace(/\b\d{17}[\dXx]\b/g, "[身份证号已隐藏]")
  .replace(/\b1\d{10}\b/g, "[手机号已隐藏]")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 32);

export function isConversationUndoRequest(message) {
  const text = String(message ?? "").trim();
  if (/退号|取消挂号|挂错了|挂号错了|这个号不要了/.test(text)) return false;
  return /(?:撤销|撤回|取消|删除)(?:我)?(?:刚才|上一条|上一个|前一条)(?:的)?(?:输入|消息|提问|话)?|回到(?:刚才|上一轮|上一步|之前)|刚才(?:说错|问错|点错|误触|不是我想(?:问|说|点)的)(?:了)?|我(?:刚才)?不小心(?:说错|问错|点错|误触)/.test(text);
}

export class ConversationRollbackService {
  constructor(db, audit) {
    this.db = db;
    this.audit = audit;
  }

  captureState(session) {
    const workflow = this.db.get(`SELECT * FROM conversation_workflow_states WHERE session_id=:session`, { session: session.session_id });
    const facts = this.db.all(`SELECT * FROM patient_facts WHERE session_id=:session ORDER BY created_at,fact_id`, { session: session.session_id });
    const currentSession = this.db.get(`SELECT current_stage FROM patient_sessions WHERE session_id=:session`, { session: session.session_id });
    return { currentStage: currentSession?.current_stage ?? session.current_stage, workflow, facts };
  }

  expirePending(sessionId) {
    const expired = this.db.all(`SELECT action_id,parameters_json FROM pending_actions
      WHERE session_id=:session AND action_type='UNDO_LAST_CONVERSATION_TURN' AND status='PENDING' AND expires_at<=:now`, {
      session: sessionId, now: nowIso(),
    });
    for (const action of expired) {
      const parameters = parse(action.parameters_json);
      this.db.run(`UPDATE pending_actions SET status='EXPIRED' WHERE action_id=:action`, { action: action.action_id });
      if (parameters.controlInteractionId) this.db.run(`UPDATE conversation_turns SET turn_status='UNDONE',undone_at=:now
        WHERE session_id=:session AND interaction_id=:interaction AND turn_status='ACTIVE'`, {
        now: nowIso(), session: sessionId, interaction: parameters.controlInteractionId,
      });
    }
  }

  latestTarget(sessionId, excludedTurnId = null) {
    return this.db.get(`SELECT * FROM conversation_turns
      WHERE session_id=:session AND role='PATIENT' AND turn_kind='CHAT' AND turn_status='ACTIVE'
        AND (:excluded IS NULL OR turn_id<>:excluded)
      ORDER BY created_at DESC,turn_id DESC LIMIT 1`, { session: sessionId, excluded: excludedTurnId });
  }

  relatedClinicalEntityIds(patientId) {
    if (!patientId) return new Set();
    const ids = new Set();
    for (const row of this.db.all(`SELECT appointment_id FROM appointments WHERE patient_id=:patient`, { patient: patientId })) ids.add(row.appointment_id);
    for (const row of this.db.all(`SELECT r.record_id FROM medical_records r WHERE r.patient_id=:patient`, { patient: patientId })) ids.add(row.record_id);
    for (const row of this.db.all(`SELECT o.order_id FROM medical_orders o JOIN medical_records r ON r.record_id=o.record_id WHERE r.patient_id=:patient`, { patient: patientId })) ids.add(row.order_id);
    for (const row of this.db.all(`SELECT t.task_id FROM journey_tasks t JOIN appointments a ON a.appointment_id=t.appointment_id WHERE a.patient_id=:patient`, { patient: patientId })) ids.add(row.task_id);
    for (const row of this.db.all(`SELECT b.bill_id FROM bills b JOIN appointments a ON a.appointment_id=b.appointment_id WHERE a.patient_id=:patient`, { patient: patientId })) ids.add(row.bill_id);
    return ids;
  }

  irreversibleChange(session, target) {
    const events = this.db.all(`SELECT * FROM audit_events WHERE created_at>=:created ORDER BY created_at`, { created: target.created_at });
    const clinicalIds = this.relatedClinicalEntityIds(session.patient_id);
    for (const event of events) {
      if (event.action === "SIMULATED_NURSE_CALL" && event.actor_id === session.session_id) {
        return { code: "NURSE_CALL_CANNOT_BE_UNDONE", message: "模拟护士呼叫已经发出，不能通过撤销对话删除该记录。" };
      }
      if (event.actor_type === "PATIENT" && event.actor_id === session.patient_id && IRREVERSIBLE_PATIENT_ACTIONS.has(event.action)) {
        const message = event.action === "APPOINTMENT_CREATED"
          ? "挂号已经确认写入，不能撤销上一条输入；如不再需要，请使用退号功能。"
          : event.action === "SIMULATED_PAYMENT_COMPLETED"
            ? "支付已经完成，不能通过撤销对话恢复。"
            : "上一条输入之后已经完成业务操作，当前内容无法撤销。";
        return { code: "BUSINESS_ACTION_CANNOT_BE_UNDONE", message };
      }
      if (clinicalIds.has(event.entity_id) && IRREVERSIBLE_CLINICAL_ACTIONS.has(event.action)) {
        return { code: "CLINICAL_ACTION_CANNOT_BE_UNDONE", message: "医生或就诊流程已经处理了相关信息，当前内容无法撤销。" };
      }
    }
    return null;
  }

  prepare(session, { excludedTurnId = null, controlInteractionId = null } = {}) {
    this.expirePending(session.session_id);
    const target = this.latestTarget(session.session_id, excludedTurnId);
    if (!target) return { available: false, reasonCode: "NO_UNDOABLE_TURN", message: "当前没有可以撤销的上一条输入。" };
    if (!target.state_before_json) return { available: false, reasonCode: "LEGACY_TURN_NOT_UNDOABLE", message: "这条较早的输入没有保存恢复点，无法安全撤销。" };
    const irreversible = this.irreversibleChange(session, target);
    if (irreversible) return { available: false, reasonCode: irreversible.code, message: irreversible.message };
    const workflow = this.db.get(`SELECT revision FROM conversation_workflow_states WHERE session_id=:session`, { session: session.session_id });
    const superseded = this.db.all(`SELECT action_id,parameters_json FROM pending_actions
      WHERE session_id=:session AND action_type='UNDO_LAST_CONVERSATION_TURN' AND status='PENDING'`, { session: session.session_id });
    for (const oldAction of superseded) {
      const oldParameters = parse(oldAction.parameters_json);
      this.db.run(`UPDATE pending_actions SET status='CANCELLED' WHERE action_id=:action`, { action: oldAction.action_id });
      if (oldParameters.controlInteractionId) this.db.run(`UPDATE conversation_turns SET turn_status='UNDONE',undone_at=:now
        WHERE session_id=:session AND interaction_id=:interaction AND turn_status='ACTIVE'`, {
        now: nowIso(), session: session.session_id, interaction: oldParameters.controlInteractionId,
      });
    }
    const actionId = newId("action");
    const createdAt = nowIso();
    const parameters = {
      targetTurnId: target.turn_id,
      targetInteractionId: target.interaction_id,
      controlInteractionId,
      expectedWorkflowRevision: workflow?.revision ?? 0,
    };
    const targetPreview = preview(target.message);
    const summary = `撤销上一条“${targetPreview}${target.message.length > targetPreview.length ? "…" : ""}”，并恢复上一轮状态吗？`;
    this.db.run(`INSERT INTO pending_actions(action_id,session_id,action_type,parameters_json,summary,status,created_at,expires_at,confirmed_at)
      VALUES(:id,:session,'UNDO_LAST_CONVERSATION_TURN',:parameters,:summary,'PENDING',:created,:expires,NULL)`, {
      id: actionId, session: session.session_id, parameters: json(parameters), summary, created: createdAt,
      expires: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    return { available: true, actionId, targetTurnId: target.turn_id, targetPreview, summary, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
  }

  action(sessionId, actionId) {
    return this.db.get(`SELECT * FROM pending_actions WHERE action_id=:id AND session_id=:session AND action_type='UNDO_LAST_CONVERSATION_TURN'`, { id: actionId, session: sessionId });
  }

  restoreFacts(sessionId, facts) {
    this.db.run(`DELETE FROM patient_facts WHERE session_id=:session`, { session: sessionId });
    for (const fact of facts ?? []) {
      this.db.run(`INSERT INTO patient_facts(fact_id,session_id,record_id,source_turn_id,field,normalized_value,certainty,status,created_at,confirmed_at)
        VALUES(:factId,:session,:record,:source,:field,:value,:certainty,:status,:created,:confirmed)`, {
        factId: fact.fact_id, session: fact.session_id, record: fact.record_id, source: fact.source_turn_id,
        field: fact.field, value: fact.normalized_value, certainty: fact.certainty, status: fact.status,
        created: fact.created_at, confirmed: fact.confirmed_at,
      });
    }
  }

  confirm(session, actionId) {
    const action = this.action(session.session_id, actionId);
    if (!action) throw new AppError(404, "UNDO_ACTION_NOT_FOUND", "撤销确认不存在或已失效。");
    if (action.status === "CONFIRMED") return { undone: true, idempotent: true };
    if (action.status !== "PENDING" || action.expires_at <= nowIso()) throw new AppError(409, "UNDO_ACTION_EXPIRED", "撤销确认已经失效，请重新发起。");
    const parameters = parse(action.parameters_json);
    const target = this.db.get(`SELECT * FROM conversation_turns WHERE turn_id=:turn AND session_id=:session`, { turn: parameters.targetTurnId, session: session.session_id });
    if (!target || target.turn_status !== "ACTIVE" || this.latestTarget(session.session_id)?.turn_id !== target.turn_id) {
      throw new AppError(409, "UNDO_STATE_CHANGED", "对话状态已经变化，请刷新后重新操作。");
    }
    const workflow = this.db.get(`SELECT revision FROM conversation_workflow_states WHERE session_id=:session`, { session: session.session_id });
    if ((workflow?.revision ?? 0) !== parameters.expectedWorkflowRevision) throw new AppError(409, "UNDO_STATE_CHANGED", "当前任务已经变化，无法继续使用这次撤销确认。");
    const irreversible = this.irreversibleChange(session, target);
    if (irreversible) throw new AppError(409, irreversible.code, irreversible.message);
    const snapshot = parse(target.state_before_json, null);
    if (!snapshot?.workflow) throw new AppError(409, "UNDO_SNAPSHOT_INVALID", "上一轮恢复点不完整，无法安全撤销。");
    const completedAt = nowIso();
    this.db.transaction(() => {
      this.db.run(`UPDATE conversation_turns SET turn_status='UNDONE',undone_at=:now
        WHERE session_id=:session AND interaction_id=:interaction AND turn_status='ACTIVE'`, {
        now: completedAt, session: session.session_id, interaction: parameters.targetInteractionId,
      });
      if (parameters.controlInteractionId) this.db.run(`UPDATE conversation_turns SET turn_status='UNDONE',undone_at=:now
        WHERE session_id=:session AND interaction_id=:interaction AND turn_status='ACTIVE'`, {
        now: completedAt, session: session.session_id, interaction: parameters.controlInteractionId,
      });
      this.db.run(`UPDATE conversation_workflow_states SET revision=:revision,active_task_type=:task,active_task_status=:status,
        pending_field=:field,last_question=:question,suspended_tasks_json=:suspended,recommended_departments_json=:recommended,updated_at=:updated
        WHERE session_id=:session`, {
        revision: (workflow?.revision ?? 0) + 1, task: snapshot.workflow.active_task_type,
        status: snapshot.workflow.active_task_status, field: snapshot.workflow.pending_field,
        question: snapshot.workflow.last_question, suspended: snapshot.workflow.suspended_tasks_json,
        recommended: snapshot.workflow.recommended_departments_json, updated: completedAt, session: session.session_id,
      });
      this.db.run(`UPDATE patient_sessions SET current_stage=:stage,last_active_at=:now WHERE session_id=:session`, {
        stage: snapshot.currentStage, now: completedAt, session: session.session_id,
      });
      this.restoreFacts(session.session_id, snapshot.facts);
      this.db.run(`UPDATE pending_actions SET status='CANCELLED' WHERE session_id=:session AND status='PENDING'
        AND action_id<>:action AND created_at>=:targetCreated`, { session: session.session_id, action: actionId, targetCreated: target.created_at });
      this.db.run(`UPDATE pending_actions SET status='CONFIRMED',confirmed_at=:now WHERE action_id=:action`, { now: completedAt, action: actionId });
      this.audit("PATIENT", session.patient_id, "CONVERSATION_TURN_UNDONE", "conversation_turn", target.turn_id, {
        interactionId: target.interaction_id, restoredWorkflowRevision: (workflow?.revision ?? 0) + 1,
      });
    });
    const previousAgent = this.db.get(`SELECT assistant_actions_json FROM conversation_turns
      WHERE session_id=:session AND role='AGENT' AND turn_status='ACTIVE' ORDER BY created_at DESC,turn_id DESC LIMIT 1`, { session: session.session_id });
    return { undone: true, idempotent: false, targetTurnId: target.turn_id, restoredCurrentStage: snapshot.currentStage, assistantActionsJson: previousAgent?.assistant_actions_json ?? "[]" };
  }

  cancel(session, actionId) {
    const action = this.action(session.session_id, actionId);
    if (!action) throw new AppError(404, "UNDO_ACTION_NOT_FOUND", "撤销确认不存在或已失效。");
    if (action.status === "CANCELLED") return { cancelled: true, idempotent: true };
    if (action.status !== "PENDING") throw new AppError(409, "UNDO_ACTION_ALREADY_RESOLVED", "该撤销确认已经处理。");
    const parameters = parse(action.parameters_json);
    const cancelledAt = nowIso();
    this.db.transaction(() => {
      this.db.run(`UPDATE pending_actions SET status='CANCELLED' WHERE action_id=:action`, { action: actionId });
      if (parameters.controlInteractionId) this.db.run(`UPDATE conversation_turns SET turn_status='UNDONE',undone_at=:now
        WHERE session_id=:session AND interaction_id=:interaction AND turn_status='ACTIVE'`, {
        now: cancelledAt, session: session.session_id, interaction: parameters.controlInteractionId,
      });
    });
    return { cancelled: true, idempotent: false };
  }
}
