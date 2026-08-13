const state = { config: null, departments: [], patient: null, assistantActions: [], doctor: null, doctorOrderCatalog: null, csrf: null, administrator: null, adminCsrf: null, record: null, map: null, mapLoading: false, mapLoadTimer: null, mapReady: null, searchAnalyser: null, naviAnalyser: null, navigation: null, mapContext: null, currentPosition: null, agentStreaming: false, autoRead: localStorage.getItem("hospital-auto-read") !== "off", speechPlayer: null, Transcriber: null, transcriber: null };
const portal = document.body.dataset.portal ?? "patient";
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const identitySecrets = new WeakMap();

function escapeHtml(value) { const node = document.createElement("div"); node.textContent = String(value ?? ""); return node.innerHTML; }
function formObject(form) { return Object.fromEntries(new FormData(form).entries()); }
function maskedIdentityValue(input) { return identitySecrets.get(input) ?? ""; }
function setupMaskedIdentityInput(input, revealButton) {
  identitySecrets.set(input, "");
  let revealed = false; let revealTimer = null; let didReveal = false;
  const render = () => {
    const secret = maskedIdentityValue(input);
    input.value = revealed ? secret : "*".repeat(secret.length);
    input.setCustomValidity(secret.length === 18 ? "" : "请输入18位身份证号");
    input.setSelectionRange(input.value.length, input.value.length);
  };
  const replaceSelection = (replacement, deleteBackward = false) => {
    const secret = maskedIdentityValue(input);
    let start = input.selectionStart ?? secret.length; let end = input.selectionEnd ?? start;
    if (deleteBackward && start === end && start > 0) start -= 1;
    const next = `${secret.slice(0, start)}${replacement}${secret.slice(end)}`.replace(/[^0-9X]/gi, "").toUpperCase().slice(0, 18);
    identitySecrets.set(input, next); render();
  };
  input.addEventListener("beforeinput", (event) => {
    if (revealed) { event.preventDefault(); return; }
    if (event.inputType === "deleteContentBackward") { event.preventDefault(); replaceSelection("", true); }
    else if (event.inputType === "deleteContentForward") { event.preventDefault(); replaceSelection(""); }
    else if (event.inputType?.startsWith("insert") && event.data) { event.preventDefault(); replaceSelection(event.data); }
  });
  input.addEventListener("paste", (event) => { event.preventDefault(); if (!revealed) replaceSelection(event.clipboardData?.getData("text") ?? ""); });
  input.addEventListener("drop", (event) => event.preventDefault());
  input.addEventListener("input", () => {
    if (revealed) return;
    const visible = input.value.replace(/\*/g, "");
    if (visible) identitySecrets.set(input, `${maskedIdentityValue(input)}${visible}`.replace(/[^0-9X]/gi, "").toUpperCase().slice(0, 18));
    render();
  });
  const beginReveal = (event) => {
    event.preventDefault();
    clearTimeout(revealTimer);
    revealTimer = setTimeout(() => {
      revealed = true; didReveal = true; input.readOnly = true; revealButton.textContent = "松开立即隐藏";
      revealButton.classList.add("revealing"); render();
    }, 600);
  };
  const endReveal = () => {
    clearTimeout(revealTimer); revealTimer = null;
    if (!revealed) return;
    revealed = false; input.readOnly = false; revealButton.textContent = "长按查看";
    revealButton.classList.remove("revealing"); render();
  };
  revealButton.addEventListener("pointerdown", beginReveal);
  for (const eventName of ["pointerup", "pointercancel", "pointerleave", "blur"]) revealButton.addEventListener(eventName, endReveal);
  revealButton.addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key) && !event.repeat) beginReveal(event); });
  revealButton.addEventListener("keyup", endReveal);
  revealButton.addEventListener("contextmenu", (event) => event.preventDefault());
  revealButton.addEventListener("click", (event) => {
    event.preventDefault();
    if (didReveal) { didReveal = false; return; }
    toast("请长按按钮查看，松开后会立即隐藏");
  });
  render();
  return { getValue: () => maskedIdentityValue(input), clear: () => { identitySecrets.set(input, ""); endReveal(); render(); } };
}
function reportMissingElement(selector) { console.warn(JSON.stringify({ event: "ui_element_missing", selector, path: location.pathname })); }
function bindEvent(selector, eventName, handler) {
  const node = $(selector);
  // Portal pages intentionally omit controls owned by other identities.
  if (!node) return false;
  node.addEventListener(eventName, handler);
  return true;
}
function setHidden(selector, hidden) {
  const node = $(selector);
  if (!node) { reportMissingElement(selector); return false; }
  node.classList.toggle("hidden", hidden);
  return true;
}
function toast(message, error = false) {
  const node = $("#toast");
  if (!node) { reportMissingElement("#toast"); console[error ? "error" : "info"](message); return; }
  node.textContent = message; node.className = `toast${error ? " error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { if (node.isConnected) node.classList.add("hidden"); }, 4500);
}

function scrollConversationToLatest() {
  const container = $("#chatMessages");
  if (!container) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    container.lastElementChild?.scrollIntoView({ block: "end", behavior: "auto" });
    container.scrollTop = container.scrollHeight;
  }));
}

function updateSpeechControls() {
  const toggle = $("#autoReadToggle");
  const voice = $("#voiceInput");
  const speech = state.config?.speech ?? {};
  toggle.classList.toggle("speech-unavailable", !speech.synthesis);
  toggle.textContent = state.autoRead ? "🔊 自动朗读：开" : "🔇 自动朗读：关";
  toggle.setAttribute("aria-pressed", String(state.autoRead));
  voice.classList.toggle("speech-unavailable", !speech.transcription);
}

function setVoiceInputState(status, error) {
  const button = $("#voiceInput");
  button.classList.toggle("recording", status === "recording");
  button.classList.toggle("processing", ["connecting", "processing"].includes(status));
  button.setAttribute("aria-pressed", String(status === "recording"));
  button.disabled = ["connecting", "processing"].includes(status);
  button.textContent = status === "recording" ? "■ 停止" : (status === "processing" ? "识别中…" : (status === "connecting" ? "连接中…" : "🎙 语音"));
  button.setAttribute("aria-label", status === "recording" ? "停止语音输入" : "开始语音输入");
  if (status === "error" && error) toast(error.message, true);
}

async function readAssistantReply(text) {
  if (!state.autoRead || !state.config?.speech?.synthesis || !text) return;
  try { await state.speechPlayer.speak(text); }
  catch (error) { if (error.name !== "AbortError") toast(`自动朗读失败：${error.message}`, true); }
}
async function api(path, options = {}) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(state.csrf && !["GET", undefined].includes(options.method) ? { "X-CSRF-Token": state.csrf } : {}), ...options.headers };
  const response = await fetch(path, { credentials: "same-origin", ...options, headers });
  const payload = await response.json().catch(() => ({ success: false, error: { message: "服务器返回格式无效" } }));
  if (!response.ok || !payload.success) throw new Error(payload.error?.message ?? "操作失败");
  return payload.data;
}

async function streamAgentMessage(message, assistantNode) {
  const response = await fetch("/api/agent/messages/stream", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message }) });
  if (!response.ok || !response.body) throw new Error("无法建立回复流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = null;
  let actions = [];
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      let eventName = "message"; let dataText = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) eventName = line.slice(7);
        if (line.startsWith("data: ")) dataText += line.slice(6);
      }
      if (!dataText) continue;
      const data = JSON.parse(dataText);
      if (eventName === "assistant.delta") { assistantNode.textContent += data.delta; assistantNode.removeAttribute("data-loading"); }
      else if (eventName === "assistant.completed") completed = data;
      else if (eventName === "assistant.actions") actions = data.actions ?? [];
      else if (eventName === "error") throw new Error(data.message ?? "回复失败");
    }
    if (done) break;
  }
  return { completed, actions };
}

async function adminApi(path, options = {}) {
  return api(path, { ...options, headers: { ...(options.headers ?? {}), ...(state.adminCsrf && !["GET", undefined].includes(options.method) ? { "X-CSRF-Token": state.adminCsrf } : {}) } });
}

async function restoreAdministrator() {
  try {
    const data = await api("/api/administrators/me");
    state.administrator = data.administrator; state.adminCsrf = data.csrfToken;
    setHidden("#adminAuth", true); setHidden("#adminDashboard", false);
    $("#adminWelcome").textContent = `${data.administrator.displayName} 管理员工作台`;
    await refreshAdminDoctors();
  } catch {
    state.administrator = null; state.adminCsrf = null;
    setHidden("#adminAuth", false); setHidden("#adminDashboard", true);
  }
}

async function refreshAdminDoctors() {
  const doctors = await api("/api/administrators/doctors");
  $("#adminDoctors").innerHTML = doctors.length ? doctors.map((doctor) => `<div class="result-item"><strong>${escapeHtml(doctor.displayName)} · ${escapeHtml(doctor.employeeNumber)}</strong><p>状态：<span class="badge">${escapeHtml(doctor.accountStatus)}</span></p><div class="actions"><button data-review-doctor="${doctor.doctorId}" data-review-status="ACTIVE" ${doctor.accountStatus === "ACTIVE" ? "disabled" : ""}>激活</button><button class="danger" data-review-doctor="${doctor.doctorId}" data-review-status="SUSPENDED" ${doctor.accountStatus === "SUSPENDED" ? "disabled" : ""}>停用</button></div></div>`).join("") : `<p class="muted">暂无医生账号申请。</p>`;
  $$('[data-review-doctor]').forEach((button) => button.onclick = async () => { await adminApi(`/api/administrators/doctors/${button.dataset.reviewDoctor}/status`, { method: "PUT", body: JSON.stringify({ status: button.dataset.reviewStatus }) }); toast("医生账号状态已更新"); refreshAdminDoctors(); });
}

function initializeDoctorDepartmentIndex() {
  const divisionSelect = $("#doctorDepartmentDivision");
  const departmentSelect = $("#doctorDepartment");
  const departments = state.departments.filter((item) => item.bookingEligible);
  const divisions = [...new Set(departments.map((item) => item.division || "其他临床科室"))];
  divisionSelect.innerHTML = `<option value="">请选择科室大类</option>${divisions.map((division) => `<option value="${escapeHtml(division)}">${escapeHtml(division)}</option>`).join("")}`;
  divisionSelect.onchange = () => {
    const matches = departments.filter((item) => (item.division || "其他临床科室") === divisionSelect.value);
    departmentSelect.disabled = !divisionSelect.value;
    departmentSelect.innerHTML = divisionSelect.value
      ? `<option value="">请选择具体科室</option>${matches.map((item) => `<option value="${escapeHtml(item.departmentId)}">${escapeHtml(item.displayName)}</option>`).join("")}`
      : `<option value="">请先选择科室大类</option>`;
  };
}

async function refreshPatient() {
  state.patient = await api("/api/patient/me");
  setHidden("#endPatientSession", !state.patient.hasProfile);
}

async function refreshConversation(actions = null) {
  const messages = await api("/api/patient/messages");
  const container = $("#chatMessages");
  container.innerHTML = messages.length ? messages.map((item) => `<div class="message ${item.role}">${escapeHtml(item.message)}</div>`).join("") : `<div class="message AGENT">您好，我可以协助科室导诊、挂号、就诊状态、缴费指引和院内地点。请告诉我您的问题。</div>`;
  const latestAgentTurn = [...messages].reverse().find((item) => item.role === "AGENT");
  renderAssistantActions(actions ?? latestAgentTurn?.assistantActions ?? []);
  scrollConversationToLatest();
}

async function checkProactiveUpdate() {
  if (document.hidden) return;
  try {
    const update = await api("/api/patient/proactive-update");
    if (!update) return;
    if (update.eventType === "CALLED_NOTICE") {
      state.speechPlayer.stop();
      navigator.vibrate?.([300, 120, 300]);
      const dialog = $("#calledAlert");
      $("#calledAlertMessage").textContent = `${update.departmentName}正在叫号，您的排队号是 ${update.queueNumber}。${state.agentStreaming ? "当前回复会继续完成，请同时立即前往诊室。" : "请立即前往诊室。"}`;
      if (!dialog.open) dialog.showModal();
      state.assistantActions = update.assistantActions ?? [];
      return;
    }
    const container = $("#chatMessages");
    container.querySelectorAll(".assistant-action").forEach((node) => node.remove());
    const node = document.createElement("div"); node.className = "message AGENT proactive-message"; node.textContent = update.message;
    container.append(node);
    if (update.assistantActions?.length) renderAssistantActions(update.assistantActions);
    scrollConversationToLatest();
    readAssistantReply(update.message);
  } catch (error) { console.warn("主动消息检查失败", error); }
}

function journeyHtml(journey) {
  const parts = [];
  for (const item of journey.appointments) parts.push(`<div class="result-item"><strong>${escapeHtml(item.departmentName)} · ${escapeHtml(item.doctorName)}医生</strong><p>${item.serviceDate} ${item.startTime}-${item.endTime}</p><strong class="queue-number">排队号：${item.queueNumber}</strong><div class="actions">${item.status === "BOOKED" ? `<button data-check-in="${item.appointmentId}">到院报到</button><button class="danger" data-cancel="${item.appointmentId}">退号</button>` : item.status === "PENDING_PAYMENT" ? `<button class="danger" data-cancel="${item.appointmentId}">取消挂号</button>` : item.recordExportAvailable ? `<a class="button-link" href="/api/patient/appointments/${item.appointmentId}/record-export">导出病历</a>` : ""}</div></div>`);
  for (const bill of journey.bills.filter((item) => item.status === "UNPAID")) parts.push(`<div class="result-item"><strong>${escapeHtml(bill.title ?? "待缴项目")} · ¥${(bill.amountCents / 100).toFixed(2)}</strong><button data-pay-bill="${bill.billId}">模拟支付</button><small>不会产生真实扣款</small></div>`);
  for (const order of journey.orders ?? []) {
    const canNavigate = !order.billId || order.billStatus === "PAID";
    parts.push(`<div class="result-item"><strong>${escapeHtml(order.title)}${order.quantity > 1 ? ` × ${order.quantity}` : ""}</strong><p>${order.orderType === "EXAMINATION" ? "检查" : "取药"}${order.destination ? ` · ${escapeHtml(order.destination.floorLabel ?? "院内")}` : ""}</p>${canNavigate && order.destination ? `<button data-navigate-location="${escapeHtml(order.destination.canonicalName ?? order.destination.mapLabel)}">查看地点与路线</button>` : `<small>缴费后显示地点指引</small>`}</div>`);
  }
  for (const task of journey.tasks.filter((item) => item.status === "PENDING")) {
    const completionButton = ["EXAMINATION", "PHARMACY"].includes(task.taskType) ? `<button data-complete-task="${task.taskId}" data-task-type="${task.taskType}">${task.taskType === "EXAMINATION" ? "确认检查完成" : "确认已取药"}</button>` : "";
    const returnButton = task.taskType === "RETURN_VISIT" ? `<button data-return-check-in="${task.taskId}">回诊报到</button>` : "";
    parts.push(`<div class="result-item"><strong>下一步：${escapeHtml(task.title)}</strong>${task.scheduledAt ? `<p>${new Date(task.scheduledAt).toLocaleString("zh-CN")}</p>` : ""}<div class="actions">${completionButton}${returnButton}</div></div>`);
  }
  return parts.length ? parts.join("") : `<p class="muted">当前没有挂号、账单或下一步任务。</p>`;
}

function doctorResultsHtml(action) {
  if (!action.items?.length) return `<p class="muted">没有找到已收录的信息，请尝试医生姓名或科室名称。</p>`;
  return `<div class="result-list">${action.items.slice(0, 3).map((item) => `<div class="result-item"><strong>${escapeHtml(item.displayName)} · ${escapeHtml(item.professionalTitle ?? "职称未收录")}</strong><p>${escapeHtml(item.departmentName)}</p>${item.serviceDate ? `<p>${escapeHtml(item.serviceDate)} ${escapeHtml(item.startTime)}-${escapeHtml(item.endTime)}</p>` : ""}<small>${escapeHtml(item.notice)}</small></div>`).join("")}</div>`;
}

function practicesHtml(results, requiresProfile = !state.patient?.hasProfile, showEmpty = true) {
  if (!results.length) return showEmpty ? `<p class="muted">暂无号源，请更换日期或科室。</p>` : "";
  return results.slice(0, 4).map((item) => `<div class="result-item practice-item"><div><strong>${escapeHtml(item.doctorName)}医生</strong><p>${item.serviceDate} ${item.startTime}-${item.endTime} · 剩余 ${item.remaining}</p></div><button data-book="${item.practiceId}" ${item.remaining <= 0 || requiresProfile ? "disabled" : ""}>${requiresProfile ? "先填写信息" : item.remaining > 0 ? "挂号" : "已满"}</button></div>`).join("");
}

async function searchPractices(departmentId, date, resultsNode) {
  const results = await api(`/api/practices?departmentId=${encodeURIComponent(departmentId)}&date=${encodeURIComponent(date)}`);
  resultsNode.innerHTML = practicesHtml(results);
}

function bookingDepartments(departments = state.departments) {
  return departments.filter((item) => item.bookingEligible);
}

function departmentDivisionButtonsHtml(departments) {
  const divisions = [...new Set(departments.map((item) => item.division || "其他临床科室"))];
  return divisions.map((division) => `<button type="button" class="secondary department-menu-item" data-pick-division="${encodeURIComponent(division)}">${escapeHtml(division)}</button>`).join("");
}

function appointmentHtml(action) {
  const recommended = action.selectedDepartmentId ? action.departments.slice(0, 2) : [];
  const recommendedChoices = recommended.map((item) => `<button type="button" class="department-recommendation${item.departmentId === action.selectedDepartmentId ? " active" : ""}" data-pick-department="${escapeHtml(item.departmentId)}" data-department-name="${encodeURIComponent(item.displayName)}">${escapeHtml(item.displayName)}</button>`).join("");
  const entry = recommended.length
    ? `<div class="department-recommendation-row" aria-label="推荐科室">${recommendedChoices}<button type="button" class="secondary show-all-departments" data-open-department-picker>其他科室</button></div>`
    : `<button type="button" class="secondary department-picker-trigger" data-open-department-picker>选择科室</button>`;
  return `<form class="appointment-service-form"><div class="department-picker"><input type="hidden" name="departmentId" value="${escapeHtml(action.selectedDepartmentId ?? "")}">${entry}<div class="department-picker-menu hidden"><section data-picker-page="divisions"><div class="department-picker-head"><strong>科室大类</strong><button type="button" class="secondary department-picker-close" data-close-department-picker>关闭</button></div><div class="department-menu-list" data-division-menu-list></div></section><section class="hidden" data-picker-page="departments"><div class="department-picker-head"><button type="button" class="secondary department-picker-back" data-back-to-divisions>返回</button><strong data-selected-division></strong></div><div class="department-menu-list" data-department-menu-list></div></section></div></div><div class="appointment-search-row"><label><span class="sr-only">就诊日期</span><input name="date" type="date" aria-label="就诊日期" min="${action.date}" value="${action.date}" required></label><button type="submit">查询号源</button></div></form><div class="result-list practice-results">${practicesHtml(action.practices, action.requiresProfile, action.practices.length > 0)}</div>`;
}

function locationResultsHtml(results) {
  return results.length ? results.slice(0, 4).map((item) => `<div class="result-item"><strong>${escapeHtml(item.canonicalName ?? item.mapLabel ?? "地点")}</strong><p>${escapeHtml(item.floorLabel ?? "楼层待核对")} · ${escapeHtml(item.building ?? "院内")}</p><div class="actions"><button data-route-point="start" data-location-id="${escapeHtml(item.locationId)}" data-location-name="${escapeHtml(item.canonicalName ?? item.mapLabel)}">设为起点</button><button class="secondary" data-route-point="end" data-location-id="${escapeHtml(item.locationId)}" data-location-name="${escapeHtml(item.canonicalName ?? item.mapLabel)}">设为终点</button></div></div>`).join("") : `<p class="muted">输入科室、窗口或设施名称后搜索。</p>`;
}

function renderAssistantActions(actions = []) {
  state.assistantActions = actions;
  const container = $("#chatMessages");
  container.querySelectorAll(".assistant-action").forEach((node) => node.remove());
  for (const action of actions) {
    const wrapper = document.createElement("div");
    wrapper.className = "message AGENT assistant-action";
    wrapper.dataset.actionType = action.type;
    let body = "";
    if (action.type === "PATIENT_PROFILE_FORM") body = `<form class="form-grid patient-profile-form"><label>姓名<input name="fullName" autocomplete="name" required></label><label><span class="identity-label-row"><span>身份证号</span><button type="button" class="secondary identity-reveal-button">长按查看</button></span><input class="identity-mask-input" autocomplete="off" inputmode="text" maxlength="18" aria-label="身份证号" required></label><div class="actions"><button type="submit" class="create-profile-button">确认</button><button type="button" class="secondary use-virtual-profile">使用虚拟信息</button></div></form>`;
    else if (action.type === "APPOINTMENT_SERVICE") body = appointmentHtml(action);
    else if (action.type === "JOURNEY_STATUS") body = `<div class="result-list journey-results">${journeyHtml(action.journey)}</div><button type="button" class="secondary" data-refresh-journey>刷新状态</button>`;
    else if (action.type === "POST_VISIT_SERVICE") body = `<div class="result-list journey-results">${journeyHtml(action.journey)}</div><button type="button" class="secondary" data-refresh-journey>刷新诊后待办</button>`;
    else if (action.type === "LOCATION_SERVICE") body = `<button type="button" data-open-map-page data-map-query="${encodeURIComponent(action.query)}">打开院内地图</button>`;
    else if (action.type === "HUMAN_SERVICE") body = `<p>${escapeHtml(action.text)}</p>`;
    else if (action.type === "DOCTOR_RESULTS") body = doctorResultsHtml(action);
    else if (action.type === "CURRENT_TASK") body = `<p>${escapeHtml(action.text)}</p><div class="result-list journey-results">${journeyHtml(action.journey)}</div>`;
    else if (action.type === "MEDICAL_RECORD_EXPORT") body = `<p>${escapeHtml(action.text ?? "本次就医已完成，您可以导出病历摘要。")}</p><a class="button-link" href="/api/patient/appointments/${encodeURIComponent(action.appointmentId)}/record-export">导出病历</a>`;
    else if (action.type === "EMERGENCY_ASSISTANCE") body = `<p class="emergency-notice">${escapeHtml(action.text)}</p><small>呼叫编号：${escapeHtml(action.callId)}</small>`;
    else if (action.type === "UNDO_TURN_CONFIRMATION") body = `<p>${escapeHtml(action.summary)}</p><div class="actions"><button type="button" data-confirm-undo="${escapeHtml(action.actionId)}">确认撤销</button><button type="button" class="secondary" data-cancel-undo="${escapeHtml(action.actionId)}">保留当前状态</button></div>`;
    const toolStatus = action.status === "AWAITING_USER_INPUT" ? `<span class="badge">等待您填写</span>` : action.status === "AWAITING_USER_CONFIRMATION" ? `<span class="badge warning">等待确认</span>` : "";
    wrapper.innerHTML = `<div class="service-card"><div class="service-head"><strong>${escapeHtml(action.title)}</strong>${toolStatus}</div>${body}</div>`;
    container.append(wrapper);
    bindAssistantAction(wrapper, action);
  }
}

function bindAssistantAction(root, action) {
  const confirmUndo = root.querySelector("[data-confirm-undo]");
  if (confirmUndo) confirmUndo.onclick = async () => {
    try {
      await api(`/api/patient/conversation/undo/${confirmUndo.dataset.confirmUndo}/confirm`, { method: "POST", body: "{}" });
      await refreshConversation();
      toast("已撤销上一条输入，并恢复上一轮状态");
    } catch (error) { toast(error.message, true); }
  };
  const cancelUndo = root.querySelector("[data-cancel-undo]");
  if (cancelUndo) cancelUndo.onclick = async () => {
    try {
      await api(`/api/patient/conversation/undo/${cancelUndo.dataset.cancelUndo}/cancel`, { method: "POST", body: "{}" });
      await refreshConversation();
      toast("已保留当前状态");
    } catch (error) { toast(error.message, true); }
  };
  const profileForm = root.querySelector(".patient-profile-form");
  if (profileForm) {
    const identityController = setupMaskedIdentityInput(profileForm.querySelector(".identity-mask-input"), profileForm.querySelector(".identity-reveal-button"));
    profileForm.onsubmit = async (event) => {
      event.preventDefault();
      const data = formObject(profileForm);
      try {
        const identityNumber = identityController.getValue();
        if (identityNumber.length !== 18) throw new Error("请输入18位身份证号");
        await api("/api/patient/profile", { method: "POST", body: JSON.stringify({ fullName: data.fullName, identityNumber, manualEntry: true }) });
        identityController.clear();
        await refreshPatient();
        state.assistantActions = state.assistantActions.filter((item) => item.type !== "PATIENT_PROFILE_FORM").map((item) => item.type === "APPOINTMENT_SERVICE" ? { ...item, requiresProfile: false } : item);
        await refreshConversation(state.assistantActions);
        toast("就诊档案已建立");
      } catch (error) { toast(error.message, true); }
    };
    root.querySelector(".use-virtual-profile").onclick = async () => {
      try {
        const result = await api("/api/patient/profile/virtual", { method: "POST", body: "{}" });
        identityController.clear();
        await refreshPatient();
        state.assistantActions = state.assistantActions.filter((item) => item.type !== "PATIENT_PROFILE_FORM").map((item) => item.type === "APPOINTMENT_SERVICE" ? { ...item, requiresProfile: false } : item);
        await refreshConversation(state.assistantActions);
        toast(result.virtualTestProfile ? "已使用65岁男性虚拟身份" : "就诊档案已建立");
      } catch (error) { toast(error.message, true); }
    };
  }
  const appointmentForm = root.querySelector(".appointment-service-form");
  const departmentPicker = root.querySelector(".department-picker");
  if (appointmentForm && departmentPicker) {
    const menu = departmentPicker.querySelector(".department-picker-menu");
    const divisionsPage = departmentPicker.querySelector('[data-picker-page="divisions"]');
    const departmentsPage = departmentPicker.querySelector('[data-picker-page="departments"]');
    const departmentInput = appointmentForm.elements.departmentId;
    const divisionList = departmentPicker.querySelector("[data-division-menu-list]");
    let allBookingDepartments = [];
    const showPage = (name) => {
      divisionsPage.classList.toggle("hidden", name !== "divisions");
      departmentsPage.classList.toggle("hidden", name !== "departments");
    };
    const openPicker = async () => {
      showPage("divisions");
      menu.classList.remove("hidden");
      divisionList.innerHTML = `<span class="muted">正在加载部门…</span>`;
      try {
        allBookingDepartments = await api("/api/departments?bookingEligible=true&limit=100");
        divisionList.innerHTML = departmentDivisionButtonsHtml(allBookingDepartments) || `<span class="muted">暂无可挂号部门</span>`;
      } catch (error) {
        divisionList.innerHTML = `<span class="notice">部门加载失败，请稍后重试。</span>`;
        toast(error.message, true);
      }
    };
    const selectDepartment = (departmentId, departmentName) => {
      departmentInput.value = departmentId;
      const trigger = departmentPicker.querySelector(".department-picker-trigger");
      if (trigger) trigger.textContent = departmentName;
      const recommendedButton = [...departmentPicker.querySelectorAll(".department-recommendation")].find((button) => button.dataset.pickDepartment === departmentId);
      const otherButton = departmentPicker.querySelector(".show-all-departments");
      departmentPicker.querySelectorAll("[data-pick-department]").forEach((button) => button.classList.toggle("active", button === recommendedButton));
      if (otherButton) {
        otherButton.textContent = recommendedButton ? "其他科室" : departmentName;
        otherButton.classList.toggle("department-recommendation", !recommendedButton);
        otherButton.classList.toggle("active", !recommendedButton);
      }
      menu.classList.add("hidden");
      root.querySelector(".practice-results").replaceChildren();
    };
    departmentPicker.addEventListener("click", async (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.hasAttribute("data-open-department-picker")) openPicker();
      else if (button.hasAttribute("data-close-department-picker")) menu.classList.add("hidden");
      else if (button.hasAttribute("data-back-to-divisions")) showPage("divisions");
      else if (button.dataset.pickDivision) {
        const division = decodeURIComponent(button.dataset.pickDivision);
        const matches = allBookingDepartments.filter((item) => (item.division || "其他临床科室") === division);
        departmentPicker.querySelector("[data-selected-division]").textContent = division;
        departmentPicker.querySelector("[data-department-menu-list]").innerHTML = matches.map((item) => `<button type="button" class="secondary department-menu-item" data-pick-department="${escapeHtml(item.departmentId)}" data-department-name="${encodeURIComponent(item.displayName)}">${escapeHtml(item.displayName)}</button>`).join("");
        showPage("departments");
      } else if (button.dataset.pickDepartment) selectDepartment(button.dataset.pickDepartment, decodeURIComponent(button.dataset.departmentName));
    });
  }
  if (appointmentForm) appointmentForm.onsubmit = async (event) => {
    event.preventDefault();
    const data = formObject(appointmentForm);
    try {
      if (!data.departmentId) throw new Error("请选择科室");
      await searchPractices(data.departmentId, data.date, root.querySelector(".practice-results"));
    }
    catch (error) { toast(error.message, true); }
  };
  root.onclick = async (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    try {
      if (button.dataset.book) {
        const pending = await api("/api/patient/actions", { method: "POST", body: JSON.stringify({ actionType: "CREATE_APPOINTMENT", parameters: { practiceId: button.dataset.book } }) });
        if (pending.status === "EXISTING_APPOINTMENT") {
          state.assistantActions = [{ type: "JOURNEY_STATUS", tool: "get_patient_journey", title: "已有挂号", journey: pending.journey }];
          await refreshConversation(state.assistantActions);
          toast("您已经有有效挂号");
          return;
        }
        if (!confirm(pending.summary)) return;
        await api(`/api/patient/actions/${pending.actionId}/confirm`, { method: "POST", body: "{}" });
        const journey = await api("/api/patient/journey");
        state.assistantActions = [{ type: "JOURNEY_STATUS", tool: "get_patient_journey", title: "挂号成功，查看就诊安排", journey }];
        await refreshConversation(state.assistantActions); toast("挂号成功");
      } else if (button.dataset.checkIn) {
        if (!confirm("确认已经到院并完成报到吗？报到后将进入候诊队列。")) return;
        await api(`/api/appointments/${button.dataset.checkIn}/check-in`, { method: "POST", body: "{}" }); button.closest(".journey-results").innerHTML = journeyHtml(await api("/api/patient/journey")); toast("报到成功");
      } else if (button.dataset.cancel) {
        const pending = await api("/api/patient/actions", { method: "POST", body: JSON.stringify({ actionType: "CANCEL_APPOINTMENT", parameters: { appointmentId: button.dataset.cancel } }) });
        if (!confirm(pending.summary)) return;
        await api(`/api/patient/actions/${pending.actionId}/confirm`, { method: "POST", body: "{}" }); button.closest(".journey-results").innerHTML = journeyHtml(await api("/api/patient/journey")); toast("退号成功");
      } else if (button.dataset.payBill) {
        if (!confirm("这是模拟支付，不会产生真实扣款。确认完成支付吗？")) return;
        const payment = await api(`/api/patient/bills/${button.dataset.payBill}/simulated-payment`, { method: "POST", body: "{}" });
        root.querySelector(".journey-results").innerHTML = journeyHtml(await api("/api/patient/journey")); toast(payment.simulationNotice);
      } else if (button.dataset.completeTask) {
        const label = button.dataset.taskType === "EXAMINATION" ? "检查" : "取药";
        if (!confirm(`确认已经完成${label}吗？`)) return;
        const result = await api(`/api/patient/tasks/${button.dataset.completeTask}/complete`, { method: "POST", body: "{}" });
        root.querySelector(".journey-results").innerHTML = journeyHtml(await api("/api/patient/journey"));
        toast(result.completion?.completed ? "本次就医已全部完成" : `${label}状态已更新`);
        checkProactiveUpdate();
      } else if (button.dataset.returnCheckIn) {
        await api(`/api/patient/return-visits/${button.dataset.returnCheckIn}/check-in`, { method: "POST", body: "{}" });
        root.querySelector(".journey-results").innerHTML = journeyHtml(await api("/api/patient/journey")); toast("回诊报到成功，请留意叫号");
      } else if (button.dataset.navigateLocation) {
        await openMapPage(button.dataset.navigateLocation);
      } else if (button.hasAttribute("data-refresh-journey")) root.querySelector(".journey-results").innerHTML = journeyHtml(await api("/api/patient/journey"));
      else if (button.hasAttribute("data-open-map-page")) { await openMapPage(decodeURIComponent(button.dataset.mapQuery)); }
    } catch (error) { toast(error.message, true); }
  };
}

function resetDoctorRecordWorkspace() {
  state.record = null;
  const editor = $("#recordEditor");
  if (!editor) return;
  editor.classList.add("hidden");
  editor.setAttribute("aria-hidden", "true");
  $("#recordForm")?.reset();
  $("#orderForm")?.reset();
  $("#recordOrders")?.replaceChildren();
  const count = $("#orderCount");
  if (count) count.textContent = "0 项";
  editor.querySelector(".record-lock-notice")?.remove();
  editor.querySelector(".virtual-profile-notice")?.remove();
  for (const label of editor.querySelectorAll("label.agent-prefilled")) label.classList.remove("agent-prefilled");
}

async function restoreDoctor() {
  resetDoctorRecordWorkspace();
  try {
    const [data, orderCatalog] = await Promise.all([api("/api/doctors/me"), api("/api/doctors/order-catalog")]);
    state.doctor = data.doctor; state.csrf = data.csrfToken;
    state.doctorOrderCatalog = orderCatalog;
    setHidden("#doctorAuth", true); setHidden("#doctorDashboard", false);
    $("#doctorWelcome").textContent = `${state.doctor.displayName}医生`;
    $("#doctorNotice").textContent = state.doctor.verificationNotice;
    renderDoctorPractices(data.practices); refreshDoctorAppointments();
    populateOrderCatalog();
  } catch { state.doctor = null; state.doctorOrderCatalog = null; state.csrf = null; setHidden("#doctorAuth", false); setHidden("#doctorDashboard", true); }
}

function populateOrderCatalog() {
  const form = $("#orderForm");
  if (!form || !state.doctorOrderCatalog) return;
  const typeField = form.elements?.namedItem("orderType");
  const catalogField = form.elements?.namedItem("catalogItemId");
  if (!typeField || !catalogField) return;
  const type = typeField.value;
  const items = type === "EXAMINATION" ? state.doctorOrderCatalog.examinations : state.doctorOrderCatalog.medications;
  catalogField.innerHTML = `<option value="">请选择${type === "EXAMINATION" ? "检查" : "药品"}</option>${items.map((item) => `<option value="${escapeHtml(item.catalogItemId)}">${escapeHtml(item.name)} · ¥${(item.amountCents / 100).toFixed(2)}</option>`).join("")}`;
  const notice = $("#orderCatalogNotice");
  if (notice) notice.textContent = state.doctorOrderCatalog.notice;
  const submit = $("#orderSubmitButton");
  if (submit) submit.textContent = `添加${type === "EXAMINATION" ? "检查" : "处方"}`;
}

function renderDoctorPractices(items) {
  $("#doctorPractices").innerHTML = items.length ? items.map((item) => `<div class="result-item"><strong>${escapeHtml(item.departmentName)}</strong><p>${item.serviceDate} ${item.startTime}-${item.endTime}</p><p>${item.bookedCount}/${item.capacity} · ${item.status}</p><button class="secondary" data-practice-status="${item.practiceId}" data-next-status="${item.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE"}">${item.status === "ACTIVE" ? "停诊" : "恢复出诊"}</button></div>`).join("") : `<p class="muted">尚未发布出诊号源。</p>`;
  $$('[data-practice-status]').forEach((button) => button.onclick = async () => { await api(`/api/doctors/practices/${button.dataset.practiceStatus}/status`, { method: "PUT", body: JSON.stringify({ status: button.dataset.nextStatus }) }); toast("出诊状态已更新"); const practices = await api("/api/doctors/practices"); renderDoctorPractices(practices); });
}

