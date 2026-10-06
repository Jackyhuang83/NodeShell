#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="https://github.com/Jackyhuang83/NodeShell.git"
RAW_URL="https://raw.githubusercontent.com/Jackyhuang83/NodeShell/main/nodeshell.sh"
BRANCH="main"
APP_DIR="/opt/nodeshell"
COMPOSE_FILE="${APP_DIR}/docker/docker-compose.yml"
IMAGE="ghcr.io/jackyhuang83/nodeshell:latest"
SECRETS_DIR="/etc/nodeshell/secrets"
CF_TOKEN_FILE="/etc/nodeshell/cloudflared-token"
CF_SERVICE="/etc/systemd/system/nodeshell-cloudflared.service"
LAUNCHER="/usr/local/bin/nodeshell"

C_RESET="\033[0m"
C_BOLD="\033[1m"
C_GREEN="\033[32m"
C_YELLOW="\033[33m"
C_RED="\033[31m"
C_CYAN="\033[36m"

info() { printf "%b[INFO]%b %s\n" "$C_CYAN" "$C_RESET" "$*"; }
ok() { printf "%b[OK]%b %s\n" "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf "%b[WARN]%b %s\n" "$C_YELLOW" "$C_RESET" "$*"; }
die() { printf "%b[ERROR]%b %s\n" "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

require_root() {
  if [[ ${EUID} -ne 0 ]]; then
    cat >&2 <<EOF
NodeShell 管理脚本需要 root 权限。
请使用 root 登录后运行，或执行：
  sudo bash -c 'bash <(curl -fsSL ${RAW_URL})'
EOF
    exit 1
  fi
}

require_debian_family() {
  [[ -r /etc/os-release ]] || die "无法识别系统。当前脚本仅支持 Debian / Ubuntu。"
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in
    debian|ubuntu) ;;
    *) die "当前仅支持 Debian / Ubuntu，检测到：${ID:-unknown}" ;;
  esac
}

apt_install_base() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y ca-certificates curl git openssl
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    return
  fi

  require_debian_family
  info "安装 Docker Engine 与 Compose 插件..."
  apt_install_base

  # shellcheck disable=SC1091
  . /etc/os-release
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc

  local codename
  codename="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
  [[ -n "$codename" ]] || die "无法确定系统代号。"

  cat > /etc/apt/sources.list.d/docker.list <<EOF
deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${codename} stable
EOF

  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
  ok "Docker 已就绪。"
}

install_launcher() {
  cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
set -e
exec bash <(curl -fsSL "$RAW_URL")
EOF
  chmod 0755 "$LAUNCHER"
}

ensure_secrets() {
  install -d -m 0700 "$SECRETS_DIR"
  local name file
  for name in jwt_secret database_key encryption_key internal_auth_token; do
    file="$SECRETS_DIR/$name"
    if [[ ! -s "$file" ]]; then
      openssl rand -hex 32 > "$file"
    fi
    chown root:root "$file"
    chmod 0600 "$file"
  done
  ok "NodeShell 安装密钥已就绪（root:root 0600）。"
}

clone_or_refresh_repo() {
  if [[ -d "$APP_DIR/.git" ]]; then
    return
  fi
  if [[ -e "$APP_DIR" ]]; then
    die "$APP_DIR 已存在但不是 NodeShell Git 仓库，请先检查该目录。"
  fi
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
}

build_and_start() {
  info "构建 NodeShell 镜像..."
  docker build --pull -f "$APP_DIR/docker/Dockerfile" -t "$IMAGE" "$APP_DIR"

  info "启动 NodeShell..."
  docker compose -f "$COMPOSE_FILE" up -d
  wait_for_app
}

wait_for_app() {
  local i
  for i in {1..60}; do
    if curl -fsS --max-time 2 http://127.0.0.1:8080/ >/dev/null 2>&1; then
      ok "NodeShell 已启动：http://127.0.0.1:8080"
      return
    fi
    sleep 1
  done
  warn "容器已启动，但 WebUI 60 秒内未通过本机健康检查。"
  docker logs --tail 80 nodeshell 2>/dev/null || true
}

