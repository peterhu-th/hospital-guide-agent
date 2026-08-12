const state = { config: null, departments: [], patient: null, doctor: null, csrf: null, administrator: null, adminCsrf: null, record: null, map: null, mapLoading: false, mapLoadTimer: null };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function escapeHtml(value) { const node = document.createElement("div"); node.textContent = String(value ?? ""); return node.innerHTML; }
function formObject(form) { return Object.fromEntries(new FormData(form).entries()); }
function toast(message, error = false) { const node = $("#toast"); node.textContent = message; node.className = `toast${error ? " error" : ""}`; clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.add("hidden"), 4500); }
async function api(path, options = {}) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(state.csrf && !["GET", undefined].includes(options.method) ? { "X-CSRF-Token": state.csrf } : {}), ...options.headers };
  const response = await fetch(path, { credentials: "same-origin", ...options, headers });
  const payload = await response.json().catch(() => ({ success: false, error: { message: "服务器返回格式无效" } }));
  if (!response.ok || !payload.success) throw new Error(payload.error?.message ?? "操作失败");
  return payload.data;
}

function setView(name) {
  $$(".view").forEach((node) => node.classList.toggle("active", node.id === `view-${name}`));
  $$(".topbar [data-view]").forEach((node) => node.classList.toggle("active", node.dataset.view === name));
  if (name === "map") initMap();
  if (name === "doctor") restoreDoctor();
  if (name === "admin") restoreAdministrator();
}

async function previewIdentity() {
  const value = $("#identityNumber").value.trim();
  $("#derivedSex").value = ""; $("#derivedAge").value = "";
  if (value.length !== 18) return;
  try {
    const result = await api("/api/patient/identity-preview", { method: "POST", body: JSON.stringify({ identityNumber: value }) });
    $("#derivedSex").value = result.sex === "male" ? "男" : "女";
    $("#derivedAge").value = `${result.age} 岁`;
  } catch (error) { toast(error.message, true); }
}

async function adminApi(path, options = {}) {
  return api(path, { ...options, headers: { ...(options.headers ?? {}), ...(state.adminCsrf && !["GET", undefined].includes(options.method) ? { "X-CSRF-Token": state.adminCsrf } : {}) } });
}

async function restoreAdministrator() {
  try {
    const data = await api("/api/administrators/me");
    state.administrator = data.administrator; state.adminCsrf = data.csrfToken;
    $("#adminAuth").classList.add("hidden"); $("#adminDashboard").classList.remove("hidden");
    $("#adminWelcome").textContent = `${data.administrator.displayName} 管理员工作台`;
    await refreshAdminDoctors();
  } catch {
    state.administrator = null; state.adminCsrf = null;
    $("#adminAuth").classList.remove("hidden"); $("#adminDashboard").classList.add("hidden");
  }
}

async function refreshAdminDoctors() {
  const doctors = await api("/api/administrators/doctors");
  $("#adminDoctors").innerHTML = doctors.length ? doctors.map((doctor) => `<div class="result-item"><strong>${escapeHtml(doctor.displayName)} · ${escapeHtml(doctor.employeeNumber)}</strong><p>状态：<span class="badge">${escapeHtml(doctor.accountStatus)}</span></p><div class="actions"><button data-review-doctor="${doctor.doctorId}" data-review-status="ACTIVE" ${doctor.accountStatus === "ACTIVE" ? "disabled" : ""}>激活</button><button class="danger" data-review-doctor="${doctor.doctorId}" data-review-status="SUSPENDED" ${doctor.accountStatus === "SUSPENDED" ? "disabled" : ""}>停用</button></div></div>`).join("") : `<p class="muted">暂无医生账号申请。</p>`;
  $$('[data-review-doctor]').forEach((button) => button.onclick = async () => { await adminApi(`/api/administrators/doctors/${button.dataset.reviewDoctor}/status`, { method: "PUT", body: JSON.stringify({ status: button.dataset.reviewStatus }) }); toast("医生账号状态已更新"); refreshAdminDoctors(); });
}

