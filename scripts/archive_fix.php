<?php
/*
 * Archives any project from a Harvest CSV that is still active in Invoice Ninja.
 *   php archive_fix.php harvest_project_list_archived.csv          (report only)
 *   php archive_fix.php harvest_project_list_archived.csv --live   (archive them)
 */
(@include __DIR__ . '/config.php') || exit("Copy config.example.php to config.php and fill it in first.\n");
$args = array_slice($argv, 1);
$live = in_array('--live', $args, true);
$file = current(array_filter($args, fn($a) => $a[0] !== '-'));
if (!$file || !is_readable($file)) exit("Usage: php archive_fix.php <file.csv> [--live]\n");
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


function load_projects(): array {
    global $clientsById;
    $out = [];
    foreach (fetch_all('projects') as $p) {
        $out[$p['client_id'] . '|' . norm($p['name'])] = $p;
    }
    return $out;
}

$clients = [];
foreach (fetch_all('clients') as $c) $clients[norm($c['name'])] = $c['id'];

$fh = fopen($file, 'r');
$header = array_map('clean', fgetcsv($fh));
$wanted = [];
while (($r = fgetcsv($fh)) !== false) {
    if (count($r) < count($header)) continue;
    $r = array_combine($header, $r);
    $cid = $clients[norm(clean($r['Client']))] ?? null;
    if ($cid) $wanted[$cid . '|' . norm(clean($r['Project']))] = true;
}
fclose($fh);

for ($pass = 1; $pass <= 10; $pass++) {
    $projects = load_projects();
    $found = 0; $archived = 0; $todo = [];
    foreach ($wanted as $k => $_) {
        if (!isset($projects[$k])) continue;
        $found++;
        if (!empty($projects[$k]['archived_at'])) $archived++; else $todo[] = $projects[$k]['id'];
    }
    echo "Pass $pass: $found of " . count($wanted) . " projects found, $archived archived, " . count($todo) . " still active.\n";
    if (!$todo || !$live) break;
    foreach (array_chunk($todo, 20) as $i => $chunk) {
        [$code, $json, $err] = api('POST', '/projects/bulk', ['action' => 'archive', 'ids' => $chunk]);
        if ($code < 200 || $code >= 300) echo "  ! batch " . ($i + 1) . " failed (HTTP $code): $err\n";
        usleep(300000);
    }
    sleep(3);
}
if (!$live) echo "Report only. Add --live to archive them.\n";
