"use strict";

const SCENARIOS = [
  "首次配對（兩端清空）",
  "從系統藍牙設定配對",
  "從 App 內配對",
  "App 關閉再開回連",
  "手機藍牙關閉再開回連",
  "儀表重開機回連",
  "只有手機刪除配對",
  "只有儀表刪除配對",
  "走遠斷線再走回",
  "其他",
];

const CATEGORY = {
  conn: { label: "連線", color: "#2e7d32" },
  disconnect: { label: "斷線", color: "#c62828" },
  pair_br: { label: "BR/EDR 配對", color: "#6a1b9a" },
  pair_le: { label: "LE 配對", color: "#1565c0" },
  enc: { label: "加密", color: "#00838f" },
  att: { label: "ATT", color: "#5d4037" },
  att_discovery: { label: "ATT 探索", color: "#546e7a" },
  att_capability: { label: "ATT 能力限制", color: "#ad6800" },
  cccd: { label: "CCCD", color: "#ef6c00" },
  gatt_write: { label: "GATT 寫入", color: "#283593" },
  notify: { label: "Notify", color: "#9e9d24" },
  error: { label: "錯誤", color: "#d50000" },
  mark: { label: "標記", color: "#f9a825" },
};

// 數量多的類別預設不勾選，也不畫在時間軸（時間軸已有 notify/s 長條）
const DEFAULT_OFF = new Set(["notify"]);

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hex4 = (n) => "0x" + n.toString(16).toUpperCase().padStart(4, "0");

let state = "idle";
let currentId = null;
let captureList = [];
let folders = [];
let selectedFolder = "*";
const CAPTURE_DRAG_TYPE = "application/x-bt-capture";
let downloadCaptureId = null;
let downloadFiles = [];
let archiveSaveFile = null;
let archiveBusy = false;
let captureOperation = null;
let forceClosing = false;

async function api(path, body) {
  const opt = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const r = await fetch(path, opt);
  const j = await r.json();
  if (!r.ok || j.ok === false) {
    const error = new Error(j.error || r.statusText);
    error.status = r.status;
    throw error;
  }
  return j;
}

function log(msg) {
  const el = $("log");
  el.textContent = `[${new Date().toLocaleTimeString()}] ${msg}\n` + el.textContent;
}

function busy(on) {
  for (const id of ["btn-start", "btn-stop", "btn-mark"]) $(id).classList.toggle("busy", on);
}

