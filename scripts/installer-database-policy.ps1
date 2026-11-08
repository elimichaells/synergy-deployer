# The Chocolatey MariaDB installer hardcodes the MySQL service name. Keep
# automatic installation to one engine; separately configured providers can
# still be registered together in Manager's Data services page.
function Get-ManagerDatabaseConflict([string[]]$Engines, [object[]]$Services = @()) {
    if ($Engines -contains 'mysql' -and $Engines -contains 'mariadb') {
        return 'Choose either MySQL or MariaDB for automatic installation. Their installers use the same MySQL service name and port 3306. Separately configured servers can be registered in Data services.'
    }
    foreach ($service in $Services) {
        $isMariaDb = ($service.Name + ' ' + $service.DisplayName + ' ' + $service.PathName) -match '(?i)maria'
        $isMySql = $service.Name -match '(?i)^mysql' -or $service.PathName -match '(?i)mysqld(?:\.exe)?'
        if (($Engines -contains 'mysql') -and $isMariaDb) {
            return ('MariaDB is already installed as service ' + $service.Name + '. Select MariaDB or leave both engines unchecked to reuse the existing server.')
        }
        if (($Engines -contains 'mariadb') -and $isMySql -and -not $isMariaDb) {
            return ('MySQL is already installed as service ' + $service.Name + '. Select MySQL or leave both engines unchecked to reuse the existing server.')
        }
    }
    return $null
}

function Get-ManagerControlDatabaseSql([string]$Database, [string]$Role, [string]$Password) {
    foreach ($name in @($Database,$Role)) {
        if (-not $name -or $name -match '[\x00-\x1f]' -or [Text.Encoding]::UTF8.GetByteCount($name) -gt 63) {
            throw 'Control database and role names must contain 1 to 63 UTF-8 bytes without control characters.'
        }
    }
    # A fresh installation generates new encryption keys. Never silently attach it
    # to an old Manager database or rotate a role another installation still uses.
    $delimiter = '$manager_' + [guid]::NewGuid().ToString('N') + '$'
    return @'
SET standard_conforming_strings = on;
DO {0}
BEGIN
  IF EXISTS (SELECT 1 FROM pg_database WHERE datname = '{1}') OR
     EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{2}') THEN
    RAISE EXCEPTION 'The Manager database or application role already exists. Choose unused DbName and DbAppUser values, or use recovery to preserve existing encryption keys and credentials.';
  END IF;
  CREATE ROLE "{3}" LOGIN PASSWORD '{4}';
END
{0};
CREATE DATABASE "{5}" OWNER "{3}";
'@ -f $delimiter,$Database.Replace("'","''"),$Role.Replace("'","''"),$Role.Replace('"','""'),$Password.Replace("'","''"),$Database.Replace('"','""')
}
