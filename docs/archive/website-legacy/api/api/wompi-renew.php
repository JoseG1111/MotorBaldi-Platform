<?php
declare(strict_types=1);
require_once __DIR__ . '/wompi-common.php';
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function renew_reply(int $status, array $payload): void {
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('Allow: POST');
    renew_reply(405, ['message' => 'Método no permitido.']);
}
try {
    $config = wompi_config();
    $cronSecret = $config['cron_secret'];
    $providedSecret = (string) ($_SERVER['HTTP_X_CRON_SECRET'] ?? '');
    if ($cronSecret === '' || $providedSecret === '' || !hash_equals($cronSecret, $providedSecret)) {
        renew_reply(401, ['message' => 'No autorizado.']);
    }
    $config = wompi_ready_config();
    $public = $config['public_key'];
    $private = $config['private_key'];
    if (!preg_match('/^pub_(test|prod)_[A-Za-z0-9]+$/', $public, $environment) || !preg_match('/^prv_' . $environment[1] . '_[A-Za-z0-9]+$/', $private) || strpos($config['integrity_secret'], $environment[1] . '_integrity_') !== 0) {
        renew_reply(503, ['message' => 'Los pagos no están configurados.']);
    }
    $database = wompi_database();
    $base = wompi_api_url($public);
    $pending = $database->query("SELECT transaction_id FROM subscription_payments WHERE status = 'PENDING' AND transaction_id IS NOT NULL AND transaction_id != '' ORDER BY id DESC LIMIT 25")->fetchAll(PDO::FETCH_COLUMN);
    foreach ($pending as $transactionId) {
        try {
            $check = wompi_request('GET', $base . '/transactions/' . rawurlencode($transactionId), null, ['Authorization: Bearer ' . $private]);
            if ($check['status'] === 200) {
                wompi_record_transaction($database, $check['body']['data'] ?? []);
            }
        } catch (Throwable $error) {
            // Leave this payment pending for a later check or its webhook.
        }
    }
    $now = new DateTimeImmutable('now', new DateTimeZone('America/Bogota'));
    $nowString = $now->format('Y-m-d H:i:s');
    $due = $database->prepare('SELECT * FROM subscriptions WHERE status = ? AND next_charge_at <= ? ORDER BY next_charge_at ASC LIMIT 25');
    $due->execute(['active', $nowString]);
    $subscriptions = $due->fetchAll(PDO::FETCH_ASSOC);
    if (!$subscriptions) {
        renew_reply(200, ['processed' => 0, 'results' => []]);
    }
    $base = wompi_api_url($public);
    [$acceptance, $personal] = wompi_acceptance($base, $public);
    $results = [];
    foreach ($subscriptions as $subscription) {
        $database->beginTransaction();
        $claim = $database->prepare('UPDATE subscriptions SET status = ?, updated_at = ? WHERE id = ? AND status = ? AND next_charge_at <= ?');
        $claim->execute(['processing', $nowString, $subscription['id'], 'active', $nowString]);
        if ($claim->rowCount() !== 1) {
            $database->rollBack();
            continue;
        }
        $reference = 'REF-' . strtoupper($subscription['vehicle']) . '-' . strtoupper($subscription['plan']) . '-' . bin2hex(random_bytes(16));
        $paymentInsert = $database->prepare('INSERT INTO subscription_payments (subscription_id, reference, amount_in_cents, status, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)');
        $paymentInsert->execute([$subscription['id'], $reference, $subscription['amount_in_cents'], 'PENDING', 'renewal', $nowString]);
        $database->commit();
        $body = wompi_transaction_body($config, $reference, (int) $subscription['amount_in_cents'], $subscription['customer_email'], (int) $subscription['payment_source_id'], $subscription['payment_source_type'], $acceptance, $personal);
        try {
            $response = wompi_request('POST', $base . '/transactions', $body, ['Authorization: Bearer ' . $private]);
            $transaction = $response['body']['data'] ?? [];
            if ($response['status'] < 200 || $response['status'] >= 300) { throw new RuntimeException('Cobro sin confirmar.'); }
            wompi_record_transaction($database, $transaction);
            $transactionStatus = $transaction['status'];
            $results[] = ['subscription' => (int) $subscription['id'], 'status' => $transactionStatus];
        } catch (Throwable $error) {
            // A timeout may occur after Wompi accepted the charge. Keep it
            // processing; the webhook resolves it without another debit.
            $results[] = ['subscription' => (int) $subscription['id'], 'status' => 'UNCONFIRMED', 'reference' => $reference];
        }
    }
    renew_reply(200, ['processed' => count($results), 'results' => $results]);
} catch (Throwable $error) {
    if (isset($database) && $database->inTransaction()) { $database->rollBack(); }
    renew_reply(500, ['message' => 'No pudimos procesar las renovaciones.']);
}
