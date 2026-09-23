<?php
declare(strict_types=1);

// Run on the hosting over SSH/cPanel Terminal; never publish this script.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
require __DIR__ . '/../api/wompi-common.php';
try {
    $config = wompi_ready_config();
    echo "OK: credenciales del mismo ambiente y cURL disponible.\n";
    wompi_database();
    echo "OK: PDO SQLite y almacenamiento disponibles.\n";
    wompi_acceptance(wompi_api_url($config['public_key']), $config['public_key']);
    echo "OK: Wompi entrega ambos contratos. El checkout puede prepararse.\n";
    echo "No se creó ninguna fuente de pago ni se realizó ningún cobro.\n";
} catch (Throwable $error) {
    // PDO errors can include server paths; this output is local to the operator.
    fwrite(STDERR, 'ERROR: ' . $error->getMessage() . PHP_EOL);
    exit(1);
}
