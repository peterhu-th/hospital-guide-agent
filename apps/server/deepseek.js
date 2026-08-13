const DIAGNOSIS_TERMS = /诊断为|确诊|治疗方案|用药建议|服用.*(片|粒|毫克|mg)/i;
const ROUTING_CONFIDENCE_THRESHOLD = 0.8;
const ROUTING_INTENTS = new Set(["DEPARTMENT_RECOMMENDATION", "HOSPITAL_QA", "OTHER"]);
const ROUTING_TOOLS = new Set(["NONE", "SHOW_APPOINTMENT_SERVICE", "REQUEST_HUMAN_SERVICE"]);
const TURN_INTENTS = new Set([
  "MEDICAL_INFORMATION", "LOCATION_HELP", "APPOINTMENT_HELP", "PAYMENT_HELP",
  "QUEUE_HELP", "HUMAN_HELP", "SESSION_MANAGEMENT", "DOCTOR_QUERY",
  "PATIENT_JOURNEY_QUERY", "CANCEL_APPOINTMENT", "OTHER",
]);

class ModelCallError extends Error {
  constructor(code, message, { httpStatus = null, retryable = false } = {}) {
    super(message);
    this.name = "ModelCallError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
  }
}

function publicErrorRecord(error, stage, attempt) {
  let code = error?.code ?? "MODEL_UNKNOWN_ERROR";
  let message = "模型调用发生未知错误";
  let retryable = Boolean(error?.retryable);
  let httpStatus = error?.httpStatus ?? null;
  if (error?.name === "AbortError") {
    code = "MODEL_TIMEOUT"; message = "模型响应超时"; retryable = true;
  } else if (error instanceof TypeError && !error?.code) {
    code = "MODEL_NETWORK_ERROR"; message = "无法连接模型服务"; retryable = true;
  } else {
    const messages = {
      MODEL_NOT_CONFIGURED: "模型服务未配置",
      MODEL_HTTP_ERROR: "模型服务返回异常状态",
      MODEL_RESPONSE_BODY_ERROR: "模型响应正文无法解析",
      MODEL_EMPTY_RESPONSE: "模型未返回有效内容",
      MODEL_JSON_PARSE_ERROR: "模型输出不是合法JSON",
      MODEL_CONTRACT_ERROR: "模型输出不符合路由契约",
    };
    message = messages[code] ?? message;
  }
  return {
    code, stage, message, retryable, attempt,
    ...(httpStatus ? { httpStatus } : {}),
    occurredAt: new Date().toISOString(),
  };
}

function applyConfidencePolicy(value) {
  const accepted = value.recommendations.filter((item) => item.confidence >= ROUTING_CONFIDENCE_THRESHOLD);
  if (value.recommendations.length > 0 && accepted.length === 0) {
    return {
      ...value,
      recommendations: [],
      shouldAskQuestion: false,
      clarificationQuestion: "当前信息不足以形成可信度达到80%的科室推荐，请咨询现场导诊台工作人员。",
      shouldRequestHumanHelp: true,
      suggestedTool: "REQUEST_HUMAN_SERVICE",
    };
  }
  return { ...value, recommendations: accepted };
}

function validateRoutingOutput(value, allowedIds) {
  if (!value || value.contractType !== "department_routing_response" || value.containsDiagnosis !== false) throw new Error("模型输出契约无效");
  if (!ROUTING_INTENTS.has(value.intent) || !Array.isArray(value.extractedFacts)) throw new Error("模型分类字段无效");
  if (typeof value.shouldAskQuestion !== "boolean" || typeof value.shouldRequestHumanHelp !== "boolean") throw new Error("模型决策字段无效");
  if (!ROUTING_TOOLS.has(value.suggestedTool)) throw new Error("模型工具建议无效");
  if (!Array.isArray(value.recommendations) || value.recommendations.length > 2) throw new Error("推荐数量无效");
  if (value.intent !== "DEPARTMENT_RECOMMENDATION" && value.recommendations.length > 0) throw new Error("非导诊分类不得返回科室推荐");
  for (const recommendation of value.recommendations) {
    if (!allowedIds.has(recommendation.departmentId)) throw new Error("模型返回了候选范围外的科室");
    if (!(recommendation.confidence >= 0 && recommendation.confidence <= 1) || typeof recommendation.reason !== "string" || DIAGNOSIS_TERMS.test(recommendation.reason)) throw new Error("推荐内容不安全");
  }
  if (value.shouldAskQuestion && !value.clarificationQuestion) throw new Error("缺少澄清问题");
  return value;
}

