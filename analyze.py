#!/usr/bin/env python3
"""解析擷取目錄中的 hci.btsnoop 與金鑰快照，輸出 summary.json 與 summary.txt。

支援 btsnoop datalink 2001（btmon -w）與 1002（Android HCI snoop, H4）。
用法: analyze.py <capture_dir>
"""
import configparser
import io
import json
import os
import struct
import sys
import tarfile

BTSNOOP_EPOCH_DELTA_US = 0x00DCDDB30F2F8000

DISCONNECT_REASONS = {
    0x00: "Success",
    0x05: "Authentication Failure",
    0x06: "PIN or Key Missing",
    0x08: "Connection Timeout (Supervision)",
    0x0E: "Connection Rejected (Unacceptable BD_ADDR)",
    0x13: "Remote User Terminated",
    0x14: "Remote Device Terminated (Low Resources)",
    0x15: "Remote Device Terminated (Power Off)",
    0x16: "Connection Terminated by Local Host",
    0x1A: "Unsupported Remote Feature",
    0x22: "LMP/LL Response Timeout",
    0x28: "Instant Passed",
    0x29: "Pairing With Unit Key Not Supported",
    0x3B: "Unacceptable Connection Parameters",
    0x3D: "Connection Terminated due to MIC Failure",
    0x3E: "Connection Failed to be Established",
}

LINK_KEY_TYPES = {
    0: "Combination", 3: "Debug Combination",
    4: "Unauthenticated P-192", 5: "Authenticated P-192",
    6: "Changed Combination", 7: "Unauthenticated P-256", 8: "Authenticated P-256",
}

IO_CAPS = {0: "DisplayOnly", 1: "DisplayYesNo", 2: "KeyboardOnly",
           3: "NoInputNoOutput", 4: "KeyboardDisplay"}

SMP_FAIL_REASONS = {
    0x01: "Passkey Entry Failed", 0x02: "OOB Not Available",
    0x03: "Authentication Requirements", 0x04: "Confirm Value Failed",
    0x05: "Pairing Not Supported", 0x06: "Encryption Key Size",
    0x07: "Command Not Supported", 0x08: "Unspecified Reason",
    0x09: "Repeated Attempts", 0x0A: "Invalid Parameters",
    0x0B: "DHKey Check Failed", 0x0C: "Numeric Comparison Failed",
    0x0D: "BR/EDR Pairing In Progress", 0x0E: "Cross-transport Key Derivation Not Allowed",
    0x0F: "Key Rejected",
}

ATT_ERRORS = {
    0x01: "Invalid Handle", 0x02: "Read Not Permitted", 0x03: "Write Not Permitted",
    0x04: "Invalid PDU", 0x05: "Insufficient Authentication", 0x06: "Request Not Supported",
    0x07: "Invalid Offset", 0x08: "Insufficient Authorization", 0x09: "Prepare Queue Full",
    0x0A: "Attribute Not Found", 0x0B: "Attribute Not Long", 0x0C: "Encryption Key Size Too Short",
    0x0D: "Invalid Attribute Value Length", 0x0E: "Unlikely Error",
    0x0F: "Insufficient Encryption", 0x10: "Unsupported Group Type",
    0x11: "Insufficient Resources", 0x12: "Database Out Of Sync", 0x13: "Value Not Allowed",
}

ATT_OPCODES = {
    0x01: "Error Rsp", 0x02: "Exchange MTU Req", 0x03: "Exchange MTU Rsp",
    0x04: "Find Info Req", 0x05: "Find Info Rsp", 0x06: "Find By Type Value Req",
    0x07: "Find By Type Value Rsp", 0x08: "Read By Type Req",
    0x09: "Read By Type Rsp", 0x0A: "Read Req", 0x0B: "Read Rsp",
    0x10: "Read By Group Type Req", 0x11: "Read By Group Type Rsp",
    0x12: "Write Req", 0x13: "Write Rsp", 0x1B: "Notification",
    0x1D: "Indication", 0x1E: "Confirmation", 0x52: "Write Cmd",
}

PSM_ATT = 0x001F

