<?php
declare(strict_types=1);
require_once __DIR__ . '/wompi-common.php';

// Wompi's key response currently lacks CORS headers. Relay only its public
// encryption key; card information and tokenization never pass this endpoint.
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    header('Allow: GET');
    http_response_code(405);
    echo json_encode(['message' => 'Método no permitido.']);
    exit;
}
try {
    $config = wompi_ready_config();
    $result = wompi_request('GET', wompi_api_url($config['public_key']) . '/tokens/keys/tokenization', null, ['Authorization: Bearer ' . $config['public_key']]);
    $key = $result['body']['data']['publicKey'] ?? '';
    if ($result['status'] !== 200 || !is_string($key) || strpos($key, '-----BEGIN PUBLIC KEY-----') !== 0 || strlen($key) > 10000) {
        throw new RuntimeException('Llave no disponible.');
    }
    echo json_encode(['data' => ['publicKey' => $key]]);
} catch (Throwable $error) {
    http_response_code(503);
    echo json_encode(['message' => 'No pudimos preparar el cifrado seguro. Inténtalo más tarde.']);
}