async function refreshDoctorAppointments() {
  if (!state.doctor) return;
  const items = await api("/api/doctors/appointments");
  if (state.record && !items.some((item) => item.appointmentId === state.record.appointmentId)) resetDoctorRecordWorkspace();
  $("#doctorAppointments").innerHTML = items.length ? items.map((item) => `<div class="result-item"><strong>${escapeHtml(item.patient.fullName)} · ${item.patient.age}岁 ${item.patient.virtualTestProfile ? `<span class="badge warning">虚拟测试身份</span>` : ""}</strong><p>${escapeHtml(item.departmentName)}　${item.serviceDate}　${item.startTime}-${item.endTime}</p><p>状态：${item.status}　排队号：${item.queueNumber}${item.currentRound ? `　${item.currentRound.roundType === "RETURN" ? `第${item.currentRound.roundNumber}轮回诊` : "初诊"}` : ""}</p><div class="actions"><button data-record="${item.appointmentId}" aria-controls="recordEditor">查看病历</button>${item.status === "CHECKED_IN" ? `<button data-transition="${item.appointmentId}" data-action="CALL">叫号</button>` : ""}${item.status === "CALLED" ? `<button data-transition="${item.appointmentId}" data-action="START">开始接诊</button>` : ""}${item.status === "IN_CONSULTATION" ? `<button data-transition="${item.appointmentId}" data-action="COMPLETE" data-return-required="${item.requiresReturnVisit ? "true" : "false"}">结束本轮接诊</button>` : ""}</div></div>`).join("") : `<p class="muted">当前没有挂到您号源的患者。</p>`;
  $$('[data-record]').forEach((button) => button.onclick = () => openRecord(button.dataset.record));
  $$('[data-transition]').forEach((button) => button.onclick = async () => {
    const appointmentId = button.dataset.transition;
    let body = { action: button.dataset.action };
    if (button.dataset.action === "COMPLETE") {
      const examinationRequired = button.dataset.returnRequired === "true";
      const needsReturn = examinationRequired || confirm("本轮接诊是否需要安排回诊？\n选择“确定”安排回诊，选择“取消”表示无需回诊。");
      const defaultTime = new Date(Date.now() + 120_000);
      defaultTime.setMinutes(defaultTime.getMinutes() - defaultTime.getTimezoneOffset());
      let returnVisitAt = null;
      if (needsReturn) {
        const entered = prompt(examinationRequired ? "本轮已开具检查，必须安排回诊。请输入回诊时间：" : "请输入回诊时间：", defaultTime.toISOString().slice(0, 16));
        if (!entered) return;
        returnVisitAt = new Date(entered).toISOString();
      }
      body = { action: "COMPLETE", returnVisitRequired: needsReturn, returnVisitAt };
    }
    await api(`/api/doctors/appointments/${appointmentId}/transition`, { method: "POST", body: JSON.stringify(body) });
    toast("就诊状态已更新");
    await refreshDoctorAppointments();
    if (state.record?.appointmentId === appointmentId) await openRecord(appointmentId);
  });
}