# 儀表 BLE-CAN 自訂特徵值（khi-6230 App/bluetooth/bluetooth_gatt_service.h）
KNOWN_UUIDS = {
    "797143a2-a920-41d0-8af5-4ea9ab4bbc08": "Control Point",
    "1e8c070c-9443-4b66-b002-0cc5252b2f0f": "Data Source",
    "7e32e5fd-7394-48ea-9147-ca1aea6fe567": "Data Source Mid",
    "802042c2-cf8b-4e2e-a7e6-ccfea32cf045": "Data Source High",
}


def bdaddr(b):
    return ":".join("%02X" % x for x in reversed(b[:6]))


def hex_reason(code, table):
    return "0x%02X %s" % (code, table.get(code, "Unknown"))


def uuid_str(b):
    if len(b) == 2:
        return "0x%04X" % struct.unpack("<H", b)[0]
    h = bytes(reversed(b)).hex()
    return "%s-%s-%s-%s-%s" % (h[:8], h[8:12], h[12:16], h[16:20], h[20:])


def hex_data(b, limit=20):
    text = " ".join("%02X" % x for x in b[:limit])
    return text + (" …（共 %d bytes）" % len(b) if len(b) > limit else "")


def classify_att_error(req_op, err):
    # ATT 用 Error Response 表達查無結果；不能將所有 Error Response 視為故障。
    if err == 0x0A and req_op in (0x04, 0x06, 0x08, 0x10):
        return "att_discovery", "查詢範圍內無符合屬性／探索結束；不代表連線失敗"
    if err == 0x10 and req_op == 0x10:
        return "att_capability", "不支援此群組類型的查詢；不代表連線失敗"
    return "error", ""


