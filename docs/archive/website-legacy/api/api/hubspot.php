<?php

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, max-age=0');
header('X-Content-Type-Options: nosniff');

const ALLOWED_VEHICLES = ['Automóvil', 'Motocicleta', 'Otro'];
const ALLOWED_SERVICES = [
    'Mantenimiento',
    'Aceites y lubricantes',
    'Repuestos',
    'Compra y venta',
    'Asistencia vehicular',
    'Información sobre la plataforma',
    'Programa de pioneros MB-100',
    'Otra consulta',
];

// Valores internos de las opciones creadas en las propiedades desplegables de HubSpot.
const HUBSPOT_VEHICLE_VALUES = [
    'Automóvil' => 'carro',
    'Motocicleta' => 'moto',
    'Otro' => 'otro',
];

const HUBSPOT_SERVICE_VALUES = [
    'Mantenimiento' => 'mantenimiento',
    'Aceites y lubricantes' => 'aceites_lubricantes',
    'Repuestos' => 'repuestos',
    'Compra y venta' => 'compra_venta',
    'Asistencia vehicular' => 'asistencia_vehicular',
    'Información sobre la plataforma' => 'informacion_plataforma',
    'Programa de pioneros MB-100' => 'pioneros_mb100',
    'Otra consulta' => 'otra_consulta',
];

// Nombres internos exactos de las propiedades personalizadas de Negocio en HubSpot.
const HUBSPOT_PROP_VEHICLE = 'motorbaldi_tipo_vehiculo';
const HUBSPOT_PROP_SERVICE = 'motorbaldi_servicio_solicitado';
const HUBSPOT_PROP_DETAILS = 'motorbaldi_detalle_solicitud';
const HUBSPOT_PROP_ORIGIN = 'motorbaldi_origen_solicitud';

function respond(int $status, array $payload): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function string_slice(string $value, int $maxLength): string
{
    return function_exists('mb_substr')
        ? mb_substr($value, 0, $maxLength)
        : substr($value, 0, $maxLength);
}

function string_length(string $value): int
{
    return function_exists('mb_strlen') ? mb_strlen($value) : strlen($value);
}

function text_value(array $payload, string $key, int $maxLength): string
{
    $value = $payload[$key] ?? '';
    if (!is_string($value)) {
        return '';
    }

    $value = trim(preg_replace('/\s+/u', ' ', $value) ?? '');
    return string_slice($value, $maxLength);
}

function load_hubspot_config(): array
{
    $config = [];
    $candidates = [];

    // Una ruta explícita tiene prioridad si el entorno del hosting la define.
    $explicitPath = getenv('MOTORBALDI_HUBSPOT_CONFIG');
    if (is_string($explicitPath) && $explicitPath !== '') {
        $candidates[] = $explicitPath;
    }

    // Resuelve /home/USUARIO/motorbaldi-hubspot.php tanto para producción como staging:
    //   /home/USUARIO/public_html/api/hubspot.php
    //   /home/USUARIO/public_html/staging/api/hubspot.php
    $directory = __DIR__;
    while ($directory !== dirname($directory)) {
        if (basename($directory) === 'public_html') {
            $candidates[] = dirname($directory) . '/motorbaldi-hubspot.php';
            break;
        }
        $directory = dirname($directory);
    }

    $home = getenv('HOME');
    if (is_string($home) && $home !== '') {
        $candidates[] = rtrim($home, '/\\') . '/motorbaldi-hubspot.php';
    }

    foreach (array_unique($candidates) as $configPath) {
        if (!is_file($configPath)) {
            continue;
        }

        $loaded = require $configPath;
        if (is_array($loaded)) {
            $config = $loaded;
            break;
        }
    }

    return [
        'token' => getenv('MOTORBALDI_HUBSPOT_TOKEN') ?: ($config['token'] ?? ''),
        'pipeline' => getenv('MOTORBALDI_HUBSPOT_PIPELINE') ?: ($config['pipeline'] ?? 'default'),
        'stage' => getenv('MOTORBALDI_HUBSPOT_STAGE') ?: ($config['stage'] ?? '1433840728'),
        'api_base' => getenv('MOTORBALDI_HUBSPOT_API_BASE') ?: 'https://api.hubapi.com',
    ];
}

