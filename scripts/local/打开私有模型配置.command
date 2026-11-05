#!/bin/zsh
set -eu
ROOT=${0:A:h}
while [[ ! -f "$ROOT/package.json" || ! -e "$ROOT/.git" ]]; do
  if [[ "$ROOT" == / ]]; then print '找不到项目目录。'; exit 1; fi
  ROOT=${ROOT:h}
done
if [[ ! -f "$ROOT/.env.local" ]]; then print '此工作区没有私有配置。'; exit 1; fi
if [[ "${1:-}" == --check ]]; then
  print '已定位私有配置；没有打开或显示文件内容。'
  exit 0
fi
/usr/bin/open -e "$ROOT/.env.local"
