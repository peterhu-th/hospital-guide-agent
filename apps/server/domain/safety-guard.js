import { newId } from "../security.js";

const EMERGENCY_PATTERNS = [
  /(?:突然|现在|正在).{0,8}(?:昏倒|昏迷|意识不清|叫不醒)/,
  /(?:无法|不能|喘不上).{0,4}(?:呼吸|气)/,
  /(?:大量|不停|止不住).{0,5}出血/,
  /(?:突然|正在).{0,6}(?:抽搐|剧烈胸痛)/,
  /(?:想|准备|马上要).{0,4}(?:自杀|自残|伤害自己)/,
];
const NEGATED = /(?:没有|并无|不是|否认|未出现).{0,8}(?:胸痛|呼吸困难|出血|抽搐|昏迷)/;
const HYPOTHETICAL = /(?:如果|假如|万一|怎么办|如何处理).{0,12}(?:昏倒|昏迷|呼吸困难|出血|抽搐|胸痛)/;
const HISTORICAL = /(?:昨天|前天|上周|以前|曾经|前段时间).{0,12}(?:昏倒|昏迷|呼吸困难|出血|抽搐|胸痛)/;
const NEGATIVE_EMOTION = /烦死|太烦|很烦|烦躁|崩溃|绝望|受不了|不想排|不想等|心情不好|很难过|很焦虑|害怕|无助/;

export class SafetyGuard {
  constructor(db, audit) { this.db = db; this.audit = audit; }

  assess(message) {
    const text = String(message).trim();
    const emergency = !NEGATED.test(text) && !HYPOTHETICAL.test(text) && !HISTORICAL.test(text) && EMERGENCY_PATTERNS.some((pattern) => pattern.test(text));
    return { emergency, negativeEmotion: !emergency && NEGATIVE_EMOTION.test(text) };
  }

  requestNurseAssistance(session, reason = "SUDDEN_MEDICAL_RISK") {
    const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
    const existing = this.db.get(`SELECT entity_id,created_at FROM audit_events WHERE actor_type='PATIENT_SESSION' AND actor_id=:session AND action='SIMULATED_NURSE_CALL' AND created_at>:cutoff ORDER BY created_at DESC LIMIT 1`, { session: session.session_id, cutoff });
    if (existing) return { callId: existing.entity_id, status: "SIMULATED_DISPATCHED", simulated: true, idempotent: true, createdAt: existing.created_at };
    const callId = newId("nurse-call");
    const createdAt = new Date().toISOString();
    this.audit("PATIENT_SESSION", session.session_id, "SIMULATED_NURSE_CALL", "simulated_nurse_call", callId, { reason, simulated: true });
    return { callId, status: "SIMULATED_DISPATCHED", simulated: true, idempotent: false, createdAt };
  }
}