function fmtClock(t) {
  const d = new Date(t * 1000);
  return d.toLocaleTimeString("zh-TW", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

function fmtOffset(sec) {
  const sign = sec < 0 ? "慢" : "快";
  let s = Math.abs(sec);
  if (s < 60) return `${sign} ${s.toFixed(1)} 秒`;
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const mi = Math.floor(s / 60); s -= mi * 60;
  return `${sign} ${d ? d + " 天 " : ""}${h} 時 ${mi} 分 ${Math.round(s)} 秒`;
}

// ---------- 控制 ----------
function applyState(s) {
  state = s.state;
  const capturing = state === "capturing";
  $("btn-start").disabled = capturing || !!captureOperation || forceClosing;
  $("btn-stop").disabled = !capturing || !!captureOperation || forceClosing;
  $("btn-force-stop").disabled = forceClosing || (!capturing && !captureOperation);
  $("btn-mark").disabled = !capturing;
  $("mark-text").disabled = !capturing;
  for (const id of ["scenario", "app", "phone"]) $(id).disabled = capturing;
  if (!$("conn-host").dataset.envLocked) $("conn-host").disabled = capturing;
  const st = $("state");
  st.className = "state " + state;
  if (capturing) {
    const m = s.current.meta;
    const sec = Math.floor(s.current.elapsed);
    st.textContent = `擷取中 ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}｜${m.scenario}｜${m.app}｜${m.phone}`;
  } else {
    st.textContent = "閒置";
  }
}

async function poll() {
  try {
    applyState(await api("/api/status"));
    $("host-status").textContent = "";
  } catch (e) {
    $("host-status").textContent = "伺服器無回應";
  }
}

async function start() {
  const operation = {};
  captureOperation = operation;
  busy(true);
  log("開始擷取…（SSH 連線、拍金鑰快照、啟動 btmon）");
  try {
    const r = await api("/api/start", { scenario: $("scenario").value, app: $("app").value, phone: $("phone").value });
    if (captureOperation !== operation) return;
    log("已開始: " + r.output);
    localStorage.setItem("phone", $("phone").value);
  } catch (e) {
    if (captureOperation === operation) log("開始失敗: " + e.message);
  }
  if (captureOperation !== operation) return;
  captureOperation = null;
  busy(false);
  poll();
}

async function stop() {
  const operation = {};
  captureOperation = operation;
  busy(true);
  log("停止中…（拉回檔案、分析）");
  try {
    const r = await api("/api/stop", {});
    if (captureOperation !== operation) return;
    log("完成: " + r.output);
    await loadCaptures();
    if (r.id) openCapture(r.id);
  } catch (e) {
    if (captureOperation === operation) log("停止失敗: " + e.message + "；可按「強制關閉」解除狀態。");
  }
  if (captureOperation !== operation) return;
  captureOperation = null;
  busy(false);
  poll();
}

async function forceStop() {
  if (forceClosing || !confirm("強制關閉目前擷取？\n會中止卡住的操作並保留本機已取得的檔案；未拉回的資料可能不完整。")) return;
  forceClosing = true;
  captureOperation = null;
  busy(true);
  $("btn-force-stop").disabled = true;
  log("強制關閉中…");
  try {
    const result = await api("/api/force-stop", {});
    captureOperation = null;
    busy(false);
    log(result.output);
    await loadCaptures();
  } catch (error) {
    log("強制關閉失敗: " + error.message);
  } finally {
    forceClosing = false;
    busy(false);
    await poll();
  }
}

async function mark() {
  const text = $("mark-text").value.trim();
  try {
    await api("/api/mark", { text });
    log("已標記: " + (text || "(無說明)"));
    $("mark-text").value = "";
  } catch (e) {
    log("標記失敗: " + e.message);
  }
}

// ---------- 紀錄清單 ----------
async function loadCaptures() {
  const folderRequest = api("/api/folders").catch((e) => {
    if (e.status !== 404) throw e;
    log("伺服器尚未更新，請重啟 server.py 以啟用改名與資料夾分類；現有紀錄仍可檢視。");
    return [];
  });
  [captureList, folders] = await Promise.all([api("/api/captures"), folderRequest]);
  if (selectedFolder !== "*" && selectedFolder !== "" && !folders.some((f) => f.id === selectedFolder)) selectedFolder = "*";
  renderCaptures();
  const phones = new Set(captureList.map((c) => c.meta.phone).filter(Boolean));
  $("phones").innerHTML = [...phones].map((p) => `<option value="${esc(p)}">`).join("");
}

function renderFolders() {
  const entries = [{id: "*", name: "全部紀錄"}, {id: "", name: "未分類"}, ...folders];
  $("folders").innerHTML = entries.map((f) => {
    const count = captureList.filter((c) => f.id === "*" || (c.folder || "") === f.id).length;
    return `<button class="folder-item${f.id === selectedFolder ? " selected" : ""}" data-folder="${esc(f.id)}" aria-pressed="${f.id === selectedFolder}" title="${f.id === "*" ? "檢視全部紀錄" : "點擊檢視，或拖曳紀錄到這裡"}"><span>${f.id === "*" ? "☰" : "📁"} ${esc(f.name)}</span><small>${count}</small></button>`;
  }).join("");
  for (const button of $("folders").querySelectorAll("[data-folder]")) {
    const folder = button.dataset.folder;
    button.onclick = () => { selectedFolder = folder; renderCaptures(); };
    if (folder === "*") continue;
    button.ondragover = (e) => {
      if (!Array.from(e.dataTransfer.types).includes(CAPTURE_DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      button.classList.add("drop-target");
    };
    button.ondragleave = (e) => {
      if (!button.contains(e.relatedTarget)) button.classList.remove("drop-target");
    };
    button.ondrop = async (e) => {
      e.preventDefault();
      button.classList.remove("drop-target");
      const id = e.dataTransfer.getData(CAPTURE_DRAG_TYPE);
      if (!captureList.some((c) => c.id === id)) return;
      try {
        await saveOrganization(id, {folder});
        log(`已移到「${entries.find((f) => f.id === folder).name}」`);
      } catch (error) {
        alert("移動失敗: " + error.message);
      }
    };
  }
}

function renderCaptures() {
  const selected = selectedFolder;
  renderFolders();
  const specificFolder = folders.some((f) => f.id === selected);
  $("folder-rename").disabled = $("folder-delete").disabled = !specificFolder;
  const list = captureList.filter((c) => selected === "*" || (c.folder || "") === selected);
  $("captures").innerHTML = list.map((c) => {
    const t = c.meta.start_time ? new Date(c.meta.start_time * 1000).toLocaleString("zh-TW", { hour12: false }) : c.id;
    const title = c.name || (c.incomplete ? "（不完整：擷取啟動失敗）" : c.meta.scenario);
    const folderName = folders.find((f) => f.id === c.folder)?.name || "未分類";
    const sub = c.incomplete ? esc(c.id) : `${esc(t)}｜${esc(c.meta.app)}｜${esc(c.meta.phone)}${c.analyzed ? "" : "｜未分析"}`;
    return `<li data-id="${esc(c.id)}" draggable="true" class="${c.id === currentId ? "active" : ""}${c.incomplete ? " incomplete" : ""}">
      <button class="cap-del" title="刪除這筆紀錄" data-del="${esc(c.id)}">✕</button>
      <div class="cap-title" tabindex="0" title="雙擊改名，或按 F2">${esc(title)}</div>
      <div class="cap-sub">${sub}<br>📁 ${esc(folderName)}${c.incomplete ? "｜不完整" : ""}</div></li>`;
  }).join("") || "<li class='empty'>此分類尚無紀錄</li>";
  for (const li of $("captures").querySelectorAll("li[data-id]")) {
    li.onclick = () => openCapture(li.dataset.id);
    const title = li.querySelector(".cap-title");
    title.ondblclick = (e) => { e.stopPropagation(); renameCapture(li.dataset.id, title); };
    title.onkeydown = (e) => {
      if (e.key === "F2") { e.preventDefault(); renameCapture(li.dataset.id, title); }
    };
    li.ondragstart = (e) => {
      if (li.querySelector("input")) { e.preventDefault(); return; }
      e.dataTransfer.setData(CAPTURE_DRAG_TYPE, li.dataset.id);
      e.dataTransfer.effectAllowed = "move";
      li.classList.add("dragging");
    };
    li.ondragend = () => {
      li.classList.remove("dragging");
      for (const target of $("folders").querySelectorAll(".drop-target")) target.classList.remove("drop-target");
    };
  }
  for (const b of $("captures").querySelectorAll("button[data-del]")) {
    b.onclick = (e) => { e.stopPropagation(); deleteCapture(b.dataset.del); };
  }
}

function renameCapture(id, title) {
  const c = captureList.find((c) => c.id === id);
  if (!c || title.querySelector("input")) return;
  const original = title.textContent;
  const input = document.createElement("input");
  input.className = "cap-name-input";
  input.maxLength = 120;
  input.value = c.name || c.meta.scenario || "";
  input.setAttribute("aria-label", "紀錄名稱");
  input.title = "Enter 儲存，Esc 取消；留空恢復原名";
  title.replaceChildren(input);
  let finished = false;
  const finish = async (cancel = false) => {
    if (finished) return;
    finished = true;
    const name = input.value.trim();
    title.textContent = original;
    if (cancel || name === (c.name || c.meta.scenario || "")) return;
    try {
      await saveOrganization(id, {name});
    } catch (e) {
      alert("改名失敗: " + e.message);
    }
  };
  input.onclick = input.ondblclick = (e) => e.stopPropagation();
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.isComposing) return;
    if (e.key === "Enter" || e.key === "Escape") {
      e.preventDefault();
      finish(e.key === "Escape");
    }
  };
  input.onblur = () => finish();
  input.focus();
  input.select();
}

async function saveOrganization(id, changes) {
  await api(`/api/captures/${encodeURIComponent(id)}/organization`, changes);
  await loadCaptures();
  if (currentId === id) await openCapture(id);
}

async function manageFolder(action) {
  const folder = folders.find((f) => f.id === selectedFolder);
  const body = { id: folder?.id };
  if (action === "delete") {
    if (!folder || !confirm(`刪除分類資料夾「${folder.name}」？裡面的紀錄會移回「未分類」，擷取檔案會保留。`)) return;
  } else {
    const name = prompt(action === "create" ? "新增分類資料夾名稱：" : "修改分類資料夾名稱：", action === "rename" ? folder?.name : "");
    if (name === null) return;
    body.name = name;
  }
  try {
    await api(`/api/folders/${action}`, body);
    await loadCaptures();
    // 新增後保持目前清單，方便直接將現有紀錄拖進新資料夾。
    renderCaptures();
    if (currentId) await openCapture(currentId);
  } catch (e) {
    alert("資料夾操作失敗: " + e.message);
  }
}

async function deleteCapture(id) {
  if (!confirm(`確定要刪除這筆紀錄嗎？\n${id}\n\n資料夾內所有檔案（含 hci.btsnoop）都會被刪除，無法復原。`)) return;
  try {
    await api(`/api/captures/${encodeURIComponent(id)}/delete`, {});
    log("已刪除紀錄: " + id);
    if (currentId === id) {
      currentId = null;
      $("result").innerHTML = `<p class="hint">選擇左側的擷取紀錄以檢視結果。</p>`;
    }
    await loadCaptures();
  } catch (e) {
    alert("刪除失敗: " + e.message);
  }
}

async function openCapture(id) {
  currentId = id;
  for (const li of $("captures").querySelectorAll("li")) li.classList.toggle("active", li.dataset.id === id);
  try {
    const s = await api(`/api/captures/${encodeURIComponent(id)}`);
    renderResult(id, s);
  } catch (e) {
    $("result").innerHTML = `<p class="error">${esc(e.message)}</p>
      <div class="downloads"><button onclick="reanalyze('${esc(id)}')">重新分析</button>
      <button class="danger" onclick="deleteCapture('${esc(id)}')">刪除紀錄</button></div>`;
  }
}

async function reanalyze(id) {
  const btns = [...document.querySelectorAll("#result button")];
  btns.forEach((b) => (b.disabled = true));
  log("重新分析中… " + id);
  try {
    const r = await api(`/api/captures/${encodeURIComponent(id)}/reanalyze`, {});
    const msg = `重新分析完成：封包 ${r.packets}、連線 ${r.connections}、事件 ${r.events}` +
      (r.warnings.length ? `｜警告：${r.warnings.join("；")}` : "");
    log(msg);
    await loadCaptures();
    await openCapture(id);
    flash(msg, r.warnings.length ? "warn" : "ok");
  } catch (e) {
    btns.forEach((b) => (b.disabled = false));
    alert("分析失敗: " + e.message);
  }
}

function flash(msg, cls) {
  const el = document.createElement("div");
  el.className = "flash " + cls;
  el.textContent = `${msg}（${new Date().toLocaleTimeString("zh-TW", { hour12: false })}）`;
  $("result").prepend(el);
}

// ---------- LOG 壓縮下載 ----------
const LOG_DESCRIPTIONS = {
  "hci.btsnoop": "原始藍牙封包，可用 Wireshark 開啟",
  "btmon.out": "藍牙封包文字解析",
  "summary.txt": "連線、配對與 ATT 分析摘要",
  "dbus.log": "D-Bus 事件紀錄",
  "journal.log": "系統服務日誌",
  "marks.txt": "擷取時的操作標記",
  "bluetoothctl_before.txt": "擷取前的藍牙裝置狀態",
  "bluetoothctl_after.txt": "擷取後的藍牙裝置狀態",
  "keys_before.tgz": "擷取前的金鑰快照",
  "keys_after.tgz": "擷取後的金鑰快照",
};

function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function zipFilename(value) {
  const name = value.trim().replace(/\.zip$/i, "");
  if (!name || name.length > 120 || /[\\/:*?"<>|\x00-\x1f]/.test(name) || /[. ]$/.test(name)) {
    throw new Error("請輸入有效的壓縮檔名稱，不可包含 \\ / : * ? \" < > |");
  }
  return name + ".zip";
}

function selectedLogFiles() {
  return [...$("download-files").querySelectorAll("input:checked")].map((cb) => cb.value);
}

function updateDownloadSelection() {
  const selected = new Set(selectedLogFiles());
  const bytes = downloadFiles.filter((f) => selected.has(f.name)).reduce((sum, f) => sum + f.size, 0);
  $("download-selection").textContent = `已選 ${selected.size} / ${downloadFiles.length} 個檔案 · 原始大小 ${formatBytes(bytes)}`;
  $("download-submit").disabled = archiveBusy || selected.size === 0;
}

async function openDownload(id) {
  downloadCaptureId = id;
  downloadFiles = [];
  archiveSaveFile = null;
  const c = captureList.find((c) => c.id === id);
  $("download-capture").textContent = c?.name || c?.meta.scenario || id;
  $("download-name").value = (c?.name || id).replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/[. ]+$/, "").slice(0, 116);
  $("download-files").textContent = "載入檔案中…";
  $("download-selection").textContent = "";
  $("download-error").textContent = $("download-status").textContent = "";
  $("download-submit").disabled = true;
  $("download-destination").value = "瀏覽器預設下載位置";
  $("download-choose").disabled = !window.showSaveFilePicker;
  $("download-destination-hint").textContent = window.showSaveFilePicker
    ? "開啟系統的另存新檔視窗，可選擇 Windows 桌面或其他位置。"
    : "此瀏覽器不支援指定儲存位置；請在瀏覽器下載設定啟用「每次下載前詢問儲存位置」。";
  $("download-dialog").showModal();
  try {
    downloadFiles = await api(`/api/captures/${encodeURIComponent(id)}/files`);
    $("download-files").innerHTML = downloadFiles.map((f) => `<label class="download-file"><input type="checkbox" value="${esc(f.name)}" ${f.name.startsWith("keys_") ? "" : "checked"}><span><strong>${esc(f.name)}</strong><small>${esc(LOG_DESCRIPTIONS[f.name] || "擷取紀錄")}</small></span><span class="file-size">${formatBytes(f.size)}</span></label>`).join("") || "沒有可下載的檔案";
    updateDownloadSelection();
  } catch (e) {
    $("download-files").textContent = "無法載入檔案清單";
    $("download-error").textContent = e.status === 404 ? "伺服器尚未更新，請重啟 server.py 後重試。" : e.message;
  }
}

async function chooseDownloadDestination() {
  try {
    const file = await window.showSaveFilePicker({
      suggestedName: zipFilename($("download-name").value),
      types: [{description: "ZIP 壓縮檔", accept: {"application/zip": [".zip"]}}],
      excludeAcceptAllOption: true,
    });
    archiveSaveFile = file;
    $("download-name").value = file.name.replace(/\.zip$/i, "");
    $("download-destination").value = `已指定儲存位置：${file.name}`;
    $("download-error").textContent = "";
  } catch (e) {
    if (e.name !== "AbortError") $("download-error").textContent = "無法選擇目的地：" + e.message;
  }
}

async function downloadArchive(e) {
  e.preventDefault();
  if (archiveBusy) return;
  let filename;
  const files = selectedLogFiles();
  $("download-error").textContent = "";
  try {
    filename = zipFilename($("download-name").value);
    if (!files.length) throw new Error("請至少選擇一個檔案");
  } catch (error) {
    $("download-error").textContent = error.message;
    return;
  }
  archiveBusy = true;
  for (const control of $("download-form").querySelectorAll("input, button")) control.disabled = true;
  $("download-status").textContent = "正在壓縮…";
  let writable = null;
  try {
    const response = await fetch(`/api/captures/${encodeURIComponent(downloadCaptureId)}/archive`, {
      method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({name: filename, files}),
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "壓縮失敗");
    }
    const blob = await response.blob();
    if (archiveSaveFile) {
      writable = await archiveSaveFile.createWritable();
      await writable.write(blob);
      await writable.close();
      writable = null;
      $("download-status").textContent = "已儲存到指定位置。";
    } else {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      $("download-status").textContent = "已交給瀏覽器下載。";
    }
    log("已匯出 LOG：" + filename + `（${files.length} 個檔案）`);
  } catch (error) {
    if (writable) await writable.abort().catch(() => {});
    $("download-status").textContent = "";
    $("download-error").textContent = error.message;
  } finally {
    archiveBusy = false;
    for (const control of $("download-form").querySelectorAll("input, button")) control.disabled = false;
    $("download-choose").disabled = !window.showSaveFilePicker;
    updateDownloadSelection();
  }
}

// ---------- 結果 ----------
function renderResult(id, s) {
  s.events.forEach((e, i) => (e._idx = i));
  const base = s.capture.first_ts;
  const rel = (t) => (base == null ? "" : "+" + (t - base).toFixed(3) + "s");
  const m = s.meta;
  const organization = s.organization || {};
  const folderName = folders.find((f) => f.id === organization.folder)?.name || "未分類";
  const off = m.clock_offset != null ? `儀表時鐘與電腦相差 ${fmtOffset(m.clock_offset)}` : "";

  let html = `<div class="result-head">
    <h2 class="cap-title" tabindex="0" title="雙擊改名，或按 F2">${organization.name ? esc(organization.name) : `${esc(m.scenario)}｜${esc(m.app)}｜${esc(m.phone)}`}</h2>
    <div class="sub">📁 ${esc(folderName)}${organization.name ? `｜${esc(m.scenario)}｜${esc(m.app)}｜${esc(m.phone)}` : ""}</div>
    <div class="sub">${esc(id)}｜封包 ${s.capture.packets}｜${esc(off)}（時間軸使用儀表時鐘）</div>
    <div class="downloads"><button id="btn-download-log" class="download-log-button">↓ 下載 LOG</button>
      <button class="primary" onclick="toggleSimulator()">▶ 模擬動作</button>
      <button onclick="reanalyze('${esc(id)}')" title="用目前版本的 analyze.py 重新解析原始檔">重新分析</button>
      <button class="danger" onclick="deleteCapture('${esc(id)}')">刪除紀錄</button></div></div>
    <div id="sim-panel" class="sim-panel" style="display:none"></div>`;

  if (s.warnings.length) html += `<div class="warn">${s.warnings.map(esc).join("<br>")}</div>`;

  html += "<h3>連線</h3>" + connTable(s, rel);
  html += `<div class="tl-head"><h3>時間軸</h3>
    <div class="tl-controls">
      <button id="tl-zoom-out" title="縮小">－</button>
      <span id="tl-range" class="tl-range">全部</span>
      <button id="tl-zoom-in" title="放大">＋</button>
      <button id="tl-reset" title="重設為完整範圍">全部</button>
      <label class="tl-sync"><input type="checkbox" id="tl-sync-events" checked> 同步篩選下方事件表</label>
      <span class="tl-hint">（滾輪縮放、按住拖曳平移、Shift+拖曳框選放大、雙擊還原、點事件圓點定位）</span>
    </div></div>
    <div id="timeline"></div>
    <div id="tl-detail" class="tl-detail"></div>` + legend();

  const brEvents = s.events.filter((e) => e.category === "pair_br" || (e.category === "error" && isConnTransport(s, e, "BR/EDR")));
  const leEvents = s.events.filter((e) => e.category === "pair_le" || (e.category === "error" && isConnTransport(s, e, "LE")));
  html += `<h3>BR/EDR 配對流程</h3>${eventTable(brEvents, rel)}<h3>LE 配對流程</h3>${eventTable(leEvents, rel)}`;

  html += "<h3>CCCD 寫入</h3>" + eventTable(s.events.filter((e) => e.category === "cccd"), rel);
  html += "<h3>GATT 寫入（Control Point 等）</h3>" + eventTable(s.events.filter((e) => e.category === "gatt_write"), rel);
  html += "<h3>ATT 回覆（Error Response）</h3><p class='hint'>協定的 Error Response 不一定代表故障：查無屬性／探索結束與不支援的群組查詢分別標示，其他異常保留為錯誤。</p>" + eventTable(s.events.filter(isAttErrorResponse), rel);
  html += "<h3>金鑰快照差異（開始 → 結束）</h3>" + keyTable(s.keys);
  html += `<h3>全部事件</h3><div class="filters">${Object.entries(CATEGORY).map(([k, v]) =>
    `<label><input type="checkbox" data-cat="${k}"${DEFAULT_OFF.has(k) ? "" : " checked"}><span style="color:${v.color}">${v.label}</span></label>`).join("")}</div>
    <div id="all-events">${eventTable(s.events.filter((e) => !DEFAULT_OFF.has(e.category)), rel)}</div>`;

  $("result").innerHTML = html;
  $("btn-download-log").onclick = () => openDownload(id);
  const resultTitle = $("result").querySelector(".result-head h2");
  resultTitle.ondblclick = () => renameCapture(id, resultTitle);
  resultTitle.onkeydown = (e) => {
    if (e.key === "F2") { e.preventDefault(); renameCapture(id, resultTitle); }
  };
  initTimeline(s);
  const updateAllEvents = () => {
    const on = new Set([...document.querySelectorAll(".filters input:checked")].map((x) => x.dataset.cat));
    const sync = $("tl-sync-events")?.checked && tlView;
    const evs = s.events.filter((e) => on.has(e.category) && (!sync || (e.t >= tlView.v0 - 1e-6 && e.t <= tlView.v1 + 1e-6)));
    $("all-events").innerHTML = eventTable(evs, rel);
  };
  window._updateAllEvents = updateAllEvents;
  for (const cb of document.querySelectorAll(".filters input")) cb.onchange = updateAllEvents;
  if ($("tl-sync-events")) $("tl-sync-events").onchange = updateAllEvents;
  $("result").onclick = (e) => {
    const tr = e.target.closest("table.events tbody tr[data-idx]");
    if (!tr || !tlView) return;
    const ev = s.events.find((x) => x._idx === Number(tr.dataset.idx));
    if (ev) selectTimelineEvent(ev, [ev], false);
    document.querySelectorAll("tr.hl").forEach((r) => r.classList.remove("hl"));
    tr.classList.add("hl");
  };
}

function isAttErrorResponse(e) {
  return e.title === "ATT Error" || e.title === "ATT Error Response";
}

function isConnTransport(s, e, transport) {
  if (e.conn == null) return false;
  if (isAttErrorResponse(e)) return false;
  return s.connections[e.conn].transport === transport;
}

function connTable(s, rel) {
  if (!s.connections.length) return "<p class='hint'>沒有連線</p>";
  return `<div class="scroll"><table><thead><tr><th>#</th><th>傳輸層</th><th>Handle</th><th>位址</th><th>本機角色</th>
    <th>開始</th><th>結束</th><th>加密</th><th>GATT 所在</th><th>ATT 封包</th><th>Notify</th><th>寫入</th><th>斷線原因</th></tr></thead><tbody>
    ${s.connections.map((c) => `<tr>
      <td>${c.id}</td><td><span class="tag ${c.transport === "LE" ? "le" : "br"}">${c.transport}</span></td>
      <td>${hex4(c.handle)}</td>
      <td>${esc(c.address)}${c.address_type ? ` <small>${esc(c.address_type)}</small>` : ""}${c.identity_address ? `<br><small>identity ${esc(c.identity_address)}</small>` : ""}</td>
      <td>${esc(c.role || "-")}</td><td>${rel(c.start)}</td><td>${c.end ? rel(c.end) : "未結束"}</td>
      <td>${c.encrypted_at ? rel(c.encrypted_at) : "<span class='bad'>無</span>"}</td>
      <td>${c.gatt ? `<span class="gatt">${esc(c.att_channel)}</span>` : "-"}</td>
      <td>${c.att_packets}</td><td>${c.notifications}</td><td>${c.writes}</td>
      <td>${c.disconnect_reason_text ? `${esc(c.disconnect_reason_text)}<br><small>${c.disconnect_by === "local" ? "本機斷線" : "對端斷線"}</small>` : "-"}</td>
    </tr>`).join("")}</tbody></table></div>`;
}

function eventTable(events, rel) {
  if (!events.length) return "<p class='hint'>無</p>";
  return `<div class="scroll"><table class="events"><thead><tr><th>時間</th><th>儀表時鐘</th><th>連線</th><th>類別</th><th>事件</th><th>內容</th></tr></thead><tbody>
    ${events.map((e) => {
      const c = CATEGORY[e.category] || { label: e.category, color: "#555" };
      return `<tr class="${e.category}" data-idx="${e._idx ?? ""}" data-ts="${e.t}"><td>${rel(e.t)}</td><td>${fmtClock(e.t)}</td><td>${e.conn == null ? "-" : "#" + e.conn}</td>
        <td style="color:${c.color}">${c.label}</td><td>${esc(e.title)}</td><td>${esc(e.detail)}</td></tr>`;
    }).join("")}</tbody></table></div>`;
}

function keyTable(keys) {
  if (!keys.before || !keys.after) return "<p class='hint'>缺少金鑰快照</p>";
  if (!keys.diff.length) return "<p class='hint'>沒有任何已配對裝置</p>";
  return `<table><thead><tr><th>裝置</th><th>名稱</th><th>金鑰</th><th>開始</th><th>結束</th><th>變化</th></tr></thead><tbody>
    ${keys.diff.map((r) => `<tr class="${r.change ? "changed" : ""}"><td>${esc(r.device)}</td><td>${esc(r.name)}</td>
      <td>${esc(r.section)}</td><td>${esc(r.before)}</td><td>${esc(r.after)}</td><td><b>${esc(r.change)}</b></td></tr>`).join("")}
    </tbody></table>`;
}

function legend() {
  return `<div class="legend"><span><i class="sw br"></i>BR/EDR 連線</span><span><i class="sw le"></i>LE 連線</span>
    <span><i class="sw notify"></i>Notify 密度（每秒）</span>
    ${Object.entries(CATEGORY).map(([, v]) => `<span><i class="dot" style="background:${v.color}"></i>${v.label}</span>`).join("")}</div>`;
}

// ---------- 時間軸（支援滾輪縮放、拖曳平移、Shift+框選放大、小地圖、點事件定位） ----------
let tlView = null;

function initTimeline(s) {
  const el = $("timeline");
  const times = [s.capture.first_ts, s.capture.last_ts, ...s.marks.map((m) => m.t), ...s.events.map((e) => e.t)].filter((t) => t != null);
  if (!times.length) { el.innerHTML = "<p class='hint'>無資料</p>"; tlView = null; return; }
  let t0 = Math.min(...times), t1 = Math.max(...times);
  if (t1 - t0 < 1) t1 = t0 + 1;
  const base = s.capture.first_ts ?? t0;
  tlView = { s, base, t0, t1, v0: t0, v1: t1, selectPx: null };

  const setRange = (nv0, nv1) => {
    const full = tlView.t1 - tlView.t0;
    const minSpan = Math.min(0.02, full); // 最細可放大到 20ms
    let span = Math.max(minSpan, Math.min(full, nv1 - nv0));
    if (nv0 < tlView.t0) { nv0 = tlView.t0; nv1 = nv0 + span; }
    if (nv1 > tlView.t1) { nv1 = tlView.t1; nv0 = Math.max(tlView.t0, nv1 - span); }
    tlView.v0 = nv0;
    tlView.v1 = nv1;
    drawTimeline();
    if (window._updateAllEvents) window._updateAllEvents();
  };

  const zoomBy = (factor, centerRatio = 0.5) => {
    const span = tlView.v1 - tlView.v0;
    const center = tlView.v0 + span * centerRatio;
    const newSpan = span * factor;
    setRange(center - newSpan * centerRatio, center + newSpan * (1 - centerRatio));
  };

  if ($("tl-zoom-in")) $("tl-zoom-in").onclick = () => zoomBy(0.5);
  if ($("tl-zoom-out")) $("tl-zoom-out").onclick = () => zoomBy(2.0);
  if ($("tl-reset")) $("tl-reset").onclick = () => setRange(tlView.t0, tlView.t1);

  drawTimeline();
}

function drawTimeline() {
  if (!tlView) return;
  const { s, base, t0, t1, v0, v1 } = tlView;
  const el = $("timeline");
  const W = Math.max(el.clientWidth || 720, 640), LABEL = 210, PAD = 16, ROW = 42, TOP = 32, MINI_H = 26, MINI_GAP = 10;
  const plotW = W - LABEL - PAD;
  const rows = [...s.connections.map((c) => ({ conn: c })), { conn: null }];
  const mainH = TOP + rows.length * ROW + 6;
  const miniTop = mainH + MINI_GAP;
  const H = miniTop + MINI_H + 6;
  const evPoints = [];

  const x = (t) => LABEL + ((t - v0) / (v1 - v0)) * plotW;
  const xFull = (t) => LABEL + ((t - t0) / (t1 - t0)) * plotW;
  const span = v1 - v0;
  const fullSpan = t1 - t0;
  const zoomRatio = fullSpan / span;

  if ($("tl-range")) {
    const r0 = (v0 - base).toFixed(span < 2 ? 3 : 1);
    const r1 = (v1 - base).toFixed(span < 2 ? 3 : 1);
    $("tl-range").textContent = zoomRatio > 1.02 ? `+${r0}s ~ +${r1}s (${zoomRatio.toFixed(1)}x)` : `全部 (${fullSpan.toFixed(1)}s)`;
  }

  const parts = [];
  parts.push(`<defs><clipPath id="tl-clip"><rect x="${LABEL}" y="0" width="${plotW}" height="${H}"/></clipPath></defs>`);
  parts.push(`<rect x="${LABEL}" y="${TOP - 6}" width="${plotW}" height="${mainH - TOP + 6}" class="tl-bg"/>`);

  // 動態刻度：支援從毫秒級 (0.005s) 到小時級
  const steps = [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800];
  const step = steps.find((st) => span / st <= 12) || 1800;
  const digits = step < 0.05 ? 3 : step < 1 ? 2 : step < 10 && span < 15 ? 1 : 0;
  const firstTick = Math.ceil((v0 - base) / step) * step;
  for (let relV = firstTick; base + relV <= v1 + step * 0.01; relV += step) {
    const xx = x(base + relV);
    if (xx < LABEL - 1 || xx > LABEL + plotW + 1) continue;
    parts.push(`<line x1="${xx.toFixed(1)}" y1="${TOP - 6}" x2="${xx.toFixed(1)}" y2="${mainH}" class="grid"/>`);
    parts.push(`<text x="${xx.toFixed(1)}" y="${TOP - 10}" class="axis">+${relV.toFixed(digits)}s</text>`);
  }

  // 主圖區（裁切在繪圖範圍內）
  const clipped = [];
  rows.forEach((r, i) => {
    const y = TOP + i * ROW;
    const c = r.conn;
    if (c) {
      parts.push(`<text x="6" y="${y + 21}" class="rowlabel">#${c.id} ${c.transport} ${hex4(c.handle)}${c.gatt ? " [GATT]" : ""}</text>`);
      parts.push(`<text x="6" y="${y + 31}" class="rowsub">${esc(c.address)}</text>`);
      const cs = Math.max(c.start, v0), ce = Math.min(c.end ?? t1, v1);
      if (ce >= v0 && cs <= v1) {
        const xs = x(cs), xe = x(ce);
        clipped.push(`<rect x="${xs.toFixed(1)}" y="${y + 8}" width="${Math.max(xe - xs, 2).toFixed(1)}" height="${ROW - 14}" class="bar ${c.transport === "LE" ? "le" : "br"}">
          <title>#${c.id} ${c.transport} ${esc(c.address)}\n+${(c.start - base).toFixed(3)}s (${fmtClock(c.start)}) → ${c.end ? "+" + (c.end - base).toFixed(3) + "s (" + fmtClock(c.end) + ")" : "未結束"}${c.disconnect_reason_text ? "\n" + esc(c.disconnect_reason_text) : ""}</title></rect>`);
      }
      const maxN = Math.max(1, ...c.notify_per_sec.map(([, n]) => n));
      for (const [sec, n] of c.notify_per_sec) {
        const ts = c.start + sec;
        if (ts + 1 < v0 || ts > v1) continue;
        const h = ((ROW - 16) * n) / maxN;
        const xx = x(ts);
        clipped.push(`<rect x="${xx.toFixed(1)}" y="${(y + ROW - 7 - h).toFixed(1)}" width="${Math.max(x(ts + 1) - xx - 0.5, 1).toFixed(1)}" height="${h.toFixed(1)}" class="notify"><title>+${(ts - base).toFixed(0)}s: ${n} notify/s</title></rect>`);
      }
    } else {
      parts.push(`<text x="6" y="${y + 21}" class="rowlabel">其他（無連線）</text>`);
    }
    const evs = s.events.filter((e) => e.category !== "mark" && !DEFAULT_OFF.has(e.category) && (c ? e.conn === c.id : e.conn == null) && e.t >= v0 - span * 0.02 && e.t <= v1 + span * 0.02);
    // 當放大到一定程度時，錯開重疊的事件點高度讓細節更容易點選
    let lastPx = -999, stagger = 0;
    for (const e of evs) {
      const col = (CATEGORY[e.category] || {}).color || "#555";
      const xx = x(e.t);
      if (Math.abs(xx - lastPx) < 9) stagger = (stagger + 1) % 3;
      else stagger = 0;
      lastPx = xx;
      const cy = y + 11 + stagger * 7;
      const isSelected = tlView.selectedIdx === e._idx;
      const r = isSelected ? 7 : 5.5;
      evPoints.push({ e, xx, cy, rowIdx: i });
      const shape = e.category === "error" || e.category === "disconnect"
        ? `<path class="tl-ev${isSelected ? " selected" : ""}" data-idx="${e._idx}" d="M${(xx - r - 1).toFixed(1)},${(cy - r + 1).toFixed(1)} L${(xx + r + 1).toFixed(1)},${(cy - r + 1).toFixed(1)} L${xx.toFixed(1)},${(cy + r + 2).toFixed(1)} Z" fill="${col}"/>`
        : `<circle class="tl-ev${isSelected ? " selected" : ""}" data-idx="${e._idx}" cx="${xx.toFixed(1)}" cy="${cy}" r="${r}" fill="${col}"/>`;
      // 加上透明大點擊區 (r=12) 讓滑鼠更好點中
      const hit = `<circle class="tl-hit" data-idx="${e._idx}" cx="${xx.toFixed(1)}" cy="${cy}" r="12" fill="transparent"/>`;
      clipped.push(shape + hit);
    }
  });

  for (const m of s.marks) {
    if (m.t < v0 || m.t > v1) continue;
    const xx = x(m.t);
    clipped.push(`<line x1="${xx.toFixed(1)}" y1="${TOP - 4}" x2="${xx.toFixed(1)}" y2="${mainH}" class="mark"><title>+${(m.t - base).toFixed(3)}s (${fmtClock(m.t)}) ${esc(m.text)}</title></line>`);
    clipped.push(`<text x="${(xx + 3).toFixed(1)}" y="${mainH - 3}" class="marktext">⚑ ${esc(m.text)}</text>`);
  }

  parts.push(`<g clip-path="url(#tl-clip)">${clipped.join("")}</g>`);

  // 底部總覽小地圖（Minimap）：顯示目前放大區間在整段擷取中的位置，也可直接點擊跳轉
  parts.push(`<text x="6" y="${miniTop + 17}" class="rowsub">總覽（點擊跳轉）</text>`);
  parts.push(`<rect x="${LABEL}" y="${miniTop}" width="${plotW}" height="${MINI_H}" class="mini-bg"/>`);
  for (const c of s.connections) {
    const xs = xFull(c.start), xe = xFull(c.end ?? t1);
    parts.push(`<rect x="${xs.toFixed(1)}" y="${miniTop + 4}" width="${Math.max(xe - xs, 2).toFixed(1)}" height="${MINI_H - 8}" class="bar ${c.transport === "LE" ? "le" : "br"}" pointer-events="none"/>`);
  }
  for (const e of s.events) {
    if (e.category === "error" || e.category === "disconnect" || e.category === "mark") {
      const xx = xFull(e.t);
      const col = (CATEGORY[e.category] || {}).color || "#d50000";
      parts.push(`<line x1="${xx.toFixed(1)}" y1="${miniTop + 2}" x2="${xx.toFixed(1)}" y2="${miniTop + MINI_H - 2}" stroke="${col}" stroke-width="1.5" pointer-events="none"/>`);
    }
  }
  const vx0 = xFull(v0), vx1 = xFull(v1);
  parts.push(`<rect x="${vx0.toFixed(1)}" y="${miniTop + 1}" width="${Math.max(vx1 - vx0, 4).toFixed(1)}" height="${MINI_H - 2}" class="mini-vp" pointer-events="none"/>`);

  // 游標十字線、磁吸高亮圈與框選遮罩
  parts.push(`<line id="tl-cursor" x1="0" y1="${TOP - 6}" x2="0" y2="${mainH}" class="tl-cursor" style="display:none" pointer-events="none"/>`);
  parts.push(`<text id="tl-cursor-lbl" x="0" y="${TOP - 10}" class="tl-cursor-lbl" style="display:none" pointer-events="none"></text>`);
  parts.push(`<circle id="tl-snap" cx="0" cy="0" r="8" class="tl-snap" style="display:none" pointer-events="none"/>`);
  parts.push(`<rect id="tl-sel" x="0" y="${TOP - 6}" width="0" height="${mainH - TOP + 6}" class="tl-sel" style="display:none" pointer-events="none"/>`);

  tlView.evPoints = evPoints;
  el.innerHTML = `<svg id="tl-svg" width="${W}" height="${H}">${parts.join("")}</svg>`;
  bindTimelineEvents(el, LABEL, plotW, TOP, mainH, miniTop, MINI_H, ROW);
}

function selectTimelineEvent(e, cluster, scrollTable = true) {
  if (!tlView || !e) return;
  tlView.selectedIdx = e._idx;
  const base = tlView.base;
  const list = cluster && cluster.length > 1 ? cluster : [e];

  if ($("tl-detail")) {
    const itemsHtml = list.map((ev) => {
      const cat = CATEGORY[ev.category] || { label: ev.category, color: "#555" };
      const rel = "+" + (ev.t - base).toFixed(3) + "s";
      const active = ev._idx === e._idx ? " active" : "";
      return `<div class="tl-det-item${active}" data-idx="${ev._idx}">
        <span class="tl-det-time">${esc(rel)} (${fmtClock(ev.t)})</span>
        <span class="tl-det-conn">${ev.conn == null ? "-" : "#" + ev.conn}</span>
        <b style="color:${cat.color}">[${esc(cat.label)}]</b>
        <b>${esc(ev.title)}</b> <span>${esc(ev.detail)}</span>
      </div>`;
    }).join("");
    const head = list.length > 1 ? `<div class="tl-det-head">此位置共有 ${list.length} 筆相近事件（點擊項目可切換定位）：</div>` : "";
    $("tl-detail").innerHTML = head + itemsHtml;
    for (const item of $("tl-detail").querySelectorAll(".tl-det-item")) {
      item.onclick = () => {
        const target = tlView.s.events.find((x) => x._idx === Number(item.dataset.idx));
        if (target) selectTimelineEvent(target, list, true);
      };
    }
  }

  // 更新 SVG 上的選取外框
  for (const node of document.querySelectorAll("#tl-svg .tl-ev")) {
    node.classList.toggle("selected", Number(node.dataset.idx) === e._idx);
  }

  if (scrollTable) {
    // 優先在「全部事件」找，若因篩選隱藏則自動勾回該類別
    let row = document.querySelector(`#all-events tr[data-idx="${e._idx}"]`) || document.querySelector(`tr[data-idx="${e._idx}"]`);
    if (!row) {
      const cb = document.querySelector(`.filters input[data-cat="${e.category}"]`);
      if (cb && !cb.checked) {
        cb.checked = true;
        if (window._updateAllEvents) window._updateAllEvents();
        row = document.querySelector(`#all-events tr[data-idx="${e._idx}"]`);
      }
    }
    if (row) {
      document.querySelectorAll("tr.hl").forEach((r) => r.classList.remove("hl"));
      row.classList.add("hl");
      row.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
}

function findNearestEvents(mx, my, maxDist = 24) {
  if (!tlView || !tlView.evPoints) return { best: null, cluster: [] };
  let best = null, bestD = maxDist;
  for (const p of tlView.evPoints) {
    // 同列優先：給予垂直距離較高權重
    const d = Math.hypot(p.xx - mx, (p.cy - my) * 1.25);
    if (d < bestD) { bestD = d; best = p; }
  }
  if (!best) return { best: null, cluster: [] };
  // 找出同一列中 X 座標相距 10px 內的重疊/密集事件群組
  const cluster = tlView.evPoints
    .filter((p) => p.rowIdx === best.rowIdx && Math.abs(p.xx - best.xx) <= 10)
    .map((p) => p.e);
  return { best, cluster };
}

function bindTimelineEvents(el, LABEL, plotW, TOP, mainH, miniTop, MINI_H, ROW) {
  const svg = $("tl-svg");
  if (!svg || !tlView) return;

  const pxToRatio = (clientX) => {
    const rect = svg.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left - LABEL) / plotW));
  };

  // 滾輪以滑鼠所在時間點為中心縮放
  svg.addEventListener("wheel", (e) => {
    const rect = svg.getBoundingClientRect();
    if (e.clientX - rect.left < LABEL) return;
    e.preventDefault();
    const ratio = pxToRatio(e.clientX);
    const factor = e.deltaY < 0 ? 0.72 : 1.38;
    const span = tlView.v1 - tlView.v0;
    const center = tlView.v0 + span * ratio;
    const full = tlView.t1 - tlView.t0;
    const newSpan = Math.max(Math.min(0.02, full), Math.min(full, span * factor));
    let nv0 = center - newSpan * ratio, nv1 = center + newSpan * (1 - ratio);
    if (nv0 < tlView.t0) { nv0 = tlView.t0; nv1 = nv0 + newSpan; }
    if (nv1 > tlView.t1) { nv1 = tlView.t1; nv0 = Math.max(tlView.t0, nv1 - newSpan); }
    tlView.v0 = nv0; tlView.v1 = nv1;
    drawTimeline();
    if (window._updateAllEvents) window._updateAllEvents();
  }, { passive: false });

  // 雙擊還原完整範圍
  svg.addEventListener("dblclick", () => {
    tlView.v0 = tlView.t0; tlView.v1 = tlView.t1;
    drawTimeline();
    if (window._updateAllEvents) window._updateAllEvents();
  });

  // 拖曳平移 / Shift+拖曳框選放大 / 點擊小地圖跳轉 / 點擊就近磁吸選取事件
  svg.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const rect = svg.getBoundingClientRect();
    const x0 = e.clientX - rect.left, y0 = e.clientY - rect.top;
    if (x0 < LABEL || x0 > LABEL + plotW) return;

    // 點擊底部小地圖：將視窗中心移到該位置
    if (y0 >= miniTop && y0 <= miniTop + MINI_H) {
      const clickT = tlView.t0 + ((x0 - LABEL) / plotW) * (tlView.t1 - tlView.t0);
      const span = tlView.v1 - tlView.v0;
      let nv0 = clickT - span / 2, nv1 = clickT + span / 2;
      if (nv0 < tlView.t0) { nv0 = tlView.t0; nv1 = nv0 + span; }
      if (nv1 > tlView.t1) { nv1 = tlView.t1; nv0 = Math.max(tlView.t0, nv1 - span); }
      tlView.v0 = nv0; tlView.v1 = nv1;
      drawTimeline();
      if (window._updateAllEvents) window._updateAllEvents();
      return;
    }

    const startV0 = tlView.v0, startV1 = tlView.v1, span = startV1 - startV0;
    const isBrush = e.shiftKey;
    const sel = $("tl-sel");
    let moved = false;

    const onMove = (me) => {
      const mx = Math.max(LABEL, Math.min(LABEL + plotW, me.clientX - rect.left));
      if (Math.abs(mx - x0) > 4) moved = true;
      if (isBrush && sel) {
        const left = Math.min(x0, mx), w = Math.abs(mx - x0);
        sel.setAttribute("x", left);
        sel.setAttribute("width", w);
        sel.style.display = w > 3 ? "" : "none";
      } else if (!isBrush && moved) {
        const dt = -((mx - x0) / plotW) * span;
        let nv0 = startV0 + dt, nv1 = startV1 + dt;
        if (nv0 < tlView.t0) { nv0 = tlView.t0; nv1 = nv0 + span; }
        if (nv1 > tlView.t1) { nv1 = tlView.t1; nv0 = Math.max(tlView.t0, nv1 - span); }
        tlView.v0 = nv0; tlView.v1 = nv1;
        drawTimeline();
      }
    };
    const onUp = (ue) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (isBrush) {
        const mx = Math.max(LABEL, Math.min(LABEL + plotW, ue.clientX - rect.left));
        if (Math.abs(mx - x0) > 6) {
          const r1 = (Math.min(x0, mx) - LABEL) / plotW;
          const r2 = (Math.max(x0, mx) - LABEL) / plotW;
          tlView.v0 = startV0 + r1 * span;
          tlView.v1 = startV0 + r2 * span;
          drawTimeline();
        } else if (sel) {
          sel.style.display = "none";
        }
        if (window._updateAllEvents) window._updateAllEvents();
      } else if (!moved) {
        // 單純點擊（沒有拖曳）：自動磁吸選取半徑 24px 內最近的事件點
        const hitIdx = ue.target?.dataset?.idx;
        if (hitIdx !== undefined && hitIdx !== "") {
          const p = tlView.evPoints.find((pt) => pt.e._idx === Number(hitIdx));
          if (p) {
            const cluster = tlView.evPoints
              .filter((pt) => pt.rowIdx === p.rowIdx && Math.abs(pt.xx - p.xx) <= 10)
              .map((pt) => pt.e);
            selectTimelineEvent(p.e, cluster, true);
            return;
          }
        }
        const { best, cluster } = findNearestEvents(x0, y0, 24);
        if (best) selectTimelineEvent(best.e, cluster, true);
      } else {
        if (window._updateAllEvents) window._updateAllEvents();
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });

  // 滑鼠移動時顯示時間十字準線與最近事件磁吸圈
  svg.addEventListener("mousemove", (e) => {
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const cur = $("tl-cursor"), lbl = $("tl-cursor-lbl"), snap = $("tl-snap");
    if (!cur || !lbl) return;
    if (mx < LABEL || mx > LABEL + plotW || my < TOP - 6 || my > mainH) {
      cur.style.display = lbl.style.display = "none";
      if (snap) snap.style.display = "none";
      return;
    }
    const { best } = findNearestEvents(mx, my, 24);
    if (snap) {
      if (best) {
        snap.setAttribute("cx", best.xx.toFixed(1));
        snap.setAttribute("cy", best.cy);
        snap.style.display = "";
        svg.style.cursor = "pointer";
      } else {
        snap.style.display = "none";
        svg.style.cursor = "";
      }
    }
    const t = best ? best.e.t : tlView.v0 + ((mx - LABEL) / plotW) * (tlView.v1 - tlView.v0);
    const cx = best ? best.xx : mx;
    cur.setAttribute("x1", cx); cur.setAttribute("x2", cx);
    lbl.setAttribute("x", Math.min(LABEL + plotW - 60, Math.max(LABEL + 50, cx)));
    lbl.textContent = best ? `+${(t - tlView.base).toFixed(3)}s ${best.e.title.slice(0, 14)}` : `+${(t - tlView.base).toFixed(3)}s`;
    cur.style.display = lbl.style.display = "";
  });
  svg.addEventListener("mouseleave", () => {
    if ($("tl-cursor")) $("tl-cursor").style.display = "none";
    if ($("tl-cursor-lbl")) $("tl-cursor-lbl").style.display = "none";
    if ($("tl-snap")) $("tl-snap").style.display = "none";
  });
}

