<?php
declare(strict_types=1);
require_once __DIR__ . '/wompi-common.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('Allow: POST');
    wompi_html_result(405, 'Método no permitido', 'Esta dirección solo acepta el registro de una suscripción.');
}

try {
    $vehicle = (string) ($_POST['vehicle'] ?? '');
    $plan = (string) ($_POST['plan'] ?? '');
    $fullName = wompi_normalize_name((string) ($_POST['full_name'] ?? ''));
    $email = wompi_normalize_email((string) ($_POST['email'] ?? ''));
    $consentAccepted = ($_POST['accept_all'] ?? '') === '1';
    $prices = wompi_prices();
    if (!isset($prices[$vehicle][$plan]) || !wompi_valid_name($fullName) || !wompi_valid_email($email) || !$consentAccepted) {
        wompi_html_result(400, 'Revisa tus datos', 'Ingresa un nombre y correo válidos y acepta las condiciones antes de continuar.');
    }
    $token = trim((string) ($_POST['payment_source_token'] ?? ''));
    $sourceType = strtoupper(trim((string) ($_POST['payment_source_type'] ?? '')));
    if ($token === '' || !in_array($sourceType, ['CARD', 'NEQUI'], true)) {
        wompi_html_result(400, 'Medio de pago incompleto', 'No recibimos un medio de pago válido. Vuelve a intentarlo.');
    }
    $config = wompi_ready_config();
    $public = $config['public_key'];
    $private = $config['private_key'];
    if (!preg_match('/^pub_(test|prod)_[A-Za-z0-9]+$/', $public, $environment) || !preg_match('/^prv_' . $environment[1] . '_[A-Za-z0-9]+$/', $private) || strpos($config['integrity_secret'], $environment[1] . '_integrity_') !== 0) {
        wompi_html_result(503, 'Pagos no habilitados', 'La cuenta de pagos todavía no está configurada. Contáctanos al +57 310 460 2615.');
    }
    $base = wompi_api_url($public);
    $database = wompi_database();
    $checkoutId = (string) ($_POST['checkout_id'] ?? '');
    $checkoutQuery = $database->prepare('SELECT * FROM checkout_requests WHERE id = ? AND vehicle = ? AND plan = ? AND expires_at >= ?');
    $checkoutQuery->execute([$checkoutId, $vehicle, $plan, time()]);
    $checkout = $checkoutQuery->fetch(PDO::FETCH_ASSOC);
    if (!$checkout) {
        wompi_html_result(400, 'Solicitud vencida', 'Vuelve a elegir tu plan para preparar un nuevo pago.');
    }
    $claim = $database->prepare('UPDATE checkout_requests SET claimed = 1, token_hash = ? WHERE id = ? AND claimed = 0');
    try {
        $claim->execute([hash('sha256', $token), $checkoutId]);
    } catch (PDOException $error) {
        if ($error->getCode() !== '23000') { throw $error; }
        wompi_html_result(409, 'Solicitud ya recibida', 'No repetiremos el cobro. Si no conoces el resultado, contáctanos antes de volver a pagar.');
    }
    if ($claim->rowCount() !== 1) {
        wompi_html_result(409, 'Solicitud ya recibida', 'No repetiremos el cobro. Si no conoces el resultado, contáctanos antes de volver a pagar.');
    }
    $acceptance = json_decode($checkout['acceptance'], true);
    $personal = json_decode($checkout['personal'], true);
    $now = new DateTimeImmutable('now', new DateTimeZone('America/Bogota'));
    $amount = $prices[$vehicle][$plan];
    $sourceResult = wompi_request('POST', $base . '/payment_sources', [
        'type' => $sourceType,
        'token' => $token,
        'customer_email' => $email,
        'acceptance_token' => $acceptance['acceptance_token'],
        'accept_personal_auth' => $personal['acceptance_token'],
    ], ['Authorization: Bearer ' . $private]);
    $source = $sourceResult['body']['data'] ?? [];
    if ($sourceResult['status'] < 200 || $sourceResult['status'] >= 300 || !isset($source['id']) || ($source['status'] ?? '') !== 'AVAILABLE') {
        wompi_html_result(422, 'No pudimos guardar tu medio de pago', 'Wompi no pudo autorizar la fuente de pago. Puedes intentarlo con otro medio.');
    }
    $reference = (string) ($checkout['reference'] ?? '');
    if (!preg_match('/^REF-[A-Z]+-[A-Z]+-[A-Fa-f0-9]{32}$/', $reference)) {
        throw new RuntimeException('La referencia de pago no es válida.');
    }
    $subscriptionStatus = 'pending';
    $database->beginTransaction();
    $insert = $database->prepare('INSERT INTO subscriptions (vehicle, plan, amount_in_cents, full_name, customer_email, payment_source_id, payment_source_type, status, next_charge_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    $insert->execute([$vehicle, $plan, $amount, $fullName, $email, (int) $source['id'], $sourceType, $subscriptionStatus, wompi_next_charge($plan, $now), $now->format('Y-m-d H:i:s'), $now->format('Y-m-d H:i:s')]);
    $subscriptionId = (int) $database->lastInsertId();
    $paymentInsert = $database->prepare('INSERT INTO subscription_payments (subscription_id, reference, amount_in_cents, status, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    $paymentInsert->execute([$subscriptionId, $reference, $amount, 'PENDING', 'initial', $now->format('Y-m-d H:i:s')]);
    $database->commit();
    $transactionBody = wompi_transaction_body($config, $reference, $amount, $email, (int) $source['id'], $sourceType, $acceptance, $personal);
    $transactionResult = wompi_request('POST', $base . '/transactions', $transactionBody, ['Authorization: Bearer ' . $private]);
    $transaction = $transactionResult['body']['data'] ?? [];
    if ($transactionResult['status'] < 200 || $transactionResult['status'] >= 300) {
        throw new RuntimeException('No se pudo confirmar el cobro.');
    }
    wompi_record_transaction($database, $transaction);
    $paymentQuery = $database->prepare('SELECT status FROM subscription_payments WHERE reference = ?');
    $paymentQuery->execute([$reference]);
    $transactionStatus = $paymentQuery->fetchColumn();
    if (!in_array($transactionStatus, ['APPROVED', 'PENDING'], true)) {
        wompi_html_result(422, 'Pago no autorizado', 'Wompi no aprobó el primer cobro. No se activará ninguna renovación. Puedes intentarlo de nuevo.');
    }
    $message = $transactionStatus === 'APPROVED'
        ? 'Tu plan quedó activo y se renovará automáticamente según el período elegido.'
        : 'Tu primer pago quedó pendiente. Wompi confirmará el resultado y la renovación se activará cuando sea aprobado.';
    wompi_html_result(200, 'Solicitud recibida', $message . ' Referencia: ' . $reference);
} catch (Throwable $error) {
    if (isset($database) && $database instanceof PDO && $database->inTransaction()) {
        $database->rollBack();
    }
    wompi_html_result(503, 'No pudimos confirmar tu pago', 'Contacta al +57 310 460 2615 antes de volver a pagar para comprobar si Wompi recibió el cobro.' . (isset($reference) ? ' Referencia: ' . $reference : ''));
}
