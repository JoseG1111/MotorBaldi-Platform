<?php
declare(strict_types=1);
require_once __DIR__ . '/wompi-common.php';
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

try {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        http_response_code(405);
        exit;
    }
    $event = json_decode(file_get_contents('php://input', false, null, 0, 262144), true);
    $config = wompi_config();
    $eventsSecret = $config['events_secret'];
    if (!is_array($event) || $eventsSecret === '' || !isset($event['signature']['properties'], $event['signature']['checksum'], $event['timestamp'], $event['data'])) {
        http_response_code(400);
        exit;
    }
    $values = '';
    foreach ($event['signature']['properties'] as $property) {
        $value = $event['data'];
        foreach (explode('.', (string) $property) as $key) {
            $value = is_array($value) && array_key_exists($key, $value) ? $value[$key] : null;
        }
        if ($value === null) {
            http_response_code(400);
            exit;
        }
        $values .= (string) $value;
    }
    $expected = hash('sha256', $values . $event['timestamp'] . $eventsSecret);
    $received = (string) ($event['signature']['checksum'] ?: ($_SERVER['HTTP_X_EVENT_CHECKSUM'] ?? ''));
    if (!hash_equals(strtolower($expected), strtolower($received))) {
        http_response_code(401);
        exit;
    }
    if (($event['event'] ?? '') !== 'transaction.updated') {
        http_response_code(200);
        exit;
    }
    $transaction = $event['data']['transaction'] ?? [];
    $reference = (string) ($transaction['reference'] ?? '');
    $status = strtoupper((string) ($transaction['status'] ?? ''));
    if ($reference === '' || $status === '') {
        http_response_code(400);
        exit;
    }
    $database = wompi_database();
    // Only trust transaction fields covered by Wompi's checksum. Fetch the full
    // transaction with the private key before applying reference/currency data.
    if (!in_array('transaction.id', $event['signature']['properties'], true)) {
        http_response_code(400);
        exit;
    }
    $result = wompi_request('GET', wompi_api_url($config['public_key']) . '/transactions/' . rawurlencode((string) ($transaction['id'] ?? '')), null, ['Authorization: Bearer ' . $config['private_key']]);
    if ($result['status'] !== 200) { throw new RuntimeException('No se pudo verificar el pago.'); }
    wompi_record_transaction($database, $result['body']['data'] ?? []);
    http_response_code(200);
} catch (Throwable $error) {
    if (isset($database) && $database instanceof PDO && $database->inTransaction()) {
        $database->rollBack();
    }
    http_response_code(500);
}