// ---------- 視覺化模擬動作（儀表 ⇄ 手機 封包互傳動畫） ----------
let simState = null;

function inferDirection(s, e) {
  const title = e.title || "", detail = e.detail || "";
  if (e.category === "mark") return { dir: "mark", label: "現場標記" };
  if (detail.includes("本機→對端") || title.includes("（本機）") || title.includes("（本機 發出）") || detail.startsWith("本機發起")) {
    return { dir: "m2p", label: "儀表 ➔ 手機" };
  }
  if (detail.includes("對端→本機") || title.includes("（對端）") || title.includes("（對端 發出）") || detail.startsWith("對端發起")) {
    return { dir: "p2m", label: "手機 ➔ 儀表" };
  }
  if (/本機要求斷線|Link Key Request Reply|Link Key Request Negative Reply|本機 IO Capability|IO Capability Negative Reply|User Confirmation 接受|User Confirmation 拒絕|Authentication Requested|Set Connection Encryption|LE Start Encryption|LTK Request Reply|LTK Request Negative Reply/.test(title)) {
    return { dir: "m2p", label: "儀表 ➔ 手機" };
  }
  if (/對端 IO Capability|Link Key Request|IO Capability Request|User Confirmation Request|LE LTK Request/.test(title)) {
    return { dir: "p2m", label: "手機 ➔ 儀表" };
  }
  if (e.category === "disconnect") {
    const c = e.conn != null ? s.connections[e.conn] : null;
    if (c && c.disconnect_by === "local") return { dir: "m2p", label: "儀表主動斷線 ➔" };
    if (c && c.disconnect_by === "remote") return { dir: "p2m", label: "⬅ 手機端斷線/超時" };
  }
  return { dir: "both", label: "雙向 / 狀態變更" };
}