class Analyzer:
    def __init__(self):
        self.connections = []
        self.open_by_handle = {}
        self.events = []
        self.att_errors = []
        self.warnings = []
        self.cccd_handles = set()
        self.char_uuids = {}         # (連線 id, 伺服器是否為本機, value handle) → UUID
        self.pending_read_type = {}  # (連線 id, 請求方向 tx) → Read By Type 查詢的屬性類型
        self.pending_l2cap = {}
        self.pending_disconnect = {}
        self.first_ts = None
        self.last_ts = None
        self.packets = 0

    # ---------- helpers ----------
    def event(self, t, conn, category, title, detail=""):
        self.events.append({"t": t, "conn": conn["id"] if conn else None,
                            "category": category, "title": title, "detail": detail})

    def char_label(self, c, server_local, h):
        uuid = self.char_uuids.get((c["id"], server_local, h))
        label = "handle 0x%04X" % h
        return "%s %s" % (label, KNOWN_UUIDS.get(uuid, uuid)) if uuid else label

    def conn_by_addr(self, addr, transport=None):
        for c in reversed(self.connections):
            if c["address"] == addr and c["end"] is None and (transport is None or c["transport"] == transport):
                return c
        return None

    def new_conn(self, t, handle, transport, addr, addr_type=None, role=None):
        prev = self.open_by_handle.get(handle)
        if prev is not None and prev["end"] is None:
            prev["end"] = t
            self.warnings.append("handle 0x%04X 未收到斷線事件就被重新使用" % handle)
        c = {
            "id": len(self.connections), "handle": handle, "transport": transport,
            "address": addr, "address_type": addr_type, "identity_address": None,
            "role": role, "start": t, "end": None,
            "disconnect_reason": None, "disconnect_reason_text": None, "disconnect_by": None,
            "encrypted_at": None, "att_channel": None,
            "att_packets": 0, "notifications": 0, "indications": 0, "writes": 0,
            "att_rx_cids": [], "att_tx_cids": [], "notify_buckets": {},
        }
        if transport == "LE":
            c["att_channel"] = "LE CID 0x0004"
        self.connections.append(c)
        self.open_by_handle[handle] = c
        return c

    # ---------- btsnoop ----------
    def load(self, path):
        with open(path, "rb") as f:
            data = f.read()
        if len(data) < 16 or data[:8] != b"btsnoop\0":
            raise ValueError("不是 btsnoop 檔案")
        _ver, datalink = struct.unpack(">II", data[8:16])
        if datalink not in (1002, 2001):
            raise ValueError("不支援的 datalink %d" % datalink)
        self.datalink = datalink
        off = 16
        while off + 24 <= len(data):
            _orig, incl, flags, _drops, ts = struct.unpack(">IIIIq", data[off:off + 24])
            off += 24
            pkt = data[off:off + incl]
            off += incl
            if len(pkt) < incl:
                self.warnings.append("檔案結尾不完整（擷取可能被中斷）")
                break
            t = (ts - BTSNOOP_EPOCH_DELTA_US) / 1e6
            if self.first_ts is None:
                self.first_ts = t
            self.last_ts = t
            self.packets += 1
            try:
                self.dispatch(t, flags, pkt)
            except (struct.error, IndexError):
                pass

    def dispatch(self, t, flags, pkt):
        if self.datalink == 2001:
            opcode = flags & 0xFFFF
            if opcode == 2:
                self.on_command(t, pkt)
            elif opcode == 3:
                self.on_event(t, pkt)
            elif opcode in (4, 5):
                self.on_acl(t, pkt, tx=(opcode == 4))
        else:
            if not pkt:
                return
            h4, body = pkt[0], pkt[1:]
            if h4 == 1:
                self.on_command(t, body)
            elif h4 == 4:
                self.on_event(t, body)
            elif h4 == 2:
                self.on_acl(t, body, tx=not (flags & 1))

    # ---------- HCI commands ----------
    def on_command(self, t, p):
        op, _plen = struct.unpack("<HB", p[:3])
        a = p[3:]
        if op == 0x0406:
            handle, reason = struct.unpack("<HB", a[:3])
            handle &= 0x0FFF
            self.pending_disconnect[handle] = t
            c = self.open_by_handle.get(handle)
            self.event(t, c, "conn", "本機要求斷線", hex_reason(reason, DISCONNECT_REASONS))
        elif op == 0x040B:
            addr = bdaddr(a)
            self.event(t, self.conn_by_addr(addr, "BR/EDR"), "pair_br", "Link Key Request Reply", "本機有 Link Key，" + addr)
        elif op == 0x040C:
            addr = bdaddr(a)
            self.event(t, self.conn_by_addr(addr, "BR/EDR"), "error", "Link Key Request Negative Reply",
                       "本機沒有此裝置的 Link Key，" + addr)
        elif op == 0x042B:
            addr = bdaddr(a)
            self.event(t, self.conn_by_addr(addr, "BR/EDR"), "pair_br", "本機 IO Capability",
                       "%s, OOB=%d, AuthReq=0x%02X" % (IO_CAPS.get(a[6], a[6]), a[7], a[8]))
        elif op == 0x0434:
            addr = bdaddr(a)
            self.event(t, self.conn_by_addr(addr, "BR/EDR"), "error", "IO Capability Negative Reply",
                       "reason 0x%02X" % a[6])
        elif op == 0x042C:
            addr = bdaddr(a)
            self.event(t, self.conn_by_addr(addr, "BR/EDR"), "pair_br", "User Confirmation 接受", addr)
        elif op == 0x042D:
            addr = bdaddr(a)
            self.event(t, self.conn_by_addr(addr, "BR/EDR"), "error", "User Confirmation 拒絕", addr)
        elif op == 0x0411:
            handle = struct.unpack("<H", a[:2])[0] & 0x0FFF
            self.event(t, self.open_by_handle.get(handle), "pair_br", "Authentication Requested", "")
        elif op == 0x0413:
            handle, en = struct.unpack("<HB", a[:3])
            self.event(t, self.open_by_handle.get(handle & 0x0FFF), "enc", "Set Connection Encryption", "enable=%d" % en)
        elif op == 0x2019:
            handle = struct.unpack("<H", a[:2])[0] & 0x0FFF
            self.event(t, self.open_by_handle.get(handle), "enc", "LE Start Encryption", "")
        elif op == 0x201A:
            handle = struct.unpack("<H", a[:2])[0] & 0x0FFF
            self.event(t, self.open_by_handle.get(handle), "pair_le", "LTK Request Reply", "本機有 LTK")
        elif op == 0x201B:
            handle = struct.unpack("<H", a[:2])[0] & 0x0FFF
            self.event(t, self.open_by_handle.get(handle), "error", "LTK Request Negative Reply", "本機沒有 LTK")

    # ---------- HCI events ----------
    def on_event(self, t, p):
        code, _plen = p[0], p[1]
        a = p[2:]
        if code == 0x03:
            status, handle = struct.unpack("<BH", a[:3])
            addr = bdaddr(a[3:9])
            link_type = a[9]
            if link_type not in (0x01,):
                return
            if status != 0:
                self.event(t, None, "error", "BR/EDR 連線失敗", "%s %s" % (addr, hex_reason(status, DISCONNECT_REASONS)))
                return
            c = self.new_conn(t, handle & 0x0FFF, "BR/EDR", addr)
            self.event(t, c, "conn", "BR/EDR 連線建立", addr)
        elif code == 0x05:
            status, handle, reason = struct.unpack("<BHB", a[:4])
            handle &= 0x0FFF
            c = self.open_by_handle.get(handle)
            if status != 0 or c is None or c["end"] is not None:
                return
            c["end"] = t
            c["disconnect_reason"] = reason
            c["disconnect_reason_text"] = hex_reason(reason, DISCONNECT_REASONS)
            c["disconnect_by"] = "local" if handle in self.pending_disconnect or reason == 0x16 else "remote"
            self.pending_disconnect.pop(handle, None)
            self.event(t, c, "disconnect", "%s 斷線" % c["transport"], c["disconnect_reason_text"])
        elif code == 0x06:
            status, handle = struct.unpack("<BH", a[:3])
            c = self.open_by_handle.get(handle & 0x0FFF)
            cat = "pair_br" if status == 0 else "error"
            self.event(t, c, cat, "Authentication Complete", hex_reason(status, DISCONNECT_REASONS))
        elif code in (0x08, 0x59):
            status, handle, enabled = struct.unpack("<BHB", a[:4])
            c = self.open_by_handle.get(handle & 0x0FFF)
            detail = "status %s, enabled=%d" % (hex_reason(status, DISCONNECT_REASONS), enabled)
            if code == 0x59 and len(a) >= 5:
                detail += ", key size %d" % a[4]
            if status == 0 and enabled and c is not None and c["encrypted_at"] is None:
                c["encrypted_at"] = t
            self.event(t, c, "enc" if status == 0 else "error", "Encryption Change", detail)
        elif code == 0x30:
            status, handle = struct.unpack("<BH", a[:3])
            self.event(t, self.open_by_handle.get(handle & 0x0FFF), "enc" if status == 0 else "error",
                       "Encryption Key Refresh", hex_reason(status, DISCONNECT_REASONS))
        elif code == 0x17:
            addr = bdaddr(a)
            self.event(t, self.conn_by_addr(addr, "BR/EDR"), "pair_br", "Link Key Request", addr)
        elif code == 0x18:
            addr = bdaddr(a)
            ktype = a[22]
            self.event(t, self.conn_by_addr(addr, "BR/EDR"), "pair_br", "Link Key Notification",
                       "%s, type %d %s" % (addr, ktype, LINK_KEY_TYPES.get(ktype, "")))
        elif code == 0x31:
            addr = bdaddr(a)
            self.event(t, self.conn_by_addr(addr, "BR/EDR"), "pair_br", "IO Capability Request", addr)
        elif code == 0x32:
            addr = bdaddr(a)
            self.event(t, self.conn_by_addr(addr, "BR/EDR"), "pair_br", "對端 IO Capability",
                       "%s, OOB=%d, AuthReq=0x%02X" % (IO_CAPS.get(a[6], a[6]), a[7], a[8]))
        elif code == 0x33:
            addr = bdaddr(a)
            passkey = struct.unpack("<I", a[6:10])[0]
            self.event(t, self.conn_by_addr(addr, "BR/EDR"), "pair_br", "User Confirmation Request",
                       "數字比對 %06d" % passkey)
        elif code == 0x36:
            status = a[0]
            addr = bdaddr(a[1:7])
            self.event(t, self.conn_by_addr(addr, "BR/EDR"), "pair_br" if status == 0 else "error",
                       "Simple Pairing Complete", hex_reason(status, DISCONNECT_REASONS))
        elif code == 0x3E:
            self.on_le_meta(t, a)

    def on_le_meta(self, t, a):
        sub = a[0]
        if sub in (0x01, 0x0A, 0x29):
            status, handle, role, atype = struct.unpack("<BHBB", a[1:6])
            addr = bdaddr(a[6:12])
            if status != 0:
                self.event(t, None, "error", "LE 連線失敗", "%s %s" % (addr, hex_reason(status, DISCONNECT_REASONS)))
                return
            atype_s = {0: "public", 1: "random", 2: "public-id", 3: "random-id"}.get(atype, str(atype))
            c = self.new_conn(t, handle & 0x0FFF, "LE", addr, atype_s, "central" if role == 0 else "peripheral")
            self.event(t, c, "conn", "LE 連線建立", "%s (%s), 本機角色 %s" % (addr, atype_s, c["role"]))
        elif sub == 0x05:
            handle = struct.unpack("<H", a[1:3])[0] & 0x0FFF
            self.event(t, self.open_by_handle.get(handle), "pair_le", "LE LTK Request", "")

    # ---------- ACL / L2CAP ----------
    def on_acl(self, t, p, tx):
        hf, _dlen = struct.unpack("<HH", p[:4])
        handle = hf & 0x0FFF
        pb = (hf >> 12) & 0x3
        if pb == 0x1:
            return
        c = self.open_by_handle.get(handle)
        if c is None:
            return
        l2 = p[4:]
        if len(l2) < 4:
            return
        _l2len, cid = struct.unpack("<HH", l2[:4])
        payload = l2[4:]
        if c["transport"] == "LE":
            if cid == 0x0004:
                self.on_att(t, c, payload, tx)
            elif cid == 0x0006:
                self.on_smp(t, c, payload, tx)
        else:
            if cid == 0x0001:
                self.on_l2cap_signal(t, c, payload, tx)
            elif cid == 0x0007:
                self.on_smp(t, c, payload, tx)
            elif (tx and cid in c["att_tx_cids"]) or (not tx and cid in c["att_rx_cids"]):
                self.on_att(t, c, payload, tx)

    def on_l2cap_signal(self, t, c, p, tx):
        off = 0
        while off + 4 <= len(p):
            code, ident, clen = struct.unpack("<BBH", p[off:off + 4])
            d = p[off + 4:off + 4 + clen]
            off += 4 + clen
            key = (c["id"], ident)
            if code == 0x02 and len(d) >= 4:
                psm, scid = struct.unpack("<HH", d[:4])
                self.pending_l2cap[key] = (tx, psm, scid)
            elif code == 0x03 and len(d) >= 8:
                dcid, scid, result, _st = struct.unpack("<HHHH", d[:8])
                req = self.pending_l2cap.get(key)
                if req is None or result == 1:
                    continue
                self.pending_l2cap.pop(key, None)
                req_tx, psm, _req_scid = req
                if psm != PSM_ATT:
                    continue
                if result != 0:
                    self.event(t, c, "error", "BR/EDR ATT 通道被拒", "result 0x%04X" % result)
                    continue
                # 請求方的 scid 是它自己的本地 CID；回應方的 dcid 是它自己的本地 CID
                if req_tx:
                    local_cid, remote_cid = scid, dcid
                else:
                    local_cid, remote_cid = dcid, scid
                c["att_rx_cids"].append(local_cid)
                c["att_tx_cids"].append(remote_cid)
                c["att_channel"] = "BR/EDR PSM 0x1F"
                self.event(t, c, "att", "BR/EDR ATT 通道建立",
                           "%s發起, 本機 CID 0x%04X / 對端 CID 0x%04X" % ("本機" if req_tx else "對端", local_cid, remote_cid))

    def on_att(self, t, c, p, tx):
        if not p:
            return
        op = p[0]
        c["att_packets"] += 1
        direction = "本機→對端" if tx else "對端→本機"
        if op == 0x1B:
            c["notifications"] += 1
            sec = int(t - c["start"])
            c["notify_buckets"][sec] = c["notify_buckets"].get(sec, 0) + 1
        elif op == 0x1D:
            c["indications"] += 1
        if op in (0x1B, 0x1D) and len(p) >= 3:
            h = struct.unpack("<H", p[1:3])[0]
            self.event(t, c, "notify", ATT_OPCODES[op],
                       "%s %s = %s" % (direction, self.char_label(c, tx, h), hex_data(p[3:])))
        elif op in (0x12, 0x52) and len(p) >= 3:
            c["writes"] += 1
            h = struct.unpack("<H", p[1:3])[0]
            val = p[3:]
            if op == 0x12 and (h in self.cccd_handles or (len(val) == 2 and val[1] == 0 and val[0] in (0, 1, 2))):
                bits = val[0] if val else 0
                meaning = {0: "關閉", 1: "Notify", 2: "Indicate"}.get(bits, "0x%02X" % bits)
                tag = "" if h in self.cccd_handles else "（推測）"
                self.event(t, c, "cccd", "CCCD 寫入" + tag,
                           "%s handle 0x%04X = %s" % (direction, h, meaning))
            else:
                self.event(t, c, "gatt_write", "GATT 寫入" if op == 0x12 else "GATT 寫入（Write Cmd）",
                           "%s %s = %s" % (direction, self.char_label(c, not tx, h), hex_data(val)))
        elif op == 0x08 and len(p) >= 7:
            attr_type = p[5:]
            self.pending_read_type[(c["id"], tx)] = struct.unpack("<H", attr_type)[0] if len(attr_type) == 2 else None
        elif op == 0x09 and len(p) >= 2:
            # 特徵值宣告（0x2803）：handle(2) + properties(1) + value handle(2) + UUID(2/16)
            if self.pending_read_type.pop((c["id"], not tx), None) == 0x2803 and p[1] >= 7:
                step = p[1]
                for i in range(2, len(p) - step + 1, step):
                    vh = struct.unpack("<H", p[i + 3:i + 5])[0]
                    self.char_uuids[(c["id"], tx, vh)] = uuid_str(p[i + 5:i + step])
        elif op == 0x05 and len(p) >= 2:
            fmt = p[1]
            step = 4 if fmt == 1 else 18
            for i in range(2, len(p) - step + 1, step):
                h = struct.unpack("<H", p[i:i + 2])[0]
                if fmt == 1 and struct.unpack("<H", p[i + 2:i + 4])[0] == 0x2902:
                    self.cccd_handles.add(h)
        elif op == 0x01 and len(p) >= 5:
            req_op, h, err = p[1], struct.unpack("<H", p[2:4])[0], p[4]
            category, interpretation = classify_att_error(req_op, err)
            detail = "%s %s, handle 0x%04X, %s" % (direction, ATT_OPCODES.get(req_op, "0x%02X" % req_op),
                                                   h, hex_reason(err, ATT_ERRORS))
            if interpretation:
                detail += "（%s）" % interpretation
            # 保留所有協定 Error Response，category 才是實務判讀的分類。
            self.att_errors.append({"t": t, "conn": c["id"], "detail": detail, "code": err,
                                    "request_opcode": req_op, "category": category})
            self.event(t, c, category, "ATT Error Response", detail)
        elif op in (0x02, 0x03) and len(p) >= 3:
            mtu = struct.unpack("<H", p[1:3])[0]
            self.event(t, c, "att", ATT_OPCODES[op], "%s MTU %d" % (direction, mtu))

    def on_smp(self, t, c, p, tx):
        if not p:
            return
        code = p[0]
        who = "本機" if tx else "對端"
        cat = "pair_le"
        if code in (0x01, 0x02) and len(p) >= 7:
            name = "Pairing Request" if code == 0x01 else "Pairing Response"
            auth = p[3]
            flags = []
            if auth & 0x01:
                flags.append("Bonding")
            if auth & 0x04:
                flags.append("MITM")
            if auth & 0x08:
                flags.append("SC")
            if auth & 0x20:
                flags.append("CT2")
            self.event(t, c, cat, "SMP %s（%s）" % (name, who),
                       "%s, AuthReq=%s, MaxKey=%d, InitKeys=0x%02X, RespKeys=0x%02X"
                       % (IO_CAPS.get(p[1], p[1]), "|".join(flags) or "0", p[4], p[5], p[6]))
        elif code == 0x05 and len(p) >= 2:
            self.event(t, c, "error", "SMP Pairing Failed（%s 發出）" % who, hex_reason(p[1], SMP_FAIL_REASONS))
        elif code == 0x0B:
            self.event(t, c, cat, "SMP Security Request（%s）" % who, "AuthReq=0x%02X" % (p[1] if len(p) > 1 else 0))
        elif code == 0x06:
            self.event(t, c, cat, "SMP 分發 LTK（%s）" % who, "")
        elif code == 0x08:
            self.event(t, c, cat, "SMP 分發 IRK（%s）" % who, "")
        elif code == 0x09 and len(p) >= 8:
            addr = bdaddr(p[2:8])
            if not tx:
                c["identity_address"] = addr
            self.event(t, c, cat, "SMP Identity Address（%s）" % who, addr)
        elif code == 0x0A:
            self.event(t, c, cat, "SMP 分發 CSRK（%s）" % who, "")

    # ---------- finalize ----------
    def finalize(self):
        for c in self.connections:
            c["gatt"] = c["att_packets"] > 0
            c["notify_per_sec"] = sorted(c.pop("notify_buckets").items())
            c.pop("att_rx_cids")
            c.pop("att_tx_cids")
            if c["transport"] == "BR/EDR" and not c["gatt"]:
                c["att_channel"] = None
        self.events.sort(key=lambda e: e["t"])


