#!/usr/bin/env bash
# ============================================================
# Community Platform - 一键部署脚本
# 用法（在项目根目录执行）:
#   bash deploy/deploy.sh           # 交互式：首次部署 / 更新 / 查看 / 备份 / 卸载
#   bash deploy/deploy.sh up        # 启动并构建
#   bash deploy/deploy.sh update    # 拉取最新代码并重建
#   bash deploy/deploy.sh logs      # 查看日志
#   bash deploy/deploy.sh doctor    # 部署自检
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
CASDOOR_RUNTIME_DIR="${ROOT_DIR}/deploy/runtime/casdoor"
DOCKER_SUDO=()

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

configure_docker_access() {
  DOCKER_SUDO=()
  if docker info >/dev/null 2>&1; then
    return
  fi
  if [[ $EUID -ne 0 ]] && command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    DOCKER_SUDO=(sudo)
    warn "当前用户无法直连 Docker daemon，后续 Docker 命令将自动使用 sudo；git pull 仍使用当前用户"
    return
  fi
  err "无法连接 Docker daemon。请将当前用户加入 docker 组，或确认 sudo docker 可用。"
  err "建议执行: sudo usermod -aG docker $USER && newgrp docker"
  exit 1
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

  configure_docker_access

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
TRUST_PROXY=1
MCP_API_KEY=

MYSQL_ROOT_PASSWORD=${MYSQL_ROOT_PWD}
DB_NAME=community
DB_USER=community
DB_PASS=${DB_PWD}
DB_SYNC_ALTER=

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

ENABLE_CASDOOR=1
CASDOOR_HTTP_PORT=8000
CASDOOR_PUBLIC_BASE_URL=http://${DOMAIN}:8000
CASDOOR_DB_ROOT_PASSWORD=$(random_password)
CASDOOR_DB_PASSWORD=$(random_password)
CASDOOR_ORGANIZATION=built-in
CASDOOR_APPLICATION=community
CASDOOR_CLIENT_SECRET=$(random_secret)

GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_CALLBACK_URL=http://${DOMAIN}/login/github-callback

# 部署时记录的初始管理员工号
SEED_ADMIN_EMPNO=${ADMIN_NO}
EOF

  chmod 600 "$ENV_FILE"
  ensure_casdoor_runtime
  ok "已生成 $ENV_FILE（权限 600）"
  warn "其中包含数据库与 JWT 密钥，请妥善保管，不要提交到 git"
}

