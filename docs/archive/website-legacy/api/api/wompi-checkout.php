<?php
declare(strict_types=1);
require_once __DIR__ . '/wompi-common.php';
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
function reply(int $status, array $data): void {
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('Allow: POST');
    reply(405, ['message' => 'Método no permitido.']);
}
$stage = 'input';
try {
    $input = json_decode(file_get_contents('php://input', false, null, 0, 2048), true);
    $prices = wompi_prices();
    $vehicle = $input['vehicle'] ?? null;
    $plan = $input['plan'] ?? null;
    if (!is_string($vehicle) || !is_string($plan) || !isset($prices[$vehicle][$plan])) {
        reply(400, ['message' => 'Selecciona un vehículo y un plan válidos.']);
    }
    $stage = 'configuration';
    $config = wompi_ready_config();
    $stage = 'database';
    $database = wompi_database();
    $stage = 'provider_acceptance';
    [$acceptance, $personal] = wompi_acceptance(wompi_api_url($config['public_key']), $config['public_key']);
    $stage = 'checkout_storage';
    $id = bin2hex(random_bytes(32));
    $reference = 'REF-' . strtoupper($vehicle) . '-' . strtoupper($plan) . '-' . bin2hex(random_bytes(16));
    $database->prepare('DELETE FROM checkout_requests WHERE expires_at < ? AND claimed = 0')->execute([time()]);
    $database->prepare('INSERT INTO checkout_requests (id, vehicle, plan, acceptance, personal, expires_at, reference) VALUES (?, ?, ?, ?, ?, ?, ?)')->execute([$id, $vehicle, $plan, json_encode($acceptance), json_encode($personal), time() + 3600, $reference]);
    reply(200, [
        'publicKey' => $config['public_key'],
        'currency' => 'COP',
        'amountInCents' => $prices[$vehicle][$plan],
        'reference' => $reference,
        'checkoutId' => $id,
        'acceptanceUrl' => $acceptance['permalink'],
        'personalDataUrl' => $personal['permalink'],
    ]);
} catch (Throwable $error) {
    // Never log credentials, provider payloads or customer data.
    error_log('[MotorBaldi Wompi] checkout failed at ' . $stage . ' (' . get_class($error) . ')');
    reply(503, ['message' => 'No pudimos habilitar el pago seguro. Inténtalo más tarde o contáctanos al +57 310 460 2615.']);
}
