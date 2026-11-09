#!/usr/bin/env bash
set -euo pipefail
plan_file="$1"; node_exe="$2"; stage="$(dirname "$plan_file")"
mapfile -d '' fields < <("$node_exe" -e 'const p=require(process.argv[1]);for(const k of ["service","mode","path","port","agentRoot","dataRoot","serverId","databasePassword"])process.stdout.write(String(p[k]??"")+"\0")' "$plan_file")
service="${fields[0]}"; mode="${fields[1]}"; selected="${fields[2]}"; port="${fields[3]}"; root="${fields[4]}"; files="${fields[5]}"; server_id="${fields[6]}"; password="${fields[7]}"
test "$(id -u)" = 0 || { echo 'Root or sudo is required'; exit 1; }
"$node_exe" -e 'const p=require(process.argv[1]),a=require(process.argv[2]);if(a.serverId!==p.serverId||!a.enrolled)throw Error("Agent directory belongs to another server")' "$plan_file" "$root/agent.json"
cp -- "$root/tool-paths.json" "$stage/previous-paths.json"
receipt="$stage/result.json"
"$node_exe" -e 'const fs=require("fs"),p=require(process.argv[1]);fs.writeFileSync(process.argv[2],JSON.stringify({status:"running",operationId:p.operationId,service:p.service,pid:Number(process.argv[3]),processStartedAt:fs.readFileSync("/proc/"+process.argv[3]+"/stat","utf8").split(" ")[21]}))' "$plan_file" "$receipt" "$$"
created_unit=''; policy_created=0; changed_paths=0
cleanup(){
  code=$?
  [ ! -f "$receipt" ] || chown --reference="$plan_file" "$receipt"
  if [ "$policy_created" = 1 ]; then rm -f -- /usr/sbin/policy-rc.d; fi
  rm -f -- "$stage/client.cnf"
  if [ "$code" != 0 ]; then
    if [ "$changed_paths" = 1 ]; then cp -- "$stage/previous-paths.json" "$root/tool-paths.json"; chown manager-agent:manager-agent "$root/tool-paths.json"; fi
    if [ -n "$created_unit" ]; then systemctl stop "$created_unit" || true; fi
    "$node_exe" -e 'const fs=require("fs"),p=require(process.argv[1]);fs.writeFileSync(process.argv[2],JSON.stringify({status:"failed",operationId:p.operationId,service:p.service,message:"Service operation failed; existing paths restored. Initialized data and encrypted recovery credentials are retained."}))' "$plan_file" "$receipt"
    chown --reference="$plan_file" "$receipt"
  fi
}
trap cleanup EXIT
tool="$service"; [ "$service" != postgresql ] || tool=psql
[ "$service" != angular ] || tool=ng
[ "$service" != mongodb ] || tool=mongod
[ "$service" != sqlserver ] || tool=sqlcmd
target="$files/$service"; config=''; data=''; username=''
if [ "$mode" = install-version ]; then
  version="$("$node_exe" -p 'require(process.argv[1]).version' "$plan_file")"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && [[ "$service" = node || "$service" = go ]] || exit 1
  target="$files/versions/$service/$version";test ! -e "$target" || { echo 'Version directory already exists; it will not be replaced';exit 1; }
  install -d -m 755 "$target"
  "$node_exe" "$stage/install-remote-tool.cjs" "$plan_file" "$target"
  selected="$(cat "$target/executable.txt")";arg=--version;[ "$service" != go ] || arg=version
  detected="$(cd -- "$root"; runuser -u manager-agent -- "$selected" "$arg")";[[ "$detected" = *"$version"* ]] || exit 1
  "$node_exe" - "$root/runtime-versions.json" "$service" "$version" "$selected" <<'JS'
const fs=require('fs');const [file,service,version,exe]=process.argv.slice(2);const registry=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{};(registry[service]||={})[version]=exe;const temp=file+'.'+require('crypto').randomBytes(12).toString('hex')+'.tmp';fs.writeFileSync(temp,JSON.stringify(registry),{flag:'wx',mode:0o600});fs.renameSync(temp,file);
JS
  chown -h manager-agent:manager-agent "$root/runtime-versions.json"
  "$node_exe" - "$plan_file" "$receipt" "$selected" <<'JS'
const fs=require('fs');const [planFile,file,exe]=process.argv.slice(2),p=JSON.parse(fs.readFileSync(planFile));fs.writeFileSync(file,JSON.stringify({status:'success',operationId:p.operationId,service:p.service,mode:p.mode,version:p.version,path:exe,managed:true}),{mode:0o600});
JS
  echo '[service] Project runtime installed; server defaults and existing applications are unchanged.'
  exit 0
fi
if [ "$mode" = reuse ]; then
  test -f "$selected" && test -x "$selected" || { echo 'Selected executable is inaccessible'; exit 1; }
