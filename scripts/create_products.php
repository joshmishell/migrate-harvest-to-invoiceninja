<?php
/*
 * Adds your Harvest task types as Products, so they show up in the "Service" picker on invoice lines.
 * Archives the "Sales Tax" product the invoice import created (old invoices keep their lines).
 *   php create_products.php          dry run
 *   php create_products.php --live   apply
 */
(@include __DIR__ . '/config.php') || exit("Copy config.example.php to config.php and fill it in first.\n");
const TYPES = ['Production Design', 'Creative', 'Web Development', 'Client Meeting', 'Project Management',
               'Art Direction', 'Concepting', 'Copywriting', 'Photography', 'Research', 'Video Development', 'Admin', 'Services'];
const ARCHIVE = ['Sales Tax'];
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


$existing = [];
foreach (fetch_all('products') as $p) $existing[strtolower(trim($p['product_key']))] = $p;

foreach (TYPES as $t) {
    if (isset($existing[strtolower($t)])) { echo "  exists   $t\n"; continue; }
    echo "  " . ($live ? 'created ' : 'would add') . " $t\n";
    if ($live) { [$code, , $err] = api('POST', '/products', ['product_key' => $t, 'notes' => $t, 'price' => 0, 'quantity' => 1]); if ($code >= 300) echo "    ! failed (HTTP $code): $err\n"; }
}
foreach (ARCHIVE as $a) {
    $p = $existing[strtolower($a)] ?? null;
    if (!$p || !empty($p['archived_at'])) continue;
    echo "  " . ($live ? 'archived' : 'would archive') . " $a\n";
    if ($live) api('POST', '/products/bulk', ['action' => 'archive', 'ids' => [$p['id']]]);
}