function stopSimTimer() {
  if (simState && simState.timer) {
    clearTimeout(simState.timer);
    simState.timer = null;
  }
  if (simState) simState.playing = false;
  if ($("sim-play")) $("sim-play").textContent = "▶ 播放";
}

function toggleSimulator() {
  const panel = $("sim-panel");
  if (!panel || !tlView) return;
  if (panel.style.display !== "none") {
    stopSimTimer();
    panel.style.display = "none";
    return;
  }
  const s = tlView.s;
  // 若時間軸有放大，預設模擬目前放大區間內的事件；若無則模擬全部事件
  const inZoom = (tlView.t1 - tlView.t0) / (tlView.v1 - tlView.v0) > 1.05;
  const list = s.events.filter((e) => !inZoom || (e.t >= tlView.v0 - 1e-6 && e.t <= tlView.v1 + 1e-6));
  if (!list.length) {
    alert("目前時間軸區間內沒有事件可模擬");
    return;
  }
  simState = { s, list, idx: 0, playing: false, speed: 1, mode: "step", timer: null };
  panel.style.display = "";

  const phoneName = s.meta.phone || "手機";
  const appName = s.meta.app ? `（${s.meta.app}）` : "";
  panel.innerHTML = `
    <div class="sim-bar">
      <div class="sim-controls">
        <button id="sim-prev" title="上一步">⏮</button>
        <button id="sim-play" class="primary">▶ 播放</button>
        <button id="sim-next" title="下一步">⏭</button>
        <input id="sim-slider" type="range" min="0" max="${list.length - 1}" value="0">
        <span id="sim-step-lbl" class="sim-step-lbl">1 / ${list.length}</span>
      </div>
      <div class="sim-opts">
        <label>節奏
          <select id="sim-mode">
            <option value="step">依序逐步（適合看清每顆封包）</option>
            <option value="real">依真實時間間隔</option>
          </select>
        </label>
        <label>速度
          <select id="sim-speed">
            <option value="0.5">0.5x 慢動作</option>
            <option value="1" selected>1x 標準</option>
            <option value="2">2x 快轉</option>
            <option value="4">4x 極速</option>
          </select>
        </label>
        <button id="sim-close" title="關閉模擬器">✕ 關閉</button>
      </div>
    </div>
    <div class="sim-stage">
      <div class="sim-node meter">
        <div class="sim-icon">📟</div>
        <div class="sim-node-title">儀表（本機）</div>
        <div class="sim-node-sub">${esc(s.meta.host || "hci0")}</div>
        <div id="sim-meter-state" class="sim-node-state">待機</div>
      </div>
      <div class="sim-lanes">
        <div class="sim-lane" id="sim-lane-br">
          <div class="sim-lane-head"><span class="tag br">BR/EDR 傳統藍牙</span> <span id="sim-br-status" class="sim-lane-st">未連線</span></div>
          <div class="sim-track" id="sim-track-br"><div class="sim-line"></div><div id="sim-pkt-br" class="sim-pkt-wrap"></div></div>
        </div>
        <div class="sim-lane" id="sim-lane-le">
          <div class="sim-lane-head"><span class="tag le">BLE 低功耗藍牙</span> <span id="sim-le-status" class="sim-lane-st">未連線</span></div>
          <div class="sim-track" id="sim-track-le"><div class="sim-line"></div><div id="sim-pkt-le" class="sim-pkt-wrap"></div></div>
        </div>
        <div id="sim-banner" class="sim-banner"></div>
      </div>
      <div class="sim-node phone">
        <div class="sim-icon">📱</div>
        <div class="sim-node-title">${esc(phoneName)}</div>
        <div class="sim-node-sub">對端${esc(appName)}</div>
        <div id="sim-phone-state" class="sim-node-state">待機</div>
      </div>
    </div>
    <div class="sim-feed-head">封包與事件紀錄流（點擊任一列可跳至該步驟）</div>
    <div id="sim-feed" class="sim-feed"></div>`;

  $("sim-prev").onclick = () => { stopSimTimer(); renderSimStep(Math.max(0, simState.idx - 1)); };
  $("sim-next").onclick = () => { stopSimTimer(); renderSimStep(Math.min(simState.list.length - 1, simState.idx + 1)); };
  $("sim-slider").oninput = (e) => { stopSimTimer(); renderSimStep(Number(e.target.value)); };
  $("sim-mode").onchange = (e) => { simState.mode = e.target.value; };
  $("sim-speed").onchange = (e) => { simState.speed = Number(e.target.value); };
  $("sim-close").onclick = toggleSimulator;
  $("sim-play").onclick = () => {
    if (simState.playing) {
      stopSimTimer();
    } else {
      if (simState.idx >= simState.list.length - 1) simState.idx = 0;
      simState.playing = true;
      $("sim-play").textContent = "⏸ 暫停";
      scheduleNextSimStep(true);
    }
  };

  // 直接開始自動播放
  simState.playing = true;
  $("sim-play").textContent = "⏸ 暫停";
  scheduleNextSimStep(true);
}