admin_exec() {
  if [[ -t 0 && -t 1 ]]; then
    docker exec -it nodeshell nodeshell admin "$@"
  else
    docker exec -i nodeshell nodeshell admin "$@"
  fi
}

owner_status() {
  docker exec nodeshell nodeshell admin status
}

create_owner() {
  docker ps --format '{{.Names}}' | grep -qx nodeshell || die "NodeShell 容器未运行。"
  local username
  read -r -p "Owner 用户名 [admin]: " username
  username="${username:-admin}"
  admin_exec create-owner --username "$username"
}

reset_owner_password() {
  docker ps --format '{{.Names}}' | grep -qx nodeshell || die "NodeShell 容器未运行。"
  local username
  read -r -p "Owner 用户名 [admin]: " username
  username="${username:-admin}"
  admin_exec reset-password --username "$username"
}

owner_menu() {
  while true; do
    clear || true
    cat <<'EOF'
NodeShell · Owner 管理

1. 查看初始化状态
2. 创建 Owner
3. 重置 Owner 密码
0. 返回
EOF
    local choice
    read -r -p "请选择 [0-3]: " choice
    case "$choice" in
      1) owner_status || true ;;
      2) create_owner ;;
      3) reset_owner_password ;;
      0) return ;;
      *) warn "无效选择。" ;;
    esac
    echo
    read -r -p "按 Enter 继续..." _
  done
}

install_nodeshell() {
  require_debian_family
  apt_install_base
  install_docker
  ensure_secrets
  clone_or_refresh_repo
  install_launcher
  build_and_start

  echo
  owner_status || true
  echo
  local answer
  read -r -p "现在创建 Owner 吗？[Y/n]: " answer
  if [[ ! "$answer" =~ ^[Nn]$ ]]; then
    create_owner
  fi

  cat <<'EOF'

安装完成。
NodeShell WebUI 只监听：127.0.0.1:8080
请不要把 8080 端口直接开放到公网。
可通过 SSH Local Forward、Cloudflare Access + Tunnel 或可信私网访问。
EOF
}

update_nodeshell() {
  [[ -d "$APP_DIR/.git" ]] || die "尚未安装 NodeShell。"
  install_docker
  if [[ -n "$(git -C "$APP_DIR" status --porcelain)" ]]; then
    die "$APP_DIR 存在本地修改。为避免覆盖，更新已停止。"
  fi

  info "更新 NodeShell main..."
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
  install_launcher
  build_and_start
  ok "NodeShell 更新完成。"
}

show_status() {
  echo
  echo "== Container =="
  if docker ps -a --filter name='^/nodeshell$' --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | grep -q nodeshell; then
    docker ps -a --filter name='^/nodeshell$' --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
  else
    echo "NodeShell container: not found"
  fi

  echo
  echo "== Owner =="
  if docker ps --format '{{.Names}}' | grep -qx nodeshell; then
    owner_status || true
  else
    echo "NodeShell 未运行。"
  fi

  echo
  echo "== Local WebUI =="
  if curl -fsS --max-time 2 http://127.0.0.1:8080/ >/dev/null 2>&1; then
    echo "http://127.0.0.1:8080  OK"
  else
    echo "http://127.0.0.1:8080  unavailable"
  fi

  echo
  echo "== Cloudflare Tunnel =="
  if systemctl list-unit-files nodeshell-cloudflared.service >/dev/null 2>&1; then
    systemctl --no-pager --full status nodeshell-cloudflared.service 2>/dev/null | sed -n '1,8p' || true
  else
    echo "未配置 NodeShell Cloudflare Tunnel。"
  fi
}

show_logs() {
  docker ps -a --format '{{.Names}}' | grep -qx nodeshell || die "NodeShell 容器不存在。"
  info "显示最近日志；按 Ctrl+C 返回菜单。"
  docker logs --tail 200 -f nodeshell || true
}

install_cloudflared_package() {
  if command -v cloudflared >/dev/null 2>&1; then
    return
  fi
  require_debian_family
  apt_install_base
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg     -o /usr/share/keyrings/cloudflare-main.gpg
  cat > /etc/apt/sources.list.d/cloudflared.list <<'EOF'
deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main
EOF
  apt-get update -y
  apt-get install -y cloudflared
}

