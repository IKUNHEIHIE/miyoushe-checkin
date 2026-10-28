#!/usr/bin/env bash
set -euo pipefail
REPO="${MIYOUSHE_REPO:-IKUNHEIHIE/miyoushe-checkin}"
VERSION="${MIYOUSHE_VERSION:-v0.2.0}"
DEST="/opt/miyoushe-checkin"
[[ $EUID -eq 0 ]] || { echo "请使用 sudo 运行安装脚本" >&2; exit 1; }
for cmd in curl tar sha256sum systemctl; do command -v "$cmd" >/dev/null || { echo "缺少 $cmd" >&2; exit 1; }; done
case "$(uname -m)" in x86_64) arch=x64;; aarch64|arm64) arch=arm64;; *) echo "不支持此 CPU 架构" >&2; exit 1;; esac
[[ ! -e "$DEST" ]] || { echo "$DEST 已存在，为保护数据已停止；请先备份并手动处理。" >&2; exit 1; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
name="miyoushe-${VERSION}-linux-${arch}.tar.gz"
base="https://github.com/${REPO}/releases/download/${VERSION}"
curl -fL --retry 3 "$base/$name" -o "$tmp/$name"
curl -fL --retry 3 "$base/$name.sha256" -o "$tmp/$name.sha256"
(cd "$tmp" && sha256sum -c "$name.sha256")
mkdir -p "$DEST"; tar -xzf "$tmp/$name" -C "$DEST"
if ! id miyoushe >/dev/null 2>&1; then useradd --system --home-dir "$DEST" --shell /usr/sbin/nologin miyoushe; fi
mkdir -p "$DEST/data"
key=$("$DEST/node/bin/node" -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))")
token=$("$DEST/node/bin/node" -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))")
cat > "$DEST/.env" <<EOF
HOST=127.0.0.1
PORT=3000
NODE_ENV=development
DATABASE_PATH=$DEST/data/miyoushe.sqlite
DATA_ENCRYPTION_KEY=$key
BOOTSTRAP_TOKEN=$token
ALLOWED_ORIGINS=http://127.0.0.1:8080,http://localhost:8080
COOKIE_SECURE=false
EOF
chown -R miyoushe:miyoushe "$DEST"; chmod 600 "$DEST/.env"
cat > /etc/systemd/system/miyoushe-backend.service <<EOF
[Unit]
Description=Miyoushe backend
After=network.target
[Service]
User=miyoushe
WorkingDirectory=$DEST/backend
ExecStart=$DEST/node/bin/node --env-file=$DEST/.env $DEST/backend/dist/src/server.js
Restart=on-failure
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/miyoushe-web.service <<EOF
[Unit]
Description=Miyoushe local web gateway
After=miyoushe-backend.service
[Service]
User=miyoushe
WorkingDirectory=$DEST
ExecStart=$DEST/node/bin/node $DEST/gateway.mjs
Restart=on-failure
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now miyoushe-backend.service miyoushe-web.service
ready=false
for attempt in {1..30}; do
  if curl -fsS http://127.0.0.1:8080/api/v1/health >/dev/null; then ready=true; break; fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  echo "服务未通过健康检查，请查看 journalctl -u miyoushe-backend -u miyoushe-web。" >&2
  exit 1
fi
echo "安装完成。仅监听服务器本机 127.0.0.1:8080。"
echo "远程访问：ssh -L 8080:127.0.0.1:8080 用户名@服务器，然后在本机浏览器打开 http://127.0.0.1:8080"
echo "初始化令牌：sudo 查看 $DEST/.env 中的 BOOTSTRAP_TOKEN；请妥善保管 .env 和数据库备份。"
