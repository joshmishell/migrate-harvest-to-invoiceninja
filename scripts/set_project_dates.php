<?php
/*
 * set_project_dates.php  v1.0  (2026-10-02)
 *
 * Gives imported projects a real "created" date instead of the import day.
 * Invoice Ninja's API can't change created dates, so this writes to the database directly
 * (same login Invoice Ninja uses, read from its .env). It only ever moves a date EARLIER,
 * so projects you've made in Invoice Ninja since the switch are never touched.
 *
 * Where each date comes from, best first:
 *   1. harvest   — the project's real creation date from Harvest (projects.json from harvest_export.php)
 *   2. time      — the first time entry logged on the project
 *   3. invoice   — the first invoice for the project
 *   (whichever of 2 and 3 is earlier, when Harvest's date isn't available)
 *
 *   php set_project_dates.php                                   dry run: shows what would change
 *   php set_project_dates.php --harvest=harvest_export/2026-09-29/projects.json
 *   php set_project_dates.php --harvest=... --live              apply (writes an undo file first)
 *   php set_project_dates.php --undo=project_dates_undo_2026-10-02_1215.csv   put the old dates back
 */

const APP_DIR = __DIR__ . '/../public_html';
date_default_timezone_set('UTC');

$opts = [];
foreach (array_slice($argv, 1) as $a) { if (preg_match('/^--([a-z]+)(?:=(.*))?$/', $a, $m)) $opts[$m[1]] = $m[2] ?? true; }
$live = !empty($opts['live']);