function scheduleNextSimStep(immediate = false) {
  if (!simState || !simState.playing) return;
  const run = () => {
    if (!simState || !simState.playing) return;
    renderSimStep(simState.idx);
    if (simState.idx >= simState.list.length - 1) {
      stopSimTimer();
      return;
    }
    const cur = simState.list[simState.idx];
    const nxt = simState.list[simState.idx + 1];
    simState.idx++;
    let delay = 950 / simState.speed;
    if (simState.mode === "real") {
      const dt = Math.max(0.08, Math.min(2.5, nxt.t - cur.t));
      delay = (dt * 1000) / simState.speed;
    }
    simState.timer = setTimeout(run, delay);
  };
  if (immediate) run();
  else simState.timer = setTimeout(run, 950 / simState.speed);
}

function renderSimStep(idx) {
  if (!simState) return;
  simState.idx = idx;
  const { s, list } = simState;
  const e = list[idx];
  const base = tlView.base;
  const rel = "+" + (e.t - base).toFixed(3) + "s";

  if ($("sim-slider")) $("sim-slider").value = idx;
  if ($("sim-step-lbl")) $("sim-step-lbl").textContent = `${idx + 1} / ${list.length}（${rel}）`;

  // 計算截至目前時間點 t 的 BR/EDR 與 LE 連線狀態
  const activeState = (transport) => {
    const conns = s.connections.filter((c) => c.transport === transport && c.start <= e.t + 1e-6 && (c.end == null || c.end >= e.t - 1e-6));
    if (!conns.length) return { open: false, enc: false, gatt: false, text: "未連線" };
    const c = conns[conns.length - 1];
    const enc = c.encrypted_at != null && c.encrypted_at <= e.t + 1e-6;
    const gatt = c.gatt && (transport === "LE" || s.events.some((x) => x.conn === c.id && x.category === "att" && x.t <= e.t + 1e-6));
    return {
      open: true, enc, gatt, conn: c,
      text: `#${c.id} 連線中 (${hex4(c.handle)})${enc ? " 🔒已加密" : " 🔓未加密"}${gatt ? " 📡GATT" : ""}`
    };
  };
  const brSt = activeState("BR/EDR");
  const leSt = activeState("LE");

  const setLane = (id, st) => {
    const lane = $("sim-lane-" + id), lbl = $("sim-" + id + "-status");
    if (!lane || !lbl) return;
    lane.classList.toggle("active", st.open);
    lane.classList.toggle("encrypted", st.enc);
    lbl.textContent = st.text;
  };
  setLane("br", brSt);
  setLane("le", leSt);

  // 判斷本事件屬於哪一條通道與傳送方向
  const conn = e.conn != null ? s.connections[e.conn] : null;
  const laneKey = conn ? (conn.transport === "LE" ? "le" : "br") : (e.category === "pair_le" ? "le" : "br");
  const dirInfo = inferDirection(s, e);
  const cat = CATEGORY[e.category] || { label: e.category, color: "#555" };

  $("sim-pkt-br").innerHTML = "";
  $("sim-pkt-le").innerHTML = "";

  if ($("sim-meter-state") && $("sim-phone-state")) {
    $("sim-meter-state").textContent = dirInfo.dir === "m2p" ? "📤 發送封包" : dirInfo.dir === "p2m" ? "📥 接收封包" : "⚡ 狀態更新";
    $("sim-phone-state").textContent = dirInfo.dir === "p2m" ? "📤 發送封包" : dirInfo.dir === "m2p" ? "📥 接收封包" : "⚡ 狀態更新";
  }

  // 在對應通道上播放飛行封包動畫
  const pktWrap = $("sim-pkt-" + laneKey);
  if (pktWrap && e.category !== "mark") {
    const arrow = dirInfo.dir === "m2p" ? "➔" : dirInfo.dir === "p2m" ? "⬅" : "⇄";
    pktWrap.innerHTML = `<div class="sim-packet ${dirInfo.dir}" style="--pkt-color:${cat.color}">
      <span class="sim-pkt-arrow">${arrow}</span>
      <span class="sim-pkt-title">${esc(e.title)}</span>
    </div>`;
  }

  // 中央詳細說明橫幅
  if ($("sim-banner")) {
    const isErr = e.category === "error" || e.category === "disconnect";
    $("sim-banner").className = "sim-banner " + (e.category === "mark" ? "mark" : isErr ? "err" : "normal");
    $("sim-banner").innerHTML = `
      <div class="sim-ban-top">
        <span class="sim-ban-time">${esc(rel)} (${fmtClock(e.t)})</span>
        <span class="sim-ban-dir">${esc(dirInfo.label)}</span>
        <b style="color:${cat.color}">[${esc(cat.label)}]</b>
        <b>${esc(e.title)}</b>
      </div>
      <div class="sim-ban-detail">${esc(e.detail || "（無額外參數）")}</div>`;
  }

  // 更新下方最近事件流並與時間軸選取狀態同步
  if ($("sim-feed")) {
    const start = Math.max(0, idx - 6), end = Math.min(list.length - 1, idx + 2);
    $("sim-feed").innerHTML = list.slice(start, end + 1).map((ev, i) => {
      const realIdx = start + i;
      const d = inferDirection(s, ev);
      const c = CATEGORY[ev.category] || { label: ev.category, color: "#555" };
      const r = "+" + (ev.t - base).toFixed(3) + "s";
      const arrow = d.dir === "m2p" ? "儀表 ➔ 手機" : d.dir === "p2m" ? "儀表 ⬅ 手機" : d.dir === "mark" ? "⚑ 標記" : "儀表 ⇄ 手機";
      return `<div class="sim-feed-row${realIdx === idx ? " current" : ""}" data-sidx="${realIdx}">
        <span class="sim-f-step">#${realIdx + 1}</span>
        <span class="sim-f-time">${esc(r)}</span>
        <span class="sim-f-dir ${d.dir}">${arrow}</span>
        <b style="color:${c.color}">[${esc(c.label)}]</b>
        <b>${esc(ev.title)}</b>
        <span class="sim-f-det">${esc(ev.detail)}</span>
      </div>`;
    }).join("");
    for (const row of $("sim-feed").querySelectorAll(".sim-feed-row")) {
      row.onclick = () => { stopSimTimer(); renderSimStep(Number(row.dataset.sidx)); };
    }
  }

  // 同步時間軸上的選取點（不強制捲動頁面以免干擾看動畫）
  selectTimelineEvent(e, [e], false);
}