else
  test ! -e "$target" || { echo 'Service destination already exists; it will not be overwritten'; exit 1; }
  if [ "$port" != 0 ] && ss -H -ltn | awk '{print $4}' | grep -Eq ":$port$"; then echo 'Port is already occupied'; exit 1; fi
  if [ "$service" = caddy ] && ss -H -ltn | awk '{print $4}' | grep -Eq ':(80|443|2019|2029)$'; then echo 'Existing web services occupy the proxy ports; reuse their configuration'; exit 1; fi
  case "$service" in postgresql) pattern='postgres';;mysql|mariadb) pattern='mysql|maria';;mongodb)pattern='mongo';;caddy)pattern='caddy';;*)pattern='^$';;esac
  if systemctl list-unit-files --type=service --no-legend --no-pager | grep -Ei "$pattern" >/dev/null; then echo 'An existing service was found. Choose Reuse.'; exit 1; fi
  if [ "$service" = postgresql ] || [ "$service" = mysql ] || [ "$service" = mariadb ]; then
    for existing in /var/lib/postgresql /var/lib/pgsql/data /var/lib/mysql /etc/postgresql; do
      if [ -d "$existing" ] && [ -n "$(find "$existing" -mindepth 1 -maxdepth 1 -print -quit)" ]; then echo 'Existing database files were found; initialization is blocked'; exit 1; fi
    done
  fi
  install -d -m 700 "$target"
  if command -v apt-get >/dev/null; then manager=apt; else command -v dnf >/dev/null; manager=dnf; fi
  install_package(){
    if [ "$manager" = apt ]; then
      if [ ! -e /usr/sbin/policy-rc.d ]; then printf '#!/bin/sh\nexit 101\n' >/usr/sbin/policy-rc.d; chmod 755 /usr/sbin/policy-rc.d; policy_created=1; fi
      DEBIAN_FRONTEND=noninteractive apt-get update
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-upgrade "$@"
      if [ "$policy_created" = 1 ]; then rm -f -- /usr/sbin/policy-rc.d; policy_created=0; fi
    else dnf install -y "$@"; fi
  }
  case "$service" in
    mongodb)
      for existing in /var/lib/mongodb /var/lib/mongo /data/db; do
        if [ -d "$existing" ] && [ -n "$(find "$existing" -mindepth 1 -maxdepth 1 -print -quit)" ]; then echo 'Existing MongoDB files were found. Choose Reuse.';exit 1;fi
      done
      if id manager-mongodb >/dev/null 2>&1 || [ -e /etc/systemd/system/ManagerMongoDB.service ]; then echo 'A MongoDB account or service already exists. Inspect it before continuing.';exit 1;fi
      test "$manager" = apt || { echo 'Reuse an existing MongoDB installation on this distribution.';exit 1; }
      install_package libcurl4 libgssapi-krb5-2
      "$node_exe" "$stage/install-remote-tool.cjs" "$plan_file" "$target"
      selected="$(cat "$target/executable.txt")"; "$selected" --version
      useradd --system --no-create-home --shell /usr/sbin/nologin manager-mongodb
      data="$target/data";config="$target/mongod.json";install -d -m 700 -o manager-mongodb -g manager-mongodb "$data" "$target/logs"
      "$node_exe" - "$config" "$data" "$target/logs/mongodb.log" "$port" <<'JS'
const fs=require('fs');const [file,data,log,port]=process.argv.slice(2);fs.writeFileSync(file,JSON.stringify({storage:{dbPath:data},systemLog:{destination:'file',path:log,logAppend:true},net:{bindIp:'127.0.0.1',port:Number(port)},security:{authorization:'enabled'}}),{flag:'wx',mode:0o644});
JS
      # Quote systemd paths and escape its percent specifiers. No shell executes
      # the database command or its path.
      "$node_exe" - "$selected" "$config" <<'JS'