async function openRecord(appointmentId) {
  state.record = await api(`/api/doctors/appointments/${appointmentId}/record`);
  const editor = $("#recordEditor");
  const form = $("#recordForm");
  const orderForm = $("#orderForm");
  if (!editor || !form || !orderForm) {
    toast("医生工作台资源版本不一致，请强制刷新页面后重试", true);
    return;
  }
  editor.classList.remove("hidden");
  editor.setAttribute("aria-hidden", "false");
  $(".virtual-profile-notice")?.remove();
  if (state.record.patient.virtualTestProfile) $("#recordEditor .section-head").insertAdjacentHTML("afterend", `<p class="notice virtual-profile-notice">当前患者使用65岁男性虚拟测试身份，不对应真实个人。</p>`);
  for (const label of form.querySelectorAll("label.agent-prefilled")) label.classList.remove("agent-prefilled");
  for (const [key, value] of Object.entries(state.record.recordDraft ?? state.record.doctorContent)) {
    if (!form.elements[key]) continue;
    form.elements[key].value = value;
    if (state.record.agentPrefilledFields?.includes(key)) form.elements[key].closest("label")?.classList.add("agent-prefilled");
  }
  const locked = ["COMPLETED", "CANCELLED"].includes(state.record.appointmentStatus);
  for (const element of form.elements) element.disabled = locked;
  $(".record-lock-notice")?.remove();
  if (locked) form.insertAdjacentHTML("beforebegin", `<p class="notice record-lock-notice">本次就诊已完成，病历已锁定为只读。</p>`);
  const orderAllowed = state.record.appointmentStatus === "IN_CONSULTATION";
  for (const element of orderForm.elements) element.disabled = !orderAllowed;
  populateOrderCatalog();
  renderRecordOrders();
  $("#recordEditor").scrollIntoView({ behavior: "smooth" });
}

