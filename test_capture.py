"""停止失敗與強制關閉測試；SSH 使用替身，不連接儀表。"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import server


FAKE_SSH = r'''
import io, os, sys, tarfile, time
mode = os.environ.get("BTCAP_TEST_MODE", "complete")
command = sys.argv[-1]
if mode == "offline":
    sys.exit(255)
if command.startswith("test -d"):
    if mode == "hang":
        time.sleep(60)
    sys.exit(1 if mode == "missing" else 0)
if "tar cf -" in command:
    if mode == "transfer_fail":
        sys.stdout.buffer.write(b"not a tar file")
        sys.exit(1)
    with tarfile.open(fileobj=sys.stdout.buffer, mode="w|") as archive:
        data = b"downloaded log"
        item = tarfile.TarInfo("btmon.out")
        item.size = len(data)
        archive.addfile(item, io.BytesIO(data))
'''


class CaptureRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.captures = root / "captures"
        self.captures.mkdir()
        self.directory = self.captures / "20261021-132843_test"
        self.directory.mkdir()
        self.meta = self.directory / "meta.json"
        self.meta.write_text(json.dumps({"phone": "M32", "start_time": 1}))
        self.log = self.directory / "btmon.out"
        self.log.write_text("previously recovered log")
        self.current = self.captures / ".current"
        self.current.write_text(str(self.directory))
        bin_dir = root / "bin"
        bin_dir.mkdir()
        ssh = bin_dir / "ssh"
        ssh.write_text("#!" + sys.executable + "\n" + FAKE_SSH)
        ssh.chmod(0o755)
        env_patch = patch.dict(os.environ, {"PATH": str(bin_dir) + os.pathsep + os.environ["PATH"],
                                             "BTCAP_TEST_MODE": "complete"})
        env_patch.start()
        self.addCleanup(env_patch.stop)
        root_patch = patch.object(server, "CAP_ROOT", str(self.captures))
        root_patch.start()
        self.addCleanup(root_patch.stop)

    def test_stop_missing_remote_directory_finishes_with_warning(self):
        os.environ["BTCAP_TEST_MODE"] = "missing"
        with server.capture_lock:
            output = server.run_capture("stop", timeout=10)
        self.assertIn("已不存在", output)
        self.assertIsNone(server.current_capture())
        meta = json.loads(self.meta.read_text())
        self.assertEqual(meta["completion_status"], "missing_remote")
        self.assertIn("capture_error", meta)
        summary = json.loads((self.directory / "summary.json").read_text())
        self.assertIn(meta["capture_error"], summary["warnings"])
        self.assertEqual(self.log.read_text(), "previously recovered log")

    def test_transfer_failure_preserves_local_data_and_can_force_close(self):
        os.environ["BTCAP_TEST_MODE"] = "transfer_fail"
        with self.assertRaisesRegex(RuntimeError, "拉回檔案失敗"):
            with server.capture_lock:
                server.run_capture("stop", timeout=10)
        self.assertTrue(self.current.exists())
        self.assertEqual(self.log.read_text(), "previously recovered log")
        self.assertFalse(list(self.directory.glob(".pull.*")))
        output = server.force_stop_capture()
        self.assertIn("強制關閉", output)
        self.assertFalse(self.current.exists())
        self.assertEqual(json.loads(self.meta.read_text())["completion_status"], "forced")
        self.assertEqual(self.log.read_text(), "previously recovered log")

    def test_force_close_works_without_ssh_and_is_repeatable(self):
        os.environ["BTCAP_TEST_MODE"] = "offline"
        output = server.force_stop_capture()
        self.assertIn("本機狀態已解除", output)
        self.assertFalse(self.current.exists())
        self.assertEqual(self.log.read_text(), "previously recovered log")
        server.force_stop_capture()
        self.assertFalse(self.current.exists())

    def test_force_close_interrupts_inflight_stop(self):
        os.environ["BTCAP_TEST_MODE"] = "hang"
        errors = []

        def stop():
            try:
                with server.capture_lock:
                    server.run_capture("stop", timeout=30)
            except RuntimeError as error:
                errors.append(str(error))

        thread = threading.Thread(target=stop)
        thread.start()
        self.addCleanup(thread.join, 5)
        deadline = time.monotonic() + 5
        while server.capture_process is None and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertIsNotNone(server.capture_process)
        started = time.monotonic()
        server.force_stop_capture()
        thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertLess(time.monotonic() - started, 5)
        self.assertTrue(any("已被強制關閉" in error for error in errors))
        self.assertFalse(self.current.exists())
        self.assertIsNone(server.capture_process)
        self.assertFalse(server.force_stop_requested.is_set())

    def test_normal_stop_still_downloads_and_finishes(self):
        with server.capture_lock:
            server.run_capture("stop", timeout=10)
        self.assertFalse(self.current.exists())
        self.assertEqual(self.log.read_text(), "downloaded log")
        meta = json.loads(self.meta.read_text())
        self.assertEqual(meta["completion_status"], "complete")
        self.assertNotIn("capture_error", meta)


if __name__ == "__main__":
    unittest.main()
