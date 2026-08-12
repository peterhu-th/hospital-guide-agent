import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const databasePath = resolve(process.argv[2] ?? ".local/hospital-guide.sqlite");
if (!existsSync(databasePath)) {
  console.error(`数据库不存在：${databasePath}`);
  process.exitCode = 1;
} else {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const tables = [
    "patient_profiles", "conversation_turns", "doctors", "doctor_sessions", "administrators", "administrator_sessions",
    "doctor_practices", "appointments", "medical_records", "medical_orders", "bills",
  ];
  try {
    for (const table of tables) {
      const { total } = database.prepare(`SELECT count(*) AS total FROM ${table}`).get();
      console.log(`${table}=${total}`);
    }
  } finally {
    database.close();
  }
}
