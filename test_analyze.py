# 分析器單元測試：python3 -m unittest test_analyze
import datetime
import os
import struct
import tempfile
import unittest

import analyze

ADDR = bytes([0xC1, 0x58, 0x02, 0x35, 0x23, 0x48])  # 48:23:35:02:58:C1


def le_meta(sub, body):
    a = bytes([sub]) + body
    return bytes([0x3E, len(a)]) + a


class LinkTests(unittest.TestCase):
    def setUp(self):
        self.an = analyze.Analyzer()
        self.an.datalink = 2001

    def test_enhanced_connection_params_update_and_supervision_estimate(self):
        # LE Enhanced Connection Complete：central、interval 0x18、latency 0、timeout 0xC8
        body = struct.pack("<BHBB", 0, 0x40, 0, 0) + ADDR + bytes(12) + struct.pack("<HHH", 0x18, 0, 0xC8) + b"\x00"
        self.an.on_event(10.0, le_meta(0x0A, body))
        c = self.an.connections[0]
        self.assertEqual((c["interval_ms"], c["latency"], c["supervision_ms"], c["role"]), (30.0, 0, 2000, "central"))
        self.an.on_event(11.0, le_meta(0x03, struct.pack("<BHHHH", 0, 0x40, 0x28, 4, 0x1F4)))
        self.assertEqual((c["interval_ms"], c["latency"], c["supervision_ms"]), (50.0, 4, 5000))
        # Read RSSI 的 Command Complete
        self.an.on_event(12.0, bytes([0x0E, 7, 1]) + struct.pack("<HBHb", 0x1405, 0, 0x40, -61))
        self.assertEqual(c["rssi"], [[12.0, -61]])
        # 0x08 Supervision Timeout：回推最後收到封包
        self.an.on_event(20.0, bytes([0x05, 4]) + struct.pack("<BHB", 0, 0x40, 0x08))
        self.assertEqual(c["last_rx_estimate"], 15.0)
        self.assertIn("推估最後收到對端封包", [e["title"] for e in self.an.events])

    def test_legacy_and_extended_advertising_reports(self):
        data = bytes([0x12, 0x09]) + b"KXBT-4823350258C1"
        report = bytes([0x00, 0x00]) + ADDR + bytes([len(data)]) + data + struct.pack("<b", -74)
        self.an.on_event(1.0, le_meta(0x02, bytes([1]) + report))
        ext = (struct.pack("<HB", 0x13, 0) + ADDR + bytes([1, 0, 0xFF, 0x7F]) + struct.pack("<b", -60)
               + bytes(2) + bytes(7) + bytes([0]))
        self.an.on_event(2.0, le_meta(0x0D, bytes([1]) + ext))
        a = self.an.adverts["48:23:35:02:58:C1"]
        self.assertEqual((a["name"], a["count"], a["first"], a["last"]), ("KXBT-4823350258C1", 2, 1.0, 2.0))
        self.assertEqual(a["rssi"], [[1.0, -74], [2.0, -60]])


class JournalTests(unittest.TestCase):
    def test_local_time_is_aligned_to_device_epoch(self):
        # 儀表本地時間 UTC+8；擷取開始於 2026-12-18 13:05:00 本地時間
        start = datetime.datetime(2026, 12, 18, 5, 5, 0, tzinfo=datetime.timezone.utc).timestamp()
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "journal.log")
            with open(path, "w", encoding="utf-8") as f:
                f.write("Dec 18 13:05:15.116160 stm32mp2 khi-6230[166]: [FOB] Alarm disabled\n")
                f.write("Dec 18 13:05:16.000000 stm32mp2 kernel: Bluetooth: hci0: LTK request miss\n")
                f.write("garbage line\n")
            rows = analyze.load_journal(path, start)
        self.assertEqual([r["title"] for r in rows], ["khi-6230", "kernel"])
        self.assertAlmostEqual(rows[0]["t"] - start, 15.11616, places=4)
        self.assertEqual(rows[1]["detail"], "Bluetooth: hci0: LTK request miss")
        self.assertEqual(analyze.load_journal(path + ".missing", start), [])


if __name__ == "__main__":
    unittest.main()