# ---------- 金鑰快照 ----------
KEY_SECTIONS = ["LinkKey", "LongTermKey", "PeripheralLongTermKey", "SlaveLongTermKey",
                "IdentityResolvingKey", "LocalSignatureKey", "RemoteSignatureKey"]
KEY_FIELDS = ["Type", "Authenticated", "EncSize", "PINLength"]


def load_keys(path):
    result = {}
    if not os.path.exists(path):
        return None
    with tarfile.open(path, "r:gz") as tf:
        for m in tf.getmembers():
            parts = m.name.strip("./").split("/")
            if len(parts) != 4 or parts[0] != "bluetooth" or parts[3] != "info" or not m.isfile():
                continue
            adapter, dev = parts[1], parts[2]
            text = tf.extractfile(m).read().decode("utf-8", "replace")
            cp = configparser.ConfigParser(interpolation=None, strict=False)
            cp.optionxform = str
            try:
                cp.read_string(text)
            except configparser.Error:
                continue
            info = {"name": cp.get("General", "Name", fallback=""),
                    "technologies": cp.get("General", "SupportedTechnologies", fallback=""),
                    "address_type": cp.get("General", "AddressType", fallback=""),
                    "keys": {}}
            for s in KEY_SECTIONS:
                if cp.has_section(s):
                    info["keys"][s] = {f: cp.get(s, f) for f in KEY_FIELDS if cp.has_option(s, f)}
            result.setdefault(adapter, {})[dev] = info
    return result


