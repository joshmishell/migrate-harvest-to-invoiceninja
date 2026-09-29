<?php
/*
 * Sets country = United States and currency = USD on every client that doesn't have them,
 * so ACH shows up as a payment option for everyone.
 *   php set_client_country.php          dry run
 *   php set_client_country.php --live   apply
 */
(@include __DIR__ . '/config.php') || exit("Copy config.example.php to config.php and fill it in first.\n");
const US  = '840';   // Invoice Ninja country id for United States
const USD = '1';     // Invoice Ninja currency id for US Dollar
$live = in_array('--live', array_slice($argv, 1), true);
// --- API token (typed, not echoed) ---
$token = getenv('IN_TOKEN');
if (!$token) {
    echo "Invoice Ninja API token: ";
    system('stty -echo'); $token = trim(fgets(STDIN)); system('stty echo'); echo "\n";
}

function api(string $method, string $path, ?array $body = null): array {
    global $token;
    $ch = curl_init(BASE_URL . '/api/v1' . $path);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST  => $method,
        CURLOPT_TIMEOUT        => 60,
        CURLOPT_HTTPHEADER     => [
            'X-API-TOKEN: ' . $token,
            'X-Requested-With: XMLHttpRequest',
            'Content-Type: application/json',
            'Accept: application/json',
        ],
    ]);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    $raw  = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err  = curl_error($ch);
    curl_close($ch);
    return [$code, json_decode($raw ?: 'null', true), $err ?: substr((string)$raw, 0, 300)];
}

function fetch_all(string $entity): array {
    $out = []; $page = 1;
    do {
        [$code, $json, $err] = api('GET', "/$entity?per_page=500&page=$page&status=active,archived");
        if ($code !== 200) exit("Could not read $entity (HTTP $code): $err\nCheck the token and URL.\n");
        $out = array_merge($out, $json['data'] ?? []);
        $pages = $json['meta']['pagination']['total_pages'] ?? 1;
    } while ($page++ < $pages);
    return $out;
}

function norm(string $s): string {
    $s = str_replace(["\u{FEFF}", "\u{2019}", "\u{2018}", "\u{00A0}"], ['', "'", "'", ' '], $s);
    return strtolower(preg_replace('/\s+/', ' ', trim($s)));
}
function clean(string $s): string {
    return trim(str_replace(["\u{FEFF}", "\u{00A0}"], ['', ' '], $s));
}
function num(string $s): float { return (float)str_replace([',', '$'], '', $s); }


$set = 0; $ok = 0; $other = [];
foreach (fetch_all('clients') as $c) {
    $country  = (string)($c['country_id'] ?? '');
    $currency = (string)($c['settings']['currency_id'] ?? '');
    $needCountry  = $country === '' || $country === '0';
    $needCurrency = $currency === '' || $currency === '0';
    if (!$needCountry && $country !== US) $other[] = "{$c['name']} (country id $country)";
    if (!$needCountry && !$needCurrency) { $ok++; continue; }
    $set++;
    if (!$live) continue;
    if ($needCountry)  $c['country_id'] = US;
    if ($needCurrency) $c['settings'] = array_merge((array)($c['settings'] ?? []), ['currency_id' => USD]);
    [$code, $json, $err] = api('PUT', "/clients/{$c['id']}", $c);
    if ($code < 200 || $code >= 300) echo "  ! {$c['name']} failed (HTTP $code): $err\n";
    elseif ($needCountry && (string)($json['data']['country_id'] ?? '') !== US) echo "  ! {$c['name']}: server didn't keep the country\n";
    usleep(100000);
}
echo ($live ? 'Updated' : 'Would update') . ": $set   Already set: $ok\n";
if ($other) echo "Left alone (already set to another country):\n  " . implode("\n  ", $other) . "\n";
