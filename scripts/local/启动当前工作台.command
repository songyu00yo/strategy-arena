#!/bin/zsh
set -eu

fail() {
  print -u2 -- "$1"
  if [[ -t 0 ]]; then read -r '?按回车关闭。'; fi
  exit 1
}

ARENA_ROOT=${0:A:h}
while [[ ! -f "$ARENA_ROOT/package.json" || ! -e "$ARENA_ROOT/.git" ]]; do
  if [[ "$ARENA_ROOT" == / ]]; then fail '找不到项目目录。'; fi
  ARENA_ROOT=${ARENA_ROOT:h}
done

ARENA_NODE=$(command -v node || true)
if [[ -z "$ARENA_NODE" ]] || [[ "$("$ARENA_NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)" != 24 ]]; then
  fail '请先在终端启用 Node.js 24，再启动工作台。'
fi
ARENA_PNPM=$(command -v pnpm || true)
if [[ -z "$ARENA_PNPM" ]]; then fail '找不到 pnpm，请先安装项目要求的 pnpm 11.19.0。'; fi

cd "$ARENA_ROOT"
print '当前工作台：http://127.0.0.1:3000'
print '按 Control-C 停止。3000 端口占用时会报错，不会停止已有服务。'
exec "$ARENA_PNPM" dev --port 3000
