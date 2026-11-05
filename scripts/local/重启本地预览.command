#!/bin/zsh
set -eu
ROOT=${0:A:h}
while [[ ! -f "$ROOT/package.json" || ! -e "$ROOT/.git" ]]; do
  if [[ "$ROOT" == / ]]; then print '找不到项目目录。'; exit 1; fi
  ROOT=${ROOT:h}
done
PID=$(/usr/sbin/lsof -nP -t -iTCP:3200 -sTCP:LISTEN 2>/dev/null | /usr/bin/head -n 1 || true)
if [[ -n "$PID" ]]; then
  CURRENT=$(/usr/sbin/lsof -a -p "$PID" -d cwd -Fn | /usr/bin/sed -n 's/^n//p')
  if [[ "$CURRENT" != "$ROOT/work/releases/db821be" ]]; then
    print '端口属于其他程序或版本，未停止。请先核对。'
    exit 1
  fi
  kill -TERM "$PID"
  for i in {1..50}; do
    if ! kill -0 "$PID" 2>/dev/null; then break; fi
    sleep 0.1
  done
  if kill -0 "$PID" 2>/dev/null; then print '原服务尚未退出，停止重启。'; exit 1; fi
fi
exec "${0:A:h}/启动本地预览.command" "$@"
