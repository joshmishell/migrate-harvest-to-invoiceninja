<?php
/*
 * Full Harvest account export through the Harvest API v2 — everything the CSV exports leave out:
 * invoice LINE ITEMS, every individual PAYMENT (date, amount, method, notes), invoice email history,
 * estimates (+ their line items and PDFs), expenses (+ receipt files), rates, budgets, users, settings.
 *
 * Get a token: https://id.getharvest.com/developers -> Create new personal access token.
 * That page also shows your Account ID.
 *
 *   php harvest_export.php               asks for token + account id, exports to ./harvest_export/DATE/
 *   php harvest_export.php --no-files    skip downloading receipts and estimate PDFs
 *
 * Output: one JSON file per data type (complete, raw) + CSVs for the things you'll actually look at.
 * Read-only: it never changes anything in Harvest.
 */

@include __DIR__ . '/config.php';
$noFiles = in_array('--no-files', array_slice($argv, 1), true);
$token   = getenv('HARVEST_TOKEN');
$account = getenv('HARVEST_ACCOUNT_ID');
function ask($q, $hidden = false) { echo $q; if ($hidden) system('stty -echo'); $v = trim(fgets(STDIN)); if ($hidden) { system('stty echo'); echo "\n"; } return $v; }
if (!$token)   $token   = ask('Harvest personal access token: ', true);
if (!$account) $account = ask('Harvest Account ID: ');

$out = __DIR__ . '/harvest_export/' . date('Y-m-d');
@mkdir("$out/receipts", 0700, true); @mkdir("$out/estimate_pdfs", 0700, true);
$calls = 0; $windowStart = microtime(true);

function h(string $url): array {
    global $token, $account, $calls, $windowStart;
    // Harvest allows 100 requests per 15 seconds
    if (++$calls % 95 === 0) { $wait = 15.5 - (microtime(true) - $windowStart); if ($wait > 0) usleep((int)($wait * 1e6)); $windowStart = microtime(true); }
    for ($try = 1; $try <= 5; $try++) {
        $ch = curl_init(str_starts_with($url, 'http') ? $url : 'https://api.harvestapp.com/v2/' . ltrim($url, '/'));
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 120, CURLOPT_HTTPHEADER => [
            'Authorization: Bearer ' . $token, 'Harvest-Account-Id: ' . $account, 'User-Agent: Harvest export (' . (defined('CONTACT_EMAIL') ? CONTACT_EMAIL : 'unknown') . ')']]);
        $raw = curl_exec($ch); $code = curl_getinfo($ch, CURLINFO_HTTP_CODE); curl_close($ch);
        if ($code === 429) { sleep(15); continue; }
        if ($code === 200) return json_decode($raw, true);
        if ($code === 401 || $code === 403) exit("Harvest refused the token/account id (HTTP $code). Check both at id.getharvest.com/developers\n");
        if ($code === 404) return [];
        sleep(2 * $try);
    }
    echo "  ! gave up on $url\n"; return [];
}
function all(string $path, string $key): array {             // follows Harvest's pagination
    $rows = []; $url = $path . (str_contains($path, '?') ? '&' : '?') . 'per_page=2000';
    while ($url) { $j = h($url); $rows = array_merge($rows, $j[$key] ?? []); $url = $j['links']['next'] ?? null; }
    return $rows;
}
function save(string $name, $data): void { global $out; file_put_contents("$out/$name.json", json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)); }
function csv(string $name, array $rows): void {
    global $out; if (!$rows) return;
    $cols = []; foreach ($rows as $r) foreach (array_keys($r) as $k) $cols[$k] = true;
    $f = fopen("$out/$name.csv", 'w'); fputcsv($f, array_keys($cols));
    foreach ($rows as $r) { $line = []; foreach (array_keys($cols) as $k) { $v = $r[$k] ?? ''; $line[] = is_array($v) ? json_encode($v) : $v; } fputcsv($f, $line); }
    fclose($f);
}
function step(string $m) { echo str_pad($m, 42) ; }

