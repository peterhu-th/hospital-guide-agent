const DIAGNOSIS_TERMS = /诊断为|确诊|治疗方案|用药建议|服用.*(片|粒|毫克|mg)/i;

function validateRoutingOutput(value, allowedIds) {
  if (!value || value.contractType !== "department_routing_response" || value.containsDiagnosis !== false) throw new Error("模型输出契约无效");
  if (!Array.isArray(value.recommendations) || value.recommendations.length > 2) throw new Error("推荐数量无效");
  for (const recommendation of value.recommendations) {
    if (!allowedIds.has(recommendation.departmentId)) throw new Error("模型返回了候选范围外的科室");
    if (!(recommendation.confidence >= 0 && recommendation.confidence <= 1) || typeof recommendation.reason !== "string" || DIAGNOSIS_TERMS.test(recommendation.reason)) throw new Error("推荐内容不安全");
  }
  if (value.shouldAskQuestion && !value.clarificationQuestion) throw new Error("缺少澄清问题");
  return value;
}

export class DeepSeekDepartmentRouter {
  constructor(config, knowledge) { this.config = config; this.knowledge = knowledge; }

  async recommend({ expression, patient }) {
    const candidates = this.knowledge.routingCandidates(expression);
    const allowedIds = new Set(candidates.map((item) => item.departmentId));
    const request = {
      contractType: "department_routing_request", task: "DEPARTMENT_RECOMMENDATION", userExpression: expression,
      patientContext: { ageRange: patient ? (patient.age >= 70 ? "70+" : patient.age >= 60 ? "60-69" : patient.age >= 50 ? "50-59" : patient.age >= 18 ? "18-49" : "0-17") : "unknown", sex: patient?.sex ?? "unknown" },
      confirmedFacts: [], candidateDepartments: candidates,
      constraints: { allowedDepartmentIds: [...allowedIds], maxRecommendations: 2, diagnosisForbidden: true },
    };
    if (!this.config.deepseekApiKey) return { request, result: this.fallback(candidates), provider: "fallback", degraded: true, errorCode: "MODEL_NOT_CONFIGURED" };
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.deepseekTimeoutMs);
      try {
        const response = await fetch(`${this.config.deepseekBaseUrl}/chat/completions`, {
          method: "POST", signal: controller.signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.deepseekApiKey}` },
          body: JSON.stringify({
            model: this.config.deepseekModel, temperature: 0.1, max_tokens: 900, response_format: { type: "json_object" },
            messages: [
              { role: "system", content: "你是医院导诊科室推荐器。只能从候选科室ID中选择，不诊断、不提供治疗或用药建议。必须只输出json对象，严格遵守给定字段。" },
              { role: "user", content: `请根据以下json输入返回json：${JSON.stringify(request)}\n输出字段：contractType=department_routing_response,intent,extractedFacts,recommendations,shouldAskQuestion,clarificationQuestion,shouldRequestHumanHelp,containsDiagnosis=false。` },
            ],
          }),
        });
        if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}`);
        const payload = await response.json();
        const content = payload.choices?.[0]?.message?.content;
        const result = validateRoutingOutput(JSON.parse(content), allowedIds);
        return { request, result, provider: "deepseek", degraded: false };
      } catch (error) { lastError = error; }
      finally { clearTimeout(timer); }
    }
    return { request, result: this.fallback(candidates), provider: "fallback", degraded: true, errorCode: lastError?.name === "AbortError" ? "MODEL_TIMEOUT" : "MODEL_INVALID_OUTPUT" };
  }

  fallback(candidates) {
    if (!candidates.length) return { contractType: "department_routing_response", intent: "DEPARTMENT_RECOMMENDATION", extractedFacts: [], recommendations: [], shouldAskQuestion: true, clarificationQuestion: "请问您主要不舒服的位置和最想解决的问题是什么？", shouldRequestHumanHelp: true, containsDiagnosis: false };
    const top = candidates.slice(0, 2).map((item, index) => ({ departmentId: item.departmentId, confidence: index ? 0.55 : 0.65, reason: "根据您使用的部位或症状词，与该科室公开服务范围较匹配" }));
    return { contractType: "department_routing_response", intent: "DEPARTMENT_RECOMMENDATION", extractedFacts: [], recommendations: top, shouldAskQuestion: candidates.length > 2, clarificationQuestion: candidates.length > 2 ? "为了更准确推荐，请问您主要不舒服的位置和持续时间？" : null, shouldRequestHumanHelp: false, containsDiagnosis: false };
  }
}
