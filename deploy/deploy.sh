#!/usr/bin/env bash
# ============================================================
# Community Platform - 一键部署脚本
# 用法（在项目根目录执行）:
#   bash deploy/deploy.sh           # 交互式：首次部署 / 更新 / 查看 / 备份 / 卸载
#   bash deploy/deploy.sh up        # 启动并构建
#   bash deploy/deploy.sh update    # 拉取最新代码并重建
#   bash deploy/deploy.sh logs      # 查看日志
#   bash deploy/deploy.sh seed      # 灌入种子数据（仅首次需要）
#   bash deploy/deploy.sh backup    # 备份 MySQL + uploads
#   bash deploy/deploy.sh down      # 停止并保留数据
#   bash deploy/deploy.sh nuke      # 停止并删除所有数据卷（不可逆）
# ============================================================

set -euo pipefail

# 切到项目根目录（脚本所在目录的上一层）
cd "$(dirname "$0")/.."

ROOT_DIR="$(pwd)"
ENV_FILE="${ROOT_DIR}/.env.prod"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.prod.yml"
BACKUP_DIR="${ROOT_DIR}/backups"

C_RESET='\033[0m'; C_RED='\033[31m'; C_GREEN='\033[32m'
C_YELLOW='\033[33m'; C_BLUE='\033[34m'; C_BOLD='\033[1m'

log()    { printf "${C_BLUE}[deploy]${C_RESET} %s\n" "$*"; }
ok()     { printf "${C_GREEN}[ ok ]${C_RESET} %s\n" "$*"; }
warn()   { printf "${C_YELLOW}[warn]${C_RESET} %s\n" "$*"; }
err()    { printf "${C_RED}[err ]${C_RESET} %s\n" "$*" >&2; }
section(){ printf "\n${C_BOLD}== %s ==${C_RESET}\n" "$*"; }

require_root_or_sudo() {
  if [[ $EUID -ne 0 ]] && ! command -v sudo >/dev/null 2>&1; then
    err "需要 root 权限或安装 sudo"
    exit 1
  fi
}

run_priv() {
  if [[ $EUID -eq 0 ]]; then "$@"; else sudo "$@"; fi
}

detect_compose() {
  if docker compose version >/dev/null 2>&1; then
    DC="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    DC="docker-compose"
  else
    DC=""
  fi
}

install_docker_if_missing() {
  if command -v docker >/dev/null 2>&1; then
    ok "docker 已安装：$(docker --version)"
  else
    log "未检测到 docker，开始安装..."
    require_root_or_sudo
    if [[ -f /etc/os-release ]]; then
      . /etc/os-release
      case "$ID" in
        ubuntu|debian)
          run_priv apt-get update -y
          run_priv apt-get install -y ca-certificates curl gnupg lsb-release
          run_priv install -m 0755 -d /etc/apt/keyrings
          curl -fsSL "https://download.docker.com/linux/${ID}/gpg" \
            | run_priv gpg --dearmor -o /etc/apt/keyrings/docker.gpg
          echo \
            "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${ID} \
            $(lsb_release -cs) stable" \
            | run_priv tee /etc/apt/sources.list.d/docker.list >/dev/null
          run_priv apt-get update -y
          run_priv apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
          ;;
        centos|rhel|rocky|almalinux)
          run_priv yum install -y yum-utils
          run_priv yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
          run_priv yum install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
          ;;
        *)
          err "不支持的发行版 $ID，请手工安装 docker。参考 https://docs.docker.com/engine/install/"
          exit 1
          ;;
      esac
      run_priv systemctl enable --now docker
    else
      err "无法识别系统，请手工安装 docker"
      exit 1
    fi
    ok "docker 安装完成"
  fi

  detect_compose
  if [[ -z "$DC" ]]; then
    err "未检测到 docker compose；请安装 docker-compose-plugin 或 docker-compose"
    exit 1
  fi
  ok "compose 命令: $DC"
}

random_secret() {
  # 32 字节十六进制
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-64
  fi
}

random_password() {
  # 24 字符 base64（去掉特殊字符）
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 18 | tr -d '/+=' | cut -c1-24
  else
    head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-24
  fi
}

