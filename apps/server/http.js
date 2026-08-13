import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { AppError, errorEnvelope } from "./errors.js";

const mimeTypes = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".fmap": "application/octet-stream", ".wasm": "application/wasm",
  ".ttf": "font/ttf", ".png": "image/png", ".svg": "image/svg+xml",
};

function sendHtmlDownload(res, filename, html) {
  const body = Buffer.from(html, "utf8");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8", "Content-Length": body.length,
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie ?? "").split(";").filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }));
}

function cookie(name, value, config, maxAge) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAge}`];
  if (config.secureCookies) parts.push("Secure");
  return parts.join("; ");
}

function clearCookie(name, config) { return cookie(name, "", config, 0); }

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 256_000) throw new AppError(413, "BODY_TOO_LARGE", "请求内容过大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new AppError(400, "INVALID_JSON", "请求 JSON 格式无效"); }
}

function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store", ...headers });
  res.end(body);
}

function success(res, data, status = 200, headers = {}) { sendJson(res, status, { success: true, data, requestTime: new Date().toISOString() }, headers); }

function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function streamAgentResponse(res, service, context, body, config) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive", "X-Accel-Buffering": "no",
    ...(context.created ? { "Set-Cookie": cookie("patient_session", context.token, config, 72 * 3600) } : {}),
  });
  sendEvent(res, "message.accepted", { message: body.message });
  sendEvent(res, "assistant.status", { text: "正在处理" });
  try {
    const result = await service.agentMessage(context.row, body, { onDelta: (delta) => sendEvent(res, "assistant.delta", { delta }) });
    sendEvent(res, "assistant.completed", { turnId: result.turnId, text: result.text, intent: result.intent, currentStage: result.currentStage, model: result.model ?? null });
    // Actions are deliberately emitted only after assistant.completed so cards always end the turn.
    sendEvent(res, "assistant.actions", { actions: result.assistantActions });
    res.end();
  } catch (error) {
    sendEvent(res, "error", errorEnvelope(error));
    res.end();
  }
}

function match(path, pattern) {
  const keys = [];
  const regex = new RegExp(`^${pattern.replace(/:([A-Za-z]+)/g, (_, key) => { keys.push(key); return "([^/]+)"; })}$`);
  const result = path.match(regex);
  return result ? Object.fromEntries(keys.map((key, index) => [key, decodeURIComponent(result[index + 1])])) : null;
}

function serveFile(res, filePath, cache = false, method = "GET") {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return false;
  const stat = statSync(filePath);
  res.writeHead(200, {
    "Content-Type": mimeTypes[extname(filePath)] ?? "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control": cache ? "public, max-age=3600" : "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  if (method === "HEAD") res.end();
  else createReadStream(filePath).pipe(res);
  return true;
}

function safeStatic(root, pathname) {
  const full = resolve(root, `.${pathname}`);
  return full === root || full.startsWith(`${root}${sep}`) ? full : null;
}

export function createHospitalServer(service, config, speech) {
  return createServer(async (req, res) => {
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "geolocation=(self), microphone=(self), camera=()");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.fengmap.com https://*.fengmap.cool; font-src 'self' https://*.fengmap.com https://*.fengmap.cool; connect-src 'self' https://*.fengmap.com https://*.fengmap.cool wss://iat.cn-huabei-1.xf-yun.com; media-src 'self' blob:; worker-src 'self' blob:");
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const jar = cookies(req);
    let patientContext;
    const patient = () => {
      if (!patientContext) patientContext = service.getOrCreatePatientSession(jar.patient_session);
      return patientContext;
    };
    const doctor = () => service.requireDoctor(jar.doctor_session);
    const doctorWrite = () => { const session = doctor(); service.requireCsrf(session, req.headers["x-csrf-token"]); return session; };
    const administrator = () => service.requireAdministrator(jar.administrator_session);
    const administratorWrite = () => { const session = administrator(); service.requireCsrf(session, req.headers["x-csrf-token"]); return session; };
    let params;
    try {
      if (req.method === "GET" && path === "/api/health") return success(res, { status: "ok", hospital: config.hospitalName, database: service.db.engine ?? "unknown", now: new Date().toISOString() });
      if (req.method === "GET" && path === "/api/config") return success(res, { hospital: service.knowledge.hospital, administratorInitialized: service.administratorSetupStatus().initialized, map: { mapId: config.fengmapMapId, available: true, sdkConfigured: Boolean(config.fengmapAppName && config.fengmapKey), appName: config.fengmapAppName, webApiKey: config.fengmapKey }, speech: speech.capabilities(), simulationNotice: service.knowledge.simulationManifest.notice });
      if (req.method === "GET" && path === "/api/departments") return success(res, service.knowledge.listDepartments({ bookingOnly: url.searchParams.get("bookingEligible") === "true", query: url.searchParams.get("q") ?? "", limit: url.searchParams.get("limit") ?? 100 }));
      if (req.method === "GET" && path === "/api/locations") return success(res, service.knowledge.searchLocations(url.searchParams.get("q")));
      if (req.method === "GET" && path === "/api/routes") return success(res, service.knowledge.staticRoute(url.searchParams.get("start"), url.searchParams.get("end")));
      if (req.method === "GET" && path === "/api/practices") return success(res, service.listPractices({ departmentId: url.searchParams.get("departmentId"), date: url.searchParams.get("date") }));
      if (req.method === "GET" && path === "/api/patient/me") {
        const context = patient();
        return success(res, service.patientSummary(context.row), 200, context.created ? { "Set-Cookie": cookie("patient_session", context.token, config, 72 * 3600) } : {});
      }
      if (req.method === "POST" && path === "/api/patient/identity-preview") return success(res, service.previewPatientIdentity(await readBody(req)));
      if (req.method === "POST" && path === "/api/patient/profile") {
        const context = patient();
        const result = service.createPatientProfile(context.row, await readBody(req));
        return success(res, result, 201, context.created ? { "Set-Cookie": cookie("patient_session", context.token, config, 72 * 3600) } : {});
      }
      if (req.method === "POST" && path === "/api/patient/profile/virtual") {
        const context = patient();
        const result = service.createVirtualPatientProfile(context.row);
        return success(res, result, 201, context.created ? { "Set-Cookie": cookie("patient_session", context.token, config, 72 * 3600) } : {});
      }
      if (req.method === "DELETE" && path === "/api/patient/session") { service.endPatientSession(patient().row); return success(res, { ended: true }, 200, { "Set-Cookie": clearCookie("patient_session", config) }); }
      if (req.method === "GET" && path === "/api/patient/messages") { const context = patient(); return success(res, service.conversation(context.row), 200, context.created ? { "Set-Cookie": cookie("patient_session", context.token, config, 72 * 3600) } : {}); }
      if (req.method === "POST" && path === "/api/agent/messages") {
        const context = patient();
        return success(res, await service.agentMessage(context.row, await readBody(req)), 201, context.created ? { "Set-Cookie": cookie("patient_session", context.token, config, 72 * 3600) } : {});
      }
      if (req.method === "POST" && path === "/api/agent/messages/stream") {
        const context = patient();
        return streamAgentResponse(res, service, context, await readBody(req), config);
      }
      if (req.method === "POST" && path === "/api/speech/transcription-session") {
        const context = patient();
        return success(res, speech.transcriptionSession(), 201, context.created ? { "Set-Cookie": cookie("patient_session", context.token, config, 72 * 3600) } : {});
      }
      if (req.method === "POST" && path === "/api/speech/synthesis") {
        const context = patient();
        const body = await readBody(req);
        const audio = await speech.synthesize(body.text);
        res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": audio.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...(context.created ? { "Set-Cookie": cookie("patient_session", context.token, config, 72 * 3600) } : {}) });
        return res.end(audio);
      }
      if (req.method === "POST" && path === "/api/patient/actions") return success(res, service.preparePatientAction(patient().row, await readBody(req)), 201);
      if ((params = match(path, "/api/patient/actions/:id/confirm")) && req.method === "POST") return success(res, service.confirmPatientAction(patient().row, params.id), 201);
      if (req.method === "POST" && path === "/api/patient/conversation/undo") {
        const context = patient();
        return success(res, service.prepareConversationUndo(context.row), 201, context.created ? { "Set-Cookie": cookie("patient_session", context.token, config, 72 * 3600) } : {});
      }
      if ((params = match(path, "/api/patient/conversation/undo/:id/confirm")) && req.method === "POST") return success(res, service.confirmConversationUndo(patient().row, params.id));
      if ((params = match(path, "/api/patient/conversation/undo/:id/cancel")) && req.method === "POST") return success(res, service.cancelConversationUndo(patient().row, params.id));
      if (req.method === "GET" && path === "/api/patient/journey") { const context = patient(); return success(res, service.patientJourney(context.row), 200, context.created ? { "Set-Cookie": cookie("patient_session", context.token, config, 72 * 3600) } : {}); }
      if (req.method === "GET" && path === "/api/patient/proactive-update") { const context = patient(); return success(res, await service.proactivePatientUpdate(context.row), 200, context.created ? { "Set-Cookie": cookie("patient_session", context.token, config, 72 * 3600) } : {}); }
      if (req.method === "GET" && path === "/api/patient/map-context") { const context = patient(); return success(res, service.patientMapContext(context.row), 200, context.created ? { "Set-Cookie": cookie("patient_session", context.token, config, 72 * 3600) } : {}); }
      if ((params = match(path, "/api/patient/bills/:id/simulated-payment")) && req.method === "POST") return success(res, service.payBillWithSimulation(patient().row, params.id), 201);
      if ((params = match(path, "/api/patient/tasks/:id/complete")) && req.method === "POST") return success(res, service.completePatientTask(patient().row, params.id));
      if ((params = match(path, "/api/patient/return-visits/:id/check-in")) && req.method === "POST") return success(res, service.checkInReturnVisit(patient().row, params.id));
      if ((params = match(path, "/api/patient/appointments/:id/record-export")) && req.method === "GET") {
        const exported = service.exportMedicalRecord(patient().row, params.id);
        return sendHtmlDownload(res, exported.filename, exported.html);
      }
      if ((params = match(path, "/api/appointments/:id/cancel")) && req.method === "POST") return success(res, service.cancelAppointment(patient().row, params.id));
      if ((params = match(path, "/api/appointments/:id/check-in")) && req.method === "POST") return success(res, service.checkInPatient(patient().row, params.id));
      if ((params = match(path, "/api/appointments/:id/reschedule")) && req.method === "POST") return success(res, service.rescheduleAppointment(patient().row, params.id, (await readBody(req)).practiceId));
      if (req.method === "POST" && path === "/api/doctors/register") return success(res, service.registerDoctor(await readBody(req)), 201);
      if (req.method === "POST" && path === "/api/doctors/login") {
        const result = service.loginDoctor(await readBody(req));
        return success(res, { doctor: result.doctor, csrfToken: result.csrfToken }, 200, { "Set-Cookie": cookie("doctor_session", result.token, config, 12 * 3600) });
      }
      if (req.method === "GET" && path === "/api/doctors/me") {
        const session = doctor();
        return success(res, { doctor: service.doctorPublic(session), csrfToken: service.csrfForDoctorSession(session), practices: service.listPractices({}, session.doctor_id) });
      }
      if (req.method === "POST" && path === "/api/doctors/logout") { const session = doctorWrite(); service.logoutDoctor(session); return success(res, { loggedOut: true }, 200, { "Set-Cookie": clearCookie("doctor_session", config) }); }
      if (req.method === "GET" && path === "/api/doctors/practices") { const session = doctor(); return success(res, service.listPractices({}, session.doctor_id)); }
      if (req.method === "GET" && path === "/api/doctors/order-catalog") { doctor(); return success(res, service.doctorOrderCatalog()); }
      if (req.method === "POST" && path === "/api/doctors/practices") return success(res, service.createPractice(doctorWrite(), await readBody(req)), 201);
      if ((params = match(path, "/api/doctors/practices/:id/status")) && req.method === "PUT") return success(res, service.updatePracticeStatus(doctorWrite(), params.id, (await readBody(req)).status));
      if (req.method === "GET" && path === "/api/doctors/appointments") return success(res, service.listDoctorAppointments(doctor()));
      if ((params = match(path, "/api/doctors/appointments/:id/transition")) && req.method === "POST") { const body = await readBody(req); return success(res, service.transitionAppointment(doctorWrite(), params.id, body.action, body)); }
      if ((params = match(path, "/api/doctors/appointments/:id/record")) && req.method === "GET") return success(res, service.getRecordForDoctor(doctor(), params.id));
      if ((params = match(path, "/api/doctors/records/:id")) && req.method === "PUT") return success(res, service.saveRecord(doctorWrite(), params.id, await readBody(req)));
      if ((params = match(path, "/api/doctors/records/:id/orders")) && req.method === "POST") return success(res, service.createOrder(doctorWrite(), params.id, await readBody(req)), 201);
      if ((params = match(path, "/api/doctors/orders/:id/revoke")) && req.method === "POST") return success(res, service.revokeOrder(doctorWrite(), params.id));
      if ((params = match(path, "/api/doctors/orders/:id/simulated-result")) && req.method === "POST") return success(res, service.simulateOrderResult(doctorWrite(), params.id, (await readBody(req)).objectType), 201);
      if (req.method === "GET" && path === "/api/administrators/setup") return success(res, service.administratorSetupStatus());
      if (req.method === "POST" && path === "/api/administrators/setup") return success(res, service.initializeAdministrator(await readBody(req)), 201);
      if (req.method === "POST" && path === "/api/administrators/login") {
        const result = service.loginAdministrator(await readBody(req));
        return success(res, { administrator: result.administrator, csrfToken: result.csrfToken }, 200, { "Set-Cookie": cookie("administrator_session", result.token, config, config.administratorSessionHours * 3600) });
      }
      if (req.method === "GET" && path === "/api/administrators/me") {
        const session = administrator();
        return success(res, { administrator: service.administratorPublic(session), csrfToken: service.csrfForAdministratorSession(session) });
      }
      if (req.method === "POST" && path === "/api/administrators/logout") { const session = administratorWrite(); service.logoutAdministrator(session); return success(res, { loggedOut: true }, 200, { "Set-Cookie": clearCookie("administrator_session", config) }); }
      if (req.method === "GET" && path === "/api/administrators/doctors") return success(res, service.listDoctorsForAdministrator(administrator()));
      if ((params = match(path, "/api/administrators/doctors/:id/status")) && req.method === "PUT") return success(res, service.reviewDoctor(administratorWrite(), params.id, (await readBody(req)).status));
      const mapFilePath = `/map-data/${encodeURIComponent(config.fengmapMapId)}/${encodeURIComponent(config.fengmapMapId)}.fmap`;
      if (path === mapFilePath && ["GET", "HEAD"].includes(req.method) && serveFile(res, config.mapPath, true, req.method)) return;
      if (path.startsWith("/vendor/fengmap/") && req.method === "GET") {
        const file = safeStatic(config.vendorRoot, path.slice("/vendor/fengmap".length));
        if (file && serveFile(res, file, true)) return;
      }
      if (req.method === "GET") {
        const canonicalRedirects = {
          "/": "/user", "/index.html": "/user", "/user/": "/user",
          "/doctor.html": "/doctor", "/doctor/": "/doctor",
          "/admin.html": "/admin", "/admin/": "/admin",
          "/map.html": "/map", "/map/": "/map",
        };
        const canonicalPath = canonicalRedirects[path];
        if (canonicalPath) {
          res.writeHead(302, { Location: canonicalPath, "Cache-Control": "no-store" });
          res.end();
          return;
        }
        const portalPages = { "/user": "/index.html", "/doctor": "/doctor.html", "/admin": "/admin.html", "/map": "/map.html" };
        if (portalPages[path] && url.search) {
          res.writeHead(302, { Location: path, "Cache-Control": "no-store" });
          res.end();
          return;
        }
        const targetPath = portalPages[path] ?? path;
        const file = safeStatic(config.staticRoot, targetPath);
        if (file && serveFile(res, file)) return;
      }
      throw new AppError(404, "NOT_FOUND", "接口或文件不存在");
    } catch (error) {
      const status = error instanceof AppError ? error.status : 500;
      const safeError = status === 500 ? new AppError(500, "INTERNAL_ERROR", "服务器处理失败") : error;
      const body = { success: false, error: errorEnvelope(safeError) };
      if (status === 500) console.error("Unhandled request error", error);
      sendJson(res, status, body);
    }
  });
}
