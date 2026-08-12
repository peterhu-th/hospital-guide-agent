import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(here, "../..");

function ensureSecret(path) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    const value = readFileSync(path, "utf8").trim();
    if (value.length >= 64) return Buffer.from(value, "hex");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const value = randomBytes(32);
  writeFileSync(path, value.toString("hex"), { encoding: "utf8", mode: 0o600 });
  return value;
}

function readApiConfig(path) {
  try {
    const lines = readFileSync(path, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
    let section = "";
    const values = { deepseek: {}, fengmap: {} };
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.search(/[：:=]/);
      if (separator < 0) {
        section = /蜂鸟\s*(SDK|地图)/i.test(line) ? "fengmap" : (/DeepSeek/i.test(line) ? "deepseek" : "");
        continue;
      }
      if (!section) continue;
      const name = line.slice(0, separator).trim().toLowerCase();
      const value = line.slice(separator + 1).trim();
      if (value) values[section][name] = value;
    }
    return {
      deepseekApiKey: values.deepseek.apikey ?? "",
      appName: values.fengmap.appname ?? "",
      mapId: values.fengmap.mapid ?? "",
      webApiKey: values.fengmap.apikey ?? "",
    };
  } catch (error) {
    if (error.code === "ENOENT") return { deepseekApiKey: "", appName: "", mapId: "", webApiKey: "" };
    throw error;
  }
}

export function loadConfig(overrides = {}) {
  const localDir = resolve(projectRoot, ".local");
  const secretPath = overrides.secretPath ?? process.env.APP_SECRET_PATH ?? resolve(localDir, "app-secret");
  const dbPath = overrides.dbPath ?? process.env.DATABASE_PATH ?? resolve(localDir, "hospital-guide.sqlite");
  const apiConfigPath = overrides.apiConfigPath ?? process.env.API_CONFIG_PATH ?? resolve(projectRoot, "docs/APIConfigs.txt");
  const fileApiConfig = readApiConfig(apiConfigPath);
  const fengmapMapId = overrides.fengmapMapId ?? process.env.FENGMAP_MAP_ID ?? fileApiConfig.mapId ?? "90872";
  if (fengmapMapId && fengmapMapId !== "90872") {
    throw new Error(`蜂鸟 mapID 与本地地图包不一致：当前仅支持 90872，配置为 ${fengmapMapId}`);
  }
  mkdirSync(dirname(dbPath), { recursive: true });
  return {
    host: overrides.host ?? process.env.HOST ?? "127.0.0.1",
    port: Number(overrides.port ?? process.env.PORT ?? 3000),
    databasePath: dbPath,
    databaseEngine: overrides.databaseEngine ?? process.env.DATABASE_ENGINE ?? "sqlite",
    encryptionKey: overrides.encryptionKey ?? ensureSecret(secretPath),
    staticRoot: overrides.staticRoot ?? resolve(projectRoot, "apps/web"),
    knowledgeRoot: overrides.knowledgeRoot ?? resolve(projectRoot, "knowledge"),
    mapPath: resolve(projectRoot, "assets/maps/90872.fmap"),
    vendorRoot: resolve(projectRoot, "vendor/fengmap-js-sdk-v3.2.0"),
    secureCookies: overrides.secureCookies ?? process.env.SECURE_COOKIES === "true",
    patientRetentionHours: 72,
    doctorSessionHours: 12,
    administratorSessionHours: 8,
    deepseekApiKey: overrides.deepseekApiKey ?? process.env.DEEPSEEK_API_KEY ?? fileApiConfig.deepseekApiKey,
    deepseekBaseUrl: overrides.deepseekBaseUrl ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    deepseekModel: overrides.deepseekModel ?? process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash",
    deepseekTimeoutMs: Number(overrides.deepseekTimeoutMs ?? process.env.DEEPSEEK_TIMEOUT_MS ?? 12_000),
    hospitalName: "绵阳市中心医院",
    fengmapAppName: overrides.fengmapAppName ?? process.env.FENGMAP_APP_NAME ?? fileApiConfig.appName,
    fengmapMapId: fengmapMapId || "90872",
    fengmapKey: overrides.fengmapKey ?? process.env.FENGMAP_KEY ?? fileApiConfig.webApiKey,
  };
}