def describe_key(k):
    if k is None:
        return "無"
    if not k:
        return "有"
    return ", ".join("%s=%s" % (f, v) for f, v in k.items())


def diff_keys(before, after):
    rows = []
    if before is None or after is None:
        return rows
    adapters = sorted(set(before) | set(after))
    for ad in adapters:
        b_devs, a_devs = before.get(ad, {}), after.get(ad, {})
        for dev in sorted(set(b_devs) | set(a_devs)):
            b, a = b_devs.get(dev), a_devs.get(dev)
            name = (a or b)["name"]
            sections = set((b or {}).get("keys", {})) | set((a or {}).get("keys", {}))
            if not sections:
                sections = {"(無金鑰)"}
            for s in sorted(sections):
                bk = (b or {}).get("keys", {}).get(s) if b else None
                ak = (a or {}).get("keys", {}).get(s) if a else None
                if b is None:
                    change = "新增裝置"
                elif a is None:
                    change = "裝置被刪除"
                elif bk is None and ak is not None:
                    change = "新增"
                elif bk is not None and ak is None:
                    change = "移除"
                elif bk != ak:
                    change = "變更"
                else:
                    change = ""
                rows.append({"adapter": ad, "device": dev, "name": name, "section": s,
                             "before": describe_key(bk) if b else "（無此裝置）",
                             "after": describe_key(ak) if a else "（無此裝置）",
                             "change": change})
    return rows


