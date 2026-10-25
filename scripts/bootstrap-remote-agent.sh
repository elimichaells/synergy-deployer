#!/usr/bin/env bash
set -euo pipefail
stage="$(cd -- "$(dirname -- "$0")" && pwd -P)"
root=/var/lib/manager-agent
if [ "$(id -u)" != 0 ]; then echo 'Setup needs root or sudo permission'; exit 1; fi
if [ -L "$root" ]; then echo 'Agent data directory cannot be a symbolic link'; exit 1; fi
if [ -d "$root" ] && [ -n "$(ls -A "$root")" ] && [ ! -f "$root/.manager-bootstrap" ]; then echo 'The agent data directory is not empty. Use a dedicated target.'; exit 1; fi
if [ -f "$root/agent.json" ]; then echo 'An agent enrollment already exists. Inspect it locally before retrying setup.'; exit 1; fi
if [ -e /etc/systemd/system/manager-agent.service ]; then echo 'An existing manager-agent service must be inspected before setup'; exit 1; fi
if [ ! -d /run/systemd/system ]; then echo 'Automatic setup requires systemd'; exit 1; fi
if command -v ss >/dev/null && ss -H -ltn | awk '{print $4}' | grep -Eq ':(80|443|2029)$'; then echo 'Ports 80, 443 or 2029 are already in use. Plan the existing web-server migration first.'; exit 1; fi
echo '[setup] Installing operating-system prerequisites'
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl git tar xz-utils
elif command -v dnf >/dev/null; then
  dnf install -y ca-certificates curl git tar xz
else
  echo 'Automatic setup supports apt or dnf distributions. Use manual enrollment for this distribution.'; exit 1
fi
source "$stage/downloads.env"
umask 077
install -d -m 700 "$root" "$root/tools" "$root/tools/node" "$root/tools/caddy"
touch "$root/.manager-bootstrap"
fetch_verified() {
  curl --fail --location --proto '=https' --tlsv1.2 --retry 2 "$1" --output "$2"
  printf '%s  %s\n' "$3" "$2" | sha256sum --check --status
}
echo '[setup] Downloading and verifying Node.js and Caddy'
fetch_verified "$NODE_URL" "$root/tools/node.tar.xz" "$NODE_SHA"
fetch_verified "$CADDY_URL" "$root/tools/caddy.tar.gz" "$CADDY_SHA"
tar -xJf "$root/tools/node.tar.xz" -C "$root/tools/node" --strip-components=1
tar -xzf "$root/tools/caddy.tar.gz" -C "$root/tools/caddy" caddy
chmod 755 "$root/tools/caddy/caddy"
# Account provisioning and enrollment also need useradd/runuser from sbin.
export PATH="$root/tools/node/bin:$root/tools/caddy:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
echo '[setup] Installing private PM2 tools'
npm install --prefix "$root/tools" --omit=dev --no-audit --no-fund "pm2@$PM2_VERSION"
if ! id manager-agent >/dev/null 2>&1; then useradd --system --home-dir "$root" --shell /usr/sbin/nologin manager-agent; fi
install -m 600 "$stage/manager-agent.cjs" "$root/manager-agent.cjs"
install -m 600 "$stage/enrollment.json" "$root/enrollment.json"
if [ -f "$stage/manager-ca.crt" ]; then install -m 600 "$stage/manager-ca.crt" "$root/manager-ca.crt"; fi
chown -R manager-agent:manager-agent "$root"
ca=""
if [ -f "$root/manager-ca.crt" ]; then ca="NODE_EXTRA_CA_CERTS=$root/manager-ca.crt"; fi
echo '[setup] Enrolling with Manager'
# The one-time token is read from an account-protected file, never command arguments.
trap 'rm -f -- "$root/enrollment.json"' EXIT
runuser -u manager-agent -- env "PATH=$PATH" ${ca:+"$ca"} "$root/tools/node/bin/node" "$root/manager-agent.cjs" enroll --root "$root" --enrollment-file "$root/enrollment.json"
cat > /etc/systemd/system/manager-agent.service <<'UNIT'
[Unit]
Description=Manager remote server agent
Wants=network-online.target
After=network-online.target
[Service]
Type=simple
User=manager-agent
Group=manager-agent
WorkingDirectory=/var/lib/manager-agent
Environment=PATH=/var/lib/manager-agent/tools/node/bin:/var/lib/manager-agent/tools/caddy:/usr/local/bin:/usr/bin:/bin
Environment=MANAGER_AGENT_CADDY=/var/lib/manager-agent/tools/caddy/caddy
Environment=NODE_EXTRA_CA_CERTS=/var/lib/manager-agent/manager-ca.crt
ExecStart=/var/lib/manager-agent/tools/node/bin/node /var/lib/manager-agent/manager-agent.cjs run --root /var/lib/manager-agent
Restart=on-failure
RestartSec=10
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
TimeoutStopSec=120
[Install]
WantedBy=multi-user.target
UNIT
if [ ! -f "$root/manager-ca.crt" ]; then sed -i '/^Environment=NODE_EXTRA_CA_CERTS=/d' /etc/systemd/system/manager-agent.service; fi
systemctl daemon-reload
systemctl enable --now manager-agent.service
systemctl is-active --quiet manager-agent.service
echo '[setup] Agent service started. Waiting for a heartbeat in Manager.'