function validateWaitingOutput(value) {
  if (!value || value.contractType !== "waiting_interview_response" || value.containsDiagnosis !== false) throw new Error("候诊问询输出契约无效");
  if (typeof value.acknowledgement !== "string" || value.acknowledgement.length > 60) throw new Error("候诊确认语无效");
  if (typeof value.nextQuestion !== "string" || value.nextQuestion.length > 100) throw new Error("候诊问题无效");
  if (typeof value.complete !== "boolean" || DIAGNOSIS_TERMS.test(`${value.acknowledgement}${value.nextQuestion}`)) throw new Error("候诊问询内容不安全");
  if (!Array.isArray(value.extractedFacts)) throw new Error("候诊结构化事实无效");
  return value;
}

function validateTurnResolution(value) {
  if (!value || value.contractType !== "agent_turn_resolution_response" || value.containsDiagnosis !== false) throw new Error("通用意图输出契约无效");
  if (!TURN_INTENTS.has(value.intent) || typeof value.handled !== "boolean") throw new Error("通用意图分类无效");
  if (!(Number(value.confidence) >= 0 && Number(value.confidence) <= 1)) throw new Error("通用意图置信度无效");
  if (typeof value.answer !== "string" || value.answer.length > 160 || DIAGNOSIS_TERMS.test(value.answer)) throw new Error("通用回复不安全");
  if (typeof value.shouldRequestHumanHelp !== "boolean" || !Array.isArray(value.extractedFacts)) throw new Error("通用意图决策无效");
  if (value.handled && !value.answer.trim()) throw new Error("缺少通用回复正文");
  const entities = value.entities && typeof value.entities === "object" && !Array.isArray(value.entities) ? value.entities : {};
  return { ...value, confidence: Number(value.confidence), entities };
}

export class DeepSeekDepartmentRouter {
  constructor(config, knowledge, { fetchImpl = globalThis.fetch, logger = console } = {}) {
    this.config = config;
    this.knowledge = knowledge;
    this.fetch = fetchImpl;
    this.logger = logger;
  }

  recordError(record, error) {
    this.logger.error(JSON.stringify({
      event: "deepseek_model_error",
      ...record,
      detail: String(error?.message ?? error ?? "unknown").slice(0, 300),
    }));
  }

