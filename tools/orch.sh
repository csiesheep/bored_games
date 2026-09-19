#!/usr/bin/env bash
# orchestrator 的機械動作。規矩在 TEAM.md；這裡只做「每次都一樣、手打會滑倒」的事。
#
#   orch wt <name> <ref> [--branch <b>]   在 _wt/<name> 開工作樹（預設 detached；--branch 開分支並拿掉 upstream）
#   orch rm <name>                        移除 _wt/<name>（有在 serve 就先停）
#   orch serve <name|dir>                 起 no-cache 伺服器、自己挑 port、curl 標記檔證明 origin 是你的
#   orch stop <name|dir>                  停掉 serve 起的那一個
#   orch falsify <file> '<sed>'           注入缺陷（sed 表達式必須含 FALSIFY）；有殘留或檔案不乾淨就拒絕
#   orch restore                          還原上一次注入的檔案，並驗證真的乾淨
#   orch clean                            斷言樹上沒有 FALSIFY、沒有待還原的注入（land 之前跑）
#
# Windows Git Bash 為主；需要 python、curl、netstat、taskkill。
# 2026-09-07 在一個丟棄用的 repo 上走過全部七個子命令（Windows 11 / Git Bash / python 3.10）：
#   wt 兩種模式、重複開拒絕、serve 背景行程活過工具呼叫、重複 serve 拒絕、falsify 四種拒絕、
#   restore 後 clean 綠、stop 用 netstat 抓到 pid、rm。stop 之後 curl 可能是 timeout 不是 refused。
set -u
# autocrlf 的「LF will be replaced by CRLF」警告會蓋掉 falsify 印的 diff——關掉
export GIT_CONFIG_PARAMETERS="'core.safecrlf=false'"

die(){ echo "orch: $*" >&2; exit 1; }

# 主 repo（不是目前所在的 worktree）：worktree 的 .git 是一個檔案，common-dir 指回主 repo
COMMON="$(git rev-parse --git-common-dir 2>/dev/null)" || die "不在 git repo 裡"
MAIN="$(cd "$COMMON/.." && pwd)"
WT_BASE="${ORCH_WT_BASE:-$(dirname "$MAIN")/_wt}"
MARKER='__MARKER_ORCH.txt'
STATE='__orch_falsify.state'
# 這兩個檔案本身就含 FALSIFY 字樣，掃描時排除
SELF_EXCLUDE=(':!tools/orch.sh' ':!TEAM.md')

resolve_dir(){   # name 或路徑 → 絕對路徑
  local x="$1"
  if [ -d "$x" ]; then (cd "$x" && pwd)
  elif [ -d "$WT_BASE/$x" ]; then (cd "$WT_BASE/$x" && pwd)
  else die "找不到工作樹：$x（也不是 $WT_BASE/$x）"; fi
}
write_marker(){  # <dir> <name>
  printf '%s %s\n' "$2" "$(git -C "$1" rev-parse --short HEAD)" > "$1/$MARKER"
}

