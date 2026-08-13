import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanSpeechText, signedWebSocketUrl, XfyunSpeechService } from "../apps/server/speech.js";

test("讯飞 WebSocket 短时签名符合 HMAC 鉴权结构且不暴露 APISecret", () => {
  const url = new URL(signedWebSocketUrl("wss://iat.cn-huabei-1.xf-yun.com/v1", "test-api-key", "test-api-secret", new Date("2026-08-13T00:00:00Z")));
  assert.equal(url.protocol, "wss:");
  assert.equal(url.searchParams.get("host"), "iat.cn-huabei-1.xf-yun.com");
  assert.equal(url.searchParams.get("date"), "Thu, 13 Aug 2026 00:00:00 GMT");
  const authorization = Buffer.from(url.searchParams.get("authorization"), "base64").toString("utf8");
  assert.match(authorization, /api_key="test-api-key"/);
  assert.match(authorization, /algorithm="hmac-sha256"/);
  assert.doesNotMatch(url.toString(), /test-api-secret/);
});

test("语音能力只在完整鉴权配置下开放", () => {
  const configured = new XfyunSpeechService({ xfyunIat: { appId: "a", apiKey: "k", apiSecret: "s" }, xfyunTts: { appId: "a", apiKey: "k", apiSecret: "s" } });
  assert.deepEqual(configured.capabilities(), { transcription: true, synthesis: true });
  const incomplete = new XfyunSpeechService({ xfyunIat: { appId: "a" }, xfyunTts: { appId: "a", apiPassword: "password" } });
  assert.deepEqual(incomplete.capabilities(), { transcription: false, synthesis: false });
});

test("朗读文本移除 Markdown、链接和表情控制内容", () => {
  assert.equal(cleanSpeechText("**请前往** [地图](https://example.com) 😊"), "请前往 地图");
});