function departmentOptions(select) {
  select.innerHTML = `<option value="">请选择科室</option>${state.departments.map((item) => `<option value="${escapeHtml(item.departmentId)}">${escapeHtml(item.displayName)}${item.division ? ` · ${escapeHtml(item.division)}` : ""}</option>`).join("")}`;
}

async function refreshPatient() {
  state.patient = await api("/api/patient/me");
  const status = $("#profileStatus");
  const form = $("#profileForm");
  if (state.patient.hasProfile) {
    status.innerHTML = `<p class="badge">已建档：${escapeHtml(state.patient.fullNameMasked)}，${escapeHtml(state.patient.identityNumberMasked)}</p><p class="muted">到期时间：${new Date(state.patient.expiresAt).toLocaleString()}</p><button id="endPatientSession" class="danger">结束本次就诊并清除数据</button>`;
    form.classList.add("hidden");
    $("#endPatientSession").onclick = async () => { if (!confirm("将立即清除本次患者档案、挂号、病历和会话，确定继续吗？")) return; await api("/api/patient/session", { method: "DELETE" }); location.reload(); };
  } else { status.innerHTML = ""; form.classList.remove("hidden"); }
}

async function refreshConversation() {
  const messages = await api("/api/patient/messages");
  const container = $("#chatMessages");
  container.innerHTML = messages.length ? messages.map((item) => `<div class="message ${item.role}">${escapeHtml(item.message)}</div>`).join("") : `<div class="message AGENT">您好，我可以协助挂号流程、就诊状态、缴费指引、医保历史资料和院内地点。您可以直接说现在想解决的问题。</div>`;
  container.scrollTop = container.scrollHeight;
}

async function refreshJourney() {
  const journey = await api("/api/patient/journey");
  const parts = [];
  for (const item of journey.appointments) parts.push(`<div class="result-item"><strong>${escapeHtml(item.departmentName)} · ${escapeHtml(item.doctorName)}医生</strong><p>${item.serviceDate} ${item.startTime}-${item.endTime}　排队号：${item.queueNumber}</p><p>状态：<span class="badge">${escapeHtml(item.status)}</span></p><div class="actions">${item.status === "BOOKED" ? `<button data-check-in="${item.appointmentId}">到院报到</button><button class="danger" data-cancel="${item.appointmentId}">退号</button>` : ""}</div></div>`);
  for (const bill of journey.bills) parts.push(`<div class="result-item"><strong>待缴费账单 ¥${(bill.amountCents / 100).toFixed(2)}</strong><p><span class="badge warning">${bill.status}</span>　${escapeHtml(bill.guidance)}</p></div>`);
  for (const task of journey.tasks) parts.push(`<div class="result-item"><strong>下一步：${escapeHtml(task.title)}</strong><p>${escapeHtml(task.taskType)} · ${escapeHtml(task.status)}</p></div>`);
  $("#journeyResults").innerHTML = parts.length ? parts.join("") : `<p class="muted">当前没有挂号、账单或下一步任务。</p>`;
  $$('[data-check-in]').forEach((button) => button.onclick = async () => { await api(`/api/appointments/${button.dataset.checkIn}/check-in`, { method: "POST", body: "{}" }); toast("报到成功"); refreshJourney(); });
  $$('[data-cancel]').forEach((button) => button.onclick = async () => { const pending = await api("/api/patient/actions", { method: "POST", body: JSON.stringify({ actionType: "CANCEL_APPOINTMENT", parameters: { appointmentId: button.dataset.cancel } }) }); if (!confirm(pending.summary)) return; await api(`/api/patient/actions/${pending.actionId}/confirm`, { method: "POST", body: "{}" }); toast("退号成功"); refreshJourney(); });
}

