<?php
/*
 * Optional project-code numbering (a per-client code convention, not something Harvest does itself).
 * Runs every minute from cron.
 *
 * PROJECTS  numbered TEMP-...  ->  next code for that client, e.g. ACME-1035
 *           (prefix = the client's "ID Number" field, e.g. ACME; if that's empty,
 *            the code most used on the client's existing projects)
 * INVOICES  numbered TEMP-...  ->  the invoice's project number, then a, b, c...
 *           ACME-1035 first, then ACME-1035b, ACME-1035c (bare code counts as "a")
 *
 * Only DRAFT invoices are renamed (never one that has already been sent).
 *
 *   php auto_numbers.php --dry    show what it would rename, change nothing
 *   php auto_numbers.php          rename (this is what cron runs)
 */

(@include __DIR__ . '/config.php') || exit("Copy config.example.php to config.php and fill it in first.\n");
const TEMP       = 'TEMP-';
const TOKEN_FILE = __DIR__ . '/.in_token';

$dry = in_array('--dry', array_slice($argv, 1), true);
$token = getenv('IN_TOKEN') ?: (is_readable(TOKEN_FILE) ? trim(file_get_contents(TOKEN_FILE)) : '');
if (!$token) exit("No API token: set IN_TOKEN or create " . TOKEN_FILE . "\n");

function api(string $method, string $path, ?array $body = null): array {
    global $token;
    $ch = curl_init(BASE_URL . '/api/v1' . $path);
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CUSTOMREQUEST => $method, CURLOPT_TIMEOUT => 60,
        CURLOPT_HTTPHEADER => ['X-API-TOKEN: ' . $token, 'X-Requested-With: XMLHttpRequest', 'Content-Type: application/json', 'Accept: application/json']]);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    $raw = curl_exec($ch); $code = curl_getinfo($ch, CURLINFO_HTTP_CODE); $err = curl_error($ch); curl_close($ch);
    return [$code, json_decode($raw ?: 'null', true), $err ?: substr((string)$raw, 0, 300)];
}
function fetch_all(string $entity, string $extra = ''): array {
    $out = []; $page = 1;
    do {
        [$code, $json, $err] = api('GET', "/$entity?per_page=500&page=$page&status=active,archived$extra");
        if ($code !== 200) { logm("could not read $entity (HTTP $code): $err"); exit(1); }
        $out = array_merge($out, $json['data'] ?? []);
        $pages = $json['meta']['pagination']['total_pages'] ?? 1;
    } while ($page++ < $pages);
    return $out;
}
function logm(string $m): void {
    // warnings (lines starting with "!") are logged once, not every minute
    static $seen = null; $f = __DIR__ . '/.auto_numbers_warned';
    if ($m[0] === '!') {
        if ($seen === null) $seen = is_readable($f) ? array_flip(file($f, FILE_IGNORE_NEW_LINES)) : [];
        $k = md5($m); if (isset($seen[$k])) return;
        $seen[$k] = 1; @file_put_contents($f, "$k\n", FILE_APPEND);
    }
    echo date('Y-m-d H:i:s') . "  $m\n";
}
function is_temp(?string $n): bool { return $n !== null && stripos($n, TEMP) === 0; }
function rename_entity(string $entity, array $obj, string $new, bool $dry): bool {
    $label = rtrim($entity, 's');
    if ($dry) { logm("[dry] $label {$obj['number']} -> $new"); return true; }
    $old = $obj['number'];
    $obj['number'] = $new;
    [$code, , $err] = api('PUT', "/$entity/{$obj['id']}", $obj);
    if ($code >= 200 && $code < 300) { logm("$label $old renamed to $new"); return true; }
    logm("! $label rename to $new failed (HTTP $code): $err");
    return false;
}

// quick exit when nothing is waiting
[$c1, $pj] = api('GET', '/projects?per_page=50&status=active&filter=' . urlencode(TEMP));
[$c2, $ij] = api('GET', '/invoices?per_page=50&status=active&filter=' . urlencode(TEMP));
$tempProjects = array_values(array_filter($pj['data'] ?? [], fn($p) => is_temp($p['number'] ?? null)));
$tempInvoices = array_values(array_filter($ij['data'] ?? [], fn($i) => is_temp($i['number'] ?? null)));
if (!$tempProjects && !$tempInvoices) exit(0);

// ---------- projects ----------
$projects = fetch_all('projects');
$byId = []; $maxByPrefix = []; $prefixByClient = [];
foreach ($projects as $p) {
    $byId[$p['id']] = $p;
    if (preg_match('/^(.+?)-(\d+)(?:-\d+)?$/', $p['number'] ?? '', $m) && !is_temp($p['number'])) {
        $pre = strtoupper($m[1]);
        $maxByPrefix[$pre] = max($maxByPrefix[$pre] ?? 0, (int)$m[2]);
        $prefixByClient[$p['client_id']][$pre] = ($prefixByClient[$p['client_id']][$pre] ?? 0) + 1;
    }
}
if ($tempProjects) {
    $clients = []; foreach (fetch_all('clients') as $c) $clients[$c['id']] = $c;
    foreach ($tempProjects as $p) {
        $cid = $p['client_id'];
        if (!empty($clients[$cid]['id_number'])) $pre = strtoupper(trim($clients[$cid]['id_number']));   // client code wins
        elseif (!empty($prefixByClient[$cid])) { arsort($prefixByClient[$cid]); $pre = array_key_first($prefixByClient[$cid]); }
        else { logm("! project '{$p['name']}': client '" . ($clients[$cid]['name'] ?? $cid) . "' has no code yet — put one in the client's ID Number field"); continue; }
        $next = max(($maxByPrefix[$pre] ?? 999) + 1, 1000);
        if (rename_entity('projects', $p, "$pre-$next", $dry)) {
            $maxByPrefix[$pre] = $next;
            $byId[$p['id']]['number'] = "$pre-$next";
            $prefixByClient[$cid][$pre] = 1;
        }
    }
}

// ---------- invoices ----------
foreach ($tempInvoices as $inv) {
    if ((string)$inv['status_id'] !== '1') { logm("! invoice {$inv['number']} was sent before it could be renumbered — left as is"); continue; }
    $pid = $inv['project_id'] ?? '';
    if (!$pid || empty($byId[$pid])) { logm("! invoice {$inv['number']} has no project — pick a project on it (or type a number)"); continue; }
    $code = $byId[$pid]['number'];
    if (is_temp($code)) { logm("  invoice {$inv['number']} waits: its project has no code yet"); continue; }

    // existing invoices for this project code: CODE, CODEa, CODEb ...
    [$c, $j] = api('GET', '/invoices?per_page=500&status=active,archived&filter=' . urlencode($code));
    $used = [];
    foreach ($j['data'] ?? [] as $x)
        if (preg_match('/^' . preg_quote($code, '/') . '([a-z]*)$/i', $x['number'], $m)) $used[strtolower($m[1])] = true;
    // first invoice = bare code; the bare code counts as "a", so the next is "b", then "c"...
    if (!$used) $new = $code;
    else {
        $max = 'a';
        foreach (array_keys($used) as $sfx) { $sfx = $sfx === '' ? 'a' : $sfx; if (strlen($sfx) > strlen($max) || (strlen($sfx) == strlen($max) && $sfx > $max)) $max = $sfx; }
        $max++; $new = $code . $max;   // a..z, then aa, ab...
    }
    rename_entity('invoices', $inv, $new, $dry);
}
