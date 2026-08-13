import assert from "node:assert/strict";
import test from "node:test";

import { DeepSeekDepartmentRouter } from "../apps/server/deepseek.js";
import { classifyPatientStatement } from "../apps/server/service.js";

const candidate = {
  departmentId: "dept-respiratory",
  name: "呼吸与危重症医学科",
  division: "内科部",
  summary: "面向呼吸系统相关问题提供专科门诊服务。",
  aliases: ["呼吸科"],
  differentiationHints: [],
};

const knowledge = { routingCandidates: () => [candidate] };
const config = {
  deepseekApiKey: "test-key",
  deepseekBaseUrl: "https://example.invalid",
  deepseekModel: "deepseek-v4-flash",
  deepseekTimeoutMs: 500,
};

function silentLogger(records = []) {
  return { error: (line) => records.push(JSON.parse(line)) };
}

function modelResponse(value) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function routingOutput(confidence) {
  return {
    contractType: "department_routing_response",
    intent: "DEPARTMENT_RECOMMENDATION",
    extractedFacts: [],
    recommendations: [{ departmentId: candidate.departmentId, confidence, reason: "症状表达与呼吸系统科室标签匹配" }],
    shouldAskQuestion: false,
    clarificationQuestion: null,
    shouldRequestHumanHelp: false,
    suggestedTool: "SHOW_APPOINTMENT_SERVICE",
    containsDiagnosis: false,
  };
}

test("unrelated patient text is classified as other instead of chief concern", () => {
  assert.equal(classifyPatientStatement("删除会话记录").category, "other");
  assert.equal(classifyPatientStatement("我咳嗽两天了").category, "timeline");
});

test("routing disables thinking and sends low confidence to human service", async () => {
  let requestBody;
  const router = new DeepSeekDepartmentRouter(config, knowledge, {
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return modelResponse(routingOutput(0.79));
    },
    logger: silentLogger(),
  });

  const routed = await router.recommend({ expression: "我咳嗽", patient: null });
  assert.deepEqual(requestBody.thinking, { type: "disabled" });
  assert.deepEqual(routed.result.recommendations, []);
  assert.equal(routed.result.shouldRequestHumanHelp, true);
  assert.equal(routed.result.suggestedTool, "REQUEST_HUMAN_SERVICE");
});

test("routing fallback never recommends catalogue-leading departments", async () => {
  const records = [];
  const router = new DeepSeekDepartmentRouter({ ...config, deepseekApiKey: "" }, knowledge, { logger: silentLogger(records) });
  const routed = await router.recommend({ expression: "我感脚了", patient: null });
  assert.deepEqual(routed.result.recommendations, []);
  assert.equal(routed.result.suggestedTool, "REQUEST_HUMAN_SERVICE");
  assert.equal(routed.error.code, "MODEL_NOT_CONFIGURED");
  assert.equal(records[0].event, "deepseek_model_error");
});

test("routing exposes HTTP and JSON errors as distinct safe structures", async () => {
  const httpRouter = new DeepSeekDepartmentRouter(config, knowledge, {
    fetchImpl: async () => new Response("unavailable", { status: 503 }),
    logger: silentLogger(),
  });
  const httpFailure = await httpRouter.recommend({ expression: "咳嗽", patient: null });
  assert.equal(httpFailure.error.code, "MODEL_HTTP_ERROR");
  assert.equal(httpFailure.error.httpStatus, 503);
  assert.equal(httpFailure.error.retryable, true);

  const jsonRouter = new DeepSeekDepartmentRouter(config, knowledge, {
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "not-json" } }] }), { status: 200 }),
    logger: silentLogger(),
  });
  const jsonFailure = await jsonRouter.recommend({ expression: "咳嗽", patient: null });
  assert.equal(jsonFailure.error.code, "MODEL_JSON_PARSE_ERROR");
  assert.deepEqual(jsonFailure.result.recommendations, []);
});

test("unknown deterministic intent falls back to structured model turn resolution", async () => {
  let requestBody;
  const router = new DeepSeekDepartmentRouter(config, knowledge, {
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return modelResponse({
        contractType: "agent_turn_resolution_response", intent: "LOCATION_HELP", handled: true,
        confidence: 0.96, answer: "我已为您打开大厅的位置搜索。", entities: { destination: "大厅" },
        extractedFacts: [], shouldRequestHumanHelp: false, containsDiagnosis: false,
      });
    },
    logger: silentLogger(),
  });
  const context = { patient: null, confirmedFacts: [], conversationSummary: "", currentStage: "PRE_VISIT", workflowState: { activeTaskType: "UNDERSTAND_REQUEST" } };
  const resolved = await router.resolveTurn({ expression: "我想去大厅", context });
  assert.deepEqual(requestBody.thinking, { type: "disabled" });
  assert.equal(resolved.result.intent, "LOCATION_HELP");
  assert.equal(resolved.result.entities.destination, "大厅");
});

test("low-confidence turn resolution explicitly requests human help", async () => {
  const router = new DeepSeekDepartmentRouter(config, knowledge, {
    fetchImpl: async () => modelResponse({
      contractType: "agent_turn_resolution_response", intent: "OTHER", handled: true,
      confidence: 0.72, answer: "不确定", entities: {}, extractedFacts: [],
      shouldRequestHumanHelp: false, containsDiagnosis: false,
    }),
    logger: silentLogger(),
  });
  const context = { patient: null, confirmedFacts: [], conversationSummary: "", currentStage: "PRE_VISIT", workflowState: { activeTaskType: "UNDERSTAND_REQUEST" } };
  const resolved = await router.resolveTurn({ expression: "这个怎么办", context });
  assert.equal(resolved.result.handled, false);
  assert.equal(resolved.result.shouldRequestHumanHelp, true);
  assert.match(resolved.result.answer, /人工帮助/);
});