// ---- account-level ----
step('Company settings');       $company = h('company'); save('company', $company); echo "ok\n";
step('Users');                  $users = all('users', 'users'); save('users', $users);
foreach ($users as &$u) { $u['billable_rates'] = all("users/{$u['id']}/billable_rates", 'billable_rates'); $u['cost_rates'] = all("users/{$u['id']}/cost_rates", 'cost_rates'); }
unset($u); save('users', $users); echo count($users) . "\n";
foreach ([['clients','clients'], ['contacts','contacts'], ['tasks','tasks'], ['roles','roles'],
          ['expense_categories','expense_categories'], ['invoice_item_categories','invoice_item_categories'],
          ['estimate_item_categories','estimate_item_categories']] as [$ep, $key]) {
    step(ucfirst(str_replace('_', ' ', $ep))); $rows = all($ep, $key); save($ep, $rows); echo count($rows) . "\n";
}

// ---- projects (with budgets, rates, and who/what is assigned) ----
step('Projects');                $projects = all('projects', 'projects'); save('projects', $projects); echo count($projects) . "\n";
step('Task assignments (rates/budgets)'); $ta = all('task_assignments', 'task_assignments'); save('task_assignments', $ta); echo count($ta) . "\n";
step('User assignments');        $ua = all('user_assignments', 'user_assignments'); save('user_assignments', $ua); echo count($ua) . "\n";

// ---- time ----
step('Time entries (all, incl. timestamps)'); $time = all('time_entries', 'time_entries'); save('time_entries', $time); echo count($time) . "\n";
csv('time_entries', array_map(fn($t) => [
    'id' => $t['id'], 'date' => $t['spent_date'], 'client' => $t['client']['name'] ?? '', 'project' => $t['project']['name'] ?? '',
    'project_code' => $t['project']['code'] ?? '', 'task' => $t['task']['name'] ?? '', 'notes' => $t['notes'], 'hours' => $t['hours'],
    'rounded_hours' => $t['rounded_hours'] ?? '', 'started' => $t['started_time'] ?? '', 'ended' => $t['ended_time'] ?? '',
    'billable' => $t['billable'] ? 'yes' : 'no', 'billable_rate' => $t['billable_rate'], 'invoiced' => $t['is_billed'] ? 'yes' : 'no',
    'invoice_number' => $t['invoice']['number'] ?? '', 'locked' => $t['is_locked'] ? 'yes' : 'no', 'user' => $t['user']['name'] ?? '',
    'created_at' => $t['created_at'], 'updated_at' => $t['updated_at']], $time));

// ---- expenses (+ receipts) ----
step('Expenses'); $exp = all('expenses', 'expenses'); save('expenses', $exp); echo count($exp) . "\n";
if (!$noFiles) foreach ($exp as $e) if (!empty($e['receipt']['url'])) {
    $fn = "$out/receipts/{$e['spent_date']}_{$e['id']}_" . preg_replace('/[^A-Za-z0-9._-]/', '_', $e['receipt']['file_name'] ?? 'receipt');
    if (!file_exists($fn)) { $d = @file_get_contents($e['receipt']['url']); if ($d) file_put_contents($fn, $d); }
}
csv('expenses', array_map(fn($e) => ['id' => $e['id'], 'date' => $e['spent_date'], 'client' => $e['client']['name'] ?? '', 'project' => $e['project']['name'] ?? '',
    'category' => $e['expense_category']['name'] ?? '', 'amount' => $e['total_cost'], 'notes' => $e['notes'], 'billable' => $e['billable'] ? 'yes' : 'no',
    'invoiced' => $e['is_billed'] ? 'yes' : 'no', 'receipt' => $e['receipt']['file_name'] ?? ''], $exp));