function renderRecordOrders() {
  const root = $("#recordOrders");
  if (!root || !state.record) return;
  const orders = state.record.orders ?? [];
  const count = $("#orderCount");
  if (count) count.textContent = `${orders.filter((item) => item.status !== "REVOKED").length} 项`;
  if (!orders.length) { root.innerHTML = `<p class="muted">暂无检查或处方。</p>`; return; }
  const locked = ["COMPLETED", "CANCELLED"].includes(state.record.appointmentStatus);
  const sections = [
    { type: "EXAMINATION", title: "检查" },
    { type: "PRESCRIPTION", title: "处方" },
  ];
  root.innerHTML = sections.map((section) => {
    const items = orders.filter((item) => item.orderType === section.type);
    if (!items.length) return "";
    return `<section class="order-group"><h4>${section.title}<span>${items.length}</span></h4>${items.map((item) => {
      const revoked = item.status === "REVOKED";
      const paid = item.bill?.status === "PAID";
      const canRevoke = !locked && !revoked && !paid;
      return `<article class="order-item${revoked ? " revoked" : ""}"><div class="order-item-head"><strong>${escapeHtml(item.title)}${item.quantity > 1 ? ` × ${item.quantity}` : ""}</strong><span class="badge${revoked ? " warning" : ""}">${revoked ? "已撤销" : "有效"}</span></div>${item.details ? `<p>${escapeHtml(item.details)}</p>` : ""}<div class="order-meta">${item.location ? `<span>${escapeHtml(item.location.canonicalName)} · ${escapeHtml(item.location.floorLabel ?? "院内")}</span>` : ""}${item.bill ? `<span>${paid ? "已支付" : "待支付"} ¥${(item.bill.amountCents / 100).toFixed(2)}</span>` : ""}</div>${!revoked ? `<div class="actions">${item.orderType === "EXAMINATION" ? `<button class="secondary" data-simulate="${item.orderId}">生成模拟报告</button>` : ""}${canRevoke ? `<button class="danger" data-revoke-order="${item.orderId}">撤销</button>` : paid && !locked ? `<span class="muted">已支付，需退款后撤销</span>` : ""}</div>` : ""}</article>`;
    }).join("")}</section>`;
  }).join("");
  root.querySelectorAll("[data-simulate]").forEach((button) => button.onclick = async () => {
    if (!confirm("这会生成明确标记为模拟、且不包含医学结论的演示结果。继续吗？")) return;
    try {
      const result = await api(`/api/doctors/orders/${button.dataset.simulate}/simulated-result`, { method: "POST", body: JSON.stringify({ objectType: "examination_report" }) });
      toast(result.label);
    } catch (error) { toast(error.message, true); }
  });
  root.querySelectorAll("[data-revoke-order]").forEach((button) => button.onclick = async () => {
    if (!confirm("撤销后，患者将不再看到该项目，未支付账单和对应待办也会移除。确认撤销吗？")) return;
    try {
      await api(`/api/doctors/orders/${button.dataset.revokeOrder}/revoke`, { method: "POST", body: "{}" });
      toast("医嘱已撤销");
      await refreshRecordOrders();
    } catch (error) { toast(error.message, true); }
  });
}

