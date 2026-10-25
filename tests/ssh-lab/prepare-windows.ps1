$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:MANAGER_SSH_LAB -ne '1') {
  throw 'This provisions a disposable GitHub-hosted runner only. Never run it on a Manager host.'
}
if (Test-Path -LiteralPath (Join-Path $env:ProgramData 'ManagerAgent')) { throw 'The disposable agent directory must not already exist.' }

$password = 'Aa1!' + [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
Write-Output "::add-mask::$password"
New-LocalUser -Name managersmoke -Password (ConvertTo-SecureString $password -AsPlainText -Force) -PasswordNeverExpires | Out-Null
Add-LocalGroupMember -SID 'S-1-5-32-544' -Member managersmoke
"SSH_LAB_PASSWORD=$password" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append

$sshd = Join-Path $env:SystemRoot 'System32\OpenSSH\sshd.exe'
if (!(Test-Path -LiteralPath $sshd)) {
  $release = Invoke-RestMethod 'https://api.github.com/repos/PowerShell/Win32-OpenSSH/releases/latest'
  $asset = @($release.assets | Where-Object name -eq 'OpenSSH-Win64.zip')[0]
  if (!$asset -or $asset.digest -notmatch '^sha256:[a-f0-9]{64}$' -or !$asset.browser_download_url.StartsWith('https://github.com/PowerShell/Win32-OpenSSH/releases/download/')) { throw 'Missing verified official OpenSSH download' }
  $zip = Join-Path $env:RUNNER_TEMP 'openssh.zip'
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip
  if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $asset.digest.Substring(7)) { throw 'OpenSSH checksum mismatch' }
  Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $env:ProgramFiles 'ManagerSshLab')
  $sshd = Join-Path $env:ProgramFiles 'ManagerSshLab\OpenSSH-Win64\sshd.exe'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path (Split-Path $sshd) 'install-sshd.ps1')
  if ($LASTEXITCODE) { throw 'OpenSSH installation failed' }
}
if (Get-Service sshd -ErrorAction SilentlyContinue) { Stop-Service sshd -ErrorAction SilentlyContinue }
else { New-Service -Name sshd -BinaryPathName ('"' + $sshd + '"') -StartupType Manual | Out-Null }
$sshRoot = Join-Path $env:ProgramData 'ssh'
New-Item -ItemType Directory -Force -Path $sshRoot | Out-Null
& (Join-Path (Split-Path $sshd) 'ssh-keygen.exe') -A
if ($LASTEXITCODE) { throw 'SSH host-key generation failed' }
$sftp = (Join-Path (Split-Path $sshd) 'sftp-server.exe').Replace('\','/')
@"
Port 2222
ListenAddress 127.0.0.1
HostKey $($sshRoot.Replace('\','/'))/ssh_host_ed25519_key
PasswordAuthentication yes
PubkeyAuthentication no
AllowUsers managersmoke
Subsystem sftp "$sftp"
"@ | Set-Content -LiteralPath (Join-Path $sshRoot 'sshd_config') -Encoding ascii
Start-Service sshd
$fingerprint = (& (Join-Path (Split-Path $sshd) 'ssh-keygen.exe') -lf (Join-Path $sshRoot 'ssh_host_ed25519_key.pub') -E sha256).Split(' ')[1]
"SSH_LAB_FINGERPRINT=$fingerprint" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append

$pg = @(Get-Service 'postgresql*')[0]
Set-Service -Name $pg.Name -StartupType Manual
Start-Service -Name $pg.Name
$env:PGPASSWORD = 'root'
& (Join-Path $env:PGBIN 'createdb.exe') -h 127.0.0.1 -U postgres manager_remote_test_ssh
if ($LASTEXITCODE) { throw 'Could not create the isolated lab database' }
Write-Output 'Disposable Windows SSH endpoint and database ready (loopback only).'
