#!/usr/bin/env python3
"""藍牙擷取工具的本機網頁伺服器。用法: server.py [port]，預設 8765。"""
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
import tempfile
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, unquote

HERE = os.path.dirname(os.path.abspath(__file__))
CAP_ROOT = os.environ.get("BTCAP_DIR", os.path.join(HERE, "captures"))
WEB = os.path.join(HERE, "web")
CAPTURE_SH = os.path.join(HERE, "capture.sh")
ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")
DOWNLOADS = {"hci.btsnoop", "btmon.out", "dbus.log", "journal.log", "marks.txt", "summary.txt",
             "bluetoothctl_before.txt", "bluetoothctl_after.txt", "keys_before.tgz", "keys_after.tgz"}
MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8"}

CONFIG_PATH = os.path.join(HERE, "config.json")
DEFAULT_HOST = "root@192.168.7.1"
HOST_RE = re.compile(r"^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$")
CONTROL_PATH = "/tmp/btcap-ssh-%r@%h:%p"
REQUIRED_TOOLS = ("btmon", "dbus-monitor", "bluetoothctl")

lock = threading.Lock()


# ---------- 儀表連線設定 ----------
def load_config():
    try:
        return json.load(open(CONFIG_PATH, encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def get_host():
    return os.environ.get("BTCAP_HOST") or load_config().get("host") or DEFAULT_HOST


def set_host(host):
    cfg = load_config()
    cfg["host"] = host
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def check_host(host):
    host = (host or "").strip()
    if not HOST_RE.match(host):
        raise ValueError("位址格式錯誤，應為 user@IP 或 IP，例如 root@192.168.7.1")
    return host


def hostname_of(host):
    return host.rsplit("@", 1)[-1]


def close_master(host):
    """關閉 capture.sh 留下的 SSH 共用連線，避免沿用舊的連線狀態。"""
    subprocess.run(["ssh", "-o", "ControlPath=" + CONTROL_PATH, "-O", "exit", host],
                   capture_output=True, text=True, timeout=10)


def classify_ssh_error(err):
    if "REMOTE HOST IDENTIFICATION HAS CHANGED" in err or "Host key verification failed" in err:
        m = re.search(r"(SHA256:[A-Za-z0-9+/=]+)", err)
        return "hostkey_changed", "儀表的主機金鑰與本機紀錄不符（通常是儀表重新燒錄或更換）", m.group(1) if m else None
    if "Permission denied" in err:
        return "auth_failed", "SSH 登入被拒：儀表上尚未安裝本機公鑰", None
    if "Connection refused" in err:
        return "refused", "儀表拒絕連線：SSH 服務未啟動（port 22）", None
    if "timed out" in err or "No route to host" in err or "Network is unreachable" in err:
        return "unreachable", "連不到儀表：請確認網路線 / IP 設定", None
    if "Could not resolve" in err:
        return "unreachable", "無法解析主機名稱", None
    return "error", err.strip().splitlines()[-1] if err.strip() else "未知錯誤", None


def test_connection(host):
    cmd = "echo __BTCAP_OK__; uname -a; for c in %s; do command -v $c >/dev/null || echo __MISSING__ $c; done" \
        % " ".join(REQUIRED_TOOLS)
    try:
        p = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
                            "-o", "StrictHostKeyChecking=accept-new",
                            "-o", "ControlMaster=no", "-o", "ControlPath=none", host, cmd],
                           capture_output=True, text=True, timeout=20)
    except subprocess.TimeoutExpired:
        return {"ok": False, "host": host, "code": "unreachable", "message": "連線逾時"}
    if p.returncode == 0 and "__BTCAP_OK__" in p.stdout:
        lines = [l for l in p.stdout.splitlines() if l and l != "__BTCAP_OK__"]
        missing = [l.split()[1] for l in lines if l.startswith("__MISSING__")]
        uname = next((l for l in lines if not l.startswith("__MISSING__")), "")
        return {"ok": True, "host": host, "code": "ok", "uname": uname, "missing": missing,
                "message": "連線成功" if not missing else "連線成功，但儀表上缺少: " + ", ".join(missing)}
    code, msg, fp = classify_ssh_error(p.stderr)
    return {"ok": False, "host": host, "code": code, "message": msg, "fingerprint": fp,
            "detail": p.stderr.strip()}


def forget_host_key(host):
    name = hostname_of(host)
    p = subprocess.run(["ssh-keygen", "-f", os.path.expanduser("~/.ssh/known_hosts"), "-R", name],
                       capture_output=True, text=True, timeout=10)
    close_master(host)
    if p.returncode != 0:
        raise RuntimeError((p.stdout + p.stderr).strip() or "ssh-keygen 失敗")
    return (p.stdout + p.stderr).strip()


