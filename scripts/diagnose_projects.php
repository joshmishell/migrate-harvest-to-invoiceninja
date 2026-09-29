<?php
/* Read-only diagnostic: compares what the Projects "Archived" filter returns vs. all projects. */
(@include __DIR__ . '/config.php') || exit("Copy config.example.php to config.php and fill it in first.\n");
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


function pull(string $query): array {
    $out = []; $page = 1;
    do {
        [$code, $json, $err] = api('GET', "/projects?per_page=100&page=$page&$query");
        if ($code !== 200) exit("HTTP $code on ?$query: $err\n");
        foreach ($json['data'] ?? [] as $p) $out[$p['id']] = $p;
        $pag = $json['meta']['pagination'] ?? [];
        $pages = $pag['total_pages'] ?? 1;
        if ($page === 1) echo "?$query  -> API total: " . ($pag['total'] ?? 'n/a') . ", pages: $pages\n";
    } while ($page++ < $pages);
    echo "   fetched: " . count($out) . "\n";
    return $out;
}
$all      = pull('status=active,archived,deleted');
$archived = pull('status=archived');
$active   = pull('status=active');

$clients = [];
foreach (fetch_all('clients') as $c) $clients[$c['id']] = $c;

$missing = array_filter($all, fn($p) => !empty($p['archived_at']) && !isset($archived[$p['id']]));
echo "\nArchived per archived_at: " . count(array_filter($all, fn($p) => !empty($p['archived_at']))) . "\n";
echo "Archived but NOT returned by status=archived: " . count($missing) . "\n";

$fields = ['is_deleted','archived_at','created_at','updated_at','client_id','user_id','assigned_user_id'];
echo "\nSample returned by the Archived filter:\n";
foreach (array_slice($archived, 0, 3) as $p) { $row=[]; foreach ($fields as $f) $row[]="$f=" . json_encode($p[$f] ?? null); echo "  {$p['name']}: " . implode(' ', $row) . " client_archived=" . json_encode($clients[$p['client_id']]['archived_at'] ?? '?') . "\n"; }
echo "\nSample NOT returned:\n";
foreach (array_slice($missing, 0, 3) as $p) { $row=[]; foreach ($fields as $f) $row[]="$f=" . json_encode($p[$f] ?? null); echo "  {$p['name']}: " . implode(' ', $row) . " client_archived=" . json_encode($clients[$p['client_id']]['archived_at'] ?? '?') . "\n"; }

$dupNames = array_filter(array_count_values(array_map(fn($c) => strtolower(trim($c['name'])), $clients)), fn($n) => $n > 1);
echo "\nClients: " . count($clients) . ", duplicate client names: " . count($dupNames) . "\n";
