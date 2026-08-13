const MAX_RECORDING_MS = 60_000;
const TARGET_SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 640;

function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function downsampleToPcm16(input, inputRate) {
  const ratio = inputRate / TARGET_SAMPLE_RATE;
  const length = Math.floor(input.length / ratio);
  const output = new Int16Array(length);
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.max(start + 1, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let source = start; source < end && source < input.length; source += 1) sum += input[source];
    const sample = Math.max(-1, Math.min(1, sum / (end - start)));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

function recognizedWords(result) {
  return (result.ws ?? []).map((word) => word.cw?.[0]?.w ?? "").join("");
}

export class XfyunTranscriber {
  constructor({ onText, onState }) {
    this.onText = onText;
    this.onState = onState;
    this.parts = new Map();
    this.pendingSamples = [];
    this.active = false;
  }

  async start(session) {
    if (this.active) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) throw new Error("当前浏览器不支持语音输入，请使用最新版浏览器并通过 HTTPS 访问");
    this.active = true;
    this.session = session;
    this.parts.clear();
    this.pendingSamples = [];
    this.hasSentFirstFrame = false;
    this.onState("connecting");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      this.context = new AudioContext();
      await this.context.resume();
      this.source = this.context.createMediaStreamSource(this.stream);
      this.processor = this.context.createScriptProcessor(4096, 1, 1);
      this.silentGain = this.context.createGain();
      this.silentGain.gain.value = 0;
      this.source.connect(this.processor);
      this.processor.connect(this.silentGain);
      this.silentGain.connect(this.context.destination);
      this.socket = new WebSocket(session.url);
      this.socket.addEventListener("open", () => this.beginStreaming(session));
      this.socket.addEventListener("message", (event) => this.handleMessage(event));
      this.socket.addEventListener("error", () => this.fail(new Error("无法连接讯飞语音识别服务")));
      this.socket.addEventListener("close", () => { if (this.active) this.finish(); });
      this.maxTimer = window.setTimeout(() => this.stop(), Math.min(MAX_RECORDING_MS, session.audio.maxDurationSeconds * 1000));
    } catch (error) {
      this.cleanup();
      if (error?.name === "NotAllowedError") throw new Error("未获得麦克风权限，请在浏览器设置中允许后重试");
      throw error;
    }
  }

  beginStreaming(session) {
    let firstFrame = true;
    this.processor.onaudioprocess = (event) => {
      if (!this.active) return;
      const samples = downsampleToPcm16(event.inputBuffer.getChannelData(0), this.context.sampleRate);
      this.pendingSamples.push(...samples);
    };
    this.sendTimer = window.setInterval(() => {
      if (this.socket?.readyState !== WebSocket.OPEN || this.pendingSamples.length < FRAME_SAMPLES) return;
      const samples = Int16Array.from(this.pendingSamples.splice(0, FRAME_SAMPLES));
      const request = { header: { app_id: session.appId, status: firstFrame ? 0 : 1 }, payload: { audio: { encoding: "raw", sample_rate: TARGET_SAMPLE_RATE, channels: 1, bit_depth: 16, status: firstFrame ? 0 : 1, seq: this.sequence ?? 0, audio: bytesToBase64(new Uint8Array(samples.buffer)) } } };
      if (firstFrame) {
        request.parameter = { iat: { language: "zh_cn", accent: "mulacc", domain: "slm", eos: 1800, dwa: "wpgs", ptt: 1, nunum: 1, ltc: 1, result: { encoding: "utf8", compress: "raw", format: "json" } } };
      }
      this.socket.send(JSON.stringify(request));
      firstFrame = false;
      this.hasSentFirstFrame = true;
      this.sequence = (this.sequence ?? 0) + 1;
    }, 40);
    this.onState("recording");
  }

  handleMessage(event) {
    const response = JSON.parse(event.data);
    if (response.header?.code !== 0) return this.fail(new Error(`语音识别失败：${response.header?.message ?? response.header?.code}`));
    const encoded = response.payload?.result?.text;
    if (encoded) {
      const result = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))));
      if (result.pgs === "rpl" && Array.isArray(result.rg)) for (let key = result.rg[0]; key <= result.rg[1]; key += 1) this.parts.delete(key);
      this.parts.set(Number(result.sn ?? this.parts.size), recognizedWords(result));
      this.onText([...this.parts.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]).join(""));
      if (result.ls) this.finish();
    }
    if (response.header?.status === 2 || response.payload?.result?.status === 2) this.finish();
  }

  stop() {
    if (!this.active) return;
    this.onState("processing");
    if (this.socket?.readyState === WebSocket.OPEN) {
      const samples = Int16Array.from(this.pendingSamples.splice(0));
      const request = { header: { app_id: this.session.appId, status: 2 }, payload: { audio: { encoding: "raw", sample_rate: TARGET_SAMPLE_RATE, channels: 1, bit_depth: 16, status: 2, seq: this.sequence ?? 0, audio: bytesToBase64(new Uint8Array(samples.buffer)) } } };
      if (!this.hasSentFirstFrame) request.parameter = { iat: { language: "zh_cn", accent: "mulacc", domain: "slm", eos: 1800, dwa: "wpgs", ptt: 1, nunum: 1, ltc: 1, result: { encoding: "utf8", compress: "raw", format: "json" } } };
      this.socket.send(JSON.stringify(request));
      window.setTimeout(() => { if (this.active) this.finish(); }, 3000);
    } else this.finish();
    this.stopCapture();
  }

  stopCapture() {
    clearInterval(this.sendTimer);
    clearTimeout(this.maxTimer);
    if (this.processor) this.processor.onaudioprocess = null;
    this.stream?.getTracks().forEach((track) => track.stop());
  }

  finish() { this.cleanup(); this.onState("idle"); }
  fail(error) { this.cleanup(); this.onState("error", error); }
  cleanup() {
    this.active = false;
    this.stopCapture();
    try { this.socket?.close(); } catch {}
    try { this.source?.disconnect(); this.processor?.disconnect(); this.silentGain?.disconnect(); } catch {}
    this.context?.close().catch(() => {});
    this.socket = this.context = this.stream = this.source = this.processor = this.silentGain = this.session = null;
    this.sequence = 0;
  }
}

export class SpeechOutputPlayer {
  constructor() { this.abortController = null; this.source = null; }
  async unlock() {
    this.context ??= new AudioContext();
    if (this.context.state === "suspended") await this.context.resume();
  }
  stop() {
    this.abortController?.abort();
    try { this.source?.stop(); } catch {}
    this.abortController = this.source = null;
  }
  async speak(text) {
    this.stop();
    await this.unlock();
    this.abortController = new AbortController();
    const response = await fetch("/api/speech/synthesis", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }), signal: this.abortController.signal });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error?.message ?? "语音合成失败");
    }
    const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    source.onended = () => { if (this.source === source) this.source = null; };
    this.source = source;
    source.start();
  }
}
