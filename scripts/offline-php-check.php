<?php
foreach (['mysqli', 'mbstring', 'openssl', 'curl', 'fileinfo', 'zip'] as $extension) {
    if (!extension_loaded($extension)) {
        fwrite(STDERR, 'Missing PHP extension: ' . $extension);
        exit(1);
    }
}
