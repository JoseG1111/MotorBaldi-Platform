<?php
declare(strict_types=1);

// cPanel subdomains may live several levels below public_html.
function wompi_private_directory(?string $apiDirectory = null): string
{
    $directory = $apiDirectory ?: __DIR__;
    for ($parent = $directory; $parent !== dirname($parent); $parent = dirname($parent)) {
        if (basename($parent) === 'public_html') {
            return dirname($parent);
        }
    }
    return dirname($directory, 2);
}

function wompi_config(): array
{
    static $config;
    if ($config !== null) {
        return $config;
    }

    $path = getenv('WOMPI_CONFIG_PATH') ?: wompi_private_directory() . '/motorbaldi-wompi.php';
    $fileConfig = is_file($path) ? require $path : [];
    if (!is_array($fileConfig)) {
        throw new RuntimeException('El archivo privado de Wompi debe devolver un array.');
    }
    $config = [
        'public_key' => getenv('WOMPI_PUBLIC_KEY') ?: ($fileConfig['public_key'] ?? ''),
        'private_key' => getenv('WOMPI_PRIVATE_KEY') ?: ($fileConfig['private_key'] ?? ''),
        'integrity_secret' => getenv('WOMPI_INTEGRITY_SECRET') ?: ($fileConfig['integrity_secret'] ?? ''),
        'events_secret' => getenv('WOMPI_EVENTS_SECRET') ?: ($fileConfig['events_secret'] ?? ''),
        'cron_secret' => getenv('WOMPI_CRON_SECRET') ?: ($fileConfig['cron_secret'] ?? ''),
    ];
    $config = array_map(static function ($value): string { return trim((string) $value); }, $config);
    return $config;
}

function wompi_prices(): array
{
    return [
        'car' => [
            'anual' => 95900000,
            'mensual' => 9990000,
        ],
        'moto' => [
            'anual' => 28800000,
            'mensual' => 2990000,
        ],
    ];
}

function wompi_normalize_name(string $value): string
{
    $value = trim($value);
    return preg_replace('/\s+/u', ' ', $value) ?: '';
}

function wompi_valid_name(string $value): bool
{
    $value = wompi_normalize_name($value);
    $length = function_exists('mb_strlen') ? mb_strlen($value, 'UTF-8') : strlen($value);
    if ($length < 3 || $length > 120 || strpos($value, '@') !== false
        || preg_match('~(?:https?://|www\.|\.[a-z]{2,}(?:/|$))~iu', $value)) {
        return false;
    }
    return preg_match("/^(?=(?:.*\\p{L}){2})[\\p{L}\\p{M} .’'\x{2010}-\x{2015}-]+$/u", $value) === 1;
}

function wompi_normalize_email(string $value): string
{
    return trim($value);
}

function wompi_valid_email(string $value): bool
{
    $value = wompi_normalize_email($value);
    return strlen($value) <= 180 && filter_var($value, FILTER_VALIDATE_EMAIL) !== false;
}

function wompi_transaction_body(array $config, string $reference, int $amount, string $email, int $sourceId, string $sourceType, array $acceptance, array $personal): array
{
    if ($amount <= 0 || !preg_match('/^[A-Za-z0-9_-]+$/', $reference)) {
        throw new InvalidArgumentException('Referencia o monto de transacción inválidos.');
    }
    $body = [
        'amount_in_cents' => $amount,
        'currency' => 'COP',
        'signature' => hash('sha256', $reference . $amount . 'COP' . $config['integrity_secret']),
        'customer_email' => wompi_normalize_email($email),
        'reference' => $reference,
        'payment_source_id' => $sourceId,
        'acceptance_token' => $acceptance['acceptance_token'],
        'accept_personal_auth' => $personal['acceptance_token'],
    ];
    // `recurrent` is Wompi's COF flag for RBM cards. Other reusable sources
    // are charged by their payment_source_id without this card-only flag.
    if ($sourceType === 'CARD') {
        $body['payment_method'] = ['installments' => 1];
        $body['recurrent'] = true;
    }
    return $body;
}

function wompi_ready_config(): array
{
    $config = wompi_config();
    if (!preg_match('/^pub_(test|prod)_[A-Za-z0-9]+$/', $config['public_key'], $match)) {
        throw new RuntimeException('WOMPI_PUBLIC_KEY ausente o inválida. Revisa la ubicación del archivo privado.');
    }
    if (!preg_match('/^prv_' . $match[1] . '_[A-Za-z0-9]+$/', $config['private_key'])
        || strpos($config['integrity_secret'], $match[1] . '_integrity_') !== 0
        || strpos($config['events_secret'], $match[1] . '_events_') !== 0) {
        throw new RuntimeException('Las credenciales privadas de Wompi faltan o no corresponden al mismo ambiente.');
    }
    if ($config['cron_secret'] === '') {
        throw new RuntimeException('Falta WOMPI_CRON_SECRET para proteger las renovaciones.');
    }
    if (!function_exists('curl_init')) {
        throw new RuntimeException('La extensión cURL de PHP no está habilitada.');
    }
    return $config;
}