async function refreshRecordOrders() {
  if (!state.record?.appointmentId) return;
  state.record = await api(`/api/doctors/appointments/${state.record.appointmentId}/record`);
  renderRecordOrders();
}

function setMapStatus(message, warning = false, root = document) {
  const status = root.querySelector(".map-status");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("warning", warning);
}

function supportsWebGl2() {
  try { return Boolean(document.createElement("canvas").getContext("webgl2")); }
  catch { return false; }
}

function applyTopDownMapView(animate = false) {
  if (!state.map || !window.fengmap?.FMViewMode) return;
  state.map.setViewMode({ mode: window.fengmap.FMViewMode.MODE_2D, animate });
  state.map.setTilt({ tilt: 0, animate });
  state.map.setRotation({ rotation: 0, animate });
  const interactions = state.map.getInteractions?.();
  if (interactions) {
    interactions.enableDrag = true;
    interactions.enableZoom = true;
    interactions.enableRotate = false;
    interactions.enableTilt = false;
  }
}

function resetMap() {
  window.clearTimeout(state.mapLoadTimer);
  state.mapLoadTimer = null;
  try { state.navigation?.dispose?.(); } catch (error) { console.warn("释放导航实例失败", error); }
  try { state.searchAnalyser?.dispose?.(); } catch (error) { console.warn("释放搜索分析器失败", error); }
  try { state.naviAnalyser?.dispose?.(); } catch (error) { console.warn("释放路径分析器失败", error); }
  try { state.map?.dispose?.(); } catch (error) { console.warn("释放旧地图实例失败", error); }
  state.map = null; state.mapReady = null; state.searchAnalyser = null; state.naviAnalyser = null; state.navigation = null;
  state.mapLoading = false;
  $("#hospitalMap")?.replaceChildren();
}