def local_pubkey():
    d = os.path.expanduser("~/.ssh")
    for n in ("id_ed25519.pub", "id_ecdsa.pub", "id_rsa.pub"):
        fp = os.path.join(d, n)
        if os.path.exists(fp):
            return open(fp).read().strip()
    os.makedirs(d, mode=0o700, exist_ok=True)
    key = os.path.join(d, "id_ed25519")
    subprocess.run(["ssh-keygen", "-t", "ed25519", "-N", "", "-f", key, "-q"], check=True, timeout=30)
    return open(key + ".pub").read().strip()


def install_pubkey(host, password):
    """以密碼登入儀表一次，把本機公鑰加入 authorized_keys（等同 ssh-copy-id）。"""
    import tempfile
    pub = local_pubkey()
    fd, askpass = tempfile.mkstemp(prefix="btcap-askpass-", suffix=".sh")
    try:
        with os.fdopen(fd, "w") as f:
            f.write('#!/bin/sh\nprintf "%s\\n" "$BTCAP_PASSWORD"\n')
        os.chmod(askpass, 0o700)
        env = dict(os.environ, SSH_ASKPASS=askpass, SSH_ASKPASS_REQUIRE="force",
                   DISPLAY=os.environ.get("DISPLAY", ":0"), BTCAP_PASSWORD=password)
        remote = ('k=$(cat); mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && '
                  '{ grep -qxF "$k" ~/.ssh/authorized_keys || echo "$k" >> ~/.ssh/authorized_keys; } && '
                  'chmod 600 ~/.ssh/authorized_keys && echo __BTCAP_OK__')
        # start_new_session 讓 ssh 沒有控制終端，才會改用 SSH_ASKPASS 取得密碼
        p = subprocess.run(["ssh", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=accept-new",
                            "-o", "PreferredAuthentications=password,keyboard-interactive",
                            "-o", "PubkeyAuthentication=no", "-o", "NumberOfPasswordPrompts=1",
                            "-o", "ControlMaster=no", "-o", "ControlPath=none", host, remote],
                           input=pub + "\n", capture_output=True, text=True, timeout=30,
                           env=env, start_new_session=True)
    finally:
        os.unlink(askpass)
    if "__BTCAP_OK__" not in p.stdout:
        code, msg, _ = classify_ssh_error(p.stderr)
        if code == "auth_failed":
            msg = "密碼錯誤，或儀表不允許 root 密碼登入"
        raise RuntimeError(msg + "\n" + p.stderr.strip())
    close_master(host)


def run_capture(*args, timeout=120):
    env = dict(os.environ, BTCAP_HOST=get_host())
    p = subprocess.run(["bash", CAPTURE_SH, *args], capture_output=True, text=True, timeout=timeout, env=env)
    out = (p.stdout + p.stderr).strip()
    if p.returncode != 0:
        raise RuntimeError(out or "capture.sh 失敗")
    return out


def current_capture():
    path = os.path.join(CAP_ROOT, ".current")
    if not os.path.exists(path):
        return None
    d = open(path).read().strip()
    meta = {}
    mp = os.path.join(d, "meta.json")
    if os.path.exists(mp):
        meta = json.load(open(mp, encoding="utf-8"))
    return {"id": os.path.basename(d), "meta": meta,
            "elapsed": time.time() - meta.get("start_time", time.time())}


def list_captures():
    items = []
    with lock:
        catalog = load_catalog()
    if not os.path.isdir(CAP_ROOT):
        return items
    for name in sorted(os.listdir(CAP_ROOT), reverse=True):
        d = os.path.join(CAP_ROOT, name)
        if not os.path.isdir(d) or not ID_RE.match(name):
            continue
        mp = os.path.join(d, "meta.json")
        try:
            with open(mp, encoding="utf-8") as f:
                meta = json.load(f)
            incomplete = False
        except (OSError, ValueError):
            # 啟動失敗留下的目錄：仍列出來，讓使用者可以刪除
            meta, incomplete = {}, True
        items.append({"id": name, "meta": meta, **catalog["captures"].get(name, {}), "incomplete": incomplete,
                      "analyzed": os.path.exists(os.path.join(d, "summary.json"))})
    return items


def delete_capture(cid):
    if not ID_RE.match(cid):
        raise ValueError("無效的紀錄 ID")
    d = os.path.join(CAP_ROOT, cid)
    if not os.path.isdir(d):
        raise ValueError("找不到紀錄")
    cur = current_capture()
    if cur and cur["id"] == cid:
        raise ValueError("這筆擷取正在進行中，請先停止再刪除")
    shutil.rmtree(d)
    with lock:
        catalog = load_catalog()
        catalog["captures"].pop(cid, None)
        save_catalog(catalog)