ensure_env_file() {
  if [[ -f "$ENV_FILE" ]]; then
    ok ".env.prod 已存在，沿用现有配置"
    return
  fi

  section "首次部署：生成 .env.prod"

  read -r -p "请输入对外访问域名或 IP（如 community.example.com，留空填 $(hostname -I 2>/dev/null | awk '{print $1}')）: " DOMAIN
  if [[ -z "$DOMAIN" ]]; then
    DOMAIN="$(hostname -I 2>/dev/null | awk '{print $1}')"
    [[ -z "$DOMAIN" ]] && DOMAIN="localhost"
  fi

  read -r -p "对外 HTTP 端口 [默认 80]: " HTTP_PORT
  HTTP_PORT="${HTTP_PORT:-80}"

  read -r -p "DeepSeek API Key（留空则 AI 功能进入本地兜底，AI 解读/问答会不可用）: " AI_KEY

  read -r -p "管理员账号工号 [默认 admin]: " ADMIN_NO
  ADMIN_NO="${ADMIN_NO:-admin}"

  MYSQL_ROOT_PWD="$(random_password)"
  DB_PWD="$(random_password)"
  REDIS_PWD="$(random_password)"
  JWT="$(random_secret)"

  cat > "$ENV_FILE" <<EOF
# 由 deploy.sh 生成于 $(date -Iseconds)
HTTP_PORT=${HTTP_PORT}
PUBLIC_DOMAIN=${DOMAIN}
PUBLIC_BASE_URL=http://${DOMAIN}
MCP_API_KEY=

MYSQL_ROOT_PASSWORD=${MYSQL_ROOT_PWD}
DB_NAME=community
DB_USER=community
DB_PASS=${DB_PWD}

REDIS_PASSWORD=${REDIS_PWD}

JWT_SECRET=${JWT}

MAX_UPLOAD_MB=10
SENSITIVE_WORDS=

AI_PROVIDER=$([[ -n "$AI_KEY" ]] && echo "deepseek" || echo "local")
AI_API_KEY=${AI_KEY}
AI_BASE_URL=https://api.deepseek.com
AI_MODEL=deepseek-chat
AI_TIMEOUT_MS=15000

CAS_SERVER_URL=
CAS_SERVICE_URL=http://${DOMAIN}/login/cas-callback
CAS_ATTR_EMP_NO=empNo,employeeNumber,uid,user
CAS_ATTR_NAME=name,displayName,cn
CAS_ATTR_EMAIL=email,mail
CAS_ATTR_DEPARTMENT=department,departmentName,dept
CAS_ATTR_AVATAR=avatar,picture

# 部署时记录的初始管理员工号
SEED_ADMIN_EMPNO=${ADMIN_NO}
EOF

  chmod 600 "$ENV_FILE"
  ok "已生成 $ENV_FILE（权限 600）"
  warn "其中包含数据库与 JWT 密钥，请妥善保管，不要提交到 git"
}

compose() {
  $DC --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

pull_latest_code() {
  if [[ ! -d .git ]]; then
    warn "当前目录不是 git 仓库，跳过 git pull"
    return 0
  fi

  local mode="${DEPLOY_GIT_PULL_MODE:-auto}"
  case "$mode" in
    ff-only)
      git pull --ff-only
      ;;
    rebase)
      git pull --rebase --autostash
      ;;
    merge)
      GIT_MERGE_AUTOEDIT=no git pull
      ;;
    auto)
      if git pull --ff-only; then
        return 0
      fi
      warn "fast-forward 拉取失败，尝试按本机 git pull 配置继续拉取"
      GIT_MERGE_AUTOEDIT=no git pull
      ;;
    *)
      err "未知 DEPLOY_GIT_PULL_MODE: $mode，可选 auto|ff-only|rebase|merge"
      return 1
      ;;
  esac
}

cmd_up() {
  ensure_env_file
  section "构建并启动服务"
  compose pull || true
  compose build
  compose up -d
  ok "服务已启动"
  cmd_status
  show_access_info
}

cmd_update() {
  ensure_env_file
  section "拉取最新代码"
  pull_latest_code || { err "git pull 失败，已停止部署，避免使用旧代码继续构建"; exit 1; }
  compose build --pull
  compose up -d
  ok "更新完成"
  cmd_status
}

cmd_status() {
  section "容器状态"
  compose ps
  section "健康检查"
  if curl -fsS "http://127.0.0.1:$(grep ^HTTP_PORT "$ENV_FILE" | cut -d= -f2)/healthz" >/dev/null 2>&1; then
    ok "前端 nginx /healthz 正常"
  else
    warn "前端 nginx /healthz 暂不可达（容器可能还在启动）"
  fi
  if compose exec -T backend curl -fsS http://127.0.0.1:4000/health >/dev/null 2>&1; then
    ok "后端 /health 正常"
  else
    warn "后端 /health 暂不可达"
  fi
}

cmd_logs() {
  ensure_env_file
  compose logs -f --tail=200
}