// ---------- 儀表連線 ----------
function connBadge(cls, text) {
  const b = $("conn-badge");
  b.className = "badge " + cls;
  b.textContent = text;
}

function renderConn(r) {
  const el = $("conn-result");
  if (r.ok) {
    const cls = r.missing && r.missing.length ? "warn" : "ok";
    connBadge(cls, cls === "ok" ? "已連線" : "缺少工具");
    el.innerHTML = `<div class="msg ${cls}">${esc(r.message)}</div>
      ${r.uname ? `<div class="small">${esc(r.uname)}</div>` : ""}`;
    return;
  }
  connBadge("bad", "無法連線");
  let html = `<div class="msg bad">${esc(r.message)}</div>`;
  if (r.code === "hostkey_changed") {
    html += `<div class="small">儀表目前的金鑰指紋：${esc(r.fingerprint || "未知")}<br>
      若確定這就是你的儀表（例如剛燒錄過），可刪除本機記錄的舊金鑰並重新連線。</div>
      <div class="actions"><button class="danger" id="btn-conn-forget">刪除舊主機金鑰並重試</button></div>`;
  } else if (r.code === "auth_failed") {
    html += `<div class="small">輸入儀表 root 密碼，將本機公鑰安裝到儀表（只需一次，之後免密碼）。若 root 沒有密碼請留空。</div>
      <div class="mark-row"><input id="conn-password" type="password" placeholder="root 密碼">
      <button class="primary" id="btn-conn-install">安裝公鑰</button></div>`;
  }
  if (r.detail) html += `<details><summary class="small">SSH 原始訊息</summary><pre>${esc(r.detail)}</pre></details>`;
  el.innerHTML = html;
  if ($("btn-conn-forget")) $("btn-conn-forget").onclick = forgetHostKey;
  if ($("btn-conn-install")) {
    $("btn-conn-install").onclick = installKey;
    $("conn-password").onkeydown = (e) => { if (e.key === "Enter") installKey(); };
  }
}