compose() {
  "${DOCKER_SUDO[@]}" $DC --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

docker_cmd() {
  "${DOCKER_SUDO[@]}" docker "$@"
}

env_value() {
  local key="$1"
  if [[ ! -f "$ENV_FILE" ]]; then
    return 1
  fi
  grep -E "^${key}=" "$ENV_FILE" | tail -n1 | cut -d= -f2-
}

set_env_value() {
  local key="$1"
  local value="$2"
  local tmp="${ENV_FILE}.tmp"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k {$0=k "=" v} {print}' "$ENV_FILE" > "$tmp"
    mv "$tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

ensure_env_value() {
  local key="$1"
  local value="$2"
  local current
  current="$(env_value "$key" || true)"
  if [[ -z "$current" ]]; then
    set_env_value "$key" "$value"
  fi
}

ensure_casdoor_runtime() {
  [[ -f "$ENV_FILE" ]] || return 0

  local domain casdoor_port casdoor_public casdoor_org casdoor_app casdoor_db_pwd
  domain="$(env_value PUBLIC_DOMAIN || true)"
  [[ -z "$domain" ]] && domain="localhost"

  ensure_env_value ENABLE_CASDOOR "1"
  if [[ "$(env_value ENABLE_CASDOOR || true)" == "0" ]]; then
    return 0
  fi
  ensure_env_value CASDOOR_HTTP_PORT "8000"
  ensure_env_value CASDOOR_DB_ROOT_PASSWORD "$(random_password)"
  ensure_env_value CASDOOR_DB_PASSWORD "$(random_password)"
  ensure_env_value CASDOOR_ORGANIZATION "built-in"
  ensure_env_value CASDOOR_APPLICATION "community"

  casdoor_port="$(env_value CASDOOR_HTTP_PORT || true)"
  casdoor_public="$(env_value CASDOOR_PUBLIC_BASE_URL || true)"
  if [[ -z "$casdoor_public" ]]; then
    casdoor_public="http://${domain}:${casdoor_port}"
    set_env_value CASDOOR_PUBLIC_BASE_URL "$casdoor_public"
  fi

  casdoor_org="$(env_value CASDOOR_ORGANIZATION || true)"
  casdoor_app="$(env_value CASDOOR_APPLICATION || true)"
  ensure_env_value CAS_SERVER_URL "${casdoor_public}/cas/${casdoor_org}/${casdoor_app}"
  ensure_env_value CAS_SERVICE_URL "http://${domain}/login/cas-callback"
  ensure_env_value CAS_ATTR_EMP_NO "name,user,id"
  ensure_env_value CAS_ATTR_NAME "displayName,name,user"
  ensure_env_value CAS_ATTR_EMAIL "email,mail"
  ensure_env_value CAS_ATTR_AVATAR "avatar"

  casdoor_db_pwd="$(env_value CASDOOR_DB_PASSWORD || true)"
  mkdir -p "${CASDOOR_RUNTIME_DIR}/conf"
  cat > "${CASDOOR_RUNTIME_DIR}/conf/app.conf" <<EOF
appname = casdoor
httpport = 8000
runmode = prod
copyrequestbody = true

driverName = mysql
dataSourceName = casdoor:${casdoor_db_pwd}@tcp(casdoor-mysql:3306)/
dbName = casdoor
tableNamePrefix =
showSql = false

redisEndpoint =
defaultStorageProvider =
isCloudIntranet = false
authState = "casdoor"

origin = "${casdoor_public}"
originFrontend = "${casdoor_public}"

logPostOnly = true
isUsernameLowered = false
staticBaseUrl = "https://cdn.casbin.org"
isDemoMode = false
showGithubCorner = false
defaultLanguage = "zh"
initDataNewOnly = false
initDataFile = "./init_data.json"
EOF
  chmod 600 "${CASDOOR_RUNTIME_DIR}/conf/app.conf"
}

configure_casdoor_application() {
  local enabled root_pwd org app client_id client_secret callback homepage
  enabled="$(env_value ENABLE_CASDOOR || true)"
  [[ "$enabled" == "0" ]] && return 0

  root_pwd="$(env_value CASDOOR_DB_ROOT_PASSWORD || true)"
  org="$(env_value CASDOOR_ORGANIZATION || true)"
  app="$(env_value CASDOOR_APPLICATION || true)"
  client_id="${app}-client"
  client_secret="$(env_value CASDOOR_CLIENT_SECRET || true)"
  if [[ -z "$client_secret" ]]; then
    client_secret="$(random_secret)"
    set_env_value CASDOOR_CLIENT_SECRET "$client_secret"
  fi
  callback="$(env_value CAS_SERVICE_URL || true)"
  homepage="$(env_value PUBLIC_BASE_URL || true)"

  section "初始化 Casdoor 应用"
  for _ in $(seq 1 30); do
    if compose exec -T casdoor-mysql mysql -uroot -p"${root_pwd}" casdoor -Nse "SELECT COUNT(*) FROM application WHERE name='app-built-in';" 2>/dev/null | grep -q '^1$'; then
      break
    fi
    sleep 2
  done

  if ! compose exec -T casdoor-mysql mysql -uroot -p"${root_pwd}" casdoor -Nse "SELECT COUNT(*) FROM application WHERE name='app-built-in';" 2>/dev/null | grep -q '^1$'; then
    err "Casdoor 初始数据未就绪：未找到 app-built-in。请查看 casdoor 日志，或重建 casdoor-mysql-data 卷后重试。"
    compose logs --tail=120 casdoor || true
    return 1
  fi

  compose exec -T casdoor-mysql mysql -uroot -p"${root_pwd}" casdoor <<SQL
SET @app = '${app}';
SET @org = '${org}';
SET @display = 'Community';
SET @homepage = '${homepage}';
SET @callback = '${callback}';
SET @client_id = '${client_id}';
SET @client_secret = '${client_secret}';
SET SESSION group_concat_max_len = 1000000;
DELETE FROM application WHERE name = @app;
SELECT GROUP_CONCAT(CONCAT('\`', COLUMN_NAME, '\`') ORDER BY ORDINAL_POSITION)
  INTO @cols
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'application';
SELECT GROUP_CONCAT(
  CASE COLUMN_NAME
    WHEN 'name' THEN QUOTE(@app)
    WHEN 'created_time' THEN "DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%sZ')"
    WHEN 'display_name' THEN QUOTE(@display)
    WHEN 'homepage_url' THEN QUOTE(@homepage)
    WHEN 'description' THEN "'Community CAS application'"
    WHEN 'organization' THEN QUOTE(@org)
    WHEN 'client_id' THEN QUOTE(@client_id)
    WHEN 'client_secret' THEN QUOTE(@client_secret)
    WHEN 'redirect_uris' THEN QUOTE(CONCAT('["', @callback, '"]'))
    WHEN 'signin_url' THEN "''"
    WHEN 'signup_url' THEN "''"
    WHEN 'forget_url' THEN "''"
    WHEN 'affiliation_url' THEN "''"
    WHEN 'forced_redirect_origin' THEN "''"
    WHEN 'domain' THEN "''"
    WHEN 'other_domains' THEN "'[]'"
    WHEN 'is_shared' THEN "0"
    WHEN 'enable_password' THEN "1"
    WHEN 'disable_signin' THEN "0"
    ELSE CONCAT('\`', COLUMN_NAME, '\`')
  END
  ORDER BY ORDINAL_POSITION)
  INTO @vals
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'application';
SET @sql = CONCAT('INSERT INTO application (', @cols, ') SELECT ', @vals, ' FROM application WHERE name = ''app-built-in'' LIMIT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
SQL
  ok "Casdoor 应用已配置：${org}/${app}"
}

run_git_pull() {
  local output
  set +e
  output="$("$@" 2>&1)"
  local status=$?
  set -e

  if [[ -n "$output" ]]; then
    printf '%s\n' "$output"
  fi

  if [[ $status -ne 0 && "$output" == *"Permission denied (publickey)"* ]]; then
    err "GitHub SSH 鉴权失败：当前服务器用户没有 git@github.com 的 publickey 权限"
    err "请配置该用户的 SSH deploy key，或将 git remote 改为 HTTPS 后再执行 update"
    return 128
  fi

  return "$status"
}

pull_latest_code() {
  if [[ ! -d .git ]]; then
    warn "当前目录不是 git 仓库，跳过 git pull"
    return 0
  fi

  local mode="${DEPLOY_GIT_PULL_MODE:-auto}"
  case "$mode" in
    ff-only)
      run_git_pull git pull --ff-only
      ;;
    rebase)
      run_git_pull git pull --rebase --autostash
      ;;
    merge)
      GIT_MERGE_AUTOEDIT=no run_git_pull git pull
      ;;
    auto)
      set +e
      run_git_pull git pull --ff-only
      local pull_status=$?
      set -e
      if [[ $pull_status -eq 0 ]]; then
        return 0
      fi
      if [[ $pull_status -eq 128 ]]; then
        return 1
      fi
      warn "fast-forward 拉取失败，尝试按本机 git pull 配置继续拉取"
      GIT_MERGE_AUTOEDIT=no run_git_pull git pull
      ;;
    *)
      err "未知 DEPLOY_GIT_PULL_MODE: $mode，可选 auto|ff-only|rebase|merge"
      return 1
      ;;
  esac
}