async function initMap(root) {
  if (state.mapReady) return state.mapReady;
  if (!window.fengmap?.FMMap) { setMapStatus("SDK 未加载，可使用地点搜索", true, root); return; }
  if (!state.config?.map?.sdkConfigured) { setMapStatus("缺少蜂鸟 SDK appName/key，可使用地点搜索", true, root); return; }
  if (!supportsWebGl2()) { setMapStatus("当前浏览器不支持 WebGL2，可使用地点搜索", true, root); return; }

  const mapId = String(state.config.map.mapId);
  state.mapLoading = true;
  let resolveReady; let rejectReady;
  state.mapReady = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  try {
    setMapStatus("正在从蜂鸟地图加载院内地图", false, root);
    state.map = new window.fengmap.FMMap({
      container: $("#hospitalMap"), appName: state.config.map.appName, key: state.config.map.webApiKey,
      mapID: mapId, tile: false, preLoad: true,
    });
    state.mapLoadTimer = window.setTimeout(() => {
      setMapStatus("地图渲染超时，请检查网络或蜂鸟 APIKey 域名授权后重试", true, root);
      rejectReady(new Error("地图加载超时"));
    }, 30_000);
    state.map.on("loaded", () => {
      window.clearTimeout(state.mapLoadTimer);
      state.mapLoadTimer = null;
      try { state.map.setFitView(state.map.bound, { animate: false }); } catch (error) { console.warn("地图视图自适应失败", error); }
      try { applyTopDownMapView(false); } catch (error) { console.warn("地图俯视视角设置失败", error); }
      setMapStatus("地图已加载", false, root);
      try { new window.fengmap.FMToolbar({ position: window.fengmap.FMControlPosition.RIGHT_TOP, floorButtonCount: 5, viewModeControl: false }).addTo(state.map); } catch {}
      resolveReady(state.map);
    });
    state.map.on("info", (event) => {
      if (event?.message) {
        window.clearTimeout(state.mapLoadTimer);
        state.mapLoadTimer = null;
        setMapStatus(`地图提示：${event.message}`, true, root);
      }
    });
  } catch (error) {
    rejectReady(error);
    resetMap();
    setMapStatus(`${error.message || "地图加载失败"}，可使用地点搜索`, true, root);
    console.warn("院内地图初始化失败", error);
  } finally {
    state.mapLoading = false;
  }
  return state.mapReady;
}

function createFengmapAnalyser(Constructor, options) {
  return new Promise((resolve, reject) => {
    let analyser;
    analyser = new Constructor(options, () => resolve(analyser), (error) => reject(new Error(`地图分析器初始化失败：${error ?? "未知错误"}`)));
  });
}

async function ensureNavigationAnalysers() {
  await initMap(document);
  const fm = window.fengmap;
  if (!fm?.FMSearchAnalyser || !fm?.FMNaviWalkAnalyser || !fm?.FMNavigationWalk) throw new Error("院内导航组件未加载");
  state.searchAnalyser ??= await createFengmapAnalyser(fm.FMSearchAnalyser, { map: state.map, tile: false });
  state.naviAnalyser ??= await createFengmapAnalyser(fm.FMNaviWalkAnalyser, { map: state.map, tile: false });
  state.navigation ??= new fm.FMNavigationWalk({ map: state.map, analyser: state.naviAnalyser, naviLanguage: fm.FMLanguageType?.ZH, linePassed: false });
  return state.navigation;
}