async function saveHostIfChanged() {
  const host = $("conn-host").value.trim();
  if (host && host !== $("conn-host").dataset.saved) {
    await api("/api/conn/host", { host });
    $("conn-host").dataset.saved = host;
    log("儀表位址已設為 " + host);
  }
}

async function connAction(label, fn) {
  connBadge("testing", label);
  $("btn-conn-test").disabled = true;
  try {
    await saveHostIfChanged();
    renderConn(await fn());
  } catch (e) {
    connBadge("bad", "失敗");
    $("conn-result").innerHTML = `<div class="msg bad">${esc(e.message).replace(/\n/g, "<br>")}</div>`;
  }
  $("btn-conn-test").disabled = false;
}

// 連線結果包在 result 裡：外層 ok 表示 API 呼叫成功，result.ok 才是「連不連得上儀表」
const testConn = () => connAction("測試中…", async () => (await api("/api/conn/test", {})).result);

function forgetHostKey() {
  if (!confirm(`確定要刪除本機記錄的 ${$("conn-host").value} 主機金鑰嗎？\n請確認這台確實是你的儀表。`)) return;
  connAction("刪除金鑰中…", async () => {
    const r = await api("/api/conn/forget", {});
    log("已刪除舊主機金鑰: " + (r.output || "完成"));
    return r.test;
  });
}