function wompi_api_url(string $publicKey): string
{
    return strpos($publicKey, 'pub_test_') === 0
        ? 'https://sandbox.wompi.co/v1'
        : 'https://production.wompi.co/v1';
}

function wompi_request(string $method, string $url, ?array $body = null, array $headers = []): array
{
    if (!function_exists('curl_init')) {
        throw new RuntimeException('La extensión cURL de PHP no está habilitada.');
    }
    $curl = curl_init($url);
    $requestHeaders = array_merge(['Accept: application/json'], $headers);
    $options = [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => 30,
        CURLOPT_HTTPHEADER => $requestHeaders,
    ];
    if ($body !== null) {
        $options[CURLOPT_POSTFIELDS] = json_encode($body, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
        $requestHeaders[] = 'Content-Type: application/json';
        $options[CURLOPT_HTTPHEADER] = $requestHeaders;
    }
    curl_setopt_array($curl, $options);
    $raw = curl_exec($curl);
    $error = curl_error($curl);
    $status = (int) curl_getinfo($curl, CURLINFO_HTTP_CODE);
    curl_close($curl);
    if ($raw === false || $error !== '') {
        throw new RuntimeException('No se pudo conectar con Wompi.');
    }
    $decoded = json_decode($raw, true);
    return ['status' => $status, 'body' => is_array($decoded) ? $decoded : []];
}

function wompi_database(): PDO
{
    if (!class_exists('PDO') || !in_array('sqlite', PDO::getAvailableDrivers(), true)) {
        throw new RuntimeException('PHP PDO SQLite no está habilitado.');
    }
    $testSuffix = strpos(wompi_config()['public_key'], 'pub_test_') === 0 ? '-test' : '';
    $legacyPath = dirname(__DIR__, 2) . '/motorbaldi-wompi' . $testSuffix . '.sqlite';
    $path = getenv('WOMPI_DB_PATH') ?: wompi_private_directory() . '/motorbaldi-wompi' . $testSuffix . '.sqlite';
    if (!getenv('WOMPI_DB_PATH') && $legacyPath !== $path && is_file($legacyPath)) {
        throw new RuntimeException('Existe una base de pagos en la ubicación anterior. Configura WOMPI_DB_PATH para conservar las suscripciones antes de actualizar.');
    }
    $database = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $database->exec('PRAGMA busy_timeout = 5000');
    $database->exec('PRAGMA journal_mode = WAL');
    $database->exec('CREATE TABLE IF NOT EXISTS subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vehicle TEXT NOT NULL,
        plan TEXT NOT NULL,
        amount_in_cents INTEGER NOT NULL,
        full_name TEXT NOT NULL,
        customer_email TEXT NOT NULL,
        payment_source_id INTEGER NOT NULL,
        payment_source_type TEXT NOT NULL,
        status TEXT NOT NULL,
        next_charge_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )');
    $database->exec('CREATE TABLE IF NOT EXISTS subscription_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subscription_id INTEGER NOT NULL,
        reference TEXT NOT NULL UNIQUE,
        transaction_id TEXT,
        amount_in_cents INTEGER NOT NULL,
        status TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(subscription_id) REFERENCES subscriptions(id)
    )');
    $database->exec('CREATE TABLE IF NOT EXISTS checkout_requests (
        id TEXT PRIMARY KEY,
        vehicle TEXT NOT NULL,
        plan TEXT NOT NULL,
        acceptance TEXT NOT NULL,
        personal TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        claimed INTEGER NOT NULL DEFAULT 0,
        token_hash TEXT UNIQUE
    )');
    $checkoutColumns = $database->query('PRAGMA table_info(checkout_requests)')->fetchAll(PDO::FETCH_COLUMN, 1);
    if (!in_array('reference', $checkoutColumns, true)) {
        $database->exec('ALTER TABLE checkout_requests ADD COLUMN reference TEXT');
    }
    $database->exec('CREATE UNIQUE INDEX IF NOT EXISTS checkout_requests_reference ON checkout_requests(reference)');
    return $database;
}

function wompi_next_charge(string $plan, ?DateTimeImmutable $from = null): string
{
    $months = [
        'mensual' => 1,
        'bimestral' => 2,
        'trimestral' => 3,
        'semestral' => 6,
        'anual' => 12,
    ];
    $date = $from ?: new DateTimeImmutable('now', new DateTimeZone('America/Bogota'));
    // Clamp month ends: January 31 + one month must not become March.
    $target = $date->modify('first day of this month')->modify('+' . ($months[$plan] ?? 1) . ' months');
    return $target->setDate((int) $target->format('Y'), (int) $target->format('m'), min((int) $date->format('d'), (int) $target->format('t')))->format('Y-m-d H:i:s');
}

// API responses, webhooks and reconciliation share one atomic transition.
function wompi_record_transaction(PDO $database, array $transaction): void
{
    $status = (string) ($transaction['status'] ?? '');
    if (!in_array($status, ['PENDING', 'APPROVED', 'DECLINED', 'ERROR', 'VOIDED'], true)
        || empty($transaction['id']) || empty($transaction['reference'])) {
        throw new RuntimeException('Respuesta de transacción incompleta.');
    }
    $database->exec('BEGIN IMMEDIATE');
    try {
        $query = $database->prepare('SELECT p.*, s.plan, s.next_charge_at, s.status AS subscription_status FROM subscription_payments p JOIN subscriptions s ON s.id = p.subscription_id WHERE p.reference = ?');
        $query->execute([$transaction['reference']]);
        $payment = $query->fetch(PDO::FETCH_ASSOC);
        if (!$payment) {
            $database->exec('COMMIT');
            return;
        }
        if (($transaction['currency'] ?? '') !== 'COP'
            || (int) ($transaction['amount_in_cents'] ?? 0) !== (int) $payment['amount_in_cents']
            || (!empty($payment['transaction_id']) && $payment['transaction_id'] !== (string) $transaction['id'])) {
            throw new RuntimeException('La transacción no coincide con el pedido.');
        }
        // Ignore duplicate and out-of-order notifications of terminal payments.
        if ($payment['status'] !== 'PENDING') {
            $database->exec('COMMIT');
            return;
        }
        $database->prepare('UPDATE subscription_payments SET status = ?, transaction_id = ? WHERE id = ?')->execute([$status, (string) $transaction['id'], $payment['id']]);
        $latest = $database->prepare('SELECT MAX(id) FROM subscription_payments WHERE subscription_id = ?');
        $latest->execute([$payment['subscription_id']]);
        if ((int) $latest->fetchColumn() === (int) $payment['id'] && $payment['subscription_status'] !== 'cancelled') {
            $next = $payment['next_charge_at'];
            $subscriptionStatus = $payment['kind'] === 'initial' ? 'pending' : 'processing';
            if ($status === 'APPROVED') {
                $subscriptionStatus = 'active';
                // Start the paid period on approval, avoiding catch-up charges.
                $next = wompi_next_charge($payment['plan']);
            } elseif ($status !== 'PENDING') {
                $subscriptionStatus = 'past_due';
            }
            $database->prepare('UPDATE subscriptions SET status = ?, next_charge_at = ?, updated_at = ? WHERE id = ?')->execute([$subscriptionStatus, $next, (new DateTimeImmutable('now', new DateTimeZone('America/Bogota')))->format('Y-m-d H:i:s'), $payment['subscription_id']]);
        }
        $database->exec('COMMIT');
    } catch (Throwable $error) {
        $database->exec('ROLLBACK');
        throw $error;
    }
}

function wompi_acceptance(string $baseUrl, string $publicKey): array
{
    $result = wompi_request('GET', $baseUrl . '/merchants/info', null, ['x-merchant-public-key: ' . $publicKey]);
    $data = $result['body']['data'] ?? [];
    $acceptance = $data['presigned_acceptance'] ?? [];
    $personal = $data['presigned_personal_data_auth'] ?? [];
    if ($result['status'] < 200 || $result['status'] >= 300 || empty($acceptance['acceptance_token']) || empty($personal['acceptance_token']) || empty($acceptance['permalink']) || empty($personal['permalink'])) {
        throw new RuntimeException('Wompi no entregó los tokens de aceptación requeridos.');
    }
    return [$acceptance, $personal];
}

function wompi_html_result(int $status, string $title, string $message): void
{
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store');
    http_response_code($status);
    $safeTitle = htmlspecialchars($title, ENT_QUOTES, 'UTF-8');
    $safeMessage = htmlspecialchars($message, ENT_QUOTES, 'UTF-8');
    echo '<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' . $safeTitle . ' | MotorBaldi</title><style>body{margin:0;background:#080b0d;color:#f3f1ec;font:16px/1.5 system-ui;display:grid;place-items:center;min-height:100vh;padding:24px}main{max-width:560px}h1{font-size:42px;line-height:1}p{color:#aab1b5}a{color:#fff}</style><main><h1>' . $safeTitle . '</h1><p>' . $safeMessage . '</p><a href="/precios">Volver a precios</a></main></html>';
    exit;
}
