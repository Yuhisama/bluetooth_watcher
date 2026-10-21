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