def load_marks(path):
    marks = []
    if not os.path.exists(path):
        return marks
    for line in open(path, encoding="utf-8", errors="replace"):
        line = line.rstrip("\n")
        if not line:
            continue
        ts, _, text = line.partition(" ")
        try:
            marks.append({"t": float(ts), "text": text})
        except ValueError:
            pass
    return marks


def fmt_t(t, base):
    return "+%8.3fs" % (t - base) if base is not None else "%.3f" % t


def write_text(summary, path):
    base = summary["capture"]["first_ts"]
    out = io.StringIO()
    m = summary["meta"]
    out.write("情境: %s | App: %s | 手機: %s\n" % (m.get("scenario", ""), m.get("app", ""), m.get("phone", "")))
    out.write("封包數: %d\n\n" % summary["capture"]["packets"])
    out.write("== 連線 ==\n")
    for c in summary["connections"]:
        out.write("#%d %-6s handle 0x%04X %s%s 角色=%s 開始%s 結束%s GATT=%s(%s) notify=%d 斷線=%s(%s)\n" % (
            c["id"], c["transport"], c["handle"], c["address"],
            " id=" + c["identity_address"] if c["identity_address"] else "",
            c["role"] or "-", fmt_t(c["start"], base),
            fmt_t(c["end"], base) if c["end"] else " (未結束)",
            "有" if c["gatt"] else "無", c["att_channel"] or "-", c["notifications"],
            c["disconnect_reason_text"] or "-", c["disconnect_by"] or "-"))
    out.write("\n== 事件 ==\n")
    for e in summary["events"]:
        out.write("%s [%s] #%s %s %s\n" % (fmt_t(e["t"], base), e["category"],
                                          "-" if e["conn"] is None else e["conn"], e["title"], e["detail"]))
    out.write("\n== 金鑰差異 ==\n")
    for r in summary["keys"]["diff"]:
        out.write("%s %s %-22s 前: %s | 後: %s %s\n" % (r["device"], r["name"], r["section"],
                                                     r["before"], r["after"], r["change"]))
    if summary["warnings"]:
        out.write("\n== 警告 ==\n")
        for w in summary["warnings"]:
            out.write(w + "\n")
    with open(path, "w", encoding="utf-8") as f:
        f.write(out.getvalue())