function hubspot_request(array $config, string $method, string $path, ?array $payload = null): array
{
    $handle = curl_init(rtrim((string) $config['api_base'], '/') . $path);
    if ($handle === false) {
        throw new RuntimeException('HubSpot cURL initialization failed');
    }

    $headers = [
        'Authorization: Bearer ' . $config['token'],
        'Accept: application/json',
        'Content-Type: application/json',
        'User-Agent: MotorBaldi-Web/12.2',
    ];

    curl_setopt_array($handle, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT => 15,
    ]);

    if ($payload !== null) {
        $encodedPayload = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($encodedPayload === false) {
            throw new RuntimeException('HubSpot JSON encoding failed');
        }
        curl_setopt($handle, CURLOPT_POSTFIELDS, $encodedPayload);
    }

    $body = curl_exec($handle);
    $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
    $error = curl_error($handle);

    if ($body === false || $error !== '') {
        throw new RuntimeException('HubSpot transport error: ' . ($error !== '' ? $error : 'unknown error'));
    }

    $decoded = json_decode($body, true);

    return [
        'status' => $status,
        'body' => is_array($decoded) ? $decoded : [],
    ];
}

function hubspot_failure(string $context, array $response): RuntimeException
{
    $status = (int) ($response['status'] ?? 0);
    $body = is_array($response['body'] ?? null) ? $response['body'] : [];
    $message = isset($body['message']) && is_string($body['message']) ? $body['message'] : '';
    $category = isset($body['category']) && is_string($body['category']) ? $body['category'] : '';
    $correlationId = '';

    if (isset($body['correlationId']) && is_string($body['correlationId'])) {
        $correlationId = $body['correlationId'];
    } elseif (isset($body['correlationID']) && is_string($body['correlationID'])) {
        $correlationId = $body['correlationID'];
    }

    $parts = [$context . ': HTTP ' . $status];
    if ($category !== '') {
        $parts[] = 'category=' . $category;
    }
    if ($message !== '') {
        $parts[] = 'message=' . string_slice($message, 500);
    }
    if ($correlationId !== '') {
        $parts[] = 'correlationId=' . $correlationId;
    }

    return new RuntimeException(implode(' | ', $parts));
}

function rate_limit(): void
{
    $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    $file = sys_get_temp_dir() . '/motorbaldi-form-' . hash('sha256', $ip) . '.json';
    $now = time();
    $windowStart = $now - 600;
    $handle = @fopen($file, 'c+');

    if (!$handle) {
        return;
    }

    try {
        if (!flock($handle, LOCK_EX)) {
            return;
        }

        $contents = stream_get_contents($handle);
        $attempts = json_decode($contents ?: '[]', true);
        $attempts = is_array($attempts)
            ? array_values(array_filter(
                $attempts,
                static fn ($time) => is_int($time) && $time >= $windowStart
            ))
            : [];

        if (count($attempts) >= 5) {
            respond(429, [
                'ok' => false,
                'message' => 'Demasiados intentos. Espera unos minutos y vuelve a intentarlo.',
            ]);
        }

        $attempts[] = $now;
        ftruncate($handle, 0);
        rewind($handle);
        fwrite($handle, json_encode($attempts));
        fflush($handle);
        flock($handle, LOCK_UN);
    } finally {
        fclose($handle);
    }
}

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    header('Allow: POST');
    respond(405, ['ok' => false, 'message' => 'Método no permitido.']);
}

if (!function_exists('curl_init')) {
    respond(503, ['ok' => false, 'message' => 'El servidor no tiene las extensiones necesarias.']);
}

$host = strtolower(preg_replace('/:\d+$/', '', $_SERVER['HTTP_HOST'] ?? ''));
$allowedHosts = [
    'motorbaldi.com',
    'www.motorbaldi.com',
    'staging.motorbaldi.com',
    'localhost',
    '127.0.0.1',
];

if (!in_array($host, $allowedHosts, true)) {
    respond(403, ['ok' => false, 'message' => 'Origen no permitido.']);
}

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '') {
    $originHost = strtolower((string) parse_url($origin, PHP_URL_HOST));
    if ($originHost !== $host) {
        respond(403, ['ok' => false, 'message' => 'Origen no permitido.']);
    }
}

$contentLength = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
if ($contentLength <= 0 || $contentLength > 16384) {
    respond(413, ['ok' => false, 'message' => 'Solicitud inválida.']);
}

$raw = file_get_contents('php://input');
$payload = json_decode($raw ?: '', true);
if (!is_array($payload)) {
    respond(400, ['ok' => false, 'message' => 'Solicitud inválida.']);
}

// Honeypot: para bots se responde como éxito sin enviar datos a HubSpot.
if (text_value($payload, 'company_website', 200) !== '') {
    usleep(250000);
    respond(200, ['ok' => true]);
}

rate_limit();

$name = text_value($payload, 'name', 100);
$email = strtolower(text_value($payload, 'email', 160));
$phone = text_value($payload, 'phone', 30);
$vehicle = text_value($payload, 'vehicle', 30);
$service = text_value($payload, 'service', 80);
$details = text_value($payload, 'details', 1200);
$consent = ($payload['consent'] ?? false) === true;

