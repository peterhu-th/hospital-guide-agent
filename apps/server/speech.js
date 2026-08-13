import { createHmac } from "node:crypto";
import { AppError } from "./errors.js";

const toBase64 = (value) => Buffer.from(value, "utf8").toString("base64");

function signedWebSocketUrl(rawUrl, apiKey, apiSecret, now = new Date()) {
  const url = new URL(rawUrl);
  const date = now.toUTCString();
  const signatureOrigin = `host: ${url.host}\ndate: ${date}\nGET ${url.pathname} HTTP/1.1`;
  const signature = createHmac("sha256", apiSecret).update(signatureOrigin).digest("base64");
  const authorization = toBase64(`api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`);
  url.searchParams.set("authorization", authorization);
  url.searchParams.set("date", date);
  url.searchParams.set("host", url.host);
  return url.toString();
}

function cleanSpeechText(value) {
  return String(value ?? "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\[([^\]]+)]\(https?:\/\/[^)]+\)/g, "$1")
    .replace(/[*_#>`~\[\]{}]/g, "")
    .replace(/https?:\/\/\S+/g, "链接")
    .replace(/[\u{1F000}-\u{1FAFF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export class XfyunSpeechService {
  constructor(config, WebSocketImpl = globalThis.WebSocket) {
    this.config = config;
    this.WebSocketImpl = WebSocketImpl;
  }

  capabilities() {
    const iat = this.config.xfyunIat ?? {};
    const tts = this.config.xfyunTts ?? {};
    return {
      transcription: Boolean(iat.appId && iat.apiKey && iat.apiSecret),
      synthesis: Boolean(tts.appId && tts.apiKey && tts.apiSecret),
    };
  }

  transcriptionSession() {
    if (!this.capabilities().transcription) throw new AppError(503, "SPEECH_NOT_CONFIGURED", "语音识别服务尚未配置");
    return {
      provider: "xfyun",
      url: signedWebSocketUrl(this.config.xfyunIatUrl, this.config.xfyunIat.apiKey, this.config.xfyunIat.apiSecret),
      appId: this.config.xfyunIat.appId,
      expiresInSeconds: 60,
      audio: { encoding: "raw", sampleRate: 16000, channels: 1, bitDepth: 16, maxDurationSeconds: 60 },
    };
  }

  async synthesize(rawText) {
    if (!this.capabilities().synthesis) throw new AppError(503, "SPEECH_NOT_CONFIGURED", "语音合成服务尚未配置");
    if (!this.WebSocketImpl) throw new AppError(503, "SPEECH_UNAVAILABLE", "当前服务端不支持语音合成连接");
    const text = cleanSpeechText(rawText);
    if (!text || text.length > 1000) throw new AppError(400, "INVALID_SPEECH_TEXT", "待朗读文字应为 1 至 1000 字");
    const credentials = this.config.xfyunTts;
    const url = signedWebSocketUrl(this.config.xfyunTtsUrl, credentials.apiKey, credentials.apiSecret);
    const socket = new this.WebSocketImpl(url);
    const timeoutMs = 20_000;
    return new Promise((resolve, reject) => {
      const chunks = [];
      let settled = false;
      const finish = (error, audio) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.close(); } catch {}
        if (error) reject(error); else resolve(audio);
      };
      const timer = setTimeout(() => finish(new AppError(504, "SPEECH_TIMEOUT", "语音合成超时，请稍后重试")), timeoutMs);
      socket.addEventListener("open", () => socket.send(JSON.stringify({
        header: { app_id: credentials.appId, status: 2 },
        parameter: {
          oral: { spark_assist: 0, remain: 1 },
          tts: {
            vcn: this.config.xfyunTtsVoice, speed: 42, volume: 60, pitch: 50,
            audio: { encoding: "lame", sample_rate: 24000, channels: 1, bit_depth: 16, frame_size: 0 },
          },
        },
        payload: { text: { encoding: "utf8", compress: "raw", format: "plain", status: 2, seq: 0, text: toBase64(text) } },
      })));
      socket.addEventListener("message", (event) => {
        try {
          const response = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8"));
          if (response.header?.code !== 0) return finish(new AppError(502, "SPEECH_PROVIDER_ERROR", `语音合成失败：${response.header?.message ?? response.header?.code}`));
          const audio = response.payload?.audio;
          if (audio?.audio) chunks.push({ seq: Number(audio.seq ?? chunks.length), data: Buffer.from(audio.audio, "base64") });
          if (response.header?.status === 2 || audio?.status === 2) {
            chunks.sort((a, b) => a.seq - b.seq);
            const output = Buffer.concat(chunks.map((chunk) => chunk.data));
            finish(output.length ? null : new AppError(502, "SPEECH_PROVIDER_ERROR", "语音合成未返回音频"), output);
          }
        } catch (error) { finish(error instanceof AppError ? error : new AppError(502, "SPEECH_PROVIDER_ERROR", "语音合成响应格式无效")); }
      });
      socket.addEventListener("error", () => finish(new AppError(502, "SPEECH_PROVIDER_ERROR", "无法连接语音合成服务")));
      socket.addEventListener("close", () => { if (!settled) finish(new AppError(502, "SPEECH_PROVIDER_ERROR", "语音合成连接提前关闭")); });
    });
  }
}

export { cleanSpeechText, signedWebSocketUrl };
