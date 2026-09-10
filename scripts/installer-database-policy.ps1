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