cmd_seed() {
  ensure_env_file
  section "灌入种子数据"
  warn "仅在首次部署执行；重复执行会跳过已存在的用户与分类"
  compose exec backend node seed.js
  ok "种子数据完成"
  log "默认账号："
  log "  admin / admin123    （管理员）"
  log "  mod001 / mod123     （版主）"
  log "  user001 / user123   （普通用户）"
  warn "登录后请立即在 后台-用户管理 里修改默认密码"
}

cmd_backup() {
  ensure_env_file
  mkdir -p "$BACKUP_DIR"
  ts="$(date +%Y%m%d-%H%M%S)"
  section "备份 MySQL"
  ROOT_PWD="$(grep ^MYSQL_ROOT_PASSWORD "$ENV_FILE" | cut -d= -f2)"
  DB_NAME="$(grep ^DB_NAME "$ENV_FILE" | cut -d= -f2)"
  compose exec -T mysql sh -c "exec mysqldump -uroot -p'${ROOT_PWD}' --single-transaction --quick --routines --triggers ${DB_NAME}" \
    | gzip > "${BACKUP_DIR}/db-${ts}.sql.gz"
  ok "数据库已备份到 ${BACKUP_DIR}/db-${ts}.sql.gz"

  section "备份 uploads"
  docker run --rm \
    -v community_uploads-data:/data:ro \
    -v "${BACKUP_DIR}:/backup" \
    alpine sh -c "tar czf /backup/uploads-${ts}.tar.gz -C /data ." \
    || warn "若上面失败，可能是卷名不同，请运行: docker volume ls 查看"
  ok "上传文件已备份到 ${BACKUP_DIR}/uploads-${ts}.tar.gz"

  log "建议把 ${BACKUP_DIR} 同步到对象存储（OSS/COS/S3）"
}

cmd_down() {
  ensure_env_file
  warn "停止所有容器（数据卷保留）"
  compose down
  ok "已停止"
}

cmd_nuke() {
  ensure_env_file
  warn "本操作会删除所有容器和数据卷（数据库、Redis 持久化、上传文件全部丢失）"
  read -r -p "确认请输入 yes： " ans
  [[ "$ans" == "yes" ]] || { log "已取消"; exit 0; }
  compose down -v
  ok "已清理"
}

show_access_info() {
  local port domain port_suffix
  port="$(grep ^HTTP_PORT "$ENV_FILE" | cut -d= -f2)"
  domain="$(grep ^PUBLIC_DOMAIN "$ENV_FILE" | cut -d= -f2)"
  if [[ "$port" == "80" ]]; then
    port_suffix=""
  else
    port_suffix=":${port}"
  fi
  section "访问入口"
  log "  Web 站点：http://${domain}${port_suffix}/"
  log "  MCP API ：http://${domain}${port_suffix}/mcp           (POST JSON-RPC)"
  log "  MCP 工具：http://${domain}${port_suffix}/mcp/tools     (GET 调试用)"
  log "  管理后台：登录后访问 / 中的管理入口"
  warn "首次部署请运行：bash deploy/deploy.sh seed"
  warn "建议接入 HTTPS：用 Nginx 在主机层做反代（见 deploy/README.md）"
}

interactive_menu() {
  section "Community Platform 部署助手"
  cat <<EOF
请选择操作：
  1) 首次部署（自动生成配置 -> 构建 -> 启动 -> 灌入种子）
  2) 更新部署（git pull + 重建）
  3) 查看状态 / 健康检查
  4) 查看日志
  5) 灌入种子数据
  6) 备份数据库与上传目录
  7) 停止服务（保留数据）
  8) 卸载并清理所有数据（危险）
  q) 退出
EOF
  read -r -p "输入序号 [1]: " choice
  choice="${choice:-1}"
  case "$choice" in
    1) cmd_up; cmd_seed ;;
    2) cmd_update ;;
    3) cmd_status ;;
    4) cmd_logs ;;
    5) cmd_seed ;;
    6) cmd_backup ;;
    7) cmd_down ;;
    8) cmd_nuke ;;
    q|Q) exit 0 ;;
    *) err "无效选项"; exit 1 ;;
  esac
}

main() {
  install_docker_if_missing

  case "${1:-menu}" in
    up)        cmd_up ;;
    update)    cmd_update ;;
    status|ps) cmd_status ;;
    logs)      cmd_logs ;;
    seed)      cmd_seed ;;
    backup)    cmd_backup ;;
    down)      cmd_down ;;
    nuke)      cmd_nuke ;;
    menu|"")   interactive_menu ;;
    *)
      err "未知命令: $1"
      echo "用法: bash deploy/deploy.sh [up|update|status|logs|seed|backup|down|nuke]"
      exit 1
      ;;
  esac
}

main "$@"