async function searchPractices(departmentId, date) {
  const results = await api(`/api/practices?departmentId=${encodeURIComponent(departmentId)}&date=${encodeURIComponent(date)}`);
  $("#practiceResults").innerHTML = results.length ? results.map((item) => `<div class="result-item"><strong>${escapeHtml(item.doctorName)}医生</strong><p>${item.serviceDate} ${item.startTime}-${item.endTime}</p><p>剩余号源：${item.remaining}/${item.capacity}</p><button data-book="${item.practiceId}" ${item.remaining <= 0 ? "disabled" : ""}>${item.remaining > 0 ? "确认挂号" : "已满，请换医生或时段"}</button></div>`).join("") : `<p class="muted">该日期暂未有医生发布出诊号源，请更换日期或科室。</p>`;
  $$('[data-book]').forEach((button) => button.onclick = async () => { try { const pending = await api("/api/patient/actions", { method: "POST", body: JSON.stringify({ actionType: "CREATE_APPOINTMENT", parameters: { practiceId: button.dataset.book } }) }); if (!confirm(pending.summary)) return; await api(`/api/patient/actions/${pending.actionId}/confirm`, { method: "POST", body: "{}" }); toast("挂号成功"); await searchPractices(departmentId, date); await refreshJourney(); } catch (error) { toast(error.message, true); } });
}

async function restoreDoctor() {
  try {
    const data = await api("/api/doctors/me");
    state.doctor = data.doctor; state.csrf = data.csrfToken;
    $("#doctorAuth").classList.add("hidden"); $("#doctorDashboard").classList.remove("hidden");
    $("#doctorWelcome").textContent = `${state.doctor.displayName}医生工作台`;
    $("#doctorNotice").textContent = state.doctor.verificationNotice;
    renderDoctorPractices(data.practices); refreshDoctorAppointments();
  } catch { state.doctor = null; state.csrf = null; $("#doctorAuth").classList.remove("hidden"); $("#doctorDashboard").classList.add("hidden"); }
}

function renderDoctorPractices(items) {
  $("#doctorPractices").innerHTML = items.length ? items.map((item) => `<div class="result-item"><strong>${escapeHtml(item.departmentName)}</strong><p>${item.serviceDate} ${item.startTime}-${item.endTime}</p><p>${item.bookedCount}/${item.capacity} · ${item.status}</p><button class="secondary" data-practice-status="${item.practiceId}" data-next-status="${item.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE"}">${item.status === "ACTIVE" ? "停诊" : "恢复出诊"}</button></div>`).join("") : `<p class="muted">尚未发布出诊号源。</p>`;
  $$('[data-practice-status]').forEach((button) => button.onclick = async () => { await api(`/api/doctors/practices/${button.dataset.practiceStatus}/status`, { method: "PUT", body: JSON.stringify({ status: button.dataset.nextStatus }) }); toast("出诊状态已更新"); const practices = await api("/api/doctors/practices"); renderDoctorPractices(practices); });
}

async function refreshDoctorAppointments() {
  if (!state.doctor) return;
  const items = await api("/api/doctors/appointments");
  $("#doctorAppointments").innerHTML = items.length ? items.map((item) => `<div class="result-item"><strong>${escapeHtml(item.patient.fullName)} · ${item.patient.age}岁</strong><p>${escapeHtml(item.departmentName)}　${item.serviceDate}　${item.startTime}-${item.endTime}</p><p>状态：${item.status}　排队号：${item.queueNumber}</p><div class="actions"><button data-record="${item.appointmentId}">查看病历</button>${item.status === "CHECKED_IN" ? `<button data-transition="${item.appointmentId}" data-action="CALL">进入候诊</button>` : ""}${item.status === "WAITING" ? `<button data-transition="${item.appointmentId}" data-action="START">开始接诊</button>` : ""}${item.status === "IN_CONSULTATION" ? `<button data-transition="${item.appointmentId}" data-action="COMPLETE">完成接诊</button>` : ""}</div></div>`).join("") : `<p class="muted">当前没有挂到您号源的患者。</p>`;
  $$('[data-record]').forEach((button) => button.onclick = () => openRecord(button.dataset.record));
  $$('[data-transition]').forEach((button) => button.onclick = async () => { await api(`/api/doctors/appointments/${button.dataset.transition}/transition`, { method: "POST", body: JSON.stringify({ action: button.dataset.action }) }); toast("就诊状态已更新"); refreshDoctorAppointments(); });
}

