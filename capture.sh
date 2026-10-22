#!/usr/bin/env bash
# 透過 SSH 在儀表端擷取藍牙資料。
#   capture.sh start <scenario> <app> <phone>
#   capture.sh start <scenario> --meta <json>   （json 內的欄位併入 meta.json，例如 devices）
#   capture.sh mark "<text>"
#   capture.sh stop
#   capture.sh force-stop
#   capture.sh status
#   capture.sh live <dir>   （擷取中把儀表端新增的資料追加到 <dir>，供即時分析）
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="${BTCAP_HOST:-root@192.168.7.1}"
CAP_ROOT="${BTCAP_DIR:-$HERE/captures}"
CURRENT="$CAP_ROOT/.current"
REMOTE_DIR=/tmp/btcap
MIN_FREE_KB=20480

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new
          -o ServerAliveInterval=3 -o ServerAliveCountMax=2
          -o ControlMaster=auto -o "ControlPath=/tmp/btcap-ssh-%r@%h:%p" -o ControlPersist=300)

die() { echo "錯誤: $*" >&2; exit 1; }
rsh() { ssh "${SSH_OPTS[@]}" "$HOST" "$@"; }

json_meta() {
    python3 - "$@" <<'EOF'
import json, sys
keys = sys.argv[1::2]
vals = sys.argv[2::2]
out = {}
for k, v in zip(keys, vals):
    try:
        out[k] = float(v) if k.endswith("_time") or k == "clock_offset" else v
    except ValueError:
        out[k] = v
print(json.dumps(out, ensure_ascii=False, indent=2))
EOF
}

now() { date +%s.%N; }

remote_now() {
    rsh 'd=$(date +%s.%N); case $d in *N*) d=$(date +%s);; esac; echo $d'
}

snapshot() {
    local dir="$1" tag="$2"
    rsh 'tar czf - -C /var/lib bluetooth 2>/dev/null' > "$dir/keys_$tag.tgz" \
        || echo "警告: 無法取得 /var/lib/bluetooth 快照" >&2
    rsh 'timeout 5 bluetoothctl devices Paired 2>&1; echo "----";
         for a in $(timeout 5 bluetoothctl devices Paired 2>/dev/null | awk "/^Device/{print \$2}"); do
             timeout 5 bluetoothctl info "$a" 2>&1; echo "----";
         done' > "$dir/bluetoothctl_$tag.txt" 2>&1 || true
}

