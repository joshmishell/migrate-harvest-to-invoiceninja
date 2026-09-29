<?php
/*
 * Harvest time report -> Invoice Ninja tasks (one task per Harvest time entry)
 *
 *   php import_time.php harvest_time_report.csv              dry run, creates nothing
 *   php import_time.php harvest_time_report.csv --limit=3    create just 3, to eyeball in the app
 *   php import_time.php harvest_time_report.csv --live       create everything
 *
 * Kept ACTIVE: billable, not-yet-invoiced entries on your current (active) projects = real unbilled work.
 * Everything else is created and then ARCHIVED (already invoiced, non-billable, or on old projects).
 * Resumable: finished rows are recorded in import_time_done.txt; re-running skips them.
 */
(@include __DIR__ . '/config.php') || exit("Copy config.example.php to config.php and fill it in first.\n");
const TZ         = TIMEZONE;
const STATE_FILE = 'import_time_done.txt';

$args  = array_slice($argv, 1);
$live  = in_array('--live', $args, true);
$limit = 0;
foreach ($args as $a) if (preg_match('/^--limit=(\d+)$/', $a, $m)) { $limit = (int)$m[1]; $live = true; }
$file  = current(array_filter($args, fn($a) => $a[0] !== '-'));
if (!$file || !is_readable($file)) exit("Usage: php import_time.php <file.csv> [--limit=N | --live]\n");
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


// --- lookups ---
echo "Reading clients and projects...\n";
$clients = []; foreach (fetch_all('clients') as $c) $clients[norm($c['name'])] = $c['id'];
$projects = []; $projectActive = [];
foreach (fetch_all('projects') as $p) {
    $k = $p['client_id'] . '|' . norm($p['name']);
    $projects[$k] = $p['id'];
    $projectActive[$k] = empty($p['archived_at']);
}

// --- resume state: "rowIndex,taskId,archive(0/1),archivedDone(0/1)" ---
$done = [];
if (file_exists(STATE_FILE)) foreach (file(STATE_FILE, FILE_IGNORE_NEW_LINES) as $line) {
    [$i, $id, $arch] = explode(',', $line) + [null, null, '0'];
    $done[(int)$i] = ['id' => $id, 'archive' => $arch === '1'];
}
$state = $live ? fopen(STATE_FILE, 'a') : null;

// --- read CSV ---
$fh = fopen($file, 'r');
$header = array_map('clean', fgetcsv($fh));
$rows = [];
while (($r = fgetcsv($fh)) !== false) if (count($r) >= count($header)) $rows[] = array_combine($header, $r);
fclose($fh);

$tz = new DateTimeZone(TZ);
$stats = ['internal' => 0, 'already' => 0, 'active' => 0, 'archive' => 0, 'failed' => 0];
$missing = []; $created = 0;

foreach ($rows as $i => $r) {
    $clientName = clean($r['Client']);
    if (in_array(norm($clientName), SKIP_CLIENTS, true)) { $stats['internal']++; continue; }
    if (isset($done[$i])) { $stats['already']++; continue; }

    $cid = $clients[norm($clientName)] ?? null;
    $pk  = $cid ? $cid . '|' . norm(clean($r['Project'])) : null;
    $pid = $pk ? ($projects[$pk] ?? null) : null;
    if (!$pid) { $missing["$clientName / " . clean($r['Project'])] = ($missing["$clientName / " . clean($r['Project'])] ?? 0) + 1; continue; }

    $hours    = num($r['Hours Rounded']);
    $billable = strcasecmp($r['Billable?'], 'Yes') === 0;
    $invoiced = strcasecmp($r['Invoiced?'], 'Yes') === 0;
    $keepActive = $billable && !$invoiced && ($projectActive[$pk] ?? false);

    $start = (new DateTime($r['Date'] . ' 09:00:00', $tz))->getTimestamp();
    $end   = $start + (int)round($hours * 3600);
    $notes = clean($r['Notes']);
    $desc  = clean($r['Task']) . ($notes !== '' ? ' — ' . $notes : '');
    if ($invoiced) $desc .= "\n[Invoiced in Harvest]";

    $payload = [
        'client_id'   => $cid,
        'project_id'  => $pid,
        'description' => $desc,
        'rate'        => num($r['Billable Rate']),
        'time_log'    => json_encode([[$start, $end, $notes, $billable]]),
    ];

    if ($live && $limit && $created >= $limit) break;
    $stats[$keepActive ? 'active' : 'archive']++;
    if (!$live) continue;

    [$code, $json, $err] = api('POST', '/tasks', $payload);
    if ($code >= 200 && $code < 300 && !empty($json['data']['id'])) {
        $id = $json['data']['id'];
        fwrite($state, "$i,$id," . ($keepActive ? '0' : '1') . "\n");
        $done[$i] = ['id' => $id, 'archive' => !$keepActive];
        $created++;
        if ($created % 100 === 0) echo "  $created created...\n";
    } else {
        $stats['failed']++;
        file_put_contents('import_time_failures.log', "row $i [{$r['Date']} $clientName] HTTP $code: $err\n", FILE_APPEND);
        if ($stats['failed'] <= 3) echo "  ! row $i failed (HTTP $code): $err\n";
    }
    usleep(100000);
}
if ($state) fclose($state);

// --- archive, then verify and retry ---
if ($live && !$limit) {
    $toArchive = array_values(array_map(fn($d) => $d['id'], array_filter($done, fn($d) => $d['archive'])));
    for ($pass = 1; $pass <= 10 && $toArchive; $pass++) {
        echo "Archive pass $pass: " . count($toArchive) . " tasks...\n";
        foreach (array_chunk($toArchive, 25) as $chunk) {
            [$code, , $err] = api('POST', '/tasks/bulk', ['action' => 'archive', 'ids' => $chunk]);
            if ($code < 200 || $code >= 300) echo "  ! batch failed (HTTP $code): $err\n";
            usleep(200000);
        }
        sleep(3);
        $stillActive = [];
        foreach (fetch_all('tasks') as $t) if (empty($t['archived_at'])) $stillActive[$t['id']] = true;
        $toArchive = array_values(array_filter($toArchive, fn($id) => isset($stillActive[$id])));
    }
    echo $toArchive ? "  ! " . count($toArchive) . " tasks still not archived — re-run the same command.\n" : "All archiving verified.\n";
}

echo "\n==== " . ($live ? ($limit ? "TEST: created $created" : 'DONE') : 'DRY RUN — nothing created') . " ====\n";
echo "Rows in file:                 " . count($rows) . "\n";
echo "Skipped (internal FS time):   {$stats['internal']}\n";
echo "Skipped (done in earlier run): {$stats['already']}\n";
echo "Stay ACTIVE (unbilled WIP):   {$stats['active']}\n";
echo "Created then ARCHIVED:        {$stats['archive']}\n";
if ($live) echo "Failed:                       {$stats['failed']}" . ($stats['failed'] ? "  (see import_time_failures.log)" : '') . "\n";
if ($missing) { echo "\nNo matching project in Invoice Ninja:\n"; foreach ($missing as $k => $n) echo "  - $k ($n entries)\n"; }