async function openRecord(appointmentId) {
  state.record = await api(`/api/doctors/appointments/${appointmentId}/record`);
  $("#recordEditor").classList.remove("hidden");
  $("#patientStatements").innerHTML = `<h3>患者主动表达（不可修改）</h3>${state.record.patientStatements.length ? state.record.patientStatements.map((item) => `<div class="statement"><strong>患者自述 · 未经医生核验</strong><p>${escapeHtml(item.patientWords)}</p><small>${new Date(item.createdAt).toLocaleString()}</small></div>`).join("") : `<p class="muted">暂无患者主动表达。</p>`}`;
  const form = $("#recordForm");
  for (const [key, value] of Object.entries(state.record.doctorContent)) if (form.elements[key]) form.elements[key].value = value;
  $("#recordOrders").innerHTML = state.record.orders.length ? state.record.orders.map((item) => `<div class="result-item"><strong>${escapeHtml(item.title)} · ${item.orderType}</strong><p>${escapeHtml(item.details)}</p>${item.bill ? `<p class="notice">账单 ${item.bill.status}：¥${(item.bill.amountCents / 100).toFixed(2)}。${escapeHtml(item.bill.guidance)}</p>` : ""}${item.orderType === "EXAMINATION" ? `<button data-simulate="${item.orderId}">生成明确标记的模拟检查报告</button>` : ""}</div>`).join("") : `<p class="muted">暂无医嘱。</p>`;
  $$('[data-simulate]').forEach((button) => button.onclick = async () => { if (!confirm("这会生成明确标记为模拟、且不包含医学结论的演示结果。继续吗？")) return; const result = await api(`/api/doctors/orders/${button.dataset.simulate}/simulated-result`, { method: "POST", body: JSON.stringify({ objectType: "examination_report" }) }); toast(result.label); });
  $("#recordEditor").scrollIntoView({ behavior: "smooth" });
}

function setMapStatus(message, warning = false) {
  const status = $("#mapStatus");
  status.textContent = message;
  status.classList.toggle("warning", warning);
}

function supportsWebGl2() {
  try { return Boolean(document.createElement("canvas").getContext("webgl2")); }
  catch { return false; }
}

function resetMap() {
  window.clearTimeout(state.mapLoadTimer);
  state.mapLoadTimer = null;
  try { state.map?.dispose?.(); } catch (error) { console.warn("释放旧地图实例失败", error); }
  state.map = null;
  state.mapLoading = false;
  $("#fengmapContainer").replaceChildren();
}

async function initMap() {
  if (state.map || state.mapLoading) return;
  if (!window.fengmap?.FMMap) { setMapStatus("SDK 未加载，可使用地点搜索", true); return; }
  if (!state.config?.map?.sdkConfigured) { setMapStatus("缺少蜂鸟 SDK appName/key，可使用地点搜索", true); return; }
  if (!supportsWebGl2()) { setMapStatus("当前浏览器不支持 WebGL2，可使用地点搜索", true); return; }

  const mapId = String(state.config.map.mapId);
  const mapBaseUrl = new URL(`/map-data/${encodeURIComponent(mapId)}/`, window.location.origin).href;
  const mapFileUrl = new URL(`${encodeURIComponent(mapId)}.fmap`, mapBaseUrl).href;
  state.mapLoading = true;
  try {
    setMapStatus("正在校验地图资源");
    const mapResponse = await fetch(mapFileUrl, { method: "HEAD", credentials: "same-origin" });
    if (!mapResponse.ok) throw new Error(`地图文件不可用（HTTP ${mapResponse.status}）`);

    setMapStatus("地图资源已就绪，正在渲染");
    state.map = new window.fengmap.FMMap({
      container: $("#fengmapContainer"), appName: state.config.map.appName, key: state.config.map.webApiKey,
      mapID: mapId, mapURL: mapBaseUrl, mapURLAbsolute: true, themeID: "2001", preLoad: true,
    });
    state.mapLoadTimer = window.setTimeout(() => {
      setMapStatus("地图渲染超时，请检查网络或 APIKey 域名授权后重试", true);
    }, 20_000);
    state.map.on("loaded", () => {
      window.clearTimeout(state.mapLoadTimer);
      state.mapLoadTimer = null;
      setMapStatus("地图已加载");
      try { new window.fengmap.FMToolbar({ position: window.fengmap.FMControlPosition.RIGHT_TOP, floorButtonCount: 5 }).addTo(state.map); } catch {}
    });
    state.map.on("info", (event) => {
      if (event?.message) {
        window.clearTimeout(state.mapLoadTimer);
        state.mapLoadTimer = null;
        setMapStatus(`地图提示：${event.message}`, true);
      }
    });
  } catch (error) {
    resetMap();
    setMapStatus(`${error.message || "地图加载失败"}，可使用地点搜索`, true);
    console.warn("院内地图初始化失败", error);
  } finally {
    state.mapLoading = false;
  }
}