def analyze(dirpath):
    meta_path = os.path.join(dirpath, "meta.json")
    meta = json.load(open(meta_path, encoding="utf-8")) if os.path.exists(meta_path) else {}
    an = Analyzer()
    if meta.get("capture_error"):
        an.warnings.append(meta["capture_error"])
    snoop = os.path.join(dirpath, "hci.btsnoop")
    if os.path.exists(snoop):
        try:
            an.load(snoop)
        except ValueError as e:
            an.warnings.append("hci.btsnoop 解析失敗: %s" % e)
    else:
        an.warnings.append("找不到 hci.btsnoop")
    an.finalize()

    marks = load_marks(os.path.join(dirpath, "marks.txt"))
    for mk in marks:
        an.events.append({"t": mk["t"], "conn": None, "category": "mark", "title": "標記", "detail": mk["text"]})
    an.events.sort(key=lambda e: e["t"])

    before = load_keys(os.path.join(dirpath, "keys_before.tgz"))
    after = load_keys(os.path.join(dirpath, "keys_after.tgz"))

    summary = {
        "meta": meta,
        "capture": {"first_ts": an.first_ts, "last_ts": an.last_ts, "packets": an.packets},
        "connections": an.connections,
        "events": an.events,
        "att_errors": an.att_errors,
        "marks": marks,
        "keys": {"before": before, "after": after, "diff": diff_keys(before, after)},
        "warnings": an.warnings,
    }
    with open(os.path.join(dirpath, "summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=1)
    write_text(summary, os.path.join(dirpath, "summary.txt"))
    return summary


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("用法: analyze.py <capture_dir>")
    s = analyze(sys.argv[1])
    print("連線 %d 條，事件 %d 筆，輸出 %s" % (len(s["connections"]), len(s["events"]),
                                         os.path.join(sys.argv[1], "summary.txt")))