function installKey() {
  const password = $("conn-password").value;
  connAction("安裝公鑰中…", async () => {
    const r = await api("/api/conn/install-key", { password });
    log("已安裝公鑰到儀表");
    return r.test;
  });
}

async function initConn() {
  const c = await api("/api/conn");
  $("conn-host").value = $("conn-host").dataset.saved = c.host;
  $("conn-host").disabled = c.env_locked;
  if (c.env_locked) $("conn-host").dataset.envLocked = "1";
  $("btn-conn-test").onclick = testConn;
  $("conn-host").onkeydown = (e) => { if (e.key === "Enter") testConn(); };
  testConn();
}

// ---------- init ----------
$("download-form").onsubmit = downloadArchive;
$("download-files").onchange = updateDownloadSelection;
$("download-choose").onclick = chooseDownloadDestination;
$("download-name").oninput = () => {
  if (!archiveSaveFile) return;
  archiveSaveFile = null;
  $("download-destination").value = "檔名已變更，請重新選擇儲存位置";
};
$("download-cancel").onclick = () => $("download-dialog").close();
$("download-dialog").oncancel = (e) => { if (archiveBusy) e.preventDefault(); };
for (const [id, checked] of [["download-all", true], ["download-none", false]]) {
  $(id).onclick = () => {
    for (const cb of $("download-files").querySelectorAll("input")) cb.checked = checked;
    updateDownloadSelection();
  };
}
$("folder-create").onclick = () => manageFolder("create");
$("folder-rename").onclick = () => manageFolder("rename");
$("folder-delete").onclick = () => manageFolder("delete");
$("scenario").innerHTML = SCENARIOS.map((s) => `<option>${esc(s)}</option>`).join("");
$("phone").value = localStorage.getItem("phone") || "";
$("btn-start").onclick = start;
$("btn-stop").onclick = stop;
$("btn-force-stop").onclick = forceStop;
$("btn-mark").onclick = mark;
$("mark-text").onkeydown = (e) => { if (e.key === "Enter") mark(); };
window.reanalyze = reanalyze;
window.deleteCapture = deleteCapture;
window.toggleSimulator = toggleSimulator;
initConn();
loadCaptures();
poll();
setInterval(poll, 1000);
