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
if ! command -v ss >/dev/null; then echo 'Install the OS networking tools before setup so occupied ports can be checked.'; exit 1; fi
if ss -H -ltn | awk '{print $4}' | grep -Eq ':(80|443|2029)$'; then echo 'Ports 80, 443 or 2029 are already in use. Existing web services are preserved; plan their integration first.'; exit 1; fi
source "$stage/downloads.env"
if [ "$INSTALL_GIT" = 1 ] && command -v git >/dev/null 2>&1; then
  if ! git --version | grep -Eq '^git version 2\.'; then echo 'Existing Git is not compatible. Select a verified Git path before setup.'; exit 1; fi
  TOOL_git="$(command -v git)"; INSTALL_GIT=0
fi
# A server reusing all four tools needs no release downloads or package upgrade.
if [ -n "$NODE_URL$CADDY_URL" ] || [ "$INSTALL_GIT" = 1 ]; then
echo '[setup] Installing missing operating-system prerequisites'
packages=(ca-certificates curl tar)
[ "$INSTALL_GIT" != 1 ] || packages+=(git)
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y "${packages[@]}" xz-utils
elif command -v dnf >/dev/null; then
  dnf install -y "${packages[@]}" xz
else
  echo 'Automatic setup supports apt or dnf distributions. Use manual enrollment for this distribution.'; exit 1
fi
fi
umask 077
install -d -m 700 "$root" "$root/tools" "$root/tools/node" "$root/tools/caddy"
touch "$root/.manager-bootstrap"
fetch_verified() {
  curl --fail --location --proto '=https' --tlsv1.2 --retry 2 "$1" --output "$2"
  printf '%s  %s\n' "$3" "$2" | sha256sum --check --status
}
echo '[setup] Reusing selected tools and installing missing prerequisites'
if [ -n "$NODE_URL" ]; then
fetch_verified "$NODE_URL" "$root/tools/node.tar.xz" "$NODE_SHA"
tar -xJf "$root/tools/node.tar.xz" -C "$root/tools/node" --strip-components=1
TOOL_node="$root/tools/node/bin/node"
fi
if [ -n "$CADDY_URL" ]; then
fetch_verified "$CADDY_URL" "$root/tools/caddy.tar.gz" "$CADDY_SHA"
tar -xzf "$root/tools/caddy.tar.gz" -C "$root/tools/caddy" caddy
chmod 755 "$root/tools/caddy/caddy"
TOOL_caddy="$root/tools/caddy/caddy"
fi
# Account provisioning and enrollment also need useradd/runuser from sbin.
export PATH="$(dirname "$TOOL_node"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
if [ "$INSTALL_GIT" = 1 ]; then TOOL_git="$(command -v git)"; fi
if [ -n "$PM2_VERSION" ]; then
echo '[setup] Installing private PM2 tools'
npm install --prefix "$root/tools" --omit=dev --no-audit --no-fund "pm2@$PM2_VERSION"
TOOL_pm2="$root/tools/node_modules/pm2/bin/pm2"
fi
if ! id manager-agent >/dev/null 2>&1; then useradd --system --home-dir "$root" --shell /usr/sbin/nologin manager-agent; fi
install -m 600 "$stage/manager-agent.cjs" "$root/manager-agent.cjs"
install -m 600 "$stage/manager-agent-supervisor.cjs" "$root/manager-agent-supervisor.cjs"
install -m 600 "$stage/enrollment.json" "$root/enrollment.json"
install -m 600 "$stage/tool-paths.json" "$root/tool-paths.json"
"$TOOL_node" - "$root/tool-paths.json" "$TOOL_node" "$TOOL_git" "$TOOL_caddy" "$TOOL_pm2" <<'JS'
const fs=require('fs');const [file,...paths]=process.argv.slice(2);const data=JSON.parse(fs.readFileSync(file,'utf8'));['node','git','caddy','pm2'].forEach((key,i)=>data[key]=paths[i]);fs.writeFileSync(file,JSON.stringify(data));
JS
if [ -f "$stage/manager-ca.crt" ]; then install -m 600 "$stage/manager-ca.crt" "$root/manager-ca.crt"; fi
chown -R manager-agent:manager-agent "$root"
ca=""
if [ -f "$root/manager-ca.crt" ]; then ca="NODE_EXTRA_CA_CERTS=$root/manager-ca.crt"; fi
echo '[setup] Enrolling with Manager'
# The one-time token is read from an account-protected file, never command arguments.
trap 'rm -f -- "$root/enrollment.json"' EXIT
runuser -u manager-agent -- env "PATH=$PATH" ${ca:+"$ca"} "$TOOL_node" "$root/manager-agent.cjs" check-tools --root "$root"
runuser -u manager-agent -- env "PATH=$PATH" ${ca:+"$ca"} "$TOOL_node" "$root/manager-agent.cjs" enroll --root "$root" --enrollment-file "$root/enrollment.json"
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
Environment=NODE_EXTRA_CA_CERTS=/var/lib/manager-agent/manager-ca.crt
ExecStart=__MANAGER_NODE__ /var/lib/manager-agent/manager-agent-supervisor.cjs --root /var/lib/manager-agent
Restart=on-failure
RestartSec=10
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
TimeoutStopSec=120
[Install]
WantedBy=multi-user.target
UNIT
"$TOOL_node" - /etc/systemd/system/manager-agent.service "$TOOL_node" <<'JS'
const fs=require('fs');const [file,node]=process.argv.slice(2);const quoted='"'+node.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/%/g,'%%').replace(/\$/g,'$$$$')+'"';fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('__MANAGER_NODE__',()=>quoted));
JS
if [ ! -f "$root/manager-ca.crt" ]; then sed -i '/^Environment=NODE_EXTRA_CA_CERTS=/d' /etc/systemd/system/manager-agent.service; fi
systemctl daemon-reload
systemctl enable --now manager-agent.service
systemctl is-active --quiet manager-agent.service
echo '[setup] Agent service started. Waiting for a heartbeat in Manager.'
