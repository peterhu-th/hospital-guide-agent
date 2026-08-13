import { loadConfig } from "./config.js";
import { SqliteDatabase } from "./database.js";
import { createHospitalServer } from "./http.js";
import { KnowledgeRepository } from "./knowledge.js";
import { HospitalService } from "./service.js";
import { DeepSeekDepartmentRouter } from "./deepseek.js";
import { PostgresDatabase } from "./postgres.js";
import { XfyunSpeechService } from "./speech.js";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function buildApplication(overrides = {}) {
  const config = loadConfig(overrides);
  const database = config.databaseEngine === "postgresql" ? new PostgresDatabase() : new SqliteDatabase(config.databasePath);
  const knowledge = new KnowledgeRepository(config.knowledgeRoot);
  const departmentRouter = new DeepSeekDepartmentRouter(config, knowledge);
  const service = new HospitalService(database, knowledge, config, departmentRouter);
  const speech = overrides.speechService ?? new XfyunSpeechService(config);
  const server = createHospitalServer(service, config, speech);
  return { config, database, knowledge, service, speech, server };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = buildApplication();
  app.server.listen(app.config.port, app.config.host, () => {
    console.log(`${app.config.hospitalName}最小业务系统已启动：http://${app.config.host}:${app.config.port}`);
    console.log(`医生账号由管理员工作台审核，不使用本地 CLI 审核码。`);
  });
  const shutdown = () => app.server.close(() => { app.database.close(); process.exit(0); });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
