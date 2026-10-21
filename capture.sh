#!/usr/bin/env bash
# 透過 SSH 在儀表端擷取藍牙資料。
#   capture.sh start <scenario> <app> <phone>
#   capture.sh mark "<text>"
#   capture.sh stop
#   capture.sh status
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="${BTCAP_HOST:-root@192.168.7.1}"
CAP_ROOT="${BTCAP_DIR:-$HERE/captures}"
CURRENT="$CAP_ROOT/.current"
REMOTE_DIR=/tmp/btcap
MIN_FREE_KB=20480

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new
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
    [ $# -ge 1 ] || die "用法: capture.sh start <scenario> [app] [phone]"
    local scenario="$1" app="${2:-}" phone="${3:-}"
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
    safe=$(printf '%s' "$scenario" | tr -c 'A-Za-z0-9_-' '_' | cut -c1-40)
    dir="$CAP_ROOT/$(date +%Y%m%d-%H%M%S)_$safe"
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

    json_meta scenario "$scenario" app "$app" phone "$phone" host "$HOST" \
        start_time "$t0" clock_offset "$offset" > "$dir/meta.json"
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

    rsh "[ -f $REMOTE_DIR/pids ] && kill \$(cat $REMOTE_DIR/pids) 2>/dev/null; sleep 1; rm -f $REMOTE_DIR/pids" || true
    kill_strays || true
    snapshot "$dir" after
    rsh "tar cf - -C $REMOTE_DIR ." | tar xf - -C "$dir" || die "拉回檔案失敗，儀表端資料仍保留在 $REMOTE_DIR"
    rsh "rm -rf $REMOTE_DIR" || true

    python3 - "$dir/meta.json" "$(now)" <<'EOF'
import json, sys
p = sys.argv[1]
m = json.load(open(p, encoding="utf-8"))
m["stop_time"] = float(sys.argv[2])
json.dump(m, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
EOF
    rm -f "$CURRENT"

    python3 "$HERE/analyze.py" "$dir" || echo "警告: 分析失敗，原始檔案已保存在 $dir" >&2
    echo "$dir"
}

cmd_status() {
    if [ -f "$CURRENT" ]; then echo "capturing $(cat "$CURRENT")"; else echo "idle"; fi
}

mkdir -p "$CAP_ROOT"
case "${1:-}" in
    start)  shift; cmd_start "$@" ;;
    mark)   shift; cmd_mark "$@" ;;
    stop)   shift; cmd_stop ;;
    status) cmd_status ;;
    *) die "用法: capture.sh {start <scenario> [app] [phone] | mark <text> | stop | status}" ;;
esac
