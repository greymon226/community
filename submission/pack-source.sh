#!/usr/bin/env bash
# ============================================================
# Community Platform - 源码 ZIP 打包脚本（Linux / macOS / WSL）
# 用法：在项目根目录执行
#   bash submission/pack-source.sh
# 产出：./submission/community-source.zip
# ============================================================

set -euo pipefail

# 切到项目根目录
cd "$(dirname "$0")/.."
ROOT_DIR="$(pwd)"
OUT_ZIP="${ROOT_DIR}/submission/community-source.zip"
STAGING="$(mktemp -d -t community-pack-XXXXXX)"

echo "[pack] root: $ROOT_DIR"
echo "[pack] staging: $STAGING"

# 排除清单
EXCLUDE_PATTERNS=(
  '*/node_modules/*'
  '*/.git/*'
  '*/uploads/*'
  '*/dist/*'
  '*/build/*'
  '*/.vscode/*'
  '*/backups/*'
  '*/.idea/*'
  '*/submission/*'
  '*.log'
  '*.tmp'
  '*.env'
  '*.env.prod'
  '*.env.local'
  '~\$*'
)

# 用 rsync 拷到 staging（带排除）
RSYNC_ARGS=(-a)
for p in "${EXCLUDE_PATTERNS[@]}"; do
  RSYNC_ARGS+=(--exclude "$p")
done

if command -v rsync >/dev/null 2>&1; then
  rsync "${RSYNC_ARGS[@]}" "$ROOT_DIR/" "$STAGING/"
else
  echo "[pack] rsync 未安装，使用 cp + 手动清理 fallback"
  cp -a "$ROOT_DIR/." "$STAGING/"
  for p in node_modules .git uploads dist build .vscode backups .idea submission; do
    find "$STAGING" -type d -name "$p" -prune -exec rm -rf {} + 2>/dev/null || true
  done
  find "$STAGING" -type f \( -name '.env' -o -name '.env.prod' -o -name '.env.local' -o -name '*.log' -o -name '*.tmp' \) -delete 2>/dev/null || true
fi

# 但保留 .env.example
if [[ -f "$ROOT_DIR/backend/.env.example" ]]; then
  cp "$ROOT_DIR/backend/.env.example" "$STAGING/backend/.env.example" 2>/dev/null || true
fi
if [[ -f "$ROOT_DIR/deploy/.env.prod.example" ]]; then
  mkdir -p "$STAGING/deploy"
  cp "$ROOT_DIR/deploy/.env.prod.example" "$STAGING/deploy/.env.prod.example" 2>/dev/null || true
fi

# 验证关键资产
MUST_EXIST=(
  '.kiro/specs/tech-community-platform/requirements.md'
  '.kiro/specs/tech-community-platform/design.md'
  '.kiro/specs/tech-community-platform/tasks.md'
  'backend/src/app.js'
  'backend/tests/property'
  'frontend/src/main.jsx'
  'docker-compose.yml'
  'docker-compose.prod.yml'
  'deploy/deploy.sh'
  'README.md'
)

for p in "${MUST_EXIST[@]}"; do
  if [[ ! -e "$STAGING/$p" ]]; then
    echo "[pack][WARN] missing key asset: $p"
  fi
done

# 打 ZIP
rm -f "$OUT_ZIP"
mkdir -p "$(dirname "$OUT_ZIP")"

if command -v zip >/dev/null 2>&1; then
  (cd "$STAGING" && zip -qr "$OUT_ZIP" .)
else
  echo "[pack] zip 未安装，请先 apt/brew install zip"
  exit 1
fi

# 清理
rm -rf "$STAGING"

# 体积摘要
SIZE_MB=$(du -m "$OUT_ZIP" | cut -f1)
echo "[pack] done!"
echo "       output: $OUT_ZIP"
echo "       size  : ${SIZE_MB} MB"
