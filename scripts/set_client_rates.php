<?php
/*
 * Sets each client's default task rate to the last billable rate you used for them in Harvest,
 * so new time you log for that client is billed at the right rate automatically.
 *   php set_client_rates.php harvest_time_report.csv          dry run
 *   php set_client_rates.php harvest_time_report.csv --live   apply
 */
(@include __DIR__ . '/config.php') || exit("Copy config.example.php to config.php and fill it in first.\n");
$args = array_slice($argv, 1);
$live = in_array('--live', $args, true);
$file = current(array_filter($args, fn($a) => $a[0] !== '-'));
if (!$file || !is_readable($file)) exit("Usage: php set_client_rates.php <harvest_time_report.csv> [--live]\n");
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


// latest billable rate per client
$fh = fopen($file, 'r'); $h = array_map('clean', fgetcsv($fh)); $latest = [];
while (($r = fgetcsv($fh)) !== false) {
    if (count($r) < count($h)) continue; $r = array_combine($h, $r);
    $rate = num($r['Billable Rate']);
    if (strcasecmp($r['Billable?'], 'Yes') !== 0 || $rate <= 0) continue;
    $k = norm(clean($r['Client']));
    if (!isset($latest[$k]) || $r['Date'] >= $latest[$k]['date']) $latest[$k] = ['date' => $r['Date'], 'rate' => $rate];
}
fclose($fh);

$set = 0; $same = 0; $none = [];
foreach (fetch_all('clients') as $c) {
    $k = norm($c['name']);
    if (!isset($latest[$k])) { $none[] = $c['name']; continue; }
    $rate = $latest[$k]['rate'];
    $current = (float)($c['settings']['default_task_rate'] ?? 0);
    if (abs($current - $rate) < 0.001) { $same++; continue; }
    printf("  %-45s %s -> $%s  (last used %s)\n", mb_substr($c['name'], 0, 45), $current ? '$' . $current : '(none)', $rate, $latest[$k]['date']);
    if (!$live) { $set++; continue; }
    $c['settings'] = array_merge((array)($c['settings'] ?? []), ['default_task_rate' => $rate]);
    [$code, , $err] = api('PUT', "/clients/{$c['id']}", $c);
    if ($code >= 200 && $code < 300) $set++; else echo "  ! {$c['name']} failed (HTTP $code): $err\n";
    usleep(100000);
}
echo "\n" . ($live ? "Updated" : "Would update") . ": $set   Already correct: $same   No billable history: " . count($none) . "\n";
