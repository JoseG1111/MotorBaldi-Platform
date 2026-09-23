<?php
declare(strict_types=1);
require __DIR__ . '/../api/wompi-common.php';
function check(bool $condition, string $label): void {
    if (!$condition) { throw new RuntimeException($label); }
    echo "OK: $label\n";
}
$database = wompi_database();
check(wompi_private_directory('/home/account/public_html/api') === '/home/account', 'configuración privada en producción');
check(wompi_private_directory('/home/account/public_html/staging/api') === '/home/account', 'configuración privada en staging anidado');
check(wompi_private_directory('/home/account/staging.motorbaldi.com/api') === '/home/account', 'configuración privada en subdominio independiente');
check(array_keys(wompi_prices()['moto']) === ['anual', 'mensual'], 'solo dos planes nuevos');
check(wompi_valid_name("  María José O'Neill-Pérez  "), 'nombre real con tildes y signos');
check(!wompi_valid_name('cliente@example.com'), 'nombre rechaza correos');
check(!wompi_valid_name('https://example.com'), 'nombre rechaza URLs');
check(!wompi_valid_name('12345'), 'nombre rechaza números');
check(wompi_normalize_email(' TEST@Example.com ') === 'TEST@Example.com', 'recorta correo');
$testConfig = ['integrity_secret' => 'test_integrity_local'];
$testAcceptance = ['acceptance_token' => 'acceptance'];
$testPersonal = ['acceptance_token' => 'personal'];
$cardBody = wompi_transaction_body($testConfig, 'REF-CAR-MENSUAL-abcdef123456', 9990000, 'TEST@example.com', 10, 'CARD', $testAcceptance, $testPersonal);
$nequiBody = wompi_transaction_body($testConfig, 'REF-MOTO-MENSUAL-abcdef123456', 2990000, 'test@example.com', 11, 'NEQUI', $testAcceptance, $testPersonal);
check(($cardBody['recurrent'] ?? false) === true && ($cardBody['payment_method']['installments'] ?? 0) === 1, 'COF recurrente solo para tarjeta');
check(!isset($nequiBody['recurrent'], $nequiBody['payment_method']), 'fuente Nequi sin campos exclusivos de tarjeta');
check(wompi_next_charge('mensual', new DateTimeImmutable('2026-01-31 12:00:00')) === '2026-02-28 12:00:00', 'fin de mes');
check(wompi_next_charge('anual', new DateTimeImmutable('2024-02-29 12:00:00')) === '2025-02-28 12:00:00', 'año bisiesto');
$database->exec("INSERT INTO subscriptions (vehicle, plan, amount_in_cents, full_name, customer_email, payment_source_id, payment_source_type, status, next_charge_at, created_at, updated_at) VALUES ('car', 'mensual', 9990000, 'Test', 'test@example.com', 1, 'CARD', 'pending', '2026-01-31 00:00:00', '2026-01-01', '2026-01-01')");
$id = (int) $database->lastInsertId();
$database->prepare("INSERT INTO subscription_payments (subscription_id, reference, amount_in_cents, status, kind, created_at) VALUES (?, 'initial', 9990000, 'PENDING', 'initial', '2026-01-01')")->execute([$id]);
$transaction = ['id' => 'test-1', 'reference' => 'initial', 'amount_in_cents' => 9990000, 'currency' => 'COP', 'status' => 'APPROVED'];
$wrong = $transaction;
$wrong['amount_in_cents'] = 100;
try { wompi_record_transaction($database, $wrong); throw new LogicException('Monto incorrecto aceptado'); }
catch (RuntimeException $error) { check($error->getMessage() === 'La transacción no coincide con el pedido.', 'rechaza monto alterado'); }
wompi_record_transaction($database, $transaction);
check($database->query("SELECT status FROM subscriptions WHERE id = $id")->fetchColumn() === 'active', 'aprobación activa el plan');
$next = $database->query("SELECT next_charge_at FROM subscriptions WHERE id = $id")->fetchColumn();
$transaction['status'] = 'PENDING';
wompi_record_transaction($database, $transaction);
check($database->query("SELECT status FROM subscriptions WHERE id = $id")->fetchColumn() === 'active', 'pendiente tardío no revierte aprobación');
$transaction['status'] = 'APPROVED';
wompi_record_transaction($database, $transaction);
check($database->query("SELECT next_charge_at FROM subscriptions WHERE id = $id")->fetchColumn() === $next, 'webhook duplicado no alarga el período');
$database->prepare("INSERT INTO subscription_payments (subscription_id, reference, amount_in_cents, status, kind, created_at) VALUES (?, 'renewal', 9990000, 'PENDING', 'renewal', '2026-01-01')")->execute([$id]);
$renewal = array_merge($transaction, ['id' => 'test-2', 'reference' => 'renewal', 'status' => 'PENDING']);
wompi_record_transaction($database, $renewal);
check($database->query("SELECT status FROM subscriptions WHERE id = $id")->fetchColumn() === 'processing', 'renovación pendiente no habilita otro cobro');
wompi_record_transaction($database, $transaction);
check($database->query("SELECT status FROM subscriptions WHERE id = $id")->fetchColumn() === 'processing', 'evento antiguo no reactiva una renovación pendiente');
$renewal['status'] = 'DECLINED';
wompi_record_transaction($database, $renewal);
check($database->query("SELECT status FROM subscriptions WHERE id = $id")->fetchColumn() === 'past_due', 'rechazo detiene renovaciones');
$database->prepare("INSERT INTO subscription_payments (subscription_id, reference, amount_in_cents, status, kind, created_at) VALUES (?, 'cancelled-payment', 9990000, 'PENDING', 'renewal', '2026-01-01')")->execute([$id]);
$database->prepare("UPDATE subscriptions SET status = 'cancelled' WHERE id = ?")->execute([$id]);
$cancelled = array_merge($transaction, ['id' => 'test-3', 'reference' => 'cancelled-payment', 'status' => 'APPROVED']);
wompi_record_transaction($database, $cancelled);
check($database->query("SELECT status FROM subscriptions WHERE id = $id")->fetchColumn() === 'cancelled', 'un evento tardío no reactiva una cancelación');