// ---- invoices + line items + every payment + email history ----
step('Invoices'); $inv = all('invoices', 'invoices'); echo count($inv) . "\n";
step('  payments + messages (slow, ~2 per invoice)');
$lines = []; $pays = [];
foreach ($inv as $i => &$v) {
    $v['payments'] = all("invoices/{$v['id']}/payments", 'invoice_payments');
    $v['messages'] = all("invoices/{$v['id']}/messages", 'invoice_messages');
    foreach ($v['line_items'] ?? [] as $li) $lines[] = ['invoice' => $v['number'], 'issue_date' => $v['issue_date'], 'client' => $v['client']['name'] ?? '',
        'kind' => $li['kind'], 'description' => $li['description'], 'quantity' => $li['quantity'], 'unit_price' => $li['unit_price'], 'amount' => $li['amount'],
        'taxed' => $li['taxed'] ? 'yes' : 'no', 'project' => $li['project']['name'] ?? '', 'project_code' => $li['project']['code'] ?? ''];
    foreach ($v['payments'] as $p) $pays[] = ['invoice' => $v['number'], 'client' => $v['client']['name'] ?? '', 'paid_date' => $p['paid_date'], 'paid_at' => $p['paid_at'],
        'amount' => $p['amount'], 'recorded_by' => $p['recorded_by'] ?? '', 'notes' => $p['notes'] ?? '', 'transaction_id' => $p['transaction_id'] ?? '',
        'gateway' => $p['payment_gateway']['name'] ?? ''];
    if (($i + 1) % 100 === 0) echo ($i + 1) . '… ';
}
unset($v); echo "done\n";
save('invoices', $inv);
csv('invoice_line_items', $lines);
usort($pays, fn($a, $b) => strcmp($a['paid_date'], $b['paid_date']));
csv('invoice_payments', $pays);
csv('invoices', array_map(fn($v) => ['number' => $v['number'], 'client' => $v['client']['name'] ?? '', 'subject' => $v['subject'], 'state' => $v['state'],
    'issue_date' => $v['issue_date'], 'due_date' => $v['due_date'], 'sent_at' => $v['sent_at'], 'paid_date' => $v['paid_date'], 'amount' => $v['amount'],
    'due_amount' => $v['due_amount'], 'tax' => $v['tax_amount'], 'discount' => $v['discount_amount'], 'purchase_order' => $v['purchase_order'],
    'notes' => $v['notes'], 'payments' => count($v['payments']), 'emails_sent' => count($v['messages'])], $inv));

// ---- estimates (+ PDFs through the client link) ----
step('Estimates'); $est = all('estimates', 'estimates'); echo count($est) . "\n";
$sub = parse_url($company['base_uri'] ?? '', PHP_URL_HOST);
foreach ($est as &$e) {
    $e['messages'] = all("estimates/{$e['id']}/messages", 'estimate_messages');
    if (!$noFiles && $sub && !empty($e['client_key'])) {
        $fn = "$out/estimate_pdfs/" . preg_replace('/[^A-Za-z0-9._-]/', '_', ($e['number'] ?: $e['id'])) . '.pdf';
        if (!file_exists($fn)) { $d = @file_get_contents("https://$sub/client/estimates/{$e['client_key']}.pdf"); if ($d && str_starts_with($d, '%PDF')) file_put_contents($fn, $d); }
    }
}
unset($e); save('estimates', $est);
csv('estimates', array_map(fn($e) => ['number' => $e['number'], 'client' => $e['client']['name'] ?? '', 'subject' => $e['subject'], 'state' => $e['state'],
    'issue_date' => $e['issue_date'], 'amount' => $e['amount'], 'accepted_at' => $e['accepted_at'], 'declined_at' => $e['declined_at'], 'notes' => $e['notes']], $est));

// ---- year-by-year totals (for year-end / tax: cash received per year) ----
$byYear = [];
foreach ($pays as $p) { $y = substr($p['paid_date'], 0, 4); $byYear[$y]['received'] = ($byYear[$y]['received'] ?? 0) + $p['amount']; }
foreach ($inv as $v) { $y = substr($v['issue_date'], 0, 4); $byYear[$y]['invoiced'] = ($byYear[$y]['invoiced'] ?? 0) + $v['amount']; }
foreach ($time as $t) { $y = substr($t['spent_date'], 0, 4); $byYear[$y]['hours'] = ($byYear[$y]['hours'] ?? 0) + $t['hours']; }
ksort($byYear);
csv('totals_by_year', array_map(fn($y, $v) => ['year' => $y, 'invoiced' => round($v['invoiced'] ?? 0, 2), 'cash_received' => round($v['received'] ?? 0, 2), 'hours' => round($v['hours'] ?? 0, 2)], array_keys($byYear), $byYear));

echo "\nDone. Everything is in $out\n";
echo "Key files: invoice_line_items.csv, invoice_payments.csv, totals_by_year.csv, time_entries.csv, estimates.csv, expenses.csv\n";
