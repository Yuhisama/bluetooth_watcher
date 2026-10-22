"""分類 API 整合測試：python3 -m unittest -v test_server.py。"""
import json
import io
from pathlib import Path
import tempfile
import threading
import unittest
import zipfile
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import server


class OrganizationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.patch = patch.object(server, "CAP_ROOT", self.tmp.name)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.capture = self.root / "20261021-101135_test"
        self.capture.mkdir()
        (self.capture / "meta.json").write_text(json.dumps({"phone": "Galaxy M32"}))
        (self.capture / "btmon.out").write_text("original capture")
        self.http = server.ReusableHTTPServer(("127.0.0.1", 0), server.Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_http)

    def stop_http(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()

    def request(self, path, body=None, status=200):
        req = Request("http://127.0.0.1:%d/api%s" % (self.http.server_port, path),
                      data=None if body is None else json.dumps(body).encode(),
                      headers={"Content-Type": "application/json"})
        try:
            response = urlopen(req, timeout=10)
        except HTTPError as e:
            response = e
        with response:
            self.assertEqual(response.status, status)
            return json.load(response)

    def create_folder(self, name="M32 測試"):
        return self.request("/folders/create", {"name": name})["folder"]

    def organize(self, name, folder="", status=200):
        return self.request("/captures/%s/organization" % self.capture.name,
                            {"name": name, "folder": folder}, status)

    def test_name_and_folder_survive_reanalysis(self):
        folder = self.create_folder()
        self.organize(" 首次配對成功 ", folder["id"])
        listing = self.request("/captures")
        self.assertEqual(listing[0]["name"], "首次配對成功")
        self.assertEqual(listing[0]["folder"], folder["id"])
        self.request("/captures/%s/reanalyze" % self.capture.name, {})
        summary = self.request("/captures/" + self.capture.name)
        self.assertEqual(summary["organization"], {"name": "首次配對成功", "folder": folder["id"]})
        self.assertEqual(summary["meta"]["phone"], "Galaxy M32")
        self.assertEqual((self.capture / "btmon.out").read_text(), "original capture")
        catalog = json.loads((self.root / ".catalog.json").read_text())
        self.assertEqual(catalog, server.load_catalog())
        self.assertEqual(len(self.request("/captures")), 1)
        self.organize("")
        self.assertEqual(self.request("/captures/" + self.capture.name)["organization"],
                         {"name": "", "folder": ""})

    def test_move_rename_and_delete_folder_preserve_records(self):
        first = self.create_folder()
        second = self.create_folder("iPhone")
        self.organize("M32", first["id"])
        self.organize("M32", second["id"])
        self.request("/folders/rename", {"id": second["id"], "name": "回連測試"})
        self.assertEqual(self.request("/folders")[1]["name"], "回連測試")
        self.request("/folders/delete", {"id": second["id"]})
        item = self.request("/captures")[0]
        self.assertEqual(item["folder"], "")
        self.assertEqual(item["name"], "M32")
        self.assertTrue(self.capture.is_dir())
        self.assertEqual((self.capture / "btmon.out").read_text(), "original capture")

    def test_rename_and_move_are_independent(self):
        folder = self.create_folder()
        path = "/captures/%s/organization" % self.capture.name
        self.organize("原名")
        self.request(path, {"folder": folder["id"]})
        self.assertEqual(self.request("/captures")[0]["name"], "原名")
        self.request(path, {"name": "雙擊改名"})
        item = self.request("/captures")[0]
        self.assertEqual(item["name"], "雙擊改名")
        self.assertEqual(item["folder"], folder["id"])
        self.request(path, {"folder": ""})
        item = self.request("/captures")[0]
        self.assertEqual(item["name"], "雙擊改名")
        self.assertEqual(item["folder"], "")

    def test_invalid_edits_do_not_change_catalog(self):
        folder = self.create_folder()
        self.organize("M32", folder["id"])
        before = server.load_catalog()
        self.request("/folders/create", {"name": " M32 測試 "}, 500)
        self.request("/folders/create", {"name": " "}, 500)
        self.request("/folders/create", {"name": "x" * 121}, 500)
        self.request("/folders/rename", {"id": "missing", "name": "test"}, 500)
        self.organize("M32", "missing", 500)
        self.organize("M32", [], 500)
        self.organize("x" * 121, status=500)
        self.request("/captures/missing/organization", {"name": "test"}, 500)
        self.assertEqual(server.load_catalog(), before)

    def test_nested_folders_move_and_delete(self):
        parent = self.create_folder("Android")
        child = self.request("/folders/create", {"name": "首次配對", "parent": parent["id"]})["folder"]
        self.assertEqual(child["parent"], parent["id"])
        # 同名只限制在同一層
        self.request("/folders/create", {"name": "首次配對"})
        self.request("/folders/create", {"name": "首次配對", "parent": parent["id"]}, 500)
        self.request("/folders/create", {"name": "x", "parent": "missing"}, 500)
        self.organize("M32", child["id"])
        before = server.load_catalog()
        self.request("/folders/move", {"id": parent["id"], "parent": child["id"]}, 500)
        self.request("/folders/move", {"id": parent["id"], "parent": parent["id"]}, 500)
        self.assertEqual(server.load_catalog(), before)
        self.request("/folders/move", {"id": child["id"], "parent": ""}, 500)  # 根目錄已有同名
        sibling = self.create_folder("iPhone")
        self.request("/folders/move", {"id": child["id"], "parent": sibling["id"]})
        self.request("/folders/move", {"id": child["id"], "parent": parent["id"]})
        self.request("/folders/rename", {"id": child["id"], "name": "回連"})
        self.assertEqual(next(f for f in self.request("/folders") if f["id"] == child["id"])["parent"], parent["id"])
        grandchild = self.request("/folders/create", {"name": "第二次", "parent": child["id"]})["folder"]
        # 刪除資料夾：子資料夾與紀錄移到上一層
        self.request("/folders/delete", {"id": child["id"]})
        self.assertEqual(self.request("/captures")[0]["folder"], parent["id"])
        self.assertEqual(next(f for f in self.request("/folders") if f["id"] == grandchild["id"])["parent"], parent["id"])
        self.assertEqual((self.capture / "btmon.out").read_text(), "original capture")

    def test_presets_favorites_and_device_sets(self):
        presets = self.request("/presets")
        self.assertEqual(presets["favorites"], [])
        self.assertEqual(presets["device_types"], server.DEFAULT_DEVICE_TYPES)
        saved = self.request("/presets", {"favorites": [" 首次配對 ", "回連", "首次配對", ""]})["presets"]
        self.assertEqual(saved["favorites"], ["首次配對", "回連"])
        devices = [{"type": "手機", "name": "iPhone 12", "app": "客戶App"}, {"type": "MOB/FOB", "name": "FOB #2"}, {"type": "", "name": ""}]
        saved = self.request("/presets", {"device_sets": [{"name": "iPhone + FOB", "devices": devices}]})["presets"]
        self.assertEqual(saved["favorites"], ["首次配對", "回連"])
        self.assertEqual(saved["device_sets"][0]["devices"],
                         [{"type": "手機", "name": "iPhone 12", "app": "客戶App", "address": ""},
                          {"type": "MOB/FOB", "name": "FOB #2", "app": "", "address": ""}])
        before = self.request("/presets")
        self.request("/presets", {"favorites": "not a list"}, 500)
        self.request("/presets", {"device_sets": [{"name": "", "devices": []}]}, 500)
        self.request("/presets", {"device_sets": [{"name": "x", "devices": [{"name": "y" * 121}]}]}, 500)
        self.assertEqual(self.request("/presets"), before)

    def test_start_passes_devices_and_remembers_them(self):
        seen = {}

        def fake_run(*args, **kwargs):
            seen["args"] = args
            with open(args[3], encoding="utf-8") as f:
                seen["meta"] = json.load(f)
            return "started"

        devices = [{"type": "手機", "name": "Galaxy M32", "app": "nRF Connect"}, {"type": "耳機", "name": ""}]
        with patch.object(server, "run_capture", fake_run):
            self.request("/start", {"scenario": " 我自己填的情境 ", "devices": devices})
            self.request("/start", {"scenario": "x", "devices": [{"name": "z"}] * 11}, 500)
        self.assertEqual(seen["args"][:3], ("start", "我自己填的情境", "--meta"))
        self.assertFalse(Path(seen["args"][3]).exists(), "暫存 meta 檔用完要刪除")
        expected = [{"type": "手機", "name": "Galaxy M32", "app": "nRF Connect", "address": ""},
                    {"type": "耳機", "name": "", "app": "", "address": ""}]
        self.assertEqual(seen["meta"], {"devices": expected})
        self.assertEqual(self.request("/presets")["last_devices"], expected)

    def test_device_map_is_saved_with_organization(self):
        path = "/captures/%s/organization" % self.capture.name
        self.organize("M32")
        self.request(path, {"device_map": {"A8:91:3D:E8:E4:F2": 0, "72:D6:37:A5:22:4D": -1}})
        org = self.request("/captures")[0]
        self.assertEqual(org["device_map"], {"A8:91:3D:E8:E4:F2": 0, "72:D6:37:A5:22:4D": -1})
        self.assertEqual(org["name"], "M32")
        self.request(path, {"device_map": {"72:D6:37:A5:22:4D": None}})
        self.assertEqual(self.request("/captures")[0]["device_map"], {"A8:91:3D:E8:E4:F2": 0})
        before = server.load_catalog()
        for bad in ({"x": 10}, {"x": -2}, {"x": "0"}, {"x": True}, []):
            self.request(path, {"device_map": bad}, 500)
        self.assertEqual(server.load_catalog(), before)
        self.request(path, {"device_map": {"A8:91:3D:E8:E4:F2": None}})
        self.assertNotIn("device_map", self.request("/captures")[0])

    def test_live_fetches_incrementally_and_caches(self):
        self.assertEqual(self.request("/live"), {"capturing": False, "summary": None})
        (self.root / ".current").write_text(str(self.capture))
        (self.capture / "meta.json").write_text(json.dumps({"scenario": "FOB 走遠", "devices": [{"type": "MOB/FOB", "name": "FOB"}]}))
        calls = []

        def fake_run(*args, **kwargs):
            calls.append(args)
            with open(Path(args[1]) / "hci.btsnoop", "wb") as f:
                f.write(b"btsnoop\0" + (1).to_bytes(4, "big") + (2001).to_bytes(4, "big"))
            return ""

        with patch.object(server, "run_capture", fake_run):
            live = self.request("/live")
            self.assertTrue(live["capturing"])
            self.assertEqual(live["summary"]["live"]["id"], self.capture.name)
            self.assertEqual(live["summary"]["meta"]["scenario"], "FOB 走遠")
            self.assertEqual(live["summary"]["warnings"], [])
            self.request("/live")
            self.assertEqual(len(calls), 1, "1.5 秒內重複查詢使用快取")
            self.assertEqual(calls[0][:2], ("live", str(self.root / ".live")))
            server.live_cache["at"] = 0
            with patch.object(server, "run_capture", side_effect=RuntimeError("ssh 中斷")):
                live = self.request("/live")
            self.assertIn("即時資料拉回失敗: ssh 中斷", live["summary"]["warnings"])
        self.assertEqual([c["id"] for c in self.request("/captures")], [self.capture.name], ".live 不出現在紀錄清單")
        server.live_cache.update(id=None, at=0.0, summary=None)

    def test_incomplete_capture_can_be_organized_and_deleted(self):
        (self.capture / "meta.json").unlink()
        self.organize("失敗紀錄")
        self.assertTrue(self.request("/captures")[0]["incomplete"])
        self.request("/captures/%s/delete" % self.capture.name, {})
        self.assertEqual(self.request("/captures"), [])
        self.assertNotIn(self.capture.name, server.load_catalog()["captures"])

    def test_log_file_listing_and_selected_zip(self):
        (self.capture / "journal.log").write_bytes("系統日誌\n".encode())
        available = self.request("/captures/%s/files" % self.capture.name)
        self.assertEqual({f["name"] for f in available}, {"btmon.out", "journal.log"})
        self.assertTrue(all(f["size"] > 0 for f in available))
        req = Request("http://127.0.0.1:%d/api/captures/%s/archive" %
                      (self.http.server_port, self.capture.name),
                      data=json.dumps({"name": "配對測試.zip", "files": ["journal.log", "journal.log"]}).encode(),
                      headers={"Content-Type": "application/json"})
        with urlopen(req, timeout=10) as response:
            self.assertEqual(response.headers["Content-Type"], "application/zip")
            self.assertIn("filename*=UTF-8''%E9%85%8D", response.headers["Content-Disposition"])
            body = response.read()
            self.assertEqual(int(response.headers["Content-Length"]), len(body))
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            self.assertEqual(archive.namelist(), ["journal.log"])
            self.assertEqual(archive.read("journal.log"), "系統日誌\n".encode())
            self.assertIsNone(archive.testzip())
        self.assertEqual((self.capture / "btmon.out").read_text(), "original capture")
        self.assertFalse(any(self.capture.glob("*.zip")))

    def test_zip_rejects_invalid_names_and_file_selections(self):
        path = "/captures/%s/archive" % self.capture.name
        for name in ("../outside", "", "bad/name", "bad\\name", "bad\nname", "..", "x" * 121):
            self.request(path, {"name": name, "files": ["btmon.out"]}, 500)
        for files in ([], None, "btmon.out", ["../meta.json"], ["meta.json"], ["journal.log"], [None]):
            self.request(path, {"name": "test", "files": files}, 500)
        self.request("/captures/missing/archive", {"name": "test", "files": ["btmon.out"]}, 404)
        self.assertEqual((self.capture / "btmon.out").read_text(), "original capture")


if __name__ == "__main__":
    unittest.main()
