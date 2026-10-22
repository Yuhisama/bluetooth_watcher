"use strict";

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
  applog: { label: "App 日誌", color: "#607d8b" },
  error: { label: "錯誤", color: "#d50000" },
  mark: { label: "標記", color: "#f9a825" },
};

// 數量多的類別預設不勾選，也不畫在時間軸（時間軸已有 notify/s 長條）
const DEFAULT_OFF = new Set(["notify", "applog"]);

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hex4 = (n) => "0x" + n.toString(16).toUpperCase().padStart(4, "0");

let state = "idle";
let currentId = null;
let captureList = [];
let folders = [];
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
  $("capture-form").disabled = capturing;
  if (!$("conn-host").dataset.envLocked) $("conn-host").disabled = capturing;
  const dot = $("tab-capture").querySelector(".tab-dot");
  if (dot) dot.hidden = !capturing;
  const st = $("state");
  st.className = "state " + state;
  if (capturing) {
    const m = s.current.meta;
    const sec = Math.floor(s.current.elapsed);
    st.textContent = `擷取中 ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}｜${m.scenario}｜${devicesSummary(m)}`;
  } else {
    st.textContent = "閒置";
  }
}

async function poll() {
  try {
    applyState(await api("/api/status"));
    $("host-status").textContent = "";
    refreshLive();
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
    const devices = readDevices();
    const r = await api("/api/start", { scenario: $("scenario").value.trim(), devices });
    if (captureOperation !== operation) return;
    log("已開始: " + r.output);
    store.set("scenario", $("scenario").value.trim());
    presets.last_devices = devices;
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
    if (r.id) {
      lastFinishedId = r.id;
      setTab("records");
      openCapture(r.id);
    }
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

// ---------- 裝置 ----------
const DEVICE_ICONS = { "手機": "📱", "MOB/FOB": "🛟", "耳機": "🎧" };
const deviceIcon = (type) => DEVICE_ICONS[type] || "🔷";
let presets = { favorites: [], device_sets: [], device_types: ["手機", "MOB/FOB", "耳機", "其他"], last_devices: [] };

// 舊紀錄只有 phone/app 欄位，視為一支手機
function metaDevices(m) {
  if (m.devices?.length) return m.devices;
  if (m.phone || m.app) return [{ type: "手機", name: m.phone || "", app: m.app || "" }];
  return [];
}

const deviceLabel = (d) => `${deviceIcon(d.type)} ${d.name || d.type}`;
const devicesSummary = (m) => metaDevices(m).map((d) => deviceLabel(d) + (d.app ? `（${d.app}）` : "")).join("、") || "未指定裝置";

// 同一裝置的 LE（RPA）與 BR 連線以 identity address 合併成一組
const connKey = (c) => c.identity_address || c.address;

// 每組連線對應到哪個裝置：手動指定優先；否則用金鑰快照中的裝置名稱比對；
// 只有一個裝置且只有一組連線時直接對應。index -1 表示「不屬於列出的裝置」。
function resolvePeers(s) {
  const devices = metaDevices(s.meta);
  const manual = s.organization?.device_map || {};
  const names = {};
  for (const [addr, a] of Object.entries(s.adverts || {})) if (a.name) names[addr.toUpperCase()] = a.name;
  // 金鑰快照：{before|after: {adapter: {address: {name}}}}，結束時的名稱優先
  for (const snap of [s.keys?.before, s.keys?.after]) {
    for (const devs of Object.values(snap || {})) {
      for (const [addr, info] of Object.entries(devs)) if (info.name) names[addr.toUpperCase()] = info.name;
    }
  }
  // IRK 交換前的 LE 連線沒有 identity；同一 RPA 之後若有連線解析出 identity，就沿用它
  const identity = {};
  for (const c of s.connections) if (c.identity_address) identity[c.address] = c.identity_address;
  for (const c of s.connections) if (!c.identity_address && identity[c.address]) c.identity_address = identity[c.address];
  const keys = [...new Set(s.connections.map(connKey))];
  const peers = {};
  for (const key of keys) {
    const seen = names[key.toUpperCase()] || "";
    const auto = !(key in manual);
    let index = auto ? null : manual[key];
    if (auto) {
      const n = seen.toLowerCase();
      const hit = n ? devices.findIndex((d) => d.name && (n.includes(d.name.toLowerCase()) || d.name.toLowerCase().includes(n))) : -1;
      if (hit >= 0) index = hit;
      else if (devices.length === 1 && keys.length === 1) index = 0;
    }
    const device = index != null && index >= 0 ? devices[index] : null;
    // 裝置沒填名稱時（例如 FOB），用金鑰或廣播中的名稱
    const label = device ? `${deviceIcon(device.type)} ${device.name || seen || device.type}` : `🔷 ${seen || key}`;
    peers[key] = { key, index, auto, device, seen, label };
  }
  return peers;
}

function peerOf(s, e) {
  const c = e.conn != null ? s.connections[e.conn] : null;
  return c ? s.peers[connKey(c)] : null;
}

// ---------- 擷取表單：情境、裝置 ----------
function renderScenarioOptions() {
  const favorites = presets.favorites;
  const recent = [...new Set(captureList.map((c) => c.meta.scenario).filter(Boolean))].filter((x) => !favorites.includes(x));
  $("scenario-list").innerHTML = favorites.map((x) => `<option value="${esc(x)}">★ 最愛</option>`).join("") +
    recent.map((x) => `<option value="${esc(x)}">最近使用</option>`).join("");
  updateFavButton();
}

function updateFavButton() {
  const on = presets.favorites.includes($("scenario").value.trim());
  $("scenario-fav").textContent = on ? "★" : "☆";
  $("scenario-fav").classList.toggle("on", on);
}

async function savePresets(changes) {
  try {
    presets = (await api("/api/presets", changes)).presets;
  } catch (e) {
    alert(e.status === 404 ? "伺服器尚未更新，請重啟 server.py 後再儲存。" : "儲存失敗: " + e.message);
  }
  renderScenarioOptions();
  renderDeviceSets();
}

function toggleFavorite() {
  const value = $("scenario").value.trim();
  if (!value) return;
  const favorites = presets.favorites.includes(value) ? presets.favorites.filter((x) => x !== value) : [value, ...presets.favorites];
  savePresets({ favorites });
}

function renderDevices(devices) {
  $("devices").innerHTML = devices.map((d) => {
    const types = [...new Set([...presets.device_types, d.type].filter(Boolean))];
    return `<div class="device-row">
      <select data-f="type" aria-label="裝置類型">${types.map((t) => `<option${t === d.type ? " selected" : ""}>${esc(t)}</option>`).join("")}</select>
      <input data-f="name" list="device-names" maxlength="120" placeholder="名稱，例如 iPhone 12" value="${esc(d.name || "")}">
      <input data-f="app" list="device-apps" maxlength="120" placeholder="App（選填）" value="${esc(d.app || "")}">
      <button type="button" data-remove title="移除">✕</button></div>`;
  }).join("") || `<div class="devices-empty">未指定裝置</div>`;
}

// keepEmpty：編輯中保留空白列；送出時只留有名稱或 App 的裝置
function readDevices(keepEmpty = false) {
  return [...$("devices").querySelectorAll(".device-row")].map((row) => {
    const d = {};
    for (const el of row.querySelectorAll("[data-f]")) d[el.dataset.f] = el.value.trim();
    return d;
  }).filter((d) => keepEmpty || d.name || d.app);
}

function renderDeviceSets() {
  const current = $("device-set").value;
  $("device-set").innerHTML = `<option value="">套用裝置組合…</option>` +
    presets.device_sets.map((x) => `<option value="${esc(x.name)}"${x.name === current ? " selected" : ""}>${esc(x.name)}</option>`).join("");
  $("device-set-delete").disabled = !presets.device_sets.some((x) => x.name === $("device-set").value);
}

function saveDeviceSet() {
  const devices = readDevices();
  if (!devices.length) return alert("請先填入至少一個裝置");
  const name = prompt("裝置組合名稱：", $("device-set").value || devices.map((d) => d.name || d.type).join(" + "));
  if (!name?.trim()) return;
  const sets = presets.device_sets.filter((x) => x.name !== name.trim());
  savePresets({ device_sets: [...sets, { name: name.trim(), devices }] }).then(() => {
    $("device-set").value = name.trim();
    renderDeviceSets();
  });
}

function deleteDeviceSet() {
  const name = $("device-set").value;
  if (!name || !confirm(`刪除裝置組合「${name}」？`)) return;
  $("device-set").value = "";
  savePresets({ device_sets: presets.device_sets.filter((x) => x.name !== name) });
}

function renderDeviceHints() {
  const all = captureList.flatMap((c) => metaDevices(c.meta));
  const uniq = (values) => [...new Set(values.filter(Boolean))];
  $("device-names").innerHTML = uniq(all.map((d) => d.name)).map((x) => `<option value="${esc(x)}">`).join("");
  $("device-apps").innerHTML = uniq(["客戶App", "nRF Connect", "系統設定", ...all.map((d) => d.app)]).map((x) => `<option value="${esc(x)}">`).join("");
}

async function initCaptureForm() {
  try {
    presets = { ...presets, ...(await api("/api/presets")) };
  } catch (e) {
    if (e.status !== 404) log("讀取最愛失敗: " + e.message);
  }
  $("scenario").value = store.get("scenario", "");
  renderDevices(presets.last_devices.length ? presets.last_devices : [{ type: presets.device_types[0] }]);
  renderDeviceSets();
  renderScenarioOptions();
  $("scenario").oninput = updateFavButton;
  $("scenario-fav").onclick = toggleFavorite;
  $("device-add").onclick = () => renderDevices([...readDevices(true), { type: presets.device_types[0] }]);
  $("devices").onclick = (e) => {
    const row = e.target.closest("[data-remove]")?.closest(".device-row");
    if (!row) return;
    row.remove();
    if (!readDevices(true).length) renderDevices([]);
  };
  $("device-set").onchange = () => {
    const set = presets.device_sets.find((x) => x.name === $("device-set").value);
    if (set) renderDevices(set.devices);
    renderDeviceSets();
  };
  $("device-set-save").onclick = saveDeviceSet;
  $("device-set-delete").onclick = deleteDeviceSet;
}

// ---------- 紀錄樹 ----------
// 資料夾以 parent 形成樹（"" 為根）；紀錄是葉節點，依 folder 掛在對應資料夾下。
const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
};
let expanded = new Set(store.get("tree-expanded", []));
let treeSelection = null; // {type: "folder" | "capture", id}
let treeFilter = "";

async function loadCaptures() {
  const folderRequest = api("/api/folders").catch((e) => {
    if (e.status !== 404) throw e;
    log("伺服器尚未更新，請重啟 server.py 以啟用改名與資料夾分類；現有紀錄仍可檢視。");
    return [];
  });
  [captureList, folders] = await Promise.all([api("/api/captures"), folderRequest]);
  renderTree();
  renderScenarioOptions();
  renderDeviceHints();
}

const folderById = (id) => folders.find((f) => f.id === id);
const folderParent = (f) => (folderById(f.parent) ? f.parent : "");
const captureFolder = (c) => (folderById(c.folder) ? c.folder : "");
const captureTitle = (c) => c.name || (c.incomplete ? "（不完整：擷取啟動失敗）" : c.meta.scenario) || c.id;

function captureMatches(c, q) {
  const devices = metaDevices(c.meta).flatMap((d) => [d.type, d.name, d.app]);
  return [captureTitle(c), c.id, c.meta.scenario, ...devices].some((v) => String(v || "").toLowerCase().includes(q));
}

function treeRow(type, id, depth, twisty, icon, label, extra = "") {
  const selected = treeSelection?.type === type && treeSelection.id === id;
  const active = type === "capture" && id === currentId;
  return `<div class="tree-row ${type}${extra}${selected ? " selected" : ""}${active ? " active" : ""}" data-type="${type}" data-id="${esc(id)}" draggable="true" style="--depth:${depth}">` +
    `<span class="twisty">${twisty}</span><span class="tree-icon">${icon}</span><span class="tree-label">${label}</span></div>`;
}

function captureLabel(c) {
  const t = c.meta.start_time ? new Date(c.meta.start_time * 1000).toLocaleString("zh-TW", { hour12: false }) : "";
  const sub = c.incomplete ? esc(c.id) : `${esc(t)}｜${esc(devicesSummary(c.meta))}${c.analyzed ? "" : "｜未分析"}`;
  return `<div class="cap-title tree-name" title="${esc(c.id)}">${esc(captureTitle(c))}</div><div class="cap-sub">${sub}</div>`;
}

function renderTree() {
  const q = treeFilter.trim().toLowerCase();
  const subFolders = new Map();
  const captures = new Map();
  const add = (map, key, value) => (map.get(key) || map.set(key, []).get(key)).push(value);
  for (const f of [...folders].sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"))) add(subFolders, folderParent(f), f);
  for (const c of captureList) add(captures, captureFolder(c), c);
  // 篩選時：資料夾名稱符合則顯示整個子樹；紀錄符合則顯示其上層資料夾並展開。
  const build = (parentId, depth, inherited) => {
    let html = "";
    let count = 0;
    for (const f of subFolders.get(parentId) || []) {
      const hit = inherited || (q && f.name.toLowerCase().includes(q));
      const sub = build(f.id, depth + 1, hit);
      count += sub.count;
      if (q && !hit && !sub.html) continue;
      const open = q ? true : expanded.has(f.id);
      const label = `<span class="tree-name">${esc(f.name)}</span> <span class="tree-count">${sub.count}</span>`;
      html += `<li role="treeitem" aria-expanded="${open}">${treeRow("folder", f.id, depth, open ? "▾" : "▸", open ? "📂" : "📁", label)}` +
        (open ? `<ul role="group">${sub.html}</ul>` : "") + "</li>";
    }
    for (const c of captures.get(parentId) || []) {
      count++;
      if (q && !inherited && !captureMatches(c, q)) continue;
      html += `<li role="treeitem">${treeRow("capture", c.id, depth, "", c.incomplete ? "⚠️" : "📄", captureLabel(c), c.incomplete ? " incomplete" : "")}</li>`;
    }
    return { html, count };
  };
  $("tree").innerHTML = build("", 0, false).html || `<li class="tree-empty">${q ? "沒有符合的紀錄" : "尚無紀錄"}</li>`;
}

function selectTreeItem(type, id) {
  treeSelection = type ? { type, id } : null;
  for (const row of $("tree").querySelectorAll(".tree-row")) {
    row.classList.toggle("selected", row.dataset.type === type && row.dataset.id === id);
  }
}

function toggleFolder(id, open = !expanded.has(id)) {
  if (open) expanded.add(id); else expanded.delete(id);
  store.set("tree-expanded", [...expanded]);
  renderTree();
}

function collapseAll() {
  expanded.clear();
  store.set("tree-expanded", []);
  renderTree();
}

function inlineEdit(container, value, onSave) {
  if (container.querySelector("input")) return;
  const original = container.textContent;
  const input = document.createElement("input");
  input.className = "cap-name-input";
  input.maxLength = 120;
  input.value = value;
  input.setAttribute("aria-label", "名稱");
  input.title = "Enter 儲存，Esc 取消";
  container.replaceChildren(input);
  let finished = false;
  const finish = (cancel = false) => {
    if (finished) return;
    finished = true;
    const name = input.value.trim();
    container.textContent = original;
    if (!cancel && name !== value) onSave(name);
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

// 留空恢復原始情境名稱
function renameCapture(id, title) {
  const c = captureList.find((c) => c.id === id);
  if (!c) return;
  inlineEdit(title, c.name || c.meta.scenario || "", (name) =>
    saveOrganization(id, { name }).catch((e) => alert("改名失敗: " + e.message)));
}

async function saveOrganization(id, changes) {
  await api(`/api/captures/${encodeURIComponent(id)}/organization`, changes);
  await loadCaptures();
  if (currentId === id) await openCapture(id);
}

async function folderAction(action, body) {
  try {
    const r = await api(`/api/folders/${action}`, body);
    await loadCaptures();
    return r.folder;
  } catch (e) {
    alert("資料夾操作失敗: " + e.message);
    return null;
  }
}

function renameFolder(id, nameEl) {
  const f = folderById(id);
  if (!f) return;
  inlineEdit(nameEl, f.name, (name) => name && folderAction("rename", { id, name }));
}

// 在選取的資料夾（或選取紀錄所在的資料夾）中新增，建立後直接進入改名
async function createFolder(parent) {
  if (parent === undefined) {
    const sel = treeSelection;
    parent = sel?.type === "folder" ? sel.id : sel?.type === "capture" ? captureFolder(captureList.find((c) => c.id === sel.id) || {}) : "";
  }
  const siblings = new Set(folders.filter((f) => folderParent(f) === parent).map((f) => f.name));
  let name = "新資料夾";
  for (let i = 2; siblings.has(name); i++) name = `新資料夾 (${i})`;
  if (parent) expanded.add(parent);
  const folder = await folderAction("create", { name, parent });
  if (!folder) return;
  selectTreeItem("folder", folder.id);
  const nameEl = $("tree").querySelector(`.tree-row.folder[data-id="${CSS.escape(folder.id)}"] .tree-name`);
  if (nameEl) renameFolder(folder.id, nameEl);
}

async function deleteFolder(id) {
  const f = folderById(id);
  if (!f || !confirm(`刪除資料夾「${f.name}」？\n裡面的子資料夾與紀錄會移到上一層，擷取檔案會保留。`)) return;
  if (treeSelection?.id === id) treeSelection = null;
  await folderAction("delete", { id });
}

async function moveItem(type, id, folder) {
  try {
    if (type === "capture") {
      if (captureFolder(captureList.find((c) => c.id === id) || {}) === folder) return;
      await saveOrganization(id, { folder });
    } else {
      if (id === folder || folderParent(folderById(id) || {}) === folder) return;
      await api("/api/folders/move", { id, parent: folder });
      await loadCaptures();
    }
    if (folder && !expanded.has(folder)) toggleFolder(folder, true);
    log(`已移到「${folderById(folder)?.name || "根目錄"}」`);
  } catch (e) {
    alert("移動失敗: " + e.message);
  }
}

function renameSelection() {
  const sel = treeSelection;
  const row = sel && $("tree").querySelector(`.tree-row[data-type="${sel.type}"][data-id="${CSS.escape(sel.id)}"]`);
  if (!row) return;
  const nameEl = row.querySelector(".tree-name");
  if (sel.type === "folder") renameFolder(sel.id, nameEl); else renameCapture(sel.id, nameEl);
}

function deleteSelection() {
  const sel = treeSelection;
  if (sel?.type === "folder") deleteFolder(sel.id);
  else if (sel?.type === "capture") deleteCapture(sel.id);
}

// ---------- 右鍵選單 ----------
function showContextMenu(x, y, items) {
  const menu = $("ctx-menu");
  menu.innerHTML = items.map((it, i) => it === "-" ? `<li class="sep"></li>` :
    `<li role="menuitem" data-i="${i}" class="${it.danger ? "danger" : ""}">${esc(it.label)}${it.key ? `<kbd>${it.key}</kbd>` : ""}</li>`).join("");
  menu.hidden = false;
  menu.style.left = Math.min(x, innerWidth - menu.offsetWidth - 4) + "px";
  menu.style.top = Math.min(y, innerHeight - menu.offsetHeight - 4) + "px";
  menu.onclick = (e) => {
    const li = e.target.closest("li[data-i]");
    if (!li) return;
    hideContextMenu();
    items[Number(li.dataset.i)].run();
  };
}

function hideContextMenu() {
  $("ctx-menu").hidden = true;
}

function treeMenuItems(type, id) {
  if (type === "folder") return [
    { label: "新增子資料夾", run: () => createFolder(id) },
    { label: "改名", key: "F2", run: renameSelection },
    { label: "刪除資料夾", key: "Del", danger: true, run: () => deleteFolder(id) },
    "-",
    { label: "全部收合", run: collapseAll },
  ];
  if (type === "capture") return [
    { label: "開啟", key: "Enter", run: () => openCapture(id) },
    { label: "下載 LOG…", run: () => openDownload(id) },
    { label: "改名", key: "F2", run: renameSelection },
    "-",
    { label: "刪除紀錄", key: "Del", danger: true, run: () => deleteCapture(id) },
  ];
  return [
    { label: "新增資料夾", run: () => createFolder("") },
    { label: "全部收合", run: collapseAll },
  ];
}

// ---------- 樹的事件（委派，綁一次） ----------
const TREE_DRAG_TYPE = "application/x-bt-tree";

function initTree() {
  const tree = $("tree");
  const rowOf = (e) => e.target.closest(".tree-row");
  tree.onclick = (e) => {
    const row = rowOf(e);
    if (!row || e.target.closest("input")) return;
    selectTreeItem(row.dataset.type, row.dataset.id);
    if (row.dataset.type === "folder") toggleFolder(row.dataset.id);
    else openCapture(row.dataset.id);
  };
  tree.ondblclick = (e) => {
    const row = rowOf(e);
    if (row?.dataset.type === "capture" && e.target.closest(".tree-name")) renameSelection();
  };
  tree.oncontextmenu = (e) => {
    e.preventDefault();
    const row = rowOf(e);
    if (row) selectTreeItem(row.dataset.type, row.dataset.id);
    showContextMenu(e.clientX, e.clientY, treeMenuItems(row?.dataset.type, row?.dataset.id));
  };
  tree.onkeydown = (e) => {
    if (e.target.closest("input")) return;
    const rows = [...tree.querySelectorAll(".tree-row")];
    const idx = rows.findIndex((r) => r.classList.contains("selected"));
    const row = rows[idx];
    const go = (r) => { if (r) { selectTreeItem(r.dataset.type, r.dataset.id); r.scrollIntoView({ block: "nearest" }); } };
    if (e.key === "F2") renameSelection();
    else if (e.key === "Delete") deleteSelection();
    else if (e.key === "ArrowDown") go(rows[idx + 1] || rows[0]);
    else if (e.key === "ArrowUp") go(rows[Math.max(idx - 1, 0)]);
    else if (e.key === "Enter" && row) row.dataset.type === "folder" ? toggleFolder(row.dataset.id) : openCapture(row.dataset.id);
    else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && row?.dataset.type === "folder") toggleFolder(row.dataset.id, e.key === "ArrowRight");
    else return;
    e.preventDefault();
  };
  const clearDrop = () => {
    tree.classList.remove("drop-root");
    for (const r of tree.querySelectorAll(".drop-target")) r.classList.remove("drop-target");
  };
  tree.ondragstart = (e) => {
    const row = rowOf(e);
    if (!row || row.querySelector("input")) { e.preventDefault(); return; }
    e.dataTransfer.setData(TREE_DRAG_TYPE, JSON.stringify({ type: row.dataset.type, id: row.dataset.id }));
    e.dataTransfer.effectAllowed = "move";
    row.classList.add("dragging");
  };
  tree.ondragend = (e) => {
    rowOf(e)?.classList.remove("dragging");
    clearDrop();
  };
  // 放在資料夾列上移入該資料夾；放在空白處移到根目錄
  tree.ondragover = (e) => {
    if (!Array.from(e.dataTransfer.types).includes(TREE_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    clearDrop();
    const row = rowOf(e);
    if (row?.dataset.type === "folder") row.classList.add("drop-target");
    else if (!row) tree.classList.add("drop-root");
  };
  tree.ondragleave = (e) => { if (!tree.contains(e.relatedTarget)) clearDrop(); };
  tree.ondrop = (e) => {
    e.preventDefault();
    clearDrop();
    const row = rowOf(e);
    if (row && row.dataset.type !== "folder") return;
    let item;
    try { item = JSON.parse(e.dataTransfer.getData(TREE_DRAG_TYPE)); } catch { return; }
    moveItem(item.type, item.id, row ? row.dataset.id : "");
  };
  $("tree-filter").oninput = (e) => { treeFilter = e.target.value; renderTree(); };
  $("tree-new-folder").onclick = () => createFolder();
  $("tree-collapse").onclick = collapseAll;
  addEventListener("mousedown", (e) => { if (!e.target.closest("#ctx-menu")) hideContextMenu(); });
  addEventListener("keydown", (e) => { if (e.key === "Escape") hideContextMenu(); });
  addEventListener("blur", hideContextMenu);
}

// ---------- 側欄頁籤與寬度 ----------
function setTab(name) {
  $("result").hidden = name !== "records";
  $("live").hidden = name !== "capture";
  for (const tab of ["capture", "records"]) {
    $("pane-" + tab).hidden = tab !== name;
    $("tab-" + tab).classList.toggle("active", tab === name);
    $("tab-" + tab).setAttribute("aria-selected", tab === name);
  }
  store.set("side-tab", name);
  if (name === "capture") refreshLive(true);
}

function initSidebar() {
  for (const tab of ["capture", "records"]) $("tab-" + tab).onclick = () => setTab(tab);
  setTab(store.get("side-tab", "records"));
  const main = document.querySelector("main");
  const setWidth = (w) => main.style.setProperty("--sidebar-w", Math.round(Math.max(240, Math.min(w, innerWidth * 0.6))) + "px");
  setWidth(store.get("sidebar-w", 340));
  const resizer = $("resizer");
  resizer.onpointerdown = (e) => {
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    resizer.classList.add("dragging");
    document.body.classList.add("resizing");
    const left = main.getBoundingClientRect().left + 14;
    resizer.onpointermove = (ev) => setWidth(ev.clientX - left);
    resizer.onpointerup = () => {
      resizer.onpointermove = resizer.onpointerup = null;
      resizer.classList.remove("dragging");
      document.body.classList.remove("resizing");
      store.set("sidebar-w", parseInt(main.style.getPropertyValue("--sidebar-w"), 10));
    };
  };
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
  selectTreeItem("capture", id);
  for (const row of $("tree").querySelectorAll(".tree-row.capture")) row.classList.toggle("active", row.dataset.id === id);
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
  s.peers = resolvePeers(s);
  const devicesText = devicesSummary(m);

  let html = `<div class="result-head">
    <h2 class="cap-title" tabindex="0" title="雙擊改名，或按 F2">${esc(organization.name || m.scenario)}</h2>
    <div class="sub">📁 ${esc(folderName)}${organization.name ? `｜${esc(m.scenario)}` : ""}｜${esc(devicesText)}</div>
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
  html += "<h3>掃描到的廣播</h3><p class='hint'>連線中的空封包不經過 HCI，看不到；連線前後的廣播、RSSI 可在此觀察。藍底為本次有連線的裝置。</p>" + advertTable(s, rel);
  html += `<h3>App 日誌（journal）</h3><input id="applog-filter" class="applog-filter" type="search" placeholder="篩選，例如 [FOB]、DISCONNECTED、Alarm">
    <div id="applog">${eventTable(s.events.filter((e) => e.category === "applog"), rel)}</div>`;
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
  $("applog-filter").oninput = (e) => {
    const q = e.target.value.trim().toLowerCase();
    $("applog").innerHTML = eventTable(s.events.filter((x) => x.category === "applog" && (!q || (x.title + " " + x.detail).toLowerCase().includes(q))), rel);
  };
  for (const cb of document.querySelectorAll(".filters input")) cb.onchange = updateAllEvents;
  if ($("tl-sync-events")) $("tl-sync-events").onchange = updateAllEvents;
  $("result").onchange = (e) => {
    const select = e.target.closest("select.conn-device");
    if (!select) return;
    const value = select.value === "auto" ? null : Number(select.value);
    saveOrganization(id, { device_map: { [select.dataset.key]: value } }).catch((err) => alert("儲存失敗: " + err.message));
  };
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

function connTable(s, rel, live = false) {
  if (!s.connections.length) return "<p class='hint'>沒有連線</p>";
  const devices = metaDevices(s.meta);
  const deviceSelect = (c) => {
    const p = s.peers[connKey(c)];
    const option = (value, label) => `<option value="${value}"${!p.auto && String(p.index) === String(value) ? " selected" : ""}>${esc(label)}</option>`;
    if (live) return esc(p.label);
    return `<select class="conn-device${p.auto ? " auto" : ""}" data-key="${esc(p.key)}" title="${p.seen ? "金鑰快照名稱：" + esc(p.seen) : "金鑰快照無名稱"}">
      <option value="auto"${p.auto ? " selected" : ""}>${esc(p.auto ? `自動：${p.label}` : "自動對應")}</option>
      ${devices.map((d, i) => option(i, deviceLabel(d))).join("")}${option(-1, "不屬於列出的裝置")}</select>`;
  };
  return `<div class="scroll"><table><thead><tr><th>#</th><th>裝置</th><th>傳輸層</th><th>Handle</th><th>位址</th><th>本機角色</th>
    <th>開始</th><th>結束</th><th>加密</th><th>連線參數</th><th>RSSI</th><th>GATT 所在</th><th>ATT 封包</th><th>Notify</th><th>寫入</th><th>斷線原因</th></tr></thead><tbody>
    ${s.connections.map((c) => `<tr>
      <td>${c.id}</td><td>${deviceSelect(c)}</td><td><span class="tag ${c.transport === "LE" ? "le" : "br"}">${c.transport}</span></td>
      <td>${hex4(c.handle)}</td>
      <td>${esc(c.address)}${c.address_type ? ` <small>${esc(c.address_type)}</small>` : ""}${c.identity_address ? `<br><small>identity ${esc(c.identity_address)}</small>` : ""}</td>
      <td>${esc(c.role || "-")}</td><td>${rel(c.start)}</td><td>${c.end ? rel(c.end) : "未結束"}</td>
      <td>${c.encrypted_at ? rel(c.encrypted_at) : "<span class='bad'>無</span>"}</td>
      <td>${c.interval_ms != null ? `interval ${c.interval_ms.toFixed(2)} ms<br><small>latency ${c.latency}｜timeout ${c.supervision_ms} ms</small>` : "-"}</td>
      <td>${rssiText(c.rssi)}</td>
      <td>${c.gatt ? `<span class="gatt">${esc(c.att_channel)}</span>` : "-"}</td>
      <td>${c.att_packets}</td><td>${c.notifications}</td><td>${c.writes}</td>
      <td>${c.disconnect_reason_text ? `${esc(c.disconnect_reason_text)}<br><small>${c.disconnect_by === "local" ? "本機斷線" : "對端斷線"}</small>` : "-"}${c.last_rx_estimate ? `<br><small>推估最後收到封包 ${rel(c.last_rx_estimate)}</small>` : ""}</td>
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

function rssiText(samples) {
  if (!samples?.length) return "-";
  const values = samples.map(([, r]) => r);
  return `${Math.min(...values)}～${Math.max(...values)} dBm<br><small>${samples.length} 筆，最後 ${values[values.length - 1]}</small>`;
}

// RSSI 散點圖，橫軸為整段擷取時間，縱軸 -100～-20 dBm
function sparkline(samples, t0, t1, w = 180, h = 26) {
  if (!samples?.length) return "-";
  const x = (t) => (t1 > t0 ? ((t - t0) / (t1 - t0)) * (w - 4) + 2 : w / 2);
  const y = (r) => h - 2 - ((Math.max(-100, Math.min(-20, r)) + 100) / 80) * (h - 4);
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${samples.map(([t, r]) =>
    `<circle cx="${x(t).toFixed(1)}" cy="${y(r).toFixed(1)}" r="1.7"><title>${r} dBm</title></circle>`).join("")}</svg>`;
}

function advertTable(s, rel, limit = 0) {
  const connected = new Set(s.connections.flatMap((c) => [c.address, c.identity_address]).filter(Boolean));
  let rows = Object.entries(s.adverts || {}).sort(([a, x], [b, y]) => (connected.has(b) - connected.has(a)) || (y.count - x.count));
  if (!rows.length) return "<p class='hint'>沒有掃描到廣播（儀表未掃描，或只作為 peripheral）</p>";
  const more = limit && rows.length > limit ? rows.length - limit : 0;
  if (limit) rows = rows.slice(0, limit);
  return `<div class="scroll"><table><thead><tr><th>位址</th><th>名稱</th><th>次數</th><th>第一次</th><th>最後一次</th><th>RSSI</th><th>RSSI 變化</th></tr></thead><tbody>
    ${rows.map(([addr, a]) => `<tr class="${connected.has(addr) ? "adv-connected" : ""}"><td>${esc(addr)}</td><td>${esc(a.name || "-")}</td><td>${a.count}</td>
      <td>${rel(a.first)}</td><td>${rel(a.last)}</td><td>${rssiText(a.rssi)}</td><td>${sparkline(a.rssi, s.capture.first_ts, s.capture.last_ts)}</td></tr>`).join("")}
    </tbody></table></div>${more ? `<p class="hint">另有 ${more} 個裝置未列出</p>` : ""}`;
}

// ---------- 即時擷取畫面 ----------
let liveBusy = false;
let liveAt = 0;
let lastFinishedId = null;

async function refreshLive(force = false) {
  if ($("live").hidden || liveBusy || (!force && Date.now() - liveAt < 2000)) return;
  if (state !== "capturing") return renderLiveIdle();
  liveBusy = true;
  try {
    const r = await api("/api/live");
    if (r.capturing) renderLive(r.summary); else renderLiveIdle();
  } catch (e) {
    $("live").innerHTML = `<p class="error">即時資料讀取失敗：${esc(e.status === 404 ? "伺服器尚未更新，請重啟 server.py" : e.message)}</p>`;
  } finally {
    liveBusy = false;
    liveAt = Date.now();
  }
}

function renderLiveIdle() {
  if ($("live").dataset.mode === "idle") return;
  $("live").dataset.mode = "idle";
  $("live").innerHTML = `<div class="live-idle"><h2>即時擷取</h2>
    <p>目前沒有擷取。在左側填好測試情境與裝置後按「開始擷取」，這裡會每 2 秒更新連線、事件與 App 日誌。</p>
    ${lastFinishedId ? `<button id="live-open-last">開啟剛完成的紀錄</button>` : ""}</div>`;
  if ($("live-open-last")) $("live-open-last").onclick = () => { setTab("records"); openCapture(lastFinishedId); };
}

function renderLive(s) {
  $("live").dataset.mode = "live";
  s.events.forEach((e, i) => (e._idx = i));
  s.peers = resolvePeers(s);
  const base = s.capture.first_ts;
  const rel = (t) => (base == null ? "" : "+" + (t - base).toFixed(3) + "s");
  const sec = Math.floor(s.live.elapsed);
  const recent = (filter, n) => s.events.filter(filter).slice(-n).reverse();
  $("live").innerHTML = `<div class="result-head">
      <h2><i class="live-badge"></i>擷取中 ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}｜${esc(s.meta.scenario || "")}</h2>
      <div class="sub">${esc(devicesSummary(s.meta))}</div>
      <div class="sub">${esc(s.live.id)}｜封包 ${s.capture.packets}｜每 2 秒更新，最新的在最上面</div></div>
    ${s.warnings.length ? `<div class="warn">${s.warnings.map(esc).join("<br>")}</div>` : ""}
    <h3>連線</h3>${connTable(s, rel, true)}
    <h3>最新事件</h3>${eventTable(recent((e) => !DEFAULT_OFF.has(e.category), 40), rel)}
    <h3>App 日誌</h3>${eventTable(recent((e) => e.category === "applog", 30), rel)}
    <h3>掃描到的廣播</h3>${advertTable(s, rel, 8)}`;
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
      parts.push(`<text x="6" y="${y + 31}" class="rowsub">${esc((s.peers?.[connKey(c)]?.label || "") + " " + c.address)}</text>`);
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

// ---------- 視覺化模擬動作（儀表 ⇄ 各裝置 封包互傳動畫） ----------
let simState = null;

// dir：m2p 儀表發出、p2m 對端發出；label 用該連線對應的裝置名稱
function inferDirection(s, e) {
  const title = e.title || "", detail = e.detail || "";
  const peer = peerOf(s, e)?.label || "對端";
  const out = { dir: "m2p", label: `儀表 ➔ ${peer}` };
  const into = { dir: "p2m", label: `${peer} ➔ 儀表` };
  if (e.category === "mark") return { dir: "mark", label: "現場標記" };
  if (detail.includes("本機→對端") || title.includes("（本機）") || title.includes("（本機 發出）") || detail.startsWith("本機發起")) return out;
  if (detail.includes("對端→本機") || title.includes("（對端）") || title.includes("（對端 發出）") || detail.startsWith("對端發起")) return into;
  if (/本機要求斷線|Link Key Request Reply|Link Key Request Negative Reply|本機 IO Capability|IO Capability Negative Reply|User Confirmation 接受|User Confirmation 拒絕|Authentication Requested|Set Connection Encryption|LE Start Encryption|LTK Request Reply|LTK Request Negative Reply/.test(title)) return out;
  if (/對端 IO Capability|Link Key Request|IO Capability Request|User Confirmation Request|LE LTK Request/.test(title)) return into;
  if (e.category === "disconnect") {
    const c = e.conn != null ? s.connections[e.conn] : null;
    if (c && c.disconnect_by === "local") return { dir: "m2p", label: `儀表主動斷線 ➔ ${peer}` };
    if (c && c.disconnect_by === "remote") return { dir: "p2m", label: `⬅ ${peer} 斷線/超時` };
  }
  return { dir: "both", label: "雙向 / 狀態變更" };
}

// 模擬器中每組連線（裝置）一列；沒有連線時用第一個裝置佔位
function simPeers(s) {
  const peers = [...new Set(s.connections.map(connKey))].map((key) => ({
    ...s.peers[key], transports: [...new Set(s.connections.filter((c) => connKey(c) === key).map((c) => c.transport))],
  }));
  if (peers.length) return peers;
  const d = metaDevices(s.meta)[0];
  return [{ key: "", label: d ? deviceLabel(d) : "📱 對端", device: d, transports: ["BR/EDR", "LE"] }];
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

  simState.peers = simPeers(s);
  const lane = (i, t) => {
    const k = t === "LE" ? "le" : "br";
    return `<div class="sim-lane ${k}" id="sim-lane-${i}-${k}">
      <div class="sim-lane-head"><span class="tag ${k}">${t === "LE" ? "BLE 低功耗藍牙" : "BR/EDR 傳統藍牙"}</span> <span id="sim-${i}-${k}-status" class="sim-lane-st">未連線</span></div>
      <div class="sim-track"><div class="sim-line"></div><div id="sim-pkt-${i}-${k}" class="sim-pkt-wrap"></div></div></div>`;
  };
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
      <div class="sim-peers">
        ${simState.peers.map((p, i) => `<div class="sim-peer">
          <div class="sim-lanes">${["BR/EDR", "LE"].filter((t) => p.transports.includes(t)).map((t) => lane(i, t)).join("")}</div>
          <div class="sim-node phone">
            <div class="sim-node-title">${esc(p.label)}</div>
            <div class="sim-node-sub">${esc([p.device?.app, p.key].filter(Boolean).join("｜") || "對端")}</div>
            <div id="sim-peer-state-${i}" class="sim-node-state">待機</div>
          </div></div>`).join("")}
        <div id="sim-banner" class="sim-banner"></div>
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

  // 計算截至目前時間點各裝置 BR/EDR 與 LE 連線狀態
  const activeState = (key, transport) => {
    const conns = s.connections.filter((c) => connKey(c) === key && c.transport === transport && c.start <= e.t + 1e-6 && (c.end == null || c.end >= e.t - 1e-6));
    if (!conns.length) return { open: false, enc: false, text: "未連線" };
    const c = conns[conns.length - 1];
    const enc = c.encrypted_at != null && c.encrypted_at <= e.t + 1e-6;
    const gatt = c.gatt && (transport === "LE" || s.events.some((x) => x.conn === c.id && x.category === "att" && x.t <= e.t + 1e-6));
    return { open: true, enc, text: `#${c.id} 連線中 (${hex4(c.handle)})${enc ? " 🔒已加密" : " 🔓未加密"}${gatt ? " 📡GATT" : ""}` };
  };
  simState.peers.forEach((p, i) => {
    for (const t of p.transports) {
      const k = t === "LE" ? "le" : "br";
      const lane = $(`sim-lane-${i}-${k}`), lbl = $(`sim-${i}-${k}-status`), wrap = $(`sim-pkt-${i}-${k}`);
      if (!lane) continue;
      const st = activeState(p.key, t);
      lane.classList.toggle("active", st.open);
      lane.classList.toggle("encrypted", st.enc);
      lbl.textContent = st.text;
      wrap.innerHTML = "";
    }
  });

  // 判斷本事件屬於哪個裝置、哪一條通道與傳送方向；無連線的事件在只有一個裝置時歸給它
  const conn = e.conn != null ? s.connections[e.conn] : null;
  const peerIdx = conn ? simState.peers.findIndex((p) => p.key === connKey(conn)) : simState.peers.length === 1 ? 0 : -1;
  const transport = conn ? conn.transport : e.category === "pair_le" ? "LE" : "BR/EDR";
  const laneKey = transport === "LE" ? "le" : "br";
  const dirInfo = inferDirection(s, e);
  const cat = CATEGORY[e.category] || { label: e.category, color: "#555" };

  const sendRecv = (sender) => dirInfo.dir === "both" ? "⚡ 狀態更新" : (dirInfo.dir === "m2p") === sender ? "📤 發送封包" : "📥 接收封包";
  if ($("sim-meter-state")) $("sim-meter-state").textContent = sendRecv(true);
  simState.peers.forEach((p, i) => {
    if ($("sim-peer-state-" + i)) $("sim-peer-state-" + i).textContent = i === peerIdx ? sendRecv(false) : "待機";
  });

  // 在對應裝置的通道上播放飛行封包動畫
  const pktWrap = peerIdx >= 0 ? $(`sim-pkt-${peerIdx}-${laneKey}`) : null;
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
      const arrow = d.dir === "mark" ? "⚑ 標記" : d.dir === "both" ? `儀表 ⇄ ${peerOf(s, ev)?.label || "對端"}` : d.label;
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
initSidebar();
initTree();
initCaptureForm();
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