// ---------- database (Invoice Ninja's own .env) ----------
$env = [];
foreach (file(APP_DIR . '/.env', FILE_IGNORE_NEW_LINES) ?: [] as $line) {
    $line = trim($line);
    if ($line === '' || $line[0] === '#' || !str_contains($line, '=')) continue;
    [$k, $v] = explode('=', $line, 2); $env[trim($k)] = trim(trim($v), "\"'");
}
if (empty($env['DB_DATABASE'])) exit("Can't read the database settings from " . APP_DIR . "/.env\n");
$pdo = getenv('FS_TEST_DSN') ? new PDO(getenv('FS_TEST_DSN'), null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]) : new PDO(sprintf('mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4', $env['DB_HOST'] ?? 'localhost', $env['DB_PORT'] ?? '3306', $env['DB_DATABASE']),
    $env['DB_USERNAME'] ?? '', $env['DB_PASSWORD'] ?? '', [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);

// ---------- undo ----------
if (!empty($opts['undo'])) {
    $f = fopen($opts['undo'], 'r') or exit("Can't open {$opts['undo']}\n");
    fgetcsv($f); $n = 0;
    $st = $pdo->prepare('UPDATE projects SET created_at = ? WHERE id = ?');
    while ($r = fgetcsv($f)) { $st->execute([$r[3], $r[0]]); $n++; }
    exit("Restored $n project dates.\n");
}

// ---------- Harvest's real dates ----------
$harvest = [];   // CODE|name -> 'Y-m-d H:i:s'
if (!empty($opts['harvest'])) {
    $hp = json_decode(@file_get_contents($opts['harvest']) ?: 'null', true);
    if (!is_array($hp)) exit("Can't read {$opts['harvest']} — point --harvest at the projects.json from your Harvest export.\n");
    foreach ($hp as $p) {
        if (empty($p['created_at'])) continue;
        $d = date('Y-m-d H:i:s', strtotime($p['created_at']));
        $code = strtoupper(trim($p['code'] ?? ''));
        if ($code !== '') $harvest['code:' . $code][] = ['name' => trim($p['name'] ?? ''), 'd' => $d];
        $harvest['name:' . mb_strtolower(trim($p['name'] ?? '')) . '|' . mb_strtolower(trim($p['client']['name'] ?? ''))] = [['name' => $p['name'] ?? '', 'd' => $d]];
    }
    echo count($hp) . " Harvest projects read.\n";
} else {
    echo "No --harvest file given: using first time entry / first invoice only.\n";
}

// ---------- Invoice Ninja projects + first time entry + first invoice ----------
$projects = $pdo->query('SELECT p.id, p.number, p.name, p.created_at, c.name AS client FROM projects p LEFT JOIN clients c ON c.id = p.client_id')->fetchAll();
$firstInvoice = [];
foreach ($pdo->query("SELECT project_id, MIN(`date`) AS d FROM invoices WHERE project_id IS NOT NULL AND `date` IS NOT NULL GROUP BY project_id") as $r) $firstInvoice[$r['project_id']] = $r['d'] . ' 12:00:00';
$firstTime = [];
foreach ($pdo->query("SELECT project_id, time_log FROM tasks WHERE project_id IS NOT NULL AND time_log IS NOT NULL AND time_log <> '[]'") as $r) {
    foreach (json_decode($r['time_log'], true) ?: [] as $e) {
        if (empty($e[0]) || $e[0] < 946684800) continue;           // ignore empty / pre-2000 junk
        $d = date('Y-m-d H:i:s', (int)$e[0]);
        if (!isset($firstTime[$r['project_id']]) || $d < $firstTime[$r['project_id']]) $firstTime[$r['project_id']] = $d;
    }
}

$changes = []; $why = ['harvest' => 0, 'time' => 0, 'invoice' => 0]; $skipped = 0;
foreach ($projects as $p) {
    $new = null; $src = '';
    $code = strtoupper(trim((string)$p['number']));       // e.g. ACME-1035; duplicates were imported as ACME-1005-2
    $cands = $code === '' ? [] : ($harvest['code:' . $code] ?? $harvest['code:' . preg_replace('/^(.+?-\d+)-\d+$/', '$1', $code)] ?? []);
    if (count($cands) > 1) $cands = array_values(array_filter($cands, fn($c) => mb_strtolower($c['name']) === mb_strtolower(trim($p['name'])))) ?: $cands;
    if (!$cands) $cands = $harvest['name:' . mb_strtolower(trim($p['name'])) . '|' . mb_strtolower(trim((string)$p['client']))] ?? [];
    if ($cands) { $new = $cands[0]['d']; $src = 'harvest'; }
    else {
        $t = $firstTime[$p['id']] ?? null; $i = $firstInvoice[$p['id']] ?? null;
        if ($t && (!$i || $t <= $i)) { $new = $t; $src = 'time'; } elseif ($i) { $new = $i; $src = 'invoice'; }
    }
    if (!$new || $new >= $p['created_at']) { $skipped++; continue; }   // only ever move earlier
    $changes[] = [$p['id'], $p['number'], $p['name'], $p['created_at'], $new, $src];
    $why[$src]++;
}

printf("\n%d projects would get an earlier date (%d from Harvest, %d from first time entry, %d from first invoice). %d left as they are.\n\n",
    count($changes), $why['harvest'], $why['time'], $why['invoice'], $skipped);
foreach (array_slice($changes, 0, 25) as $c) printf("  %-16s %-40s %s -> %s  (%s)\n", $c[1], mb_strimwidth($c[2], 0, 40, '…'), substr($c[3], 0, 10), substr($c[4], 0, 10), $c[5]);
if (count($changes) > 25) echo "  … and " . (count($changes) - 25) . " more\n";

if (!$live) { echo "\nDry run — nothing changed. Add --live to apply.\n"; exit(0); }

$undo = __DIR__ . '/project_dates_undo_' . date('Y-m-d_Hi') . '.csv';
$f = fopen($undo, 'w'); fputcsv($f, ['id', 'number', 'name', 'old_created_at', 'new_created_at', 'source']);
foreach ($changes as $c) fputcsv($f, $c);
fclose($f);
$st = $pdo->prepare('UPDATE projects SET created_at = ? WHERE id = ?');
$pdo->beginTransaction();
foreach ($changes as $c) $st->execute([$c[4], $c[0]]);
$pdo->commit();
echo "\nUpdated " . count($changes) . " projects. To put the old dates back:\n  php set_project_dates.php --undo=" . basename($undo) . "\n";