configure_cloudflare() {
  install_cloudflared_package

  cat <<'EOF'
请先在 Cloudflare Dashboard 创建 Remote-managed Tunnel，
并把 Public Hostname 的 Service 设置为：

  http://localhost:8080

建议同时启用 Cloudflare Access，不要把 NodeShell 作为匿名公网服务。
下面只需要粘贴 Tunnel Token 本身（通常以 eyJ 开头），不要粘贴整条命令。
EOF

  local token
  read -r -s -p "Tunnel Token: " token
  echo
  [[ -n "$token" ]] || die "Tunnel Token 不能为空。"

  install -d -m 0700 /etc/nodeshell
  umask 077
  printf '%s\n' "$token" > "$CF_TOKEN_FILE"
  chown root:root "$CF_TOKEN_FILE"
  chmod 0600 "$CF_TOKEN_FILE"
  unset token

  cat > "$CF_SERVICE" <<EOF
[Unit]
Description=NodeShell Cloudflare Tunnel
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=simple
ExecStart=$(command -v cloudflared) tunnel run --token-file $CF_TOKEN_FILE
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable --now nodeshell-cloudflared.service
  sleep 2
  if systemctl is-active --quiet nodeshell-cloudflared.service; then
    ok "Cloudflare Tunnel 服务已启动。"
  else
    systemctl --no-pager --full status nodeshell-cloudflared.service || true
    die "Cloudflare Tunnel 启动失败，请检查上面的日志。"
  fi
}

remove_cf_service() {
  if [[ -f "$CF_SERVICE" ]]; then
    systemctl disable --now nodeshell-cloudflared.service >/dev/null 2>&1 || true
    rm -f "$CF_SERVICE"
    systemctl daemon-reload
  fi
}

uninstall_nodeshell() {
  cat <<'EOF'
卸载模式：

1. 卸载程序，保留数据卷和安装密钥（推荐）
2. 完全清除 NodeShell 数据、安装密钥和 Tunnel Token
0. 取消
EOF
  local choice
  read -r -p "请选择 [0-2]: " choice

  case "$choice" in
    1)
      remove_cf_service
      if [[ -f "$COMPOSE_FILE" ]]; then
        docker compose -f "$COMPOSE_FILE" down || true
      else
        docker rm -f nodeshell >/dev/null 2>&1 || true
      fi
      rm -rf "$APP_DIR"
      ok "NodeShell 程序已卸载；Docker 数据卷和 /etc/nodeshell 已保留。"
      ;;
    2)
      local confirm
      read -r -p "这会永久删除 NodeShell 数据。请输入 PURGE 确认: " confirm
      [[ "$confirm" == "PURGE" ]] || { warn "已取消完全清除。"; return; }
      remove_cf_service
      if [[ -f "$COMPOSE_FILE" ]]; then
        docker compose -f "$COMPOSE_FILE" down -v || true
      else
        docker rm -f nodeshell >/dev/null 2>&1 || true
      fi
      rm -rf "$APP_DIR" /etc/nodeshell
      rm -f "$LAUNCHER"
      ok "NodeShell 已完全清除。"
      ;;
    0) return ;;
    *) warn "无效选择。" ;;
  esac
}

pause_menu() {
  echo
  read -r -p "按 Enter 返回菜单..." _
}

main_menu() {
  while true; do
    clear || true
    printf "%bNodeShell%b · VPS SSH 管理\n\n" "$C_BOLD" "$C_RESET"
    cat <<'EOF'
1. 安装 NodeShell
2. 更新 NodeShell
3. Owner 管理
4. 查看运行状态
5. 查看日志
6. 配置 Cloudflare Tunnel
7. 卸载 NodeShell
0. 退出
EOF
    local choice
    read -r -p "请选择 [0-7]: " choice
    case "$choice" in
      1) install_nodeshell; pause_menu ;;
      2) update_nodeshell; pause_menu ;;
      3) owner_menu ;;
      4) show_status; pause_menu ;;
      5) show_logs; pause_menu ;;
      6) configure_cloudflare; pause_menu ;;
      7) uninstall_nodeshell; pause_menu ;;
      0) exit 0 ;;
      *) warn "无效选择。"; sleep 1 ;;
    esac
  done
}

require_root
main_menu