  async resolveTurn({ expression, context }) {
    const request = {
      contractType: "agent_turn_resolution_request",
      task: "RESOLVE_CURRENT_TURN",
      userExpression: expression,
      patientContext: context.patient,
      confirmedFacts: context.confirmedFacts,
      conversationSummary: context.conversationSummary,
      currentStage: context.currentStage,
      workflowState: context.workflowState,
      allowedIntents: [...TURN_INTENTS],
      constraints: { diagnosisForbidden: true, minimumConfidence: ROUTING_CONFIDENCE_THRESHOLD, maxAnswerLength: 160 },
    };
    if (!this.config.deepseekApiKey) {
      const sourceError = new ModelCallError("MODEL_NOT_CONFIGURED", "DeepSeek API key is missing");
      const error = publicErrorRecord(sourceError, "TURN_RESOLUTION", 0);
      this.recordError(error, sourceError);
      return { request, result: this.turnFallback(), provider: "fallback", degraded: true, errorCode: error.code, error };
    }
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.deepseekTimeoutMs);
      try {
        const response = await this.fetch(`${this.config.deepseekBaseUrl}/chat/completions`, {
          method: "POST", signal: controller.signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.deepseekApiKey}` },
          body: JSON.stringify({
            model: this.config.deepseekModel, thinking: { type: "disabled" }, temperature: 0.1, max_tokens: 500, response_format: { type: "json_object" },
            messages: [
              { role: "system", content: "你是医院导诊系统的当前轮任务路由器，不是问诊医生。结合当前表达、已确认事实、就诊阶段和待办任务判断用户此刻要完成什么。允许理解同义表达，但不得诊断、治疗或给出用药建议。不要被上一轮问题强制束缚：当前表达若是在问地点、医生、挂号、本人药品或检查、缴费、排队、退号或人工服务，必须切换到对应任务。医生姓名、科室、日期放入entities；个人查询类型用entities.queryType=APPOINTMENT、PRESCRIPTION或EXAMINATION。系统只能提供科室导诊、医生公开资料、挂号、本人就诊事项、院内地点、排队进度、模拟缴费、退号和会话管理；需要测量、真实检查、真实支付、现场设备或不在能力范围内的事项必须handled=false并请求人工帮助。不能可靠满足时同样转人工。只输出JSON。" },
              { role: "user", content: `处理以下结构化请求：${JSON.stringify(request)}。输出字段：contractType=agent_turn_resolution_response；intent只能来自allowedIntents；handled布尔值；confidence为0到1；answer为简短回复；entities为对象（地点可用destination）；extractedFacts为仅包含field、normalizedValue、confidence的数组，field只能是chiefConcern、symptoms、timeline、vitalSigns、patientHistory、patientMedications、patientAllergies、patientQuestions；shouldRequestHumanHelp布尔值；containsDiagnosis=false。血压、体温等测量值归入vitalSigns。置信度低于0.80时必须handled=false、shouldRequestHumanHelp=true。` },
            ],
          }),
        });
        if (!response.ok) throw new ModelCallError("MODEL_HTTP_ERROR", `DeepSeek HTTP ${response.status}`, { httpStatus: response.status, retryable: response.status === 429 || response.status >= 500 });
        let payload;
        try { payload = await response.json(); }
        catch (error) { throw new ModelCallError("MODEL_RESPONSE_BODY_ERROR", error.message, { retryable: true }); }
        const content = payload.choices?.[0]?.message?.content;
        if (typeof content !== "string" || !content.trim()) throw new ModelCallError("MODEL_EMPTY_RESPONSE", "DeepSeek content is empty", { retryable: true });
        let parsed;
        try { parsed = JSON.parse(content); }
        catch (error) { throw new ModelCallError("MODEL_JSON_PARSE_ERROR", error.message, { retryable: true }); }
        let result;
        try { result = validateTurnResolution(parsed); }
        catch (error) { throw new ModelCallError("MODEL_CONTRACT_ERROR", error.message, { retryable: true }); }
        if (result.confidence < ROUTING_CONFIDENCE_THRESHOLD || !result.handled) result = this.turnFallback();
        return { request, result, provider: "deepseek", degraded: false };
      } catch (error) {
        lastError = publicErrorRecord(error, "TURN_RESOLUTION", attempt);
        this.recordError(lastError, error);
      } finally { clearTimeout(timer); }
    }
    return { request, result: this.turnFallback(), provider: "fallback", degraded: true, errorCode: lastError?.code, error: lastError };
  }

  async recommend({ expression, patient, confirmedFacts = [], conversationSummary = "" }) {
    const candidates = this.knowledge.routingCandidates(expression);
    const allowedIds = new Set(candidates.map((item) => item.departmentId));
    const request = {
      contractType: "department_routing_request", task: "DEPARTMENT_RECOMMENDATION", userExpression: expression,
      patientContext: { ageRange: patient ? (patient.age >= 70 ? "70+" : patient.age >= 60 ? "60-69" : patient.age >= 50 ? "50-59" : patient.age >= 18 ? "18-49" : "0-17") : "unknown", sex: patient?.sex ?? null },
      confirmedFacts, conversationSummary, candidateDepartments: candidates,
      constraints: { allowedDepartmentIds: [...allowedIds], maxRecommendations: 2, minimumAcceptedConfidence: ROUTING_CONFIDENCE_THRESHOLD, diagnosisForbidden: true },
    };
    if (!this.config.deepseekApiKey) {
      const sourceError = new ModelCallError("MODEL_NOT_CONFIGURED", "DeepSeek API key is missing");
      const error = publicErrorRecord(sourceError, "DEPARTMENT_ROUTING", 0);
      this.recordError(error, sourceError);
      return { request, result: this.fallback(), provider: "fallback", degraded: true, errorCode: error.code, error };
    }
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.deepseekTimeoutMs);
      try {
        const response = await this.fetch(`${this.config.deepseekBaseUrl}/chat/completions`, {
          method: "POST", signal: controller.signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.deepseekApiKey}` },
          body: JSON.stringify({
            model: this.config.deepseekModel, thinking: { type: "disabled" }, temperature: 0.1, max_tokens: 900, response_format: { type: "json_object" },
            messages: [
              { role: "system", content: "你是受约束的医院导诊分类器，不是问诊医生。任务是把患者表达分类到给定科室标签，最多返回两个科室。只能从候选科室ID中选择，不诊断、不提供治疗或用药建议，也不能执行写操作。置信度必须反映分类把握：任何科室置信度低于0.80时不得推荐该科室；如果没有达到0.80的科室，recommendations必须为空、shouldRequestHumanHelp=true、suggestedTool=REQUEST_HUMAN_SERVICE。必须只输出JSON对象。" },
              { role: "user", content: `请根据以下JSON完成固定标签分类：${JSON.stringify(request)}\n严格输出字段：contractType=department_routing_response；intent只能为DEPARTMENT_RECOMMENDATION、HOSPITAL_QA或OTHER；extractedFacts为{field,rawValue,normalizedValue,confidence}数组，field只能是chiefConcern、symptoms、timeline、vitalSigns、patientHistory、patientMedications、patientAllergies、patientQuestions，血压和体温归入vitalSigns；recommendations为最多两个{departmentId,confidence,reason}；shouldAskQuestion和shouldRequestHumanHelp为布尔值；clarificationQuestion为字符串或null；suggestedTool只能为NONE、SHOW_APPOINTMENT_SERVICE或REQUEST_HUMAN_SERVICE；containsDiagnosis=false。仅当至少一个推荐置信度达到0.80时使用SHOW_APPOINTMENT_SERVICE。` },
            ],
          }),
        });
        if (!response.ok) throw new ModelCallError("MODEL_HTTP_ERROR", `DeepSeek HTTP ${response.status}`, { httpStatus: response.status, retryable: response.status === 429 || response.status >= 500 });
        let payload;
        try { payload = await response.json(); }
        catch (error) { throw new ModelCallError("MODEL_RESPONSE_BODY_ERROR", error.message, { retryable: true }); }
        const content = payload.choices?.[0]?.message?.content;
        if (typeof content !== "string" || !content.trim()) throw new ModelCallError("MODEL_EMPTY_RESPONSE", "DeepSeek content is empty", { retryable: true });
        let parsed;
        try { parsed = JSON.parse(content); }
        catch (error) { throw new ModelCallError("MODEL_JSON_PARSE_ERROR", error.message, { retryable: true }); }
        let validated;
        try { validated = validateRoutingOutput(parsed, allowedIds); }
        catch (error) { throw new ModelCallError("MODEL_CONTRACT_ERROR", error.message, { retryable: true }); }
        const result = applyConfidencePolicy(validated);
        return { request, result, provider: "deepseek", degraded: false };
      } catch (error) {
        lastError = publicErrorRecord(error, "DEPARTMENT_ROUTING", attempt);
        this.recordError(lastError, error);
      }
      finally { clearTimeout(timer); }
    }
    return { request, result: this.fallback(), provider: "fallback", degraded: true, errorCode: lastError.code, error: lastError };
  }

  async streamPatientReply({ draft, context }, onDelta) {
    if (!this.config.deepseekApiKey) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.deepseekTimeoutMs);
    try {
      const response = await this.fetch(`${this.config.deepseekBaseUrl}/chat/completions`, {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.deepseekApiKey}` },
        body: JSON.stringify({
          model: this.config.deepseekModel, temperature: 0.1, max_tokens: 240, stream: true,
          messages: [
            { role: "system", content: "你负责把已经校验的医院导诊结果写成简短患者回复。不得诊断、治疗、用药，不质疑医生，不添加输入外的事实。只输出回复正文，不输出JSON、标题或列表，最多120个中文字符。" },
            { role: "user", content: JSON.stringify({ validatedDraft: draft, structuredContext: context }) },
          ],
        }),
      });
      if (!response.ok || !response.body) throw new Error(`DeepSeek stream HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = ""; let text = "";
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
          const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? "";
          if (!delta || text.length >= 220) continue;
          const safeDelta = delta.slice(0, 220 - text.length);
          text += safeDelta; onDelta(safeDelta);
        }
        if (done) break;
      }
      if (!text || DIAGNOSIS_TERMS.test(text)) return null;
      return text;
    } catch { return null; }
    finally { clearTimeout(timer); }
  }

  async emotionalSupport({ expression, context }) {
    const fallback = "听起来这段过程让您很不好受。我会尽量帮您把眼前这一步处理清楚。";
    if (!this.config.deepseekApiKey) return { text: fallback, provider: "fallback", degraded: true };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.deepseekTimeoutMs);
    try {
      const response = await this.fetch(`${this.config.deepseekBaseUrl}/chat/completions`, {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.deepseekApiKey}` },
        body: JSON.stringify({
          model: this.config.deepseekModel, thinking: { type: "disabled" }, temperature: 0.3, max_tokens: 120,
          messages: [
            { role: "system", content: "你是医院导诊中的情绪支持助手。对患者当前的消极情绪给出一句真诚、简短、具体的回应，不诊断心理疾病，不说教，不承诺无法做到的事情，不提供治疗或用药建议。只输出正文，最多80个中文字符。" },
            { role: "user", content: JSON.stringify({ expression, currentStage: context.currentStage, currentTask: context.workflowState?.activeTaskType, confirmedFacts: context.confirmedFacts?.slice(0, 4) ?? [] }) },
          ],
        }),
      });
      if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}`);
      const payload = await response.json();
      const text = String(payload.choices?.[0]?.message?.content ?? "").trim().slice(0, 100);
      if (!text || DIAGNOSIS_TERMS.test(text)) throw new Error("情绪回应内容无效");
      return { text, provider: "deepseek", degraded: false };
    } catch {
      return { text: fallback, provider: "fallback", degraded: true };
    } finally { clearTimeout(timer); }
  }

  async waitingInterview({ expression = "", context, initial = false, targetField = null }) {
    const request = {
      contractType: "waiting_interview_request", task: "WAITING_INTERVIEW", initial,
      userExpression: expression, patientContext: context.patient, confirmedFacts: context.confirmedFacts,
      conversationSummary: context.conversationSummary, currentStage: context.currentStage,
      workflowState: context.workflowState, targetField,
      constraints: { diagnosisForbidden: true, oneQuestionOnly: true, maxQuestionLength: 100 },
    };
    if (!this.config.deepseekApiKey) return { request, result: this.waitingFallback(context, initial), provider: "fallback", degraded: true };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.deepseekTimeoutMs);
    try {
      const response = await this.fetch(`${this.config.deepseekBaseUrl}/chat/completions`, {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.deepseekApiKey}` },
        body: JSON.stringify({
          model: this.config.deepseekModel, thinking: { type: "disabled" }, temperature: 0.1, max_tokens: 300, response_format: { type: "json_object" },
          messages: [
              { role: "system", content: "你是候诊信息结构化助手，不是问诊医生。应用会决定下一步问什么；你只需理解患者对当前单项问题的回答，给出简短确认语并抽取已明确的信息。不得诊断、评价医生、提供治疗或用药建议，不得询问姓名、身份证号或联系方式。只输出JSON。" },
              { role: "user", content: `根据以下结构化输入处理患者回答：${JSON.stringify(request)}。输出 contractType=waiting_interview_response；acknowledgement为不超过60字的确认语；nextQuestion必须为空字符串；complete=false；extractedFacts为{field,normalizedValue,confidence}数组，field只能是chiefConcern、symptoms、timeline、vitalSigns、patientHistory、patientMedications、patientAllergies、patientQuestions；containsDiagnosis=false。不要保留冗余原话，只输出医生有用的规范化事实。若患者明确回答“没有”，针对targetField输出语义明确的否认事实。` },
          ],
        }),
      });
      if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}`);
      const payload = await response.json();
      return { request, result: validateWaitingOutput(JSON.parse(payload.choices?.[0]?.message?.content)), provider: "deepseek", degraded: false };
    } catch {
      return { request, result: this.waitingFallback(context, initial), provider: "fallback", degraded: true };
    } finally { clearTimeout(timer); }
  }

  waitingFallback(context, initial) {
    const count = context.confirmedFacts?.length ?? 0;
    if (initial || count === 0) return { contractType: "waiting_interview_response", acknowledgement: "候诊期间我可以先帮您整理信息，供医生接诊时查看。", nextQuestion: "", complete: false, extractedFacts: [], containsDiagnosis: false };
    return { contractType: "waiting_interview_response", acknowledgement: "好的，我会继续逐项帮您整理。", nextQuestion: "", complete: false, extractedFacts: [], containsDiagnosis: false };
  }

  fallback() {
    return { contractType: "department_routing_response", intent: "DEPARTMENT_RECOMMENDATION", extractedFacts: [], recommendations: [], shouldAskQuestion: false, clarificationQuestion: "当前无法形成可信度达到80%的科室推荐，请咨询现场导诊台工作人员。", shouldRequestHumanHelp: true, suggestedTool: "REQUEST_HUMAN_SERVICE", containsDiagnosis: false };
  }

  turnFallback() {
    return { contractType: "agent_turn_resolution_response", intent: "OTHER", handled: false, confidence: 0, answer: "我暂时无法可靠理解或完成这个请求，请前往现场导诊台寻求人工帮助。", entities: {}, extractedFacts: [], shouldRequestHumanHelp: true, containsDiagnosis: false };
  }
}