cmd_up() {
  ensure_env_file
  ensure_casdoor_runtime
  section "构建并启动服务"
  compose pull || true
  compose build
  compose up -d
  configure_casdoor_application
  ok "服务已启动"
  cmd_status
  show_access_info
}

cmd_update() {
  ensure_env_file
  ensure_casdoor_runtime
  section "拉取最新代码"
  pull_latest_code || { err "git pull 失败，已停止部署，避免使用旧代码继续构建"; exit 1; }
  compose build --pull
  compose up -d
  configure_casdoor_application
  ok "更新完成"
  cmd_status
}

cmd_status() {
  ensure_casdoor_runtime
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
  if compose exec -T casdoor wget -qO- http://127.0.0.1:8000 >/dev/null 2>&1; then
    ok "Casdoor 正常"
  else
    warn "Casdoor 暂不可达"
  fi
}

doctor_check() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    ok "$label"
    return 0
  fi
  warn "$label"
  return 1
}

cmd_doctor() {
  local problems=0

  section "部署自检"
  log "项目目录：$ROOT_DIR"
  log "当前用户：$(id -un)"

  section "Git"
  if [[ -d .git ]]; then
    ok "当前目录是 git 仓库"
    log "当前分支：$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '-')"
    log "当前提交：$(git rev-parse --short HEAD 2>/dev/null || echo '-')"
    git remote -v || true
    if git ls-remote --exit-code origin HEAD >/dev/null 2>&1; then
      ok "origin 可访问"
    else
      err "origin 不可访问；若使用 git@github.com，请确认当前用户 SSH key / deploy key 可用"
      problems=$((problems + 1))
    fi
  else
    warn "当前目录不是 git 仓库，update 会跳过 git pull"
  fi

  section "Docker"
  if docker info >/dev/null 2>&1; then
    ok "当前用户可直连 Docker daemon"
  elif [[ ${#DOCKER_SUDO[@]} -gt 0 ]]; then
    ok "当前用户需通过 sudo 访问 Docker daemon，脚本已启用 sudo docker"
  else
    err "当前用户无法访问 Docker daemon"
    problems=$((problems + 1))
  fi
  if compose config >/dev/null 2>&1; then
    ok "docker compose 配置可解析"
  else
    err "docker compose 配置解析失败"
    problems=$((problems + 1))
  fi

  section ".env.prod"
  if [[ -f "$ENV_FILE" ]]; then
    ok ".env.prod 存在"
    local mode
    mode="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE" 2>/dev/null || echo '-')"
    log ".env.prod 权限：$mode"
  else
    err ".env.prod 不存在，请先执行首次部署"
    problems=$((problems + 1))
  fi

  local http_port public_domain public_base trust_proxy mcp_key ai_provider ai_key cas_server cas_service
  http_port="$(env_value HTTP_PORT || true)"
  public_domain="$(env_value PUBLIC_DOMAIN || true)"
  public_base="$(env_value PUBLIC_BASE_URL || true)"
  trust_proxy="$(env_value TRUST_PROXY || true)"
  mcp_key="$(env_value MCP_API_KEY || true)"
  ai_provider="$(env_value AI_PROVIDER || true)"
  ai_key="$(env_value AI_API_KEY || true)"
  cas_server="$(env_value CAS_SERVER_URL || true)"
  cas_service="$(env_value CAS_SERVICE_URL || true)"

  [[ -n "$http_port" ]] && ok "HTTP_PORT=$http_port" || { err "缺少 HTTP_PORT"; problems=$((problems + 1)); }
  [[ -n "$public_domain" ]] && ok "PUBLIC_DOMAIN=$public_domain" || warn "缺少 PUBLIC_DOMAIN"
  [[ -n "$public_base" ]] && ok "PUBLIC_BASE_URL=$public_base" || warn "缺少 PUBLIC_BASE_URL，MCP 返回链接可能不正确"

  if [[ -z "$trust_proxy" ]]; then
    warn "未显式配置 TRUST_PROXY，backend 将默认按 1 层代理处理"
  elif [[ "$trust_proxy" =~ ^[0-9]+$ ]]; then
    ok "TRUST_PROXY=$trust_proxy"
  else
    warn "TRUST_PROXY=$trust_proxy（非数字模式，仅在你明确知道 Express trust proxy 语义时使用）"
  fi

  if [[ "$http_port" == "80" && "${trust_proxy:-1}" != "1" ]]; then
    warn "HTTP_PORT=80 通常表示 Docker 直接对外，建议 TRUST_PROXY=1"
  fi
  if [[ -n "$http_port" && "$http_port" != "80" && "${trust_proxy:-1}" == "1" ]]; then
    warn "HTTP_PORT=$http_port 且 TRUST_PROXY=1；如果前面还有宿主机 Nginx/HTTPS，建议 TRUST_PROXY=2"
  fi

  if [[ "$ai_provider" == "deepseek" || "$ai_provider" == "openai" ]]; then
    [[ -n "$ai_key" ]] && ok "AI_PROVIDER=$ai_provider 且 AI_API_KEY 已配置" || { err "AI_PROVIDER=$ai_provider 但 AI_API_KEY 为空"; problems=$((problems + 1)); }
  else
    warn "AI_PROVIDER=${ai_provider:-local}，真实 AI 能力会使用本地兜底或不可用"
  fi

  if [[ -n "$cas_server" ]]; then
    [[ -n "$cas_service" ]] && ok "CAS 已配置：$cas_server" || { err "CAS_SERVER_URL 已配置但 CAS_SERVICE_URL 为空"; problems=$((problems + 1)); }
  else
    warn "CAS_SERVER_URL 为空，当前为 Mock 登录模式"
  fi

  local casdoor_enabled casdoor_url
  casdoor_enabled="$(env_value ENABLE_CASDOOR || true)"
  casdoor_url="$(env_value CASDOOR_PUBLIC_BASE_URL || true)"
  if [[ "$casdoor_enabled" == "0" ]]; then
    warn "内置 Casdoor 已关闭"
  elif [[ -n "$casdoor_url" ]]; then
    ok "内置 Casdoor：$casdoor_url"
  else
    warn "CASDOOR_PUBLIC_BASE_URL 为空"
  fi

  if [[ -n "$mcp_key" ]]; then
    ok "MCP_API_KEY 已配置"
  else
    warn "MCP_API_KEY 为空，公网 /mcp 端点处于公开演示模式"
  fi

  section "运行状态"
  compose ps || { err "无法获取容器状态"; problems=$((problems + 1)); }
  if [[ -n "$http_port" ]]; then
    doctor_check "frontend /healthz 可访问" curl -fsS "http://127.0.0.1:${http_port}/healthz" || problems=$((problems + 1))
    doctor_check "MCP tools 可访问" curl -fsS "http://127.0.0.1:${http_port}/mcp/tools" || warn "若配置了 MCP_API_KEY，未带鉴权时此项失败是预期行为"
  fi
  doctor_check "backend /health 可访问" compose exec -T backend curl -fsS http://127.0.0.1:4000/health || problems=$((problems + 1))

  section "结论"
  if [[ $problems -eq 0 ]]; then
    ok "自检完成，未发现阻塞项"
  else
    err "自检完成，发现 ${problems} 个阻塞项，请按上方提示处理"
    return 1
  fi
}

cmd_logs() {
  ensure_env_file
  ensure_casdoor_runtime
  compose logs -f --tail=200
}

cmd_seed() {
  ensure_env_file
  ensure_casdoor_runtime
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
  ensure_casdoor_runtime
  mkdir -p "$BACKUP_DIR"
  ts="$(date +%Y%m%d-%H%M%S)"
  section "备份 MySQL"
  ROOT_PWD="$(grep ^MYSQL_ROOT_PASSWORD "$ENV_FILE" | cut -d= -f2)"
  DB_NAME="$(grep ^DB_NAME "$ENV_FILE" | cut -d= -f2)"
  compose exec -T mysql sh -c "exec mysqldump -uroot -p'${ROOT_PWD}' --single-transaction --quick --routines --triggers ${DB_NAME}" \
    | gzip > "${BACKUP_DIR}/db-${ts}.sql.gz"
  ok "数据库已备份到 ${BACKUP_DIR}/db-${ts}.sql.gz"

  section "备份 Casdoor MySQL"
  CASDOOR_ROOT_PWD="$(env_value CASDOOR_DB_ROOT_PASSWORD || true)"
  compose exec -T casdoor-mysql sh -c "exec mysqldump -uroot -p'${CASDOOR_ROOT_PWD}' --single-transaction --quick --routines --triggers casdoor" \
    | gzip > "${BACKUP_DIR}/casdoor-db-${ts}.sql.gz" \
    || warn "Casdoor 数据库备份失败，请确认 casdoor-mysql 容器已启动"
  ok "Casdoor 数据库已备份到 ${BACKUP_DIR}/casdoor-db-${ts}.sql.gz"

  section "备份 uploads"
  docker_cmd run --rm \
    -v community_uploads-data:/data:ro \
    -v "${BACKUP_DIR}:/backup" \
    alpine sh -c "tar czf /backup/uploads-${ts}.tar.gz -C /data ." \
    || warn "若上面失败，可能是卷名不同，请运行: docker volume ls 查看"
  ok "上传文件已备份到 ${BACKUP_DIR}/uploads-${ts}.tar.gz"

  log "建议把 ${BACKUP_DIR} 同步到对象存储（OSS/COS/S3）"
}

cmd_down() {
  ensure_env_file
  ensure_casdoor_runtime
  warn "停止所有容器（数据卷保留）"
  compose down
  ok "已停止"
}

cmd_nuke() {
  ensure_env_file
  ensure_casdoor_runtime
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
  log "  Casdoor：http://${domain}:$(env_value CASDOOR_HTTP_PORT || echo 8000)/"
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
  4) 部署自检 doctor
  5) 查看日志
  6) 灌入种子数据
  7) 备份数据库与上传目录
  8) 停止服务（保留数据）
  9) 卸载并清理所有数据（危险）
  q) 退出
EOF
  read -r -p "输入序号 [1]: " choice
  choice="${choice:-1}"
  case "$choice" in
    1) cmd_up; cmd_seed ;;
    2) cmd_update ;;
    3) cmd_status ;;
    4) cmd_doctor ;;
    5) cmd_logs ;;
    6) cmd_seed ;;
    7) cmd_backup ;;
    8) cmd_down ;;
    9) cmd_nuke ;;
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
    doctor)    cmd_doctor ;;
    logs)      cmd_logs ;;
    seed)      cmd_seed ;;
    backup)    cmd_backup ;;
    down)      cmd_down ;;
    nuke)      cmd_nuke ;;
    menu|"")   interactive_menu ;;
    *)
      err "未知命令: $1"
      echo "用法: bash deploy/deploy.sh [up|update|status|doctor|logs|seed|backup|down|nuke]"
      exit 1
      ;;
  esac
}

main "$@"