# 分類使用獨立索引，不搬移原始擷取目錄，也不會被重新分析覆蓋。
def load_catalog():
    path = os.path.join(CAP_ROOT, ".catalog.json")
    if not os.path.exists(path):
        return {"folders": [], "captures": {}}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_catalog(catalog):
    os.makedirs(CAP_ROOT, exist_ok=True)
    path = os.path.join(CAP_ROOT, ".catalog.json")
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(catalog, f, ensure_ascii=False, indent=2)
    os.replace(path + ".tmp", path)


def display_name(value, allow_empty=False):
    if not isinstance(value, str):
        raise ValueError("名稱必須是文字")
    value = value.strip()
    if (not value and not allow_empty) or len(value) > 120:
        raise ValueError("名稱需為 1～120 字")
    return value


def update_organization(cid, body):
    if not ID_RE.fullmatch(cid) or not os.path.isdir(os.path.join(CAP_ROOT, cid)):
        raise ValueError("找不到紀錄")
    with lock:
        catalog = load_catalog()
        item = dict(catalog["captures"].get(cid, {"name": "", "folder": ""}))
        name = display_name(body["name"], allow_empty=True) if "name" in body else item.get("name", "")
        folder = body.get("folder", item.get("folder", ""))
        if not isinstance(folder, str):
            raise ValueError("無效的分類資料夾")
        if folder != "" and folder not in {f["id"] for f in catalog["folders"]}:
            raise ValueError("找不到分類資料夾")
        catalog["captures"][cid] = {"name": name, "folder": folder}
        save_catalog(catalog)
    return {"name": name, "folder": folder}


def edit_folder(action, body):
    with lock:
        catalog = load_catalog()
        folders = catalog["folders"]
        folder = next((f for f in folders if f["id"] == body.get("id")), None)
        if action != "create" and folder is None:
            raise ValueError("找不到分類資料夾")
        if action == "delete":
            folders.remove(folder)
            for item in catalog["captures"].values():
                if item.get("folder") == folder["id"]:
                    item["folder"] = ""
        else:
            name = display_name(body.get("name"))
            if any(f["name"] == name and f is not folder for f in folders):
                raise ValueError("已存在同名資料夾")
            if action == "create":
                folder = {"id": uuid.uuid4().hex, "name": name}
                folders.append(folder)
            else:
                folder["name"] = name
        save_catalog(catalog)
        return folder


def archive_name(value):
    if isinstance(value, str):
        value = value.strip()
        if value.lower().endswith(".zip"):
            value = value[:-4]
    name = display_name(value)
    if not name or name in (".", "..") or re.search(r'[\\/:*?"<>|\x00-\x1f]', name) or name.endswith((".", " ")):
        raise ValueError("請輸入有效的 ZIP 檔名，不可包含路徑或特殊字元 \\ / : * ? \" < > |")
    return name + ".zip"


def capture_files(directory):
    return [{"name": name, "size": os.path.getsize(os.path.join(directory, name))}
            for name in sorted(DOWNLOADS) if os.path.isfile(os.path.join(directory, name))]


