<?php
declare(strict_types=1);
$cfg['blowfish_secret'] = getenv('PHPMYADMIN_BLOWFISH_SECRET') ?: '';
$cfg['PmaAbsoluteUri'] = getenv('PHPMYADMIN_PUBLIC_URL') ?: '';
$cfg['TempDir'] = getenv('PHPMYADMIN_TEMP_DIR');
$cfg['SessionSavePath'] = getenv('PHPMYADMIN_SESSION_DIR');
$cfg['AllowArbitraryServer'] = false;
$cfg['LoginCookieValidity'] = 1800;
foreach ([1 => ['MySQL', 3306], 2 => ['MariaDB', 3307]] as $i => $server) {
    $cfg['Servers'][$i]['verbose'] = $server[0];
    $cfg['Servers'][$i]['auth_type'] = 'cookie';
    $cfg['Servers'][$i]['host'] = '127.0.0.1';
    $cfg['Servers'][$i]['port'] = (string)$server[1];
    $cfg['Servers'][$i]['AllowNoPassword'] = false;
}
