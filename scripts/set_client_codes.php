<?php
/*
 * Fills each client's "ID Number" field with its client code (ACME, GLOBEX, INITECH...),
 * taken from the code most used on that client's existing projects.
 * Clients that already have an ID Number are left alone.
 *   php set_client_codes.php          dry run: lists every client and the code it would get
 *   php set_client_codes.php --live   save them
 */
(@include __DIR__ . '/config.php') || exit("Copy config.example.php to config.php and fill it in first.\n");
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


$count = [];
foreach (fetch_all('projects') as $p)
    if (preg_match('/^(.+?)-(\d+)(?:-\d+)?$/', $p['number'] ?? '', $m) && stripos($p['number'], 'TEMP-') !== 0)
        $count[$p['client_id']][strtoupper($m[1])] = ($count[$p['client_id']][strtoupper($m[1])] ?? 0) + 1;

$set = 0; $kept = 0; $none = [];
foreach (fetch_all('clients') as $c) {
    if (trim($c['id_number'] ?? '') !== '') { $kept++; continue; }
    if (empty($count[$c['id']])) { $none[] = $c['name']; continue; }
    arsort($count[$c['id']]); $code = array_key_first($count[$c['id']]);
    $also = count($count[$c['id']]) > 1 ? '   (also used: ' . implode(', ', array_slice(array_keys($count[$c['id']]), 1)) . ')' : '';
    printf("  %-50s %s%s\n", mb_substr($c['name'], 0, 50), $code, $also);
    if (!$live) { $set++; continue; }
    $c['id_number'] = $code;
    [$code2, , $err] = api('PUT', "/clients/{$c['id']}", $c);
    if ($code2 >= 200 && $code2 < 300) $set++; else echo "  ! {$c['name']} failed (HTTP $code2): $err\n";
    usleep(100000);
}
echo "\n" . ($live ? 'Set' : 'Would set') . ": $set   Already had a code: $kept   No projects (set by hand): " . count($none) . "\n";
if ($none) echo "  " . implode("\n  ", $none) . "\n";
