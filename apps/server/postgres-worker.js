import { parentPort } from "node:worker_threads";
import pg from "pg";

const { Pool, types } = pg;
types.setTypeParser(1082, (value) => value);
types.setTypeParser(1184, (value) => new Date(value).toISOString());
const pool = new Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : { database: process.env.PGDATABASE ?? "hospital_guide", host: process.env.PGHOST ?? "/var/run/postgresql" });
let transactionClient = null;

function convert(sql, params) {
  const values = [];
  const indexes = new Map();
  let text = sql.replace(/MAX\(0,([^\)]+)\)/gi, "GREATEST(0,$1)");
  const ignore = /INSERT OR IGNORE INTO/i.test(text);
  text = text.replace(/INSERT OR IGNORE INTO/gi, "INSERT INTO").replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_, name) => {
    if (!indexes.has(name)) { indexes.set(name, values.length + 1); values.push(params[name]); }
    return `$${indexes.get(name)}`;
  });
  if (ignore) text += " ON CONFLICT DO NOTHING";
  return { text, values };
}

async function execute(request) {
  if (request.type === "begin") { transactionClient = await pool.connect(); await transactionClient.query("BEGIN"); await transactionClient.query("SET LOCAL search_path TO runtime, public"); return null; }
  if (request.type === "commit" || request.type === "rollback") { const client = transactionClient; transactionClient = null; try { await client.query(request.type === "commit" ? "COMMIT" : "ROLLBACK"); } finally { client.release(); } return null; }
  const client = transactionClient ?? await pool.connect();
  try {
    if (!transactionClient) await client.query("SET search_path TO runtime, public");
    if (request.type === "exec") { await client.query(request.sql); return null; }
    const query = convert(request.sql, request.params ?? {});
    const result = await client.query(query.text, query.values);
    if (request.type === "run") return { changes: result.rowCount };
    if (request.type === "get") return result.rows[0];
    return result.rows;
  } finally { if (!transactionClient) client.release(); }
}

parentPort.on("message", async ({ request, shared }) => {
  const state = new Int32Array(shared, 0, 2);
  const bytes = new Uint8Array(shared, 8);
  let response;
  try { response = { result: await execute(request) }; }
  catch (error) { response = { error: { message: error.message, code: error.code } }; }
  const encoded = new TextEncoder().encode(JSON.stringify(response));
  if (encoded.length > bytes.length) response = { error: { message: "PostgreSQL 响应超过同步缓冲区", code: "RESPONSE_TOO_LARGE" } };
  const output = new TextEncoder().encode(JSON.stringify(response));
  bytes.set(output); Atomics.store(state, 1, output.length); Atomics.store(state, 0, 1); Atomics.notify(state, 0);
});
