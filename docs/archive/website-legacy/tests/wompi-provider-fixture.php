<?php
// Offline Wompi double, loaded ONLY by the test server via auto_prepend_file.
// No card data or real credentials are used and no requests leave this process.
foreach (['CURLOPT_CUSTOMREQUEST', 'CURLOPT_RETURNTRANSFER', 'CURLOPT_CONNECTTIMEOUT', 'CURLOPT_TIMEOUT', 'CURLOPT_HTTPHEADER', 'CURLOPT_POSTFIELDS', 'CURLINFO_HTTP_CODE'] as $index => $name) {
    define($name, $index + 1);
}
function curl_init($url) { return (object) ['url' => $url, 'options' => [], 'status' => 200]; }
function curl_setopt_array($curl, $options) { $curl->options = $options; return true; }
function curl_error($curl) { return ''; }
function curl_getinfo($curl, $option) { return $curl->status; }
function curl_close($curl) {}
function curl_exec($curl) {
    $path = getenv('WOMPI_FIXTURE_PATH');
    $state = json_decode(file_get_contents($path), true);
    $body = json_decode($curl->options[CURLOPT_POSTFIELDS] ?? '{}', true);
    if (strpos($curl->url, '/tokens/keys/tokenization') !== false) {
        return json_encode(['data' => ['publicKey' => "-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----"]]);
    }
    if (strpos($curl->url, '/merchants/info') !== false) {
        return json_encode(['data' => [
            'presigned_acceptance' => ['acceptance_token' => 'acceptance', 'permalink' => 'https://wompi.co/terms.pdf'],
            'presigned_personal_data_auth' => ['acceptance_token' => 'personal', 'permalink' => 'https://wompi.co/personal.pdf'],
        ]]);
    }
    if (substr($curl->url, -16) === '/payment_sources') {
        $state['sources']++;
        file_put_contents($path, json_encode($state));
        return json_encode(['data' => ['id' => $state['sources'], 'status' => 'AVAILABLE']]);
    }
    if (($curl->options[CURLOPT_CUSTOMREQUEST] ?? '') === 'POST') {
        $state['charges']++;
        $body['id'] = 'test-' . $state['charges'];
        $body['status'] = $state['next_status'];
        $state['transactions'][$body['id']] = $body;
        file_put_contents($path, json_encode($state));
        if (!empty($state['fail_after_charge'])) { return false; }
        return json_encode(['data' => $body]);
    }
    $id = basename($curl->url);
    if (!isset($state['transactions'][$id])) { $curl->status = 404; }
    return json_encode(['data' => $state['transactions'][$id] ?? []]);
}
