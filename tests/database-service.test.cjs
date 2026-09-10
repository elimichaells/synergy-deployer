const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('database service discovery, configuration and data preservation guards', { skip: process.platform !== 'win32' }, () => {
  const helper = path.resolve(__dirname, '../scripts/database-service.ps1').replaceAll("'", "''");
  const script = `
    $ErrorActionPreference = 'Stop'
    . '${helper}'
    function Check($ok, $message) { if (-not $ok) { throw $message } }
    $custom = [pscustomobject]@{Name='ProjectDatabase'; DisplayName='Business DB'; PathName='"C:\\Program Files\\MySQL\\bin\\mysqld.exe" --defaults-file="C:\\db config\\my.ini" ProjectDatabase'}
    $maria = [pscustomobject]@{Name='MySQL'; DisplayName='MySQL'; PathName='"C:\\Program Files\\MariaDB\\bin\\mysqld.exe"'}
    $client = [pscustomobject]@{Name='MySQL'; DisplayName='MySQL'; PathName='C:\\client\\mysql.exe'}
    Check ((Select-DatabaseService 'mysql' @($custom,$maria,$client)).Name -eq 'ProjectDatabase') 'Custom MySQL service was not recognized'
    Check ((Select-DatabaseService 'mariadb' @($custom,$maria,$client)).Name -eq 'MySQL') 'MariaDB service was misclassified'
    Check ($null -eq (Select-DatabaseService 'mysql' @($client))) 'Client executable was accepted as a server'
    Check ((Get-DatabaseServiceExecutable 'C:\\Program Files\\MySQL\\bin\\mysqld.exe --console') -eq 'C:\\Program Files\\MySQL\\bin\\mysqld.exe') 'Unquoted executable with spaces was truncated'
    $another = [pscustomobject]@{Name='Second';DisplayName='Second';PathName='C:\\mysql\\bin\\mysqld.exe'}
    $blocked = $false
    try { Select-DatabaseService 'mysql' @($custom,$another) | Out-Null } catch { $blocked = $_.Exception.Message -like 'Multiple*' }
    Check $blocked 'Ambiguous services were silently selected'
    Check ((Select-DatabaseService 'mysql' @($custom,$another) 'Second').Name -eq 'Second') 'Explicit service selection failed'
    $lines = [System.Collections.Generic.List[string]]::new()
    @('[mysqld]','datadir=C:/database','bind-address=0.0.0.0','[ProjectDatabase]','bind-address=::','bind-address=*') | ForEach-Object { $lines.Add($_) }
    Set-DatabaseServerOption $lines 'ProjectDatabase' 'bind-address' '127.0.0.1'
    Check ($lines[2] -eq 'bind-address=0.0.0.0') 'Shared settings were changed for a named service'
    Check ($lines[4] -eq 'bind-address=127.0.0.1' -and $lines[5] -eq 'bind-address=127.0.0.1') 'Duplicate overrides remained public'
    foreach ($listeners in @(@(), @([pscustomobject]@{LocalAddress='0.0.0.0';LocalPort=3306}), @([pscustomobject]@{LocalAddress='127.0.0.1';LocalPort=3307}))) {
        $blocked = $false
        try { Assert-DatabaseListeners $listeners 3306 } catch { $blocked = $true }
        Check $blocked 'An absent, public or incorrect listener passed verification'
    }
    Assert-DatabaseListeners @([pscustomobject]@{LocalAddress='127.0.0.1';LocalPort=3306}) 3306
    $processes = @(
      [pscustomobject]@{ProcessId=11;ParentProcessId=10;ExecutablePath='C:\\mysql\\mysqld.exe'},
      [pscustomobject]@{ProcessId=12;ParentProcessId=11;ExecutablePath='C:\\mysql\\mysqld.exe'},
      [pscustomobject]@{ProcessId=20;ParentProcessId=1;ExecutablePath='C:\\mysql\\mysqld.exe'},
      [pscustomobject]@{ProcessId=21;ParentProcessId=10;ExecutablePath='C:\\other\\mysqld.exe'}
    )
    $owned = @(Get-DatabaseListenerProcessIds 10 'C:\\mysql\\mysqld.exe' $processes)
    Check (($owned | Sort-Object) -join ',' -eq '10,11,12') 'Listener ownership escaped the selected service tree or missed a child server'
    $base = Join-Path $env:TEMP ('manager-mysql-unit-' + [guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Path $base | Out-Null
        Check ((Get-MySqlDataState $base) -eq 'empty') 'Empty directory cannot be initialized'
        $marker = Join-Path $base 'existing-user-data.txt'
        [IO.File]::WriteAllText($marker, 'preserve-me')
        $blocked = $false
        try { Get-MySqlDataState $base | Out-Null } catch { $blocked = $_.Exception.Message -like '*will not be initialized*' }
        Check $blocked 'Non-empty incomplete directory could be initialized'
        New-Item -ItemType Directory -Path (Join-Path $base 'mysql') | Out-Null
        Check ((Get-MySqlDataState $base) -eq 'existing') 'Existing data was not recognized'
        Check ([IO.File]::ReadAllText($marker) -eq 'preserve-me') 'Existing files were changed'
    } finally {
        $allowed = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\\') + '\\manager-mysql-unit-'
        if (-not [IO.Path]::GetFullPath($base).StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected cleanup path' }
        Remove-Item -LiteralPath $base -Recurse -Force
    }
    'PASS: service discovery, loopback listener checks, and data preservation guards'
  `;
  const output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.match(output, /PASS:/);
});