const fs=require('fs');const q=s=>'"'+s.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%')+'"';fs.writeFileSync('/etc/systemd/system/ManagerMongoDB.service','[Unit]\nDescription=Manager MongoDB\nAfter=network.target\n[Service]\nUser=manager-mongodb\nGroup=manager-mongodb\nExecStart='+q(process.argv[2])+' --config '+q(process.argv[3])+'\nRestart=on-failure\nNoNewPrivileges=true\n[Install]\nWantedBy=multi-user.target\n',{flag:'wx',mode:0o644});
JS
      created_unit=ManagerMongoDB.service;systemctl daemon-reload;systemctl enable --now "$created_unit"
      "$node_exe" "$stage/initialize-remote-database.cjs" "$plan_file" initialize
      systemctl restart "$created_unit"
      "$node_exe" "$stage/initialize-remote-database.cjs" "$plan_file" verify
      username=manager_provisioner
      ;;
    postgresql)
      if [ "$manager" = apt ]; then
        install_package postgresql postgresql-client
        row="$(pg_lsclusters --no-header)"; test "$(printf '%s\n' "$row"|wc -l)" = 1
        read -r major cluster _ _ _ data _ <<< "$row"
        config="/etc/postgresql/$major/$cluster/postgresql.conf"; created_unit="postgresql@$major-$cluster.service"
      else
        install_package postgresql-server postgresql
        postgresql-setup --initdb
        data=/var/lib/pgsql/data; config="$data/postgresql.conf"; created_unit=postgresql.service
      fi
      printf "\nlisten_addresses='127.0.0.1'\nport=%s\npassword_encryption='scram-sha-256'\n" "$port" >> "$config"
      # This is a freshly initialized cluster. Keep local peer administration and password-only TCP.
      hba="$(dirname "$config")/pg_hba.conf"; [ -f "$hba" ] || hba="$data/pg_hba.conf"
      printf 'local all all peer\nhost all all 127.0.0.1/32 scram-sha-256\nhost all all ::1/128 scram-sha-256\n' > "$hba"
      systemctl enable --now "$created_unit"
      printf "CREATE ROLE manager_provisioner WITH LOGIN SUPERUSER PASSWORD '%s';\n" "$password" | runuser -u postgres -- psql -X -p "$port" -d postgres -v ON_ERROR_STOP=1
      username=manager_provisioner; selected="$(command -v psql)"
      PGPASSWORD="$password" "$selected" -X -h 127.0.0.1 -p "$port" -U "$username" -d postgres -v ON_ERROR_STOP=1 -c 'SELECT 1'
      ;;
    mysql|mariadb)
      install_package "$service-server"
      selected="$(command -v "$service")"; [ -n "$selected" ] || selected="$(command -v mysql)"
      data=/var/lib/mysql
      if [ "$manager" = apt ]; then
        dir=/etc/mysql/conf.d; [ "$service" != mariadb ] || dir=/etc/mysql/mariadb.conf.d
      else dir=/etc/my.cnf.d; fi
      install -d -m 755 "$dir"; config="$dir/zz-manager.cnf"; test ! -e "$config"
      printf '[mysqld]\nbind-address=127.0.0.1\nport=%s\n' "$port" > "$config"
      [ "$service" != mysql ] || printf 'mysqlx=OFF\n' >> "$config"
      created_unit="$service.service"; if [ "$manager" = dnf ] && [ "$service" = mysql ]; then created_unit=mysqld.service; fi
      systemctl enable --now "$created_unit"
      username=manager_provisioner
      printf "CREATE USER 'manager_provisioner'@'localhost' IDENTIFIED BY '%s'; GRANT ALL PRIVILEGES ON *.* TO 'manager_provisioner'@'localhost' WITH GRANT OPTION;\n" "$password" | "$selected" --protocol=socket -uroot
      printf '[client]\nuser=%s\npassword=%s\nhost=127.0.0.1\nport=%s\n' "$username" "$password" "$port" > "$stage/client.cnf"; chmod 600 "$stage/client.cnf"
      "$selected" --defaults-extra-file="$stage/client.cnf" --connect-timeout=5 -e 'SELECT 1'
      ;;
    go|php|python|composer|git)
      package="$service"; case "$service" in go)package=golang;;python)package=python3;;esac
      install_package "$package"
      command_name="$service"; [ "$service" != python ] || command_name=python3; selected="$(command -v "$command_name")"
      ;;
    node|caddy|pm2|sling|angular)
      "$node_exe" "$stage/install-remote-tool.cjs" "$plan_file" "$target"
      selected="$(cat "$target/executable.txt")"
      ;;
    *) echo 'Unsupported service'; exit 1;;
  esac
fi
test -n "$selected" && test -f "$selected"
"$node_exe" - "$root/tool-paths.json" "$tool" "$selected" <<'JS'
const fs=require('fs'),path=require('path');const [file,tool,exe]=process.argv.slice(2),p=JSON.parse(fs.readFileSync(file,'utf8'));p[tool]=exe;if(tool==='psql')for(const id of ['pg_dump','pg_restore'])p[id]=path.join(path.dirname(exe),id);const temporary=file+'.'+require('crypto').randomBytes(12).toString('hex')+'.tmp';fs.writeFileSync(temporary,JSON.stringify(p),{flag:'wx',mode:0o600});fs.renameSync(temporary,file);
JS
changed_paths=1; chown -h manager-agent:manager-agent "$root/tool-paths.json"
agent_node="$("$node_exe" -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).node' "$root/tool-paths.json")"
# The SSH user's home can be inaccessible to the service account. Node resolves
# package metadata from cwd even for a read-only version check.
(cd -- "$root"; runuser -u manager-agent -- "$agent_node" "$root/manager-agent.cjs" check-tools --root "$root")
"$node_exe" - "$plan_file" "$receipt" "$selected" "$created_unit" "$config" "$data" "$username" <<'JS'
const fs=require('fs');const [planFile,file,exe,serviceName,configPath,dataPath,username]=process.argv.slice(2),p=JSON.parse(fs.readFileSync(planFile));fs.writeFileSync(file,JSON.stringify({status:'success',operationId:p.operationId,service:p.service,mode:p.mode,path:exe,managed:p.mode==='install',serviceName,configPath,dataPath,host:'127.0.0.1',port:p.port,username,...(username?{password:p.databasePassword}:{})}),{mode:0o600});
JS
echo '[service] Configuration complete; authenticated database checks passed where applicable.'