cmd_start() {
    [ $# -ge 1 ] || die "用法: capture.sh start <scenario> [app] [phone] | start <scenario> --meta <json>"
    local scenario="$1" app="" phone="" extra=""
    if [ "${2:-}" = "--meta" ]; then
        extra="${3:-}"
        [ -f "$extra" ] || die "找不到 meta 檔: $extra"
    else
        app="${2:-}" phone="${3:-}"
    fi
    [ -f "$CURRENT" ] && die "已有擷取進行中: $(cat "$CURRENT")，請先 stop"

    rsh true || die "無法 SSH 到 $HOST（請先設定 ssh-copy-id）"

    local missing
    missing=$(rsh 'for c in btmon dbus-monitor bluetoothctl; do command -v $c >/dev/null || echo $c; done')
    [ -z "$missing" ] || die "儀表上缺少工具: $missing"

    local free_kb
    free_kb=$(rsh "df -k /tmp | awk 'NR==2{print \$4}'")
    [ "${free_kb:-0}" -ge "$MIN_FREE_KB" ] || die "儀表 /tmp 剩餘空間不足: ${free_kb} KB"

    if rsh "[ -f $REMOTE_DIR/pids ]"; then
        die "儀表上有上一輪未結束的擷取（$REMOTE_DIR/pids），請先執行 capture.sh stop 或手動清除"
    fi
    kill_strays

    local safe dir
    # 非英數字（例如中文）會變成底線；壓縮連續底線，全是底線就只用時間當名稱
    safe=$(printf '%s' "$scenario" | tr -c 'A-Za-z0-9_-' '_' | tr -s '_' | sed 's/^_//; s/_$//' | cut -c1-40)
    dir="$CAP_ROOT/$(date +%Y%m%d-%H%M%S)${safe:+_$safe}"
    mkdir -p "$dir"
    # 啟動途中失敗就刪掉這個目錄，避免留下沒有 meta.json 的殘骸
    trap "rm -rf '$dir'" EXIT

    local t0 rt t1 offset
    t0=$(now); rt=$(remote_now); t1=$(now)
    offset=$(python3 -c "print(float('$rt') - (float('$t0') + float('$t1')) / 2)")

    snapshot "$dir" before

    # 注意：每個背景程式必須獨立一行啟動，$! 才會是該程式本身的 pid。
    # （舊版把 rm/mkdir/cd 與 btmon 用 && 串起來再加 &，整串變成背景子 shell，
    #   $! 是子 shell 的 pid，stop 時殺不掉 btmon，且 mkdir 與後續寫檔會互相競爭。）
    rsh "sh -s $REMOTE_DIR" <<'EOF' || die "儀表端啟動擷取程式失敗"
set -e
D="$1"
rm -rf "$D"
mkdir -p "$D"
cd "$D"
: > marks.txt
nohup btmon -w "$D/hci.btsnoop" > btmon.out 2>&1 < /dev/null &
echo $! > pids.tmp
nohup dbus-monitor --system "sender='org.bluez'" "destination='org.bluez'" > dbus.log 2>&1 < /dev/null &
echo $! >> pids.tmp
if command -v journalctl > /dev/null; then
    nohup journalctl -f -n 0 -o short-precise > journal.log 2>&1 < /dev/null &
    echo $! >> pids.tmp
fi
mv pids.tmp pids
EOF

    sleep 1
    local dead
    dead=$(rsh "for p in \$(cat $REMOTE_DIR/pids); do kill -0 \$p 2>/dev/null || echo \$p; done")
    [ -z "$dead" ] || echo "警告: 部分擷取程式未正常啟動（pid $dead），請檢查儀表 $REMOTE_DIR/*.out/*.log" >&2

    if [ -n "$extra" ]; then
        json_meta scenario "$scenario" host "$HOST" start_time "$t0" clock_offset "$offset" > "$dir/meta.json"
        python3 - "$dir/meta.json" "$extra" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    meta = json.load(f)
with open(sys.argv[2], encoding="utf-8") as f:
    meta.update({k: v for k, v in json.load(f).items() if k not in meta})
with open(sys.argv[1], "w", encoding="utf-8") as f:
    json.dump(meta, f, ensure_ascii=False, indent=2)
PY
    else
        json_meta scenario "$scenario" app "$app" phone "$phone" host "$HOST" \
            start_time "$t0" clock_offset "$offset" > "$dir/meta.json"
    fi
    echo "$dir" > "$CURRENT"
    trap - EXIT
    echo "$dir"
}

# 清掉儀表上本工具遺留的擷取程式（例如舊版 bug 或中斷造成的孤兒程式）。
# pattern 首字加 [] 是為了不讓 pkill 比對到執行這段指令的 shell 本身。
kill_strays() {
    rsh "pkill -f '[b]tmon -w $REMOTE_DIR/'; pkill -f \"[d]bus-monitor --system sender='org.bluez'\";
         pkill -f '[j]ournalctl -f -n 0 -o short-precise'; true"
}

cmd_mark() {
    [ -f "$CURRENT" ] || die "目前沒有擷取進行中"
    local text="${1:-}"
    printf '%s\n' "$text" | rsh "IFS= read -r t; d=\$(date +%s.%N); case \$d in *N*) d=\$(date +%s);; esac;
                                 echo \"\$d \$t\" >> $REMOTE_DIR/marks.txt"
    echo "已標記"
}

cmd_stop() {
    [ -f "$CURRENT" ] || die "目前沒有擷取進行中"
    local dir
    dir=$(cat "$CURRENT")
    [ -d "$dir" ] || die "本機擷取目錄不存在，請使用強制關閉解除狀態"

    local status
    if rsh "test -d '$REMOTE_DIR'"; then
        :
    else
        status=$?
        if [ "$status" -eq 1 ]; then
            local message="儀表端 $REMOTE_DIR 已不存在（可能重開機或暫存目錄被清除）；本次資料不完整，已保留本機檔案。"
            echo "警告: $message" >&2
            finish_capture "$dir" missing_remote "$message"
            python3 "$HERE/analyze.py" "$dir" || true
            echo "$dir"
            return
        fi
        die "無法確認儀表端擷取狀態（SSH 失敗）；可重試停止或使用強制關閉"
    fi

    rsh "[ -f $REMOTE_DIR/pids ] && kill \$(cat $REMOTE_DIR/pids) 2>/dev/null; sleep 1; rm -f $REMOTE_DIR/pids" || true
    kill_strays || true
    snapshot "$dir" after
    # 完整拉回後才合併，避免傳輸失敗覆寫先前已取得的檔案。
    local staging
    staging=$(mktemp -d "$dir/.pull.XXXXXX")
    if rsh "tar cf - -C '$REMOTE_DIR' ." | tar xf - -C "$staging"; then
        cp -a "$staging/." "$dir/"
        rm -rf "$staging"
    else
        rm -rf "$staging"
        die "拉回檔案失敗；本機已取得的檔案仍保留。請確認儀表端 $REMOTE_DIR，或使用強制關閉解除狀態"
    fi
    rsh "rm -rf $REMOTE_DIR" || true

    finish_capture "$dir" complete ""

    python3 "$HERE/analyze.py" "$dir" || echo "警告: 分析失敗，原始檔案已保存在 $dir" >&2
    echo "$dir"
}

finish_capture() {
    local dir="$1" status="$2" message="$3"
    if [ -d "$dir" ]; then
        python3 - "$dir/meta.json" "$(now)" "$status" "$message" <<'EOF'
import json, os, sys
p, stop, status, message = sys.argv[1:]
try:
    with open(p, encoding="utf-8") as f:
        meta = json.load(f)
except (OSError, ValueError):
    meta = {}
meta.update(stop_time=float(stop), completion_status=status)
if message:
    meta["capture_error"] = message
else:
    meta.pop("capture_error", None)
with open(p + ".tmp", "w", encoding="utf-8") as f:
    json.dump(meta, f, ensure_ascii=False, indent=2)
os.replace(p + ".tmp", p)
EOF
    fi
    rm -f "$CURRENT"
}

cmd_force_stop() {
    local dir="" message="使用者強制關閉擷取；未完成拉回的資料可能仍留在儀表端 $REMOTE_DIR，本機檔案已保留。"
    [ ! -f "$CURRENT" ] || dir=$(cat "$CURRENT")
    # 先解除本機狀態，遠端失聯也不能再卡住下一輪擷取。
    finish_capture "$dir" forced "$message"
    echo "已強制關閉本機擷取狀態；已取得的紀錄均保留。"
    [ -z "$dir" ] || echo "$dir"
    # 不刪遠端資料。只盡力停止本工具的收集程序及清掉 pid 標記。
    if rsh "pkill -f '[b]tmon -w $REMOTE_DIR/'; pkill -f \"[d]bus-monitor --system sender='org.bluez'\";
             pkill -f '[j]ournalctl -f -n 0 -o short-precise'; rm -f '$REMOTE_DIR/pids'; true"; then
        echo "儀表端擷取程序已清理，暫存檔案未刪除。"
    else
        echo "警告: 無法清理儀表端擷取程序；本機狀態已解除，可重新開始。" >&2
    fi
}

# btsnoop 與 journal 只會往後追加，只拉回本機還沒有的部分
cmd_live() {
    local dest="${1:-}" f have
    [ -n "$dest" ] || die "用法: capture.sh live <dir>"
    [ -f "$CURRENT" ] || die "目前沒有擷取進行中"
    mkdir -p "$dest"
    for f in hci.btsnoop journal.log; do
        have=$(stat -c %s "$dest/$f" 2>/dev/null || echo 0)
        rsh "tail -c +$((have + 1)) $REMOTE_DIR/$f 2>/dev/null" >> "$dest/$f" || true
    done
    rsh "cat $REMOTE_DIR/marks.txt 2>/dev/null" > "$dest/marks.txt" || true
}

cmd_status() {
    if [ -f "$CURRENT" ]; then echo "capturing $(cat "$CURRENT")"; else echo "idle"; fi
}

mkdir -p "$CAP_ROOT"
case "${1:-}" in
    start)  shift; cmd_start "$@" ;;
    mark)   shift; cmd_mark "$@" ;;
    stop)   shift; cmd_stop ;;
    force-stop) shift; cmd_force_stop ;;
    status) cmd_status ;;
    live)   shift; cmd_live "$@" ;;
    *) die "用法: capture.sh {start <scenario> [app] [phone] | start <scenario> --meta <json> | mark <text> | stop | force-stop | status | live <dir>}" ;;
esac
