#!/usr/bin/env bash
# The privileged installer must not execute a Node binary writable by application accounts.
set -euo pipefail
stage="$1"; operation_id="$2"; service="$3"; recovery="${4:-}"
[[ "$operation_id" =~ ^[a-f0-9-]{36}$ ]] && [[ "$service" =~ ^[a-z]+$ ]] || exit 1
[[ "$stage" = /tmp/manager-service-"$operation_id" ]] && [ ! -L "$stage" ] || exit 1
umask 077
printf '{"status":"running","operationId":"%s","service":"%s","pid":%s,"processStartedAt":"%s"}' "$operation_id" "$service" "$$" "$(awk '{print $22}' /proc/$$/stat)" > "$stage/result.json"
cleanup(){
  code=$?
  if [ "$code" != 0 ] && grep -q '"status":"running"' "$stage/result.json"; then
    status=failed;[ -z "$recovery" ] || status=interrupted
    printf '{"status":"%s","operationId":"%s","service":"%s","message":"Installer runtime preparation failed. Existing services and recovery files were preserved."}' "$status" "$operation_id" "$service" > "$stage/result.json"
  fi
  chown --reference="$stage/plan.json" "$stage/result.json"
  rm -rf -- "$stage/installer-node"
  rm -f -- "$stage/installer-node.tar.xz"
}
trap cleanup EXIT
. "$stage/privileged-node.env"
case "$NODE_URL" in https://nodejs.org/dist/v24.*/node-v24.*-linux-*.tar.xz) ;; *) echo 'Invalid installer runtime source';exit 1;; esac
[[ "$NODE_SHA" =~ ^[a-f0-9]{64}$ ]] || exit 1
umask 077
mkdir "$stage/installer-node"
curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fLS "$NODE_URL" -o "$stage/installer-node.tar.xz"
printf '%s  %s\n' "$NODE_SHA" "$stage/installer-node.tar.xz" | sha256sum -c -
tar -xJf "$stage/installer-node.tar.xz" -C "$stage/installer-node" --strip-components=1
if [ "${4:-}" = verify ] || [ "${4:-}" = restore ]; then
  "$stage/installer-node/bin/node" "$stage/service-upgrade-runner.cjs" "$stage/plan.json" "$4"
else
  /bin/bash "$stage/install-remote-service.sh" "$stage/plan.json" "$stage/installer-node/bin/node"
fi
