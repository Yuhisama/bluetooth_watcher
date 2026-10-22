// 清單篩選、原地改名與拖曳分類：node test_web.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const elements = new Map();
function node() {
  return {
    value: "", innerHTML: "", textContent: "", disabled: false, dataset: {},
    querySelectorAll: () => [],
    querySelector() { return this.child || null; },
    replaceChildren(child) { this.child = child; },
    setAttribute() {},
    focus() { this.focused = true; },
    select() { this.selected = true; },
    showModal() { this.open = true; },
    click() { this.clicked = true; },
    remove() {},
    classList: {add() {}, remove() {}, toggle() {}},
  };
}
function element(id) {
  if (!elements.has(id)) elements.set(id, node());
  return elements.get(id);
}
const context = vm.createContext({
  document: { getElementById: element, createElement: node }, console,
});
const source = fs.readFileSync(require.resolve("./web/app.js"), "utf8");
vm.runInContext(source.split("// ---------- init ----------")[0], context);
vm.runInContext(`
  folders = [{id: "m32", name: "手機 <M32>", parent: ""}, {id: "sub", name: "首次配對", parent: "m32"}, {id: "iphone", name: "iPhone"}];
  captureList = [
    {id: "one", name: "成功 <script>", folder: "sub", meta: {scenario: "配對", phone: "M32", app: "客戶App"}, analyzed: true},
    {id: "two", folder: "iphone", meta: {scenario: "回連", phone: "iPhone 12"}},
    {id: "three", incomplete: true, meta: {}},
    {id: "four", folder: "missing", meta: {scenario: "孤兒", phone: "Pixel"}},
  ];
`, context);
vm.runInContext("renderTree()", context);
let html = element("tree").innerHTML;
// 收合時只看到根層：兩個資料夾，加上根目錄紀錄（含資料夾已不存在的紀錄）
assert.ok(html.includes('data-type="folder" data-id="m32"') && html.includes('data-type="folder" data-id="iphone"'));
assert.ok(!html.includes('data-id="sub"') && !html.includes('data-id="one"') && !html.includes('data-id="two"'));
assert.ok(html.includes('data-id="three"') && html.includes('data-id="four"'));
assert.ok(html.includes("手機 &lt;M32&gt;") && !html.includes("<M32>"));
assert.match(html, /data-id="m32"[\s\S]*?tree-count">1</);

vm.runInContext('toggleFolder("m32", true); toggleFolder("sub", true)', context);
html = element("tree").innerHTML;
assert.ok(html.includes('data-id="sub"') && html.includes('data-id="one"'));
assert.ok(html.includes("成功 &lt;script&gt;") && !html.includes("<script>"));
assert.match(html, /data-id="one" draggable="true" style="--depth:2"/);

vm.runInContext('treeFilter = "iphone"; renderTree()', context);
html = element("tree").innerHTML;
assert.ok(html.includes('data-id="iphone"') && html.includes('data-id="two"'));
assert.ok(!html.includes('data-id="m32"') && !html.includes('data-id="three"'));
vm.runInContext('treeFilter = "客戶app"; collapseAll()', context);
html = element("tree").innerHTML;
assert.ok(html.includes('data-id="m32"') && html.includes('data-id="sub"') && html.includes('data-id="one"'), "篩選命中時展開上層資料夾");
vm.runInContext('treeFilter = "不存在"; renderTree()', context);
assert.ok(element("tree").innerHTML.includes("沒有符合的紀錄"));
vm.runInContext('treeFilter = ""', context);

assert.equal(vm.runInContext('JSON.stringify(treeMenuItems("folder", "m32").map((i) => i.label || i))', context),
  JSON.stringify(["新增子資料夾", "改名", "刪除資料夾", "-", "全部收合"]));
assert.ok(vm.runInContext('treeMenuItems("capture", "one").map((i) => i.label)', context).includes("下載 LOG…"));
assert.ok(!source.includes("organize-dialog"));

// 舊紀錄 phone/app 相容，以及連線 → 裝置對應
assert.equal(vm.runInContext('JSON.stringify(metaDevices({phone: "M32", app: "客戶App"}))', context),
  JSON.stringify([{type: "手機", name: "M32", app: "客戶App"}]));
assert.equal(vm.runInContext('devicesSummary({devices: [{type: "手機", name: "iPhone 12", app: "客戶App"}, {type: "MOB/FOB", name: "FOB #2"}]})', context),
  "📱 iPhone 12（客戶App）、🛟 FOB #2");
assert.equal(vm.runInContext('devicesSummary({})', context), "未指定裝置");
vm.runInContext(`
  peerCapture = {
    meta: {phone: "IPHONE12", app: "客戶App"},
    connections: [
      {id: 0, transport: "LE", address: "6A:B6:85:9A:E6:8D", identity_address: "A8:91:3D:E8:E4:F2"},
      {id: 1, transport: "BR/EDR", address: "A8:91:3D:E8:E4:F2"},
      {id: 2, transport: "LE", address: "6A:B6:85:9A:E6:8D"},
    ],
    keys: {before: null, after: null, diff: []}, organization: {},
  };
  peers1 = resolvePeers(peerCapture);
  multiCapture = {
    meta: {devices: [{type: "手機", name: "Galaxy M32"}, {type: "MOB/FOB", name: "FOB"}]},
    connections: [
      {id: 0, transport: "BR/EDR", address: "0C:8D:CA:A6:4B:EC"},
      {id: 1, transport: "LE", address: "D1:22:33:44:55:66"},
      {id: 2, transport: "LE", address: "E1:22:33:44:55:66"},
    ],
    keys: {before: {}, after: {"40:D9:5A:89:EA:65": {"0C:8D:CA:A6:4B:EC": {name: "Galaxy M32 0000"}, "D1:22:33:44:55:66": {name: "KHI FOB-01"}}}, diff: []},
    organization: {device_map: {"E1:22:33:44:55:66": 0}},
  };
  peers2 = resolvePeers(multiCapture);
  multiCapture.peers = peers2;
`, context);
assert.equal(vm.runInContext('Object.keys(peers1).length', context), 1, "LE（RPA）、BR 與 IRK 交換前的同一 RPA 連線合併");
assert.equal(vm.runInContext('peers1["A8:91:3D:E8:E4:F2"].label', context), "📱 IPHONE12");
assert.equal(vm.runInContext('peers2["0C:8D:CA:A6:4B:EC"].label', context), "📱 Galaxy M32", "以金鑰名稱比對");
assert.equal(vm.runInContext('peers2["D1:22:33:44:55:66"].label', context), "🛟 FOB");
assert.equal(vm.runInContext('peers2["E1:22:33:44:55:66"].auto', context), false, "手動指定優先");
assert.equal(vm.runInContext('inferDirection(multiCapture, {conn: 1, title: "GATT 寫入", detail: "對端→本機 handle"}).label', context), "🛟 FOB ➔ 儀表");
assert.equal(vm.runInContext('simPeers(multiCapture).length', context), 3);
vm.runInContext('multiCapture.organization.device_map = {"D1:22:33:44:55:66": -1}', context);
assert.equal(vm.runInContext('resolvePeers(multiCapture)["D1:22:33:44:55:66"].label', context), "🔷 KHI FOB-01");

// 情境清單：最愛在前，最近使用排除最愛
vm.runInContext(`presets.favorites = ["儀表重開機回連"]; captureList = [{meta: {scenario: "自訂 A"}}, {meta: {scenario: "儀表重開機回連"}}, {meta: {scenario: "自訂 A"}}, {meta: {}}]`, context);
vm.runInContext("renderScenarioOptions()", context);
assert.equal(element("scenario-list").innerHTML,
  '<option value="儀表重開機回連">★ 最愛</option><option value="自訂 A">最近使用</option>');
element("scenario").value = " 儀表重開機回連 ";
vm.runInContext("updateFavButton()", context);
assert.equal(element("scenario-fav").textContent, "★");
const deviceRows = [["手機", "iPhone 12", ""], ["MOB/FOB", "", ""], ["耳機", "", "x"]].map(([type, name, app]) => ({
  querySelectorAll: () => [{dataset: {f: "type"}, value: type}, {dataset: {f: "name"}, value: name}, {dataset: {f: "app"}, value: app}],
}));
element("devices").querySelectorAll = () => deviceRows;
assert.equal(vm.runInContext("readDevices().length", context), 2, "沒有名稱也沒有 App 的列不送出");
assert.equal(vm.runInContext("readDevices(true).length", context), 3);
element("devices").querySelectorAll = () => [];
vm.runInContext(`captureList = [
    {id: "one", name: "成功 <script>", folder: "sub", meta: {scenario: "配對", phone: "M32", app: "客戶App"}, analyzed: true},
    {id: "two", folder: "iphone", meta: {scenario: "回連", phone: "iPhone 12"}},
    {id: "three", incomplete: true, meta: {}},
    {id: "four", folder: "missing", meta: {scenario: "孤兒", phone: "Pixel"}},
  ]`, context);
// 即時畫面與廣播表
vm.runInContext(`
  liveSummary = {
    meta: {scenario: "FOB 走遠", devices: [{type: "MOB/FOB", name: ""}]},
    live: {id: "20261021-160527", elapsed: 75.4},
    capture: {first_ts: 100, last_ts: 160, packets: 357},
    connections: [{id: 0, transport: "LE", address: "48:23:35:02:58:C1", role: "central", start: 130, end: 150,
      interval_ms: 30, latency: 0, supervision_ms: 2000, last_rx_estimate: 148, rssi: [[131, -60], [140, -72]],
      att_packets: 3, notifications: 0, writes: 1, handle: 64, disconnect_reason_text: "0x08 Connection Timeout", disconnect_by: "remote"}],
    events: [{t: 150, conn: 0, category: "disconnect", title: "LE 斷線", detail: "0x08"},
             {t: 150.05, conn: null, category: "applog", title: "khi-6230", detail: "[FOB] Alarm <b>"}],
    adverts: {"11:11:11:11:11:11": {name: "LAPTOP", count: 50, first: 100, last: 160, rssi: [[101, -80]]},
              "48:23:35:02:58:C1": {name: "KXBT-4823350258C1", count: 3, first: 120, last: 129, rssi: [[120, -77], [129, -40]]}},
    keys: {}, warnings: [],
  };
  renderLive(liveSummary);
`, context);
html = element("live").innerHTML;
assert.ok(html.includes("擷取中 1:15｜FOB 走遠"));
assert.ok(html.includes("🛟 KXBT-4823350258C1"), "FOB 沒填名稱時用廣播名稱");
assert.ok(!html.includes('class="conn-device'), "即時畫面不顯示裝置對應選單");
assert.ok(html.includes("interval 30.00 ms") && html.includes("timeout 2000 ms") && html.includes("推估最後收到封包 +48.000s"));
assert.ok(html.includes("-72～-60 dBm"));
assert.ok(html.includes("[FOB] Alarm &lt;b&gt;"));
assert.ok(html.indexOf("48:23:35:02:58:C1</td>") < html.indexOf("11:11:11:11:11:11"), "有連線的裝置排在前面");
assert.equal(vm.runInContext('advertTable(liveSummary, (t) => t, 1)', context).includes("另有 1 個裝置未列出"), true);
assert.equal(vm.runInContext('sparkline([], 0, 1)', context), "-");
console.log("PASS: live dashboard, link params, supervision estimate, RSSI, adverts, applog escaping");
console.log("PASS: legacy phone/app meta, connection→device mapping (identity/key name/manual), scenario favorites, device editor");

const saves = [];
context.saveMock = async (id, changes) => saves.push({id, changes: {...changes}});
vm.runInContext("origSave = saveOrganization; saveOrganization = saveMock", context);
context.titleNode = node();
context.titleNode.textContent = "成功 <script>";
vm.runInContext('renameCapture("one", titleNode)', context);
let input = context.titleNode.child;
assert.equal(input.value, "成功 <script>");
assert.ok(input.focused && input.selected);
input.value = "新名稱";
input.onkeydown({key: "Enter", stopPropagation() {}, preventDefault() {}});
input.onblur();
assert.deepEqual(saves, [{id: "one", changes: {name: "新名稱"}}]);
context.titleNode = node();
context.titleNode.textContent = "原名";
vm.runInContext('renameCapture("one", titleNode)', context);
input = context.titleNode.child;
input.onkeydown({key: "Escape", stopPropagation() {}, preventDefault() {}});
input.onblur();
assert.equal(saves.length, 1);
context.titleNode = node();
vm.runInContext('renameCapture("one", titleNode)', context);
input = context.titleNode.child;
input.value = "中文輸入中";
input.onkeydown({key: "Enter", isComposing: true, stopPropagation() {}});
assert.equal(saves.length, 1);
input.onblur();
assert.deepEqual(saves[1], {id: "one", changes: {name: "中文輸入中"}});

const calls = [];
context.apiMock = async (path, body) => { calls.push({path, body}); return {ok: true}; };
vm.runInContext("origApi = api; origLoad = loadCaptures; api = apiMock; loadCaptures = async () => {}", context);
(async () => {
  await vm.runInContext('moveItem("capture", "one", "iphone")', context);
  assert.deepEqual(saves[2], {id: "one", changes: {folder: "iphone"}});
  await vm.runInContext('moveItem("capture", "one", "sub")', context);
  assert.equal(saves.length, 3, "已在目標資料夾時不送出");
  await vm.runInContext('moveItem("folder", "sub", "")', context);
  assert.equal(JSON.stringify(calls), JSON.stringify([{path: "/api/folders/move", body: {id: "sub", parent: ""}}]));
  await vm.runInContext('moveItem("folder", "sub", "m32")', context);
  assert.equal(calls.length, 1, "已在目標上層時不送出");
  vm.runInContext("api = origApi; loadCaptures = origLoad; saveOrganization = origSave", context);
  console.log("PASS: nested tree, filter, escaped names, inline rename (Enter/Esc/blur/IME), move capture/folder");
})().then(runRest).catch((error) => { console.error(error); process.exitCode = 1; });

function runRest() {

// 舊版伺服器尚無資料夾 API 時，仍必須顯示原有紀錄。
context.fetch = async (path) => ({
  ok: path !== "/api/folders",
  status: path === "/api/folders" ? 404 : 200,
  json: async () => path === "/api/folders" ? {error: "not found"} : [
    {id: "existing", meta: {scenario: "原有紀錄", phone: "M32"}},
  ],
});
return vm.runInContext("loadCaptures()", context).then(() => {
  assert.ok(element("tree").innerHTML.includes('data-id="existing"'));
  assert.ok(element("log").textContent.includes("請重啟 server.py"));
  console.log("PASS: old server folder API 404 preserves capture list");
}).then(async () => {
  const checkboxes = [{value: "btmon.out", checked: true}, {value: "journal.log", checked: false}];
  element("download-files").querySelectorAll = (selector) => selector === "input:checked" ? checkboxes.filter((cb) => cb.checked) : checkboxes;
  context.window = {};
  context.fetch = async () => ({ok: true, json: async () => [
    {name: "btmon.out", size: 1024}, {name: "journal.log", size: 512}, {name: "keys_before.tgz", size: 20},
  ]});
  await vm.runInContext('openDownload("existing")', context);
  assert.ok(element("download-dialog").open);
  assert.match(element("download-files").innerHTML, /value="keys_before.tgz"\s*>/);
  assert.ok(element("download-selection").textContent.includes("已選 1 / 3"));
  assert.ok(element("download-choose").disabled);
  assert.equal(vm.runInContext('zipFilename("中文紀錄.zip")', context), "中文紀錄.zip");
  assert.throws(() => vm.runInContext('zipFilename("../bad")', context));

  const exports = [];
  const anchors = [];
  context.document.body = {append: (link) => anchors.push(link)};
  context.URL = {createObjectURL: () => "blob:test", revokeObjectURL() {}};
  context.setTimeout = (fn) => fn();
  context.fetch = async (path, options) => {
    exports.push({path, body: JSON.parse(options.body)});
    return {ok: true, blob: async () => "zip-binary"};
  };
  element("download-name").value = "中文紀錄";
  await vm.runInContext('downloadArchive({preventDefault() {}})', context);
  assert.deepEqual(exports[0], {path: "/api/captures/existing/archive", body: {name: "中文紀錄.zip", files: ["btmon.out"]}});
  assert.equal(anchors[0].download, "中文紀錄.zip");
  assert.ok(anchors[0].clicked);
  assert.ok(element("download-status").textContent.includes("瀏覽器下載"));

  const written = [];
  context.window.showSaveFilePicker = async (options) => {
    assert.equal(options.suggestedName, "中文紀錄.zip");
    return {
      name: "桌面匯出.zip",
      createWritable: async () => ({write: async (data) => written.push({name: "桌面匯出.zip", data}), close: async () => {}}),
    };
  };
  await vm.runInContext("chooseDownloadDestination()", context);
  assert.equal(element("download-destination").value, "已指定儲存位置：桌面匯出.zip");
  assert.equal(element("download-name").value, "桌面匯出");
  await vm.runInContext('downloadArchive({preventDefault() {}})', context);
  assert.deepEqual(written, [{name: "桌面匯出.zip", data: "zip-binary"}]);
  assert.ok(element("download-status").textContent.includes("已儲存"));

  context.fetch = async () => ({ok: false, json: async () => ({error: "檔案不存在"})});
  await vm.runInContext('downloadArchive({preventDefault() {}})', context);
  assert.equal(element("download-error").textContent, "檔案不存在");
  assert.equal(element("download-submit").disabled, false);
  console.log("PASS: ZIP file selection/name validation, browser download, chosen destination write, error recovery");
}).then(async () => {
  let completeOldStop;
  context.oldStop = new Promise((resolve) => { completeOldStop = resolve; });
  context.confirm = () => true;
  vm.runInContext(`
    api = async (path) => path === "/api/stop" ? oldStop : {ok: true, output: "已強制關閉"};
    loadCaptures = async () => {};
    poll = async () => applyState({state: "idle", current: null});
  `, context);
  const pending = vm.runInContext("stop()", context);
  vm.runInContext('applyState({state: "capturing", current: {meta: {}, elapsed: 1}})', context);
  assert.equal(element("btn-stop").disabled, true);
  assert.equal(element("btn-force-stop").disabled, false);
  await vm.runInContext("forceStop()", context);
  assert.equal(element("btn-start").disabled, false);
  assert.equal(element("btn-stop").disabled, true);
  completeOldStop({output: "舊停止回覆", id: "old"});
  await pending;
  assert.ok(!element("log").textContent.includes("完成: 舊停止回覆"));
  assert.ok(element("log").textContent.includes("已強制關閉"));
  console.log("PASS: force close stays available during stop, restores idle controls, ignores stale response");
}).catch((error) => { console.error(error); process.exitCode = 1; });
}
