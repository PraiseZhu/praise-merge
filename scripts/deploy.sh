#!/usr/bin/env bash
# 把本仓代码拷到 Mini 的运行目录。默认只演练（列出会改什么），加 --apply 才真的拷。
# 永远不碰运行目录里的真实配置、状态和停止开关：config/app.json、config/policy.json、state/、DISABLED。
# 用法：scripts/deploy.sh [--target <dir>] [--apply]   默认 target：~/praise-merge-runtime
set -euo pipefail

src="$(cd "$(dirname "$0")/.." && pwd)"
target="${HOME}/praise-merge-runtime"
apply=0
while [ $# -gt 0 ]; do
  case "$1" in
    --target) target="$2"; shift 2 ;;
    --apply) apply=1; shift ;;
    *) echo "deploy: 未知参数 $1" >&2; exit 2 ;;
  esac
done

case "$target" in
  "$HOME/AI-Agent"|"$HOME/AI-Agent/"*) echo "deploy: 运行目录不能放在同步目录 ~/AI-Agent 下：$target" >&2; exit 2 ;;
esac

excludes=(--exclude .git --exclude node_modules --exclude /config/app.json --exclude /config/policy.json --exclude /state/ --exclude /DISABLED --exclude /VERSION)

if [ "$apply" -ne 1 ]; then
  echo "演练：以下是 --apply 会做的改动（目标 ${target}）"
  if [ -d "$target" ]; then
    rsync -a --delete --dry-run --itemize-changes "${excludes[@]}" "$src/" "$target/"
  else
    echo "  新建 $target 并拷入 $(git -C "$src" ls-files | wc -l | tr -d ' ') 个受版本管理的文件"
  fi
  exit 0
fi

mkdir -p "$target"
rsync -a --delete "${excludes[@]}" "$src/" "$target/"
git -C "$src" rev-parse HEAD > "$target/VERSION" 2>/dev/null || echo unknown > "$target/VERSION"
echo "已部署到 ${target}（$(cat "$target/VERSION")）"