async function resolveMapFeature(location) {
  await ensureNavigationAnalysers();
  const fm = window.fengmap;
  const request = new fm.FMSearchRequest();
  request.type = fm.FMType.MODEL | fm.FMType.FACILITY | fm.FMType.LABEL;
  request.addCondition({ FID: [String(location.mapFeatureId)] });
  const results = await new Promise((resolve, reject) => state.searchAnalyser.query(request, (...args) => {
    resolve(args.find((item) => Array.isArray(item)) ?? []);
  }, (error) => reject(new Error(`地图地点查询失败：${error ?? "未知错误"}`))));
  const match = results.find((item) => String(item.FID) === String(location.mapFeatureId)) ?? results[0];
  if (!match?.center) throw new Error(`地图上未找到“${location.canonicalName}”的精确位置`);
  return { x: match.center.x, y: match.center.y, level: match.level, buildingID: match.buildingID };
}

function navigationInstructions(result, fallbackSteps) {
  const instructions = (result?.subs ?? []).map((item) => item.instruction?.zh).filter(Boolean);
  return [...new Set(instructions)].slice(0, 3).length ? [...new Set(instructions)].slice(0, 3) : fallbackSteps.slice(0, 3);
}

async function drawIndoorRoute(route, barrierFree) {
  const navigation = await ensureNavigationAnalysers();
  const [start, end] = await Promise.all([resolveMapFeature(route.locations.start), resolveMapFeature(route.locations.end)]);
  navigation.clearAll();
  navigation.setStartPoint(start, true);
  navigation.setDestPoint(end, true);
  await new Promise((resolve, reject) => navigation.route({ barrierFree, mode: window.fengmap.FMNaviMode.MODULE_BEST }, resolve, (error) => reject(new Error(`地图路径计算失败：${error ?? "未知错误"}`))));
  navigation.drawNaviLine();
  try { navigation.overview({ ratio: 1.4, animate: true, tilt: 0, rotation: 0 }, () => applyTopDownMapView(false)); }
  catch { applyTopDownMapView(false); }
  return { distance: Math.round(navigation.naviResult?.distance ?? 0), steps: navigationInstructions(navigation.naviResult, route.steps) };
}

async function searchMapLocations(query) {
  const results = await api(`/api/locations?q=${encodeURIComponent(query)}`);
  $("#mapLocationResults").innerHTML = locationResultsHtml(results);
}

