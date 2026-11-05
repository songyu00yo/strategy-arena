#!/bin/zsh
set -eu
ROOT=${0:A:h}
while [[ ! -f "$ROOT/package.json" || ! -e "$ROOT/.git" ]]; do
  if [[ "$ROOT" == / ]]; then print '找不到项目目录。'; exit 1; fi
  ROOT=${ROOT:h}
done
NODE=$(command -v node || true)
if [[ -z "$NODE" ]] || [[ "$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)" != 24 ]]; then
  NODE="$HOME/.local/share/fnm/node-versions/v24.19.0/installation/bin/node"
fi
if [[ ! -x "$NODE" ]]; then print '请先安装 Node.js 24。'; exit 1; fi
RELEASE="$ROOT/work/releases/db821be"
URL='http://127.0.0.1:3200'
EXPECTED='db821be68e60d76bbec86671f2bcd7ae52292bf1'
if /usr/bin/curl -fsS "$URL/api/health" 2>/dev/null | "$NODE" -e 'let data=""; process.stdin.on("data",x=>data+=x).on("end",()=>{try{process.exit(JSON.parse(data).commit===process.argv[1]?0:1)}catch{process.exit(1)}})' "$EXPECTED"; then
  if [[ "${1:-}" != --no-open ]]; then /usr/bin/open "$URL"; fi
  exit 0
fi
if /usr/sbin/lsof -tiTCP:3200 -sTCP:LISTEN >/dev/null 2>&1; then
  print '3200 端口已被其他版本占用；没有停止其他程序。'
  exit 1
fi
if [[ ! -f "$RELEASE/server.js" || ! -f "$ROOT/.env.local" ]]; then
  print '本机运行文件或私有配置缺失，请查看交付验收说明。'
  exit 1
fi
cd "$RELEASE"
umask 077
export HOSTNAME=127.0.0.1 PORT=3200 NODE_ENV=production
export ARENA_PUBLIC_DEMO=true ARENA_PUBLIC_ORIGIN="$URL" ARENA_WORKER_ENABLED=true ARENA_RUN_BUDGET_CNY=1.4
export ARENA_DATABASE_PATH="$ROOT/data/arena.sqlite"
if [[ "${1:-}" != --no-open ]]; then (sleep 1; /usr/bin/open "$URL") & fi
print '本地预览正在运行。关闭此终端或按 Control-C 可停止服务。'
exec "$NODE" --env-file="$ROOT/.env.local" server.js
