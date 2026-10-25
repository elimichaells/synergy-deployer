#!/usr/bin/env bash
set -euo pipefail
if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_ENVIRONMENT:-}" != github-hosted || "${MANAGER_SSH_LAB:-}" != 1 ]]; then
  echo 'This provisions a disposable GitHub-hosted runner only. Never run it on a Manager host.' >&2
  exit 1
fi
test ! -e /var/lib/manager-agent
for service in apache2 nginx; do
  if systemctl is-active --quiet "$service"; then sudo systemctl stop "$service"; fi
done
sudo apt-get update -qq
sudo apt-get install -y openssh-server postgresql
password="Aa1!$(openssl rand -hex 24)"
echo "::add-mask::$password"
sudo useradd --create-home --shell /bin/bash managersmoke
printf 'managersmoke:%s\n' "$password" | sudo chpasswd
echo 'managersmoke ALL=(ALL) ALL' | sudo tee /etc/sudoers.d/manager-ssh-lab >/dev/null
sudo chmod 440 /etc/sudoers.d/manager-ssh-lab
echo "SSH_LAB_PASSWORD=$password" >> "$GITHUB_ENV"
sudo ssh-keygen -A
sudo mkdir -p /run/sshd
cat > "$RUNNER_TEMP/manager-sshd.conf" <<'CONFIG'
Port 2222
ListenAddress 127.0.0.1
HostKey /etc/ssh/ssh_host_ed25519_key
PasswordAuthentication yes
PubkeyAuthentication no
KbdInteractiveAuthentication no
UsePAM yes
AllowUsers managersmoke
Subsystem sftp internal-sftp
PidFile /run/manager-ssh-lab.pid
CONFIG
sudo /usr/sbin/sshd -f "$RUNNER_TEMP/manager-sshd.conf"
echo "SSH_LAB_FINGERPRINT=$(sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256 | awk '{print $2}')" >> "$GITHUB_ENV"
sudo systemctl start postgresql
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER ROLE postgres PASSWORD 'root'"
sudo -u postgres createdb manager_remote_test_ssh
echo 'Disposable Linux SSH endpoint and database ready (loopback only).'