function distanceMeters(first, second) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const latitudeDelta = radians(second.latitude - first.latitude);
  const longitudeDelta = radians(second.longitude - first.longitude);
  const value = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(radians(first.latitude)) * Math.cos(radians(second.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function browserPosition() {
  if (state.currentPosition) return Promise.resolve(state.currentPosition);
  if (!navigator.geolocation) return Promise.reject(new Error("当前浏览器不支持位置获取，请手动选择起点"));
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition((position) => {
    state.currentPosition = { latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy };
    resolve(state.currentPosition);
  }, () => reject(new Error("无法获取当前位置，请允许定位权限或手动选择起点")), { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 }));
}

function showOutsideHospitalAlert(distance) {
  const dialog = $("#locationAlert");
  $("#locationAlertMessage").textContent = `检测到您距离医院主院区约 ${Math.max(0.1, Math.round(distance / 100) / 10)} 公里。院内路线到院后才能使用，请到院后重新定位或手动选择地图起点。`;
  if (!dialog.open) dialog.showModal();
}

async function validateCurrentLocation() {
  const position = await browserPosition();
  const area = state.mapContext?.hospitalArea;
  if (!area?.center) return { inside: null, position };
  const distance = distanceMeters(position, area.center);
  const inside = distance <= area.radiusMeters + Math.min(position.accuracy ?? 0, 200);
  if (!inside) showOutsideHospitalAlert(distance);
  return { inside, position, distance };
}

function renderMapDestinations(appointmentDestinations, orderDestinations) {
  const container = $("#mapAppointmentSuggestions");
  const destinations = [
    ...appointmentDestinations.map((item) => ({ ...item, reason: `挂号：${item.departmentName}` })),
    ...orderDestinations.map((item) => ({ ...item, reason: `${item.orderType === "EXAMINATION" ? "检查" : "取药"}：${item.orderTitle}` })),
  ];
  if (!destinations.length) { container.classList.add("hidden"); container.replaceChildren(); return; }
  container.classList.remove("hidden");
  container.innerHTML = `<strong>根据您的就诊安排，可选择以下目的地</strong>${destinations.slice(0, 8).map((item) => `<div class="result-item appointment-destination"><strong>${escapeHtml(item.reason)}</strong><p>${escapeHtml(item.canonicalName ?? item.mapLabel)} · ${escapeHtml(item.floorLabel ?? "楼层待核对")}</p><button type="button" data-appointment-destination="${escapeHtml(item.locationId)}" data-location-name="${escapeHtml(item.canonicalName ?? item.mapLabel)}">选择为终点</button></div>`).join("")}`;
}

async function prepareMapContextAndLocation() {
  state.mapContext = await api("/api/patient/map-context");
  renderMapDestinations(state.mapContext.appointmentDestinations ?? [], state.mapContext.orderDestinations ?? []);
  try { await validateCurrentLocation(); }
  catch (error) { $("#mapRouteResult").innerHTML = `<p class="notice">${escapeHtml(error.message)}</p>`; }
}

async function openMapPage(query = "") {
  if (query) sessionStorage.setItem("hospital-map-query", query);
  else sessionStorage.removeItem("hospital-map-query");
  location.assign("/map");
}

if (portal === "map") {
bindEvent("#mapAppointmentSuggestions", "click", (event) => {
  const button = event.target.closest("[data-appointment-destination]");
  if (!button) return;
  const select = $("#mapRouteForm").elements.end;
  select.innerHTML = `<option value="${escapeHtml(button.dataset.appointmentDestination)}">${escapeHtml(button.dataset.locationName)}</option>`;
  toast("已选择挂号地点作为终点");
});

bindEvent("#mapLocationSearch", "submit", async (event) => {
  event.preventDefault();
  try { await searchMapLocations(event.currentTarget.elements.query.value); }
  catch (error) { toast(error.message, true); }
});

bindEvent("#mapLocationResults", "click", (event) => {
  const button = event.target.closest("[data-route-point]");
  if (!button) return;
  const select = $("#mapRouteForm").elements[button.dataset.routePoint];
  select.innerHTML = `<option value="${escapeHtml(button.dataset.locationId)}">${escapeHtml(button.dataset.locationName)}</option>`;
  toast(button.dataset.routePoint === "start" ? "已设置起点" : "已设置终点");
});

bindEvent("#mapRouteForm", "submit", async (event) => {
  event.preventDefault();
  const data = formObject(event.currentTarget);
  const output = $("#mapRouteResult");
  output.innerHTML = `<p class="muted">正在计算院内路线…</p>`;
  try {
    if (data.start === "current-location") {
      const location = await validateCurrentLocation();
      if (!location.inside) throw new Error("您当前不在医院范围内，暂时不能开始院内导航");
      throw new Error("浏览器定位无法识别院内楼层，请从搜索结果选择一个准确起点后开始导航");
    }
    const route = await api(`/api/routes?start=${encodeURIComponent(data.start)}&end=${encodeURIComponent(data.end)}`);
    if (route.status !== "AVAILABLE") throw new Error(route.reason);
    try {
      const navigation = await drawIndoorRoute(route, data.barrierFree === "on");
      output.innerHTML = `<div class="result-item"><strong>路线已显示在地图上${navigation.distance ? ` · 约 ${navigation.distance} 米` : ""}</strong><ol>${navigation.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol></div>`;
    } catch (mapError) {
      console.warn("精确地图路线不可用，已降级为楼层指引", mapError);
      output.innerHTML = `<div class="result-item"><strong>简要路线</strong><ol>${route.steps.slice(0, 3).map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol><p class="notice">地图暂时无法绘制路线，请同时核对现场标识。</p></div>`;
    }
  } catch (error) { output.innerHTML = `<p class="notice">无法生成路线：${escapeHtml(error.message)}</p>`; }
});

bindEvent("#reloadMap", "click", () => { resetMap(); initMap(document).catch((error) => toast(error.message, true)); });
bindEvent("#exitMap", "click", () => location.assign("/user"));
bindEvent("[data-close-location-alert]", "click", () => $("#locationAlert")?.close());
}

async function init() {
  try {
    state.config = await api("/api/config");
    if (portal === "patient") {
      const { SpeechOutputPlayer, XfyunTranscriber } = await import("./speech.js");
      state.speechPlayer = new SpeechOutputPlayer();
      state.Transcriber = XfyunTranscriber;
      updateSpeechControls();
      await refreshPatient();
      await refreshConversation();
    } else if (portal === "doctor") {
      state.departments = await api("/api/departments");
      initializeDoctorDepartmentIndex();
      const today = new Date().toISOString().slice(0, 10);
      const practiceForm = $("#practiceForm");
      if (practiceForm?.elements?.serviceDate) { practiceForm.elements.serviceDate.value = today; practiceForm.elements.serviceDate.min = today; }
      await restoreDoctor();
    } else if (portal === "admin") {
      setHidden("#adminSetupCard", state.config.administratorInitialized);
      await restoreAdministrator();
    } else if (portal === "map") {
      document.body.classList.add("map-mode");
      const query = sessionStorage.getItem("hospital-map-query") ?? "";
      sessionStorage.removeItem("hospital-map-query");
      if (query) { $("#mapLocationSearch").elements.query.value = query; await searchMapLocations(query); }
      await Promise.all([initMap(document), prepareMapContextAndLocation()]);
    }
  } catch (error) { toast(`初始化失败：${error.message}`, true); }
}

if (portal === "patient") {
bindEvent("#undoLastTurn", "click", async () => {
  try {
    await api("/api/patient/conversation/undo", { method: "POST", body: "{}" });
    await refreshConversation();
  } catch (error) { toast(error.message, true); }
});
$$("[data-quick-message]").forEach((button) => button.onclick = () => { $("#chatInput").value = button.dataset.quickMessage; $("#chatForm").requestSubmit(); });
bindEvent("#autoReadToggle", "click", async () => {
  state.autoRead = !state.autoRead;
  localStorage.setItem("hospital-auto-read", state.autoRead ? "on" : "off");
  if (!state.autoRead) state.speechPlayer.stop();
  else try { await state.speechPlayer.unlock(); } catch {}
  updateSpeechControls();
});
bindEvent("#voiceInput", "click", async () => {
  if (state.transcriber?.active) return state.transcriber.stop();
  try {
    const session = await api("/api/speech/transcription-session", { method: "POST", body: "{}" });
    const original = $("#chatInput").value.trim();
    state.transcriber = new state.Transcriber({
      onText: (text) => { $("#chatInput").value = [original, text].filter(Boolean).join(original ? " " : "").slice(0, 500); },
      onState: setVoiceInputState,
    });
    await state.transcriber.start(session);
  } catch (error) { setVoiceInputState("error", error); }
});
bindEvent("#chatForm", "submit", async (event) => {
  event.preventDefault();
  const input = $("#chatInput"); const message = input.value.trim();
  if (!message) return;
  state.transcriber?.stop();
  if (state.autoRead && state.config?.speech?.synthesis) state.speechPlayer.unlock().catch(() => {});
  state.speechPlayer.stop();
  input.value = ""; input.disabled = true;
  state.assistantActions = [];
  const container = $("#chatMessages");
  container.querySelectorAll(".assistant-action").forEach((node) => node.remove());
  const patientNode = document.createElement("div"); patientNode.className = "message PATIENT"; patientNode.textContent = message;
  const assistantNode = document.createElement("div"); assistantNode.className = "message AGENT streaming"; assistantNode.dataset.loading = "true"; assistantNode.textContent = "";
  container.append(patientNode, assistantNode); scrollConversationToLatest();
  state.agentStreaming = true;
  try {
    const result = await streamAgentMessage(message, assistantNode);
    await refreshPatient();
    // The server emits actions after assistant.completed; render them last to preserve turn order.
    renderAssistantActions(result.actions); scrollConversationToLatest();
    if (!$("#calledAlert").open) readAssistantReply(result.completed?.text ?? assistantNode.textContent);
  } catch (error) {
    console.error("患者消息处理失败", error);
    assistantNode.textContent = `发送失败：${error.message}`; assistantNode.classList.add("stream-error");
    input.value = message; toast(error.message, true);
  } finally { state.agentStreaming = false; input.disabled = false; input.focus(); scrollConversationToLatest(); }
});
bindEvent("#endPatientSession", "click", async () => { if (!confirm("将立即清除本次患者档案、挂号、病历和会话，确定继续吗？")) return; await api("/api/patient/session", { method: "DELETE" }); location.reload(); });
bindEvent("[data-close-called]", "click", () => $("#calledAlert")?.close());
}

if (portal === "doctor") {
bindEvent("#doctorRegisterForm", "submit", async (event) => { event.preventDefault(); const form = event.currentTarget; try { const result = await api("/api/doctors/register", { method: "POST", body: JSON.stringify(formObject(form)) }); toast(`注册成功，状态：${result.accountStatus}。请等待管理员审核。`); form.reset(); } catch (error) { toast(error.message, true); } });
bindEvent("#doctorLoginForm", "submit", async (event) => { event.preventDefault(); const form = event.currentTarget; try { const result = await api("/api/doctors/login", { method: "POST", body: JSON.stringify(formObject(form)) }); state.csrf = result.csrfToken; toast("登录成功"); await restoreDoctor(); form.reset(); } catch (error) { toast(error.message, true); } });
bindEvent("#doctorLogout", "click", async () => { await api("/api/doctors/logout", { method: "POST", body: "{}" }); resetDoctorRecordWorkspace(); state.csrf = null; state.doctor = null; toast("已安全退出"); restoreDoctor(); });
bindEvent("#practiceForm", "submit", async (event) => { event.preventDefault(); const data = formObject(event.currentTarget); try { await api("/api/doctors/practices", { method: "POST", body: JSON.stringify({ ...data, capacity: Number(data.capacity) }) }); toast("号源已发布"); renderDoctorPractices(await api("/api/doctors/practices")); } catch (error) { toast(error.message, true); } });
bindEvent("#refreshDoctorAppointments", "click", () => refreshDoctorAppointments().catch((error) => toast(error.message, true)));
bindEvent("#closeRecordEditor", "click", resetDoctorRecordWorkspace);
bindEvent("#recordForm", "submit", async (event) => { event.preventDefault(); const data = formObject(event.currentTarget); const changeReason = data.changeReason; delete data.changeReason; try { const result = await api(`/api/doctors/records/${state.record.recordId}`, { method: "PUT", body: JSON.stringify({ expectedVersion: state.record.version, content: data, changeReason }) }); state.record.version = result.version; toast(`病历已保存为版本 ${result.version}`); } catch (error) { toast(error.message, true); } });
bindEvent("#orderForm [name=orderType]", "change", populateOrderCatalog);
bindEvent("#orderForm", "submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = formObject(form);
  try {
    await api(`/api/doctors/records/${state.record.recordId}/orders`, { method: "POST", body: JSON.stringify({ ...data, quantity: Number(data.quantity) }) });
    toast("医生医嘱已创建；目录和费用为演示数据");
    const catalogField = form.elements?.namedItem("catalogItemId");
    const notesField = form.elements?.namedItem("doctorNotes");
    const quantityField = form.elements?.namedItem("quantity");
    if (catalogField) catalogField.value = "";
    if (notesField) notesField.value = "";
    if (quantityField) quantityField.value = "1";
    await refreshRecordOrders();
  } catch (error) { toast(error.message, true); }
});
}

if (portal === "admin") {
bindEvent("#adminSetupForm", "submit", async (event) => { event.preventDefault(); const form = event.currentTarget; try { await api("/api/administrators/setup", { method: "POST", body: JSON.stringify(formObject(form)) }); state.config.administratorInitialized = true; setHidden("#adminSetupCard", true); toast("管理员初始化成功，请登录"); form.reset(); } catch (error) { toast(error.message, true); } });
bindEvent("#adminLoginForm", "submit", async (event) => { event.preventDefault(); const form = event.currentTarget; try { const result = await api("/api/administrators/login", { method: "POST", body: JSON.stringify(formObject(form)) }); state.adminCsrf = result.csrfToken; toast("管理员登录成功"); await restoreAdministrator(); form.reset(); } catch (error) { toast(error.message, true); } });
bindEvent("#adminLogout", "click", async () => { await adminApi("/api/administrators/logout", { method: "POST", body: "{}" }); state.administrator = null; state.adminCsrf = null; toast("管理员已退出"); restoreAdministrator(); });
bindEvent("#refreshAdminDoctors", "click", () => refreshAdminDoctors().catch((error) => toast(error.message, true)));
}

init();
if (portal === "patient") window.setInterval(checkProactiveUpdate, 5000);