$errors = [];
if (string_length($name) < 2) {
    $errors['name'] = 'Ingresa tu nombre.';
}
if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    $errors['email'] = 'Ingresa un correo válido.';
}
if (!preg_match('/^\+?[0-9 ()-]{7,24}$/', $phone)) {
    $errors['phone'] = 'Ingresa un teléfono válido.';
}
if (!in_array($vehicle, ALLOWED_VEHICLES, true)) {
    $errors['vehicle'] = 'Selecciona tu vehículo.';
}
if (!in_array($service, ALLOWED_SERVICES, true)) {
    $errors['service'] = 'Selecciona un servicio.';
}
if (string_length($details) < 10) {
    $errors['details'] = 'Cuéntanos un poco más.';
}
if (!$consent) {
    $errors['consent'] = 'Debes aceptar la política de privacidad.';
}

if ($errors) {
    respond(422, [
        'ok' => false,
        'message' => 'Revisa los campos indicados.',
        'errors' => $errors,
    ]);
}

$config = load_hubspot_config();
if (!is_string($config['token']) || trim($config['token']) === '') {
    respond(503, ['ok' => false, 'message' => 'El formulario está temporalmente fuera de servicio.']);
}

$vehicleHubspotValue = HUBSPOT_VEHICLE_VALUES[$vehicle] ?? null;
$serviceHubspotValue = HUBSPOT_SERVICE_VALUES[$service] ?? null;

if ($vehicleHubspotValue === null || $serviceHubspotValue === null) {
    respond(422, ['ok' => false, 'message' => 'La selección enviada no es válida.']);
}

$parts = preg_split('/\s+/u', $name, 2) ?: [$name];
$contactProperties = [
    'email' => $email,
    'firstname' => $parts[0],
    'lastname' => $parts[1] ?? '',
    'phone' => $phone,
];

try {
    // Busca el contacto por email. Si existe, actualiza sus datos; si no, lo crea.
    $lookup = hubspot_request(
        $config,
        'GET',
        '/crm/objects/2026-03/contacts/' . rawurlencode($email) . '?idProperty=email&properties=email'
    );

    if ($lookup['status'] === 200 && isset($lookup['body']['id'])) {
        $contactId = (string) $lookup['body']['id'];
        $updated = hubspot_request(
            $config,
            'PATCH',
            '/crm/objects/2026-03/contacts/' . rawurlencode($contactId),
            ['properties' => $contactProperties]
        );

        if ($updated['status'] !== 200) {
            throw hubspot_failure('HubSpot contact update failed', $updated);
        }
    } elseif ($lookup['status'] === 404) {
        $created = hubspot_request(
            $config,
            'POST',
            '/crm/objects/2026-03/contacts',
            ['properties' => $contactProperties + ['lifecyclestage' => 'lead']]
        );

        if ($created['status'] !== 201 || !isset($created['body']['id'])) {
            throw hubspot_failure('HubSpot contact create failed', $created);
        }

        $contactId = (string) $created['body']['id'];
    } else {
        throw hubspot_failure('HubSpot contact lookup failed', $lookup);
    }

    $submittedAt = gmdate('c');

    // Cada envío crea un negocio nuevo para preservar el historial de solicitudes.
    // Los tres datos del formulario quedan tanto estructurados en propiedades
    // personalizadas como resumidos en Description para lectura rápida.
    $dealProperties = [
        'dealname' => 'Web · ' . $service . ' · ' . $name,
        'pipeline' => (string) $config['pipeline'],
        'dealstage' => (string) $config['stage'],
        HUBSPOT_PROP_VEHICLE => $vehicleHubspotValue,
        HUBSPOT_PROP_SERVICE => $serviceHubspotValue,
        HUBSPOT_PROP_DETAILS => $details,
        HUBSPOT_PROP_ORIGIN => $host,
        'description' =>
            "Vehículo: {$vehicle}\n" .
            "Servicio: {$service}\n" .
            "Detalle: {$details}\n" .
            "Origen: {$host}\n" .
            "Consentimiento de privacidad: aceptado {$submittedAt}",
    ];

    $deal = hubspot_request($config, 'POST', '/crm/objects/2026-03/deals', [
        'properties' => $dealProperties,
        'associations' => [[
            'to' => ['id' => $contactId],
            'types' => [[
                'associationCategory' => 'HUBSPOT_DEFINED',
                'associationTypeId' => 3,
            ]],
        ]],
    ]);

    if ($deal['status'] !== 201 || !isset($deal['body']['id'])) {
        throw hubspot_failure('HubSpot deal create failed', $deal);
    }

    respond(201, ['ok' => true]);
} catch (Throwable $error) {
    $reference = bin2hex(random_bytes(5));
    error_log('[MotorBaldi HubSpot ' . $reference . '] ' . $error->getMessage());

    respond(502, [
        'ok' => false,
        'message' => 'No pudimos registrar tu solicitud. Inténtalo de nuevo o escríbenos por WhatsApp.',
        'reference' => $reference,
    ]);
}
