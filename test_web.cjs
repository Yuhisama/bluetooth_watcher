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
  folders = [{id: "m32", name: "手機 <M32>"}, {id: "iphone", name: "iPhone"}];
  captureList = [
    {id: "one", name: "成功 <script>", folder: "m32", meta: {scenario: "配對", phone: "M32"}, analyzed: true},
    {id: "two", folder: "iphone", meta: {scenario: "回連", phone: "iPhone"}},
    {id: "three", incomplete: true, meta: {}},
  ];
`, context);
vm.runInContext('selectedFolder = "*"', context);
vm.runInContext("renderCaptures()", context);
let html = element("captures").innerHTML;
assert.ok(html.includes('data-id="one"') && html.includes('data-id="two"') && html.includes('data-id="three"'));
assert.ok(html.includes("成功 &lt;script&gt;"));
assert.ok(html.includes("手機 &lt;M32&gt;"));
assert.ok(!html.includes("<script>"));
assert.equal(element("folder-delete").disabled, true);

vm.runInContext('selectedFolder = "m32"', context);
vm.runInContext("renderCaptures()", context);
html = element("captures").innerHTML;
assert.ok(html.includes('data-id="one"'));
assert.ok(!html.includes('data-id="two"'));
assert.equal(element("folder-delete").disabled, false);

vm.runInContext('selectedFolder = ""', context);
vm.runInContext("renderCaptures()", context);
html = element("captures").innerHTML;
assert.ok(html.includes('data-id="three"') && !html.includes('data-id="one"'));
assert.equal(element("folder-rename").disabled, true);

assert.ok(element("folders").innerHTML.includes('data-folder="m32"'));
assert.ok(element("folders").innerHTML.includes("手機 &lt;M32&gt;"));
assert.ok(!source.includes("organize-dialog"));
const saves = [];
context.saveMock = async (id, changes) => saves.push({id, changes: {...changes}});
vm.runInContext("saveOrganization = saveMock", context);
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

const target = node();
target.dataset = {folder: "m32"};
element("folders").querySelectorAll = () => [target];
vm.runInContext("renderFolders()", context);
let prevented = false;
target.ondragover({dataTransfer: {types: ["Files"]}, preventDefault() { prevented = true; }});
assert.equal(prevented, false);
target.ondragover({dataTransfer: {types: ["application/x-bt-capture"]}, preventDefault() { prevented = true; }});
assert.equal(prevented, true);
target.ondrop({dataTransfer: {getData: () => "one"}, preventDefault() {}});
assert.deepEqual(saves[2], {id: "one", changes: {folder: "m32"}});
console.log("PASS: filters, escaped names, inline rename (Enter/Esc/blur/IME), independent folder drop");

// 舊版伺服器尚無資料夾 API 時，仍必須顯示原有紀錄。
context.fetch = async (path) => ({
  ok: path !== "/api/folders",
  status: path === "/api/folders" ? 404 : 200,
  json: async () => path === "/api/folders" ? {error: "not found"} : [
    {id: "existing", meta: {scenario: "原有紀錄", phone: "M32"}},
  ],
});
vm.runInContext('selectedFolder = "*"', context);
vm.runInContext("loadCaptures()", context).then(() => {
  assert.ok(element("captures").innerHTML.includes('data-id="existing"'));
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