def write_archive(directory, filenames, output):
    if not isinstance(filenames, list) or not filenames or any(not isinstance(f, str) or f not in DOWNLOADS for f in filenames):
        raise ValueError("請至少選擇一個有效的擷取檔案")
    filenames = list(dict.fromkeys(filenames))
    for name in filenames:
        if not os.path.isfile(os.path.join(directory, name)):
            raise ValueError("檔案不存在：" + name)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in filenames:
            archive.write(os.path.join(directory, name), arcname=name)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path, ctype, download_name=None):
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if download_name:
            self.send_header("Content-Disposition", 'attachment; filename="%s"' % download_name)
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def capture_dir(self, cid):
        if not ID_RE.match(cid):
            return None
        d = os.path.join(CAP_ROOT, cid)
        return d if os.path.isdir(d) else None

    def do_GET(self):
        path = unquote(self.path.split("?")[0])
        if path == "/":
            path = "/index.html"
        if path == "/api/status":
            cur = current_capture()
            return self.send_json({"state": "capturing" if cur else "idle", "current": cur})
        if path == "/api/captures":
            return self.send_json(list_captures())
        if path == "/api/folders":
            with lock:
                folders = load_catalog()["folders"]
            return self.send_json(folders)
        if path == "/api/conn":
            return self.send_json({"host": get_host(), "env_locked": bool(os.environ.get("BTCAP_HOST"))})
        m = re.match(r"^/api/captures/([^/]+)(?:/([^/]+))?$", path)
        if m:
            d = self.capture_dir(m.group(1))
            if d is None:
                return self.send_json({"error": "找不到擷取"}, 404)
            fname = m.group(2)
            if fname == "files":
                return self.send_json(capture_files(d))
            if fname is None:
                sp = os.path.join(d, "summary.json")
                if not os.path.exists(sp):
                    return self.send_json({"error": "尚未分析"}, 404)
                with open(sp, encoding="utf-8") as f:
                    summary = json.load(f)
                with lock:
                    summary["organization"] = load_catalog()["captures"].get(m.group(1), {})
                return self.send_json(summary)
            fp = os.path.join(d, fname)
            if fname not in DOWNLOADS or not os.path.exists(fp):
                return self.send_json({"error": "找不到檔案"}, 404)
            return self.send_file(fp, "application/octet-stream", "%s_%s" % (m.group(1), fname))
        name = os.path.basename(path)
        fp = os.path.join(WEB, name)
        if os.path.isfile(fp):
            return self.send_file(fp, MIME.get(os.path.splitext(name)[1], "application/octet-stream"))
        self.send_json({"error": "not found"}, 404)

    def do_POST(self):
        path = self.path.split("?")[0]
        try:
            body = self.read_body()
            m = re.fullmatch(r"/api/captures/([^/]+)/archive", path)
            if m:
                d = self.capture_dir(m.group(1))
                if d is None:
                    return self.send_json({"error": "找不到擷取"}, 404)
                name = archive_name(body.get("name", ""))
                with tempfile.TemporaryFile() as output:
                    write_archive(d, body.get("files"), output)
                    size = output.tell()
                    output.seek(0)
                    self.send_response(200)
                    self.send_header("Content-Type", "application/zip")
                    self.send_header("Content-Length", str(size))
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Content-Disposition", "attachment; filename=logs.zip; filename*=UTF-8''" + quote(name, safe=""))
                    self.end_headers()
                    shutil.copyfileobj(output, self.wfile)
                return
            m = re.fullmatch(r"/api/folders/(create|rename|delete)", path)
            if m:
                folder = edit_folder(m.group(1), body)
                return self.send_json({"ok": True, "folder": folder})
            m = re.fullmatch(r"/api/captures/([^/]+)/organization", path)
            if m:
                return self.send_json({"ok": True, "organization": update_organization(m.group(1), body)})
            if path == "/api/conn/host":
                host = check_host(body.get("host"))
                if os.environ.get("BTCAP_HOST"):
                    raise ValueError("位址由環境變數 BTCAP_HOST 指定，無法在網頁修改")
                if current_capture():
                    raise ValueError("擷取進行中，無法變更儀表位址")
                set_host(host)
                return self.send_json({"ok": True, "host": host})
            if path == "/api/conn/test":
                return self.send_json({"ok": True, "result": test_connection(get_host())})
            if path == "/api/conn/forget":
                host = get_host()
                out = forget_host_key(host)
                return self.send_json({"ok": True, "output": out, "test": test_connection(host)})
            if path == "/api/conn/install-key":
                host = get_host()
                install_pubkey(host, body.get("password", ""))
                return self.send_json({"ok": True, "test": test_connection(host)})
            if path == "/api/start":
                with lock:
                    out = run_capture("start", body.get("scenario") or "未指定",
                                      body.get("app", ""), body.get("phone", ""))
                return self.send_json({"ok": True, "output": out})
            if path == "/api/mark":
                out = run_capture("mark", body.get("text", ""), timeout=15)
                return self.send_json({"ok": True, "output": out})
            if path == "/api/stop":
                with lock:
                    out = run_capture("stop", timeout=300)
                ids = [os.path.basename(l.strip()) for l in out.splitlines()
                       if l.strip().startswith(CAP_ROOT + os.sep)]
                return self.send_json({"ok": True, "output": out, "id": ids[-1] if ids else ""})
            m = re.match(r"^/api/captures/([^/]+)/delete$", path)
            if m:
                delete_capture(m.group(1))
                return self.send_json({"ok": True})
            m = re.match(r"^/api/captures/([^/]+)/reanalyze$", path)
            if m:
                d = self.capture_dir(m.group(1))
                if d is None:
                    return self.send_json({"error": "找不到擷取"}, 404)
                p = subprocess.run([sys.executable, os.path.join(HERE, "analyze.py"), d],
                                   capture_output=True, text=True, timeout=300)
                if p.returncode != 0:
                    raise RuntimeError(p.stdout + p.stderr)
                with open(os.path.join(d, "summary.json"), encoding="utf-8") as f:
                    s = json.load(f)
                return self.send_json({"ok": True, "packets": s["capture"]["packets"],
                                       "connections": len(s["connections"]), "events": len(s["events"]),
                                       "warnings": s["warnings"]})
            self.send_json({"error": "not found"}, 404)
        except (RuntimeError, subprocess.SubprocessError, ValueError, OSError) as e:
            self.send_json({"ok": False, "error": str(e)}, 500)


class ReusableHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    os.makedirs(CAP_ROOT, exist_ok=True)
    srv = ReusableHTTPServer(("127.0.0.1", port), Handler)
    print("開啟 http://localhost:%d" % port)
    srv.serve_forever()


if __name__ == "__main__":
    main()