async function init() {
  try {
    [state.config, state.departments] = await Promise.all([api("/api/config"), api("/api/departments")]);
    $("#adminSetupCard").classList.toggle("hidden", state.config.administratorInitialized);
    departmentOptions($("#patientDepartment")); departmentOptions($("#doctorDepartment"));
    const today = new Date().toISOString().slice(0, 10); $("#patientDate").value = today; $("#patientDate").min = today; $("#practiceForm").elements.serviceDate.value = today; $("#practiceForm").elements.serviceDate.min = today;
    await refreshPatient();
    await Promise.all([refreshConversation(), refreshJourney()]);
  } catch (error) { toast(`初始化失败：${error.message}`, true); }
}

$$("[data-view]").forEach((button) => button.onclick = () => setView(button.dataset.view));
$$("[data-quick-message]").forEach((button) => button.onclick = () => { $("#chatInput").value = button.dataset.quickMessage; $("#chatForm").requestSubmit(); });
$("#chatForm").onsubmit = async (event) => { event.preventDefault(); const input = $("#chatInput"); const message = input.value; input.value = ""; try { const result = await api("/api/agent/messages", { method: "POST", body: JSON.stringify({ message }) }); await refreshConversation(); toast(result.recordCapture); } catch (error) { input.value = message; toast(error.message, true); } };
$("#identityNumber").addEventListener("change", previewIdentity);
$("#identityNumber").addEventListener("blur", previewIdentity);
$("#profileForm").onsubmit = async (event) => { event.preventDefault(); const data = formObject(event.currentTarget); try { await api("/api/patient/profile", { method: "POST", body: JSON.stringify({ fullName: data.fullName, identityNumber: data.identityNumber, manualEntry: true }) }); toast("本次就诊档案已建立"); await refreshPatient(); } catch (error) { toast(error.message, true); } };
$("#practiceSearchForm").onsubmit = async (event) => { event.preventDefault(); const data = formObject(event.currentTarget); try { await searchPractices(data.departmentId, data.date); } catch (error) { toast(error.message, true); } };
$("#refreshJourney").onclick = () => refreshJourney().catch((error) => toast(error.message, true));
$("#reloadMap").onclick = () => { resetMap(); initMap(); };
$("#locationSearchForm").onsubmit = async (event) => { event.preventDefault(); try { const results = await api(`/api/locations?q=${encodeURIComponent($("#locationQuery").value)}`); $("#locationResults").innerHTML = results.length ? results.map((item) => `<div class="result-item"><strong>${escapeHtml(item.canonicalName ?? item.mapLabel ?? "地点")}</strong><p>${escapeHtml(item.floorLabel ?? "楼层待核对")} · ${escapeHtml(item.building ?? "院内")}</p><div class="actions"><button data-route-point="start" data-location-id="${escapeHtml(item.locationId)}" data-location-name="${escapeHtml(item.canonicalName ?? item.mapLabel)}">设为起点</button><button class="secondary" data-route-point="end" data-location-id="${escapeHtml(item.locationId)}" data-location-name="${escapeHtml(item.canonicalName ?? item.mapLabel)}">设为终点</button></div></div>`).join("") : `<p class="muted">未找到地点，请尝试科室全称或设施名称。</p>`; $$('[data-route-point]').forEach((button) => button.onclick = () => { const select = button.dataset.routePoint === "start" ? $("#routeStart") : $("#routeEnd"); select.innerHTML = `<option value="${escapeHtml(button.dataset.locationId)}">${escapeHtml(button.dataset.locationName)}</option>`; }); } catch (error) { toast(error.message, true); } };
$("#routeForm").onsubmit = async (event) => { event.preventDefault(); const data = formObject(event.currentTarget); try { const route = await api(`/api/routes?start=${encodeURIComponent(data.start)}&end=${encodeURIComponent(data.end)}`); $("#routeResult").innerHTML = route.status === "AVAILABLE" ? `<div class="result-item"><strong>静态路线</strong><ol>${route.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol><p class="notice">${escapeHtml(route.reason)}</p></div>` : `<p class="notice">无法生成可靠路线：${escapeHtml(route.reason)}</p>`; } catch (error) { toast(error.message, true); } };
$("#doctorRegisterForm").onsubmit = async (event) => { event.preventDefault(); try { const result = await api("/api/doctors/register", { method: "POST", body: JSON.stringify(formObject(event.currentTarget)) }); toast(`注册成功，状态：${result.accountStatus}。请等待管理员审核。`); event.currentTarget.reset(); } catch (error) { toast(error.message, true); } };
$("#doctorLoginForm").onsubmit = async (event) => { event.preventDefault(); try { const result = await api("/api/doctors/login", { method: "POST", body: JSON.stringify(formObject(event.currentTarget)) }); state.csrf = result.csrfToken; toast("登录成功"); await restoreDoctor(); event.currentTarget.reset(); } catch (error) { toast(error.message, true); } };
$("#doctorLogout").onclick = async () => { await api("/api/doctors/logout", { method: "POST", body: "{}" }); state.csrf = null; state.doctor = null; toast("已安全退出"); restoreDoctor(); };
$("#adminSetupForm").onsubmit = async (event) => { event.preventDefault(); try { await api("/api/administrators/setup", { method: "POST", body: JSON.stringify(formObject(event.currentTarget)) }); state.config.administratorInitialized = true; $("#adminSetupCard").classList.add("hidden"); toast("管理员初始化成功，请登录"); event.currentTarget.reset(); } catch (error) { toast(error.message, true); } };
$("#adminLoginForm").onsubmit = async (event) => { event.preventDefault(); try { const result = await api("/api/administrators/login", { method: "POST", body: JSON.stringify(formObject(event.currentTarget)) }); state.adminCsrf = result.csrfToken; toast("管理员登录成功"); await restoreAdministrator(); event.currentTarget.reset(); } catch (error) { toast(error.message, true); } };
$("#adminLogout").onclick = async () => { await adminApi("/api/administrators/logout", { method: "POST", body: "{}" }); state.administrator = null; state.adminCsrf = null; toast("管理员已退出"); restoreAdministrator(); };
$("#refreshAdminDoctors").onclick = () => refreshAdminDoctors().catch((error) => toast(error.message, true));
$("#practiceForm").onsubmit = async (event) => { event.preventDefault(); const data = formObject(event.currentTarget); try { await api("/api/doctors/practices", { method: "POST", body: JSON.stringify({ ...data, capacity: Number(data.capacity) }) }); toast("号源已发布"); renderDoctorPractices(await api("/api/doctors/practices")); } catch (error) { toast(error.message, true); } };
$("#refreshDoctorAppointments").onclick = () => refreshDoctorAppointments().catch((error) => toast(error.message, true));
$("#recordForm").onsubmit = async (event) => { event.preventDefault(); const data = formObject(event.currentTarget); const changeReason = data.changeReason; delete data.changeReason; try { const result = await api(`/api/doctors/records/${state.record.recordId}`, { method: "PUT", body: JSON.stringify({ expectedVersion: state.record.version, content: data, changeReason }) }); state.record.version = result.version; toast(`病历已保存为版本 ${result.version}`); } catch (error) { toast(error.message, true); } };
$("#orderForm").onsubmit = async (event) => { event.preventDefault(); const data = formObject(event.currentTarget); try { await api(`/api/doctors/records/${state.record.recordId}/orders`, { method: "POST", body: JSON.stringify({ ...data, amountCents: Math.round(Number(data.amountYuan) * 100) }) }); toast("医嘱已创建；如有费用，账单保持待缴费"); await openRecord(state.record.appointmentId); } catch (error) { toast(error.message, true); } };

init();
