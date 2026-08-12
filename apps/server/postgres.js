import { Worker } from "node:worker_threads";

export class PostgresDatabase {
  constructor() { this.worker = new Worker(new URL("./postgres-worker.js", import.meta.url)); }
  get engine() { return "postgresql"; }
  request(type, sql = "", params = {}) {
    const shared = new SharedArrayBuffer(2 * 1024 * 1024);
    const state = new Int32Array(shared, 0, 2);
    this.worker.postMessage({ request: { type, sql, params }, shared });
    const wait = Atomics.wait(state, 0, 0, 30_000);
    if (wait === "timed-out") throw new Error("PostgreSQL 操作超时");
    const length = Atomics.load(state, 1);
    const response = JSON.parse(new TextDecoder().decode(new Uint8Array(shared, 8, length)));
    if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return response.result;
  }
  run(sql, params = {}) { return this.request("run", sql, params); }
  get(sql, params = {}) { return this.request("get", sql, params); }
  all(sql, params = {}) { return this.request("all", sql, params); }
  exec(sql) { return this.request("exec", sql); }
  transaction(callback) {
    this.request("begin");
    try { const result = callback(); this.request("commit"); return result; }
    catch (error) { this.request("rollback"); throw error; }
  }
  close() { this.worker.terminate(); }
}