# ---------------------------------------------------------------- wt / rm
cmd_wt(){
  local name="${1:-}" ref="${2:-}" branch=""
  [ -n "$name" ] && [ -n "$ref" ] || die "用法：orch wt <name> <ref> [--branch <b>]"
  shift 2
  while [ $# -gt 0 ]; do case "$1" in --branch) branch="${2:-}"; shift 2;; *) die "不認得的參數 $1";; esac; done
  local sha; sha="$(git -C "$MAIN" rev-parse --verify "$ref^{commit}" 2>/dev/null)" || die "解析不到 $ref"
  local dir="$WT_BASE/$name"
  [ -e "$dir" ] && die "已存在：$dir（先 orch rm $name）"
  mkdir -p "$WT_BASE"
  if [ -n "$branch" ]; then
    git -C "$MAIN" worktree add -b "$branch" "$dir" "$sha" >/dev/null || die "worktree add 失敗"
    # 每個從 origin/main 開的分支都會繼承 upstream，裸 git push 就是部署——拿掉它
    git -C "$dir" branch --unset-upstream >/dev/null 2>&1 || true
  else
    git -C "$MAIN" worktree add --detach "$dir" "$sha" >/dev/null || die "worktree add 失敗"
  fi
  write_marker "$dir" "$name"
  # 印解析後的 SHA，不印你打的 ref：分支名是一次讀數，merge 的時候貼這個
  printf 'wt %-10s %s  %-10s %s\n' "$name" "$(git -C "$dir" rev-parse --short HEAD)" "${branch:-detached}" "$dir"
}

cmd_rm(){
  local name="${1:-}"; [ -n "$name" ] || die "用法：orch rm <name>"
  local dir; dir="$(resolve_dir "$name")" || exit 1
  [ -f "$dir/__orch_serve.port" ] && cmd_stop "$dir"
  git -C "$MAIN" worktree remove --force "$dir" && echo "rm $(basename "$dir")"
}

# ---------------------------------------------------------------- serve / stop
free_port(){ python -c "import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1])"; }

cmd_serve(){
  local dir; dir="$(resolve_dir "${1:-.}")" || exit 1
  local name; name="$(basename "$dir")"
  [ -f "$dir/__orch_serve.port" ] && die "$name 已經在 serve（port $(cat "$dir/__orch_serve.port")）；先 orch stop $name"
  [ -f "$dir/$MARKER" ] || write_marker "$dir" "$name"
  local want; want="$(cat "$dir/$MARKER")"
  local port; port="$(free_port)"
  python "$dir/tools/serve.py" "$port" "$dir" > "$dir/__orch_serve.log" 2>&1 &
  echo "$port" > "$dir/__orch_serve.port"
  # 起完自己 curl：對得上 name + SHA 才是你的 origin（port 是共用資源，背景失敗你不會立刻看到）
  local got; got="$(curl -s --retry 10 --retry-delay 1 --retry-connrefused "http://127.0.0.1:$port/$MARKER")"
  if [ "$got" != "$want" ]; then
    rm -f "$dir/__orch_serve.port"
    die "port $port 上回的不是我的標記（要「$want」，拿到「$got」）"
  fi
  echo "serve $name  http://127.0.0.1:$port  ($want)"
  echo "harness: http://127.0.0.1:$port/tests/index.html?json=1"
}

cmd_stop(){
  local dir; dir="$(resolve_dir "${1:-.}")" || exit 1
  [ -f "$dir/__orch_serve.port" ] || die "$(basename "$dir") 沒有在 serve"
  local port; port="$(cat "$dir/__orch_serve.port")"
  # 用 port 找 Windows pid：bash 的 $! 是 MSYS pid，taskkill 不認
  local pid; pid="$(netstat -ano 2>/dev/null | awk -v p=":$port" '$2 ~ p"$" && $4=="LISTENING" {print $5; exit}')"
  if [ -n "$pid" ]; then taskkill //F //PID "$pid" >/dev/null 2>&1 || kill "$pid" 2>/dev/null; fi
  rm -f "$dir/__orch_serve.port"
  echo "stop $(basename "$dir")  port $port${pid:+  pid $pid}"
}

# ---------------------------------------------------------------- falsify / restore / clean
cmd_falsify(){
  local file="${1:-}" expr="${2:-}"
  [ -n "$file" ] && [ -n "$expr" ] || die "用法：orch falsify <file> '<sed 表達式，含 FALSIFY>'"
  case "$expr" in *FALSIFY*) ;; *) die "sed 表達式要含 FALSIFY 字樣，restore / clean 才認得出來";; esac
  [ -f "$file" ] || die "找不到 $file"
  local dir; dir="$(git -C "$(dirname "$file")" rev-parse --show-toplevel)" || die "$file 不在 repo 裡"
  # 前置檢查：上一次的殘留、或檔案本來就不乾淨，都不是這一次該處理的
  [ -f "$dir/$STATE" ] && die "上一次注入還沒 restore（$(cat "$dir/$STATE")）"
  if git -C "$dir" grep -q FALSIFY -- ':/' "${SELF_EXCLUDE[@]}" 2>/dev/null; then
    die "樹上已有 FALSIFY：$(git -C "$dir" grep -l FALSIFY -- ':/' "${SELF_EXCLUDE[@]}" | tr '\n' ' ')"
  fi
  git -C "$dir" diff --quiet -- "$file" || die "$file 有未提交的改動，不能拿來注缺陷"
  sed -i "$expr" "$file" || die "sed 失敗"
  # 沒改到任何東西的注入，會通過所有測試——因為它什麼都沒做
  if git -C "$dir" diff --quiet -- "$file"; then die "sed 沒改到任何東西（pattern 沒命中）"; fi
  printf '%s\n' "$(cd "$(dirname "$file")" && pwd)/$(basename "$file")" > "$dir/$STATE"
  echo "falsify 注入 $file："
  git -C "$dir" --no-pager diff -U0 -- "$file" | grep '^[-+][^-+]' | sed 's/^/  /'
  echo "（跑完驗證後：orch restore）"
}

cmd_restore(){
  local dir; dir="$(git rev-parse --show-toplevel 2>/dev/null)" || die "不在 repo 裡"
  [ -f "$dir/$STATE" ] || die "沒有待還原的注入"
  local file; file="$(cat "$dir/$STATE")"
  git -C "$dir" checkout -- "$file" || die "checkout 失敗"
  # 還原不是一個步驟，是要被驗證的事實
  git -C "$dir" diff --quiet -- "$file" || die "還原後 $file 仍有差異"
  grep -q FALSIFY "$file" && die "還原後 $file 仍含 FALSIFY"
  rm -f "$dir/$STATE"
  echo "restore $file  乾淨"
}

cmd_clean(){
  local dir; dir="$(git rev-parse --show-toplevel 2>/dev/null)" || die "不在 repo 裡"
  local bad=0
  [ -f "$dir/$STATE" ] && { echo "clean: 有未還原的注入：$(cat "$dir/$STATE")"; bad=1; }
  if git -C "$dir" grep -q FALSIFY -- ':/' "${SELF_EXCLUDE[@]}" 2>/dev/null; then
    echo "clean: 樹上有 FALSIFY：$(git -C "$dir" grep -l FALSIFY -- ':/' "${SELF_EXCLUDE[@]}" | tr '\n' ' ')"; bad=1
  fi
  [ "$bad" = 0 ] && echo "clean: 沒有 FALSIFY、沒有待還原的注入"
  return "$bad"
}

case "${1:-}" in
  wt)      shift; cmd_wt "$@";;
  rm)      shift; cmd_rm "$@";;
  serve)   shift; cmd_serve "$@";;
  stop)    shift; cmd_stop "$@";;
  falsify) shift; cmd_falsify "$@";;
  restore) shift; cmd_restore "$@";;
  clean)   shift; cmd_clean "$@";;
  *) sed -n '2,10p' "$0"; exit 1;;
esac
