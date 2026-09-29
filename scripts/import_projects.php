<?php
/*
 * Harvest -> Invoice Ninja project importer
 *
 * Dry run (default, creates nothing):
 *   php import_projects.php harvest_project_list.csv
 * Create for real:
 *   php import_projects.php harvest_project_list.csv --live
 * Create and archive (for the archived export):
 *   php import_projects.php harvest_project_list_archived.csv --live --archive
 *
 * Safe to re-run: projects that already exist (same client + name) are skipped.
 */

(@include __DIR__ . '/config.php') || exit("Copy config.example.php to config.php and fill it in first.\n");

$args    = array_slice($argv, 1);
$live    = in_array('--live', $args, true);
$archive = in_array('--archive', $args, true);
$file    = current(array_filter($args, fn($a) => $a[0] !== '-'));
if (!$file || !is_readable($file)) exit("Usage: php import_projects.php <file.csv> [--live] [--archive]\n");

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

// --- load existing data ---
echo "Reading clients and projects from Invoice Ninja...\n";
$clients = [];
foreach (fetch_all('clients') as $c) $clients[norm($c['name'])] = $c['id'];
$existing = []; $numbers = [];
foreach (fetch_all('projects') as $p) {
    $existing[$p['client_id'] . '|' . norm($p['name'])] = true;
    if (!empty($p['number'])) $numbers[strtolower($p['number'])] = true;
}
echo count($clients) . " clients, " . count($existing) . " existing projects.\n\n";

// --- read CSV ---
$fh = fopen($file, 'r');
$header = array_map('clean', fgetcsv($fh));
$rows = [];
while (($r = fgetcsv($fh)) !== false) {
    if (count($r) < count($header)) continue;
    $rows[] = array_combine($header, $r);
}
fclose($fh);

$missing = []; $skipped = 0; $created = []; $failed = []; $todo = 0;

foreach ($rows as $i => $r) {
    $clientName = clean($r['Client']);
    $name       = clean($r['Project']);
    if (in_array(norm($clientName), SKIP_CLIENTS, true)) { $skipped++; continue; }

    $clientId = $clients[norm($clientName)] ?? null;
    if (!$clientId) { $missing[$clientName][] = $name; continue; }
    if (isset($existing[$clientId . '|' . norm($name)])) { $skipped++; continue; }

    // project number = Harvest code (made unique if Harvest reused one)
    $number = clean($r['Project Code']);
    if ($number !== '') {
        $base = $number; $n = 2;
        while (isset($numbers[strtolower($number)])) $number = $base . '-' . $n++;
        $numbers[strtolower($number)] = true;
    }

    // hourly rate from Harvest's billable amount / billable hours
    $bh = num($r['Billable Hours']); $ba = num($r['Billable Amount']);
    $rate = $bh > 0 ? round($ba / $bh, 2) : 0;

    // Harvest history goes into private notes
    $notes = [];
    if (clean($r['Project Notes']) !== '') $notes[] = clean($r['Project Notes']);
    $hist = 'Imported from Harvest.';
    if ($r['Start Date']) $hist .= ' Start: ' . $r['Start Date'] . '.';
    if ($r['End Date'])   $hist .= ' End: ' . $r['End Date'] . '.';
    $hist .= sprintf(' Hours: %s (billable %s). Billable: $%s. Invoiced: $%s.',
        $r['Total Hours'], $r['Billable Hours'], number_format($ba, 2), number_format(num($r['Invoiced Amount']), 2));
    if ($r['Budget By'] !== '' && $r['Budget'] !== '') $hist .= ' Budget: ' . $r['Budget'] . ' (' . $r['Budget By'] . ').';
    $notes[] = $hist;

    $payload = array_filter([
        'client_id'      => $clientId,
        'name'           => $name,
        'number'         => $number ?: null,
        'task_rate'      => $rate ?: null,
        'budgeted_hours' => (strcasecmp($r['Budget By'], 'Hours') === 0 && $r['Budget'] !== '') ? num($r['Budget']) : null,
        'due_date'       => $r['End Date'] ?: null,
        'private_notes'  => implode("\n\n", $notes),
    ], fn($v) => $v !== null);

    $todo++;
    if (!$live) continue;

    [$code, $json, $err] = api('POST', '/projects', $payload);
    if ($code >= 200 && $code < 300 && !empty($json['data']['id'])) {
        $created[] = $json['data']['id'];
        $existing[$clientId . '|' . norm($name)] = true;
        echo "  + [$clientName] $name\n";
    } else {
        $failed[] = "[$clientName] $name — HTTP $code: $err";
        echo "  ! FAILED [$clientName] $name (HTTP $code)\n";
    }
    usleep(150000);
}

// --- archive ---
if ($live && $archive && $created) {
    echo "\nArchiving " . count($created) . " projects...\n";
    foreach (array_chunk($created, 100) as $chunk) {
        [$code, , $err] = api('POST', '/projects/bulk', ['action' => 'archive', 'ids' => $chunk]);
        if ($code < 200 || $code >= 300) echo "  ! archive batch failed (HTTP $code): $err\n";
    }
}

// --- report ---
echo "\n==== " . ($live ? 'DONE' : 'DRY RUN — nothing created') . " ====\n";
echo "Rows in file:            " . count($rows) . "\n";
echo ($live ? "Created:                 " . count($created) : "Would create:            $todo") . "\n";
echo "Skipped (exist/internal): $skipped\n";
if ($live) echo "Failed:                  " . count($failed) . "\n";
if ($missing) {
    echo "\nClient not found in Invoice Ninja (" . array_sum(array_map('count', $missing)) . " projects):\n";
    foreach ($missing as $c => $ps) echo "  - $c (" . count($ps) . " projects)\n";
    echo "Import or create these clients, then re-run. Existing projects will be skipped.\n";
}
if ($failed) {
    file_put_contents('import_failures.log', implode("\n", $failed) . "\n");
    echo "\nFailures written to import_failures.log\n";
}
