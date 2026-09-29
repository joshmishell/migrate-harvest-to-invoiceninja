<?php
/*
 * Marks time that was already invoiced in Harvest as invoiced in Invoice Ninja,
 * so "Invoice project" never pulls it onto a new invoice again.
 *
 * Each task tagged "[Invoiced in Harvest]" is linked to an imported invoice:
 *   1. the first invoice on the same project dated on/after the time entry
 *   2. else the last invoice on that project
 *   3. else the first invoice for the same client dated on/after the entry
 *   4. else the client's last invoice
 *
 *   php link_invoiced_tasks.php            dry run
 *   php link_invoiced_tasks.php --limit=3  link 3, then check them in the app
 *   php link_invoiced_tasks.php --live     link all (safe to re-run)
 */
(@include __DIR__ . '/config.php') || exit("Copy config.example.php to config.php and fill it in first.\n");
const MARK     = '[Invoiced in Harvest]';

$args = array_slice($argv, 1);
$live = in_array('--live', $args, true); $limit = 0;
foreach ($args as $a) if (preg_match('/^--limit=(\d+)$/', $a, $m)) { $limit = (int)$m[1]; $live = true; }

$token = getenv('IN_TOKEN') ?: (is_readable(__DIR__ . '/.in_token') ? trim(file_get_contents(__DIR__ . '/.in_token')) : '');
if (!$token) { echo "Invoice Ninja API token: "; system('stty -echo'); $token = trim(fgets(STDIN)); system('stty echo'); echo "\n"; }

function api(string $method, string $path, ?array $body = null): array {
    global $token;
    $ch = curl_init(BASE_URL . '/api/v1' . $path);
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CUSTOMREQUEST => $method, CURLOPT_TIMEOUT => 60,
        CURLOPT_HTTPHEADER => ['X-API-TOKEN: ' . $token, 'X-Requested-With: XMLHttpRequest', 'Content-Type: application/json', 'Accept: application/json']]);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    $raw = curl_exec($ch); $code = curl_getinfo($ch, CURLINFO_HTTP_CODE); $err = curl_error($ch); curl_close($ch);
    return [$code, json_decode($raw ?: 'null', true), $err ?: substr((string)$raw, 0, 300)];
}
function fetch_all(string $entity): array {
    $out = []; $page = 1;
    do {
        [$code, $json, $err] = api('GET', "/$entity?per_page=500&page=$page&status=active,archived");
        if ($code !== 200) exit("Could not read $entity (HTTP $code): $err\n");
        $out = array_merge($out, $json['data'] ?? []);
        $pages = $json['meta']['pagination']['total_pages'] ?? 1;
    } while ($page++ < $pages);
    return $out;
}
function task_date(array $t): string {
    if (!empty($t['date'])) return $t['date'];
    $log = json_decode($t['time_log'] ?? '[]', true);
    return !empty($log[0][0]) ? date('Y-m-d', (int)$log[0][0]) : '0000-00-00';
}
function pick(array $list, string $date): ?array {           // $list sorted by date asc
    foreach ($list as $inv) if ($inv['date'] >= $date) return $inv;
    return $list ? end($list) : null;
}

echo "Reading tasks and invoices...\n";
$tasks = array_filter(fetch_all('tasks'), fn($t) => empty($t['invoice_id']) && str_contains($t['description'] ?? '', MARK));
$byProject = []; $byClient = [];
foreach (fetch_all('invoices') as $inv) {
    if (!empty($inv['is_deleted'])) continue;
    $row = ['id' => $inv['id'], 'number' => $inv['number'], 'date' => $inv['date'] ?? ''];
    if (!empty($inv['project_id'])) $byProject[$inv['project_id']][] = $row;
    $byClient[$inv['client_id']][] = $row;
}
foreach ([&$byProject, &$byClient] as &$group) foreach ($group as &$l) usort($l, fn($a, $b) => strcmp($a['date'], $b['date']));
unset($group, $l);

echo count($tasks) . " Harvest-invoiced tasks not yet linked.\n";
$done = 0; $none = 0; $fail = 0; $how = ['project' => 0, 'client' => 0];
foreach ($tasks as $t) {
    $d = task_date($t);
    $inv = null;
    if (!empty($t['project_id']) && !empty($byProject[$t['project_id']])) { $inv = pick($byProject[$t['project_id']], $d); $via = 'project'; }
    if (!$inv && !empty($byClient[$t['client_id']])) { $inv = pick($byClient[$t['client_id']], $d); $via = 'client'; }
    if (!$inv) { $none++; continue; }
    $how[$via]++;
    if (!$live) continue;
    if ($limit && $done >= $limit) break;

    $t['invoice_id'] = $inv['id'];
    [$code, $json, $err] = api('PUT', "/tasks/{$t['id']}", $t);
    if ($code >= 200 && $code < 300 && ($json['data']['invoice_id'] ?? '') === $inv['id']) {
        $done++;
        if ($limit) echo "  linked task {$t['number']} ($d) -> invoice {$inv['number']}\n";
        elseif ($done % 200 === 0) echo "  $done linked...\n";
    } else {
        $fail++;
        echo "  ! task {$t['number']} not linked (HTTP $code): " . ($code < 300 ? 'server ignored invoice_id' : $err) . "\n";
        if ($fail >= 3 && !$done) exit("Stopping: Invoice Ninja isn't accepting the link. Nothing else was changed.\n");
    }
    usleep(80000);
}
echo "\n" . ($live ? "Linked: $done   Failed: $fail" : "Would link: " . ($how['project'] + $how['client'])) .
     "   (by project: {$how['project']}, by client only: {$how['client']})   No invoice found: $none\n";
