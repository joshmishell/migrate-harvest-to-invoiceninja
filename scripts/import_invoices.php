<?php
/*
 * Harvest invoice report -> Invoice Ninja invoices (+ payments + original PDFs)
 *
 *   php import_invoices.php harvest_invoice_report.csv --pdfs=invoice_pdfs                 dry run
 *   php import_invoices.php harvest_invoice_report.csv --pdfs=invoice_pdfs --only=ALAN-1000,GOLD-1003   test a few
 *   php import_invoices.php harvest_invoice_report.csv --pdfs=invoice_pdfs --live          everything
 *
 * NO EMAILS: invoices are marked sent (never emailed); payments use email_receipt=false.
 * Paid in Harvest       -> invoice + payment dated Harvest's last payment date.
 * Closed unpaid ($0 paid)-> invoice, then cancelled (no balance, no reminders).
 * Linked to the project whose code matches the invoice number (ALEM-1001b -> ALEM-1001).
 * Safe to re-run: each step is checked against what's already in Invoice Ninja.
 */

(@include __DIR__ . '/config.php') || exit("Copy config.example.php to config.php and fill it in first.\n");

$args  = array_slice($argv, 1);
$live  = in_array('--live', $args, true);
$only  = []; $pdfDir = null;
foreach ($args as $a) {
    if (preg_match('/^--only=(.+)$/', $a, $m)) { $only = array_map('strtolower', array_map('trim', explode(',', $m[1]))); $live = true; }
    if (preg_match('/^--pdfs=(.+)$/', $a, $m)) $pdfDir = rtrim($m[1], '/');
}
$file = current(array_filter($args, fn($a) => $a[0] !== '-'));
if (!$file || !is_readable($file)) exit("Usage: php import_invoices.php <file.csv> --pdfs=<folder> [--only=ID,ID | --live]\n");
if ($pdfDir && !is_dir($pdfDir)) exit("PDF folder '$pdfDir' not found.\n");

$token = getenv('IN_TOKEN');
if (!$token) { echo "Invoice Ninja API token: "; system('stty -echo'); $token = trim(fgets(STDIN)); system('stty echo'); echo "\n"; }

function api(string $method, string $path, $body = null, bool $multipart = false): array {
    global $token;
    $ch = curl_init(BASE_URL . '/api/v1' . $path);
    $headers = ['X-API-TOKEN: ' . $token, 'X-Requested-With: XMLHttpRequest', 'Accept: application/json'];
    if (!$multipart) $headers[] = 'Content-Type: application/json';
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CUSTOMREQUEST => $method, CURLOPT_TIMEOUT => 120, CURLOPT_HTTPHEADER => $headers]);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $multipart ? $body : json_encode($body));
    $raw = curl_exec($ch); $code = curl_getinfo($ch, CURLINFO_HTTP_CODE); $err = curl_error($ch); curl_close($ch);
    return [$code, json_decode($raw ?: 'null', true), $err ?: substr((string)$raw, 0, 300)];
}
function fetch_all(string $entity, string $extra = ''): array {
    $out = []; $page = 1;
    do {
        [$code, $json, $err] = api('GET', "/$entity?per_page=500&page=$page&status=active,archived$extra");
        if ($code !== 200) exit("Could not read $entity (HTTP $code): $err\n");
        $out = array_merge($out, $json['data'] ?? []);
        $pages = $json['meta']['pagination']['total_pages'] ?? 1;
    } while ($page++ < $pages);
    return $out;
}
function norm(string $s): string { $s = str_replace(["\u{FEFF}", "\u{2019}", "\u{00A0}"], ['', "'", ' '], $s); return strtolower(preg_replace('/\s+/', ' ', trim($s))); }
function clean(string $s): string { return trim(str_replace(["\u{FEFF}", "\u{00A0}"], ['', ' '], $s)); }
function num(string $s): float { return (float)str_replace([',', '$'], '', $s); }
function key_of(string $s): string { return strtolower(preg_replace('/[^A-Za-z0-9]/', '', $s)); }
function ok(int $c): bool { return $c >= 200 && $c < 300; }

// --- lookups ---
echo "Reading clients, projects and invoices from Invoice Ninja...\n";
$clients = []; foreach (fetch_all('clients') as $c) $clients[norm($c['name'])] = $c['id'];
$projects = [];
foreach (fetch_all('projects') as $p) if (!empty($p['number'])) $projects[$p['client_id'] . '|' . strtolower($p['number'])] = $p['id'];
$existing = [];
foreach (fetch_all('invoices', '&include=documents') as $inv)
    $existing[strtolower($inv['number'])] = ['id' => $inv['id'], 'balance' => (float)$inv['balance'], 'status' => (string)$inv['status_id'], 'docs' => count($inv['documents'] ?? [])];

// --- PDFs: ..._invoice_ALEM_1000.pdf -> alem1000 ---
$pdfs = [];
if ($pdfDir) foreach (glob("$pdfDir/*.pdf") as $f)
    if (preg_match('/invoice_(.+)\.pdf$/i', basename($f), $m)) $pdfs[key_of($m[1])] = $f;

// --- CSV ---
$fh = fopen($file, 'r');
$header = array_map('clean', fgetcsv($fh));
$rows = [];
while (($r = fgetcsv($fh)) !== false) if (count($r) >= count($header)) $rows[] = array_combine($header, $r);
fclose($fh);

$s = ['created' => 0, 'paid' => 0, 'cancelled' => 0, 'pdf' => 0, 'noproject' => 0, 'nopdf' => 0, 'mismatch' => 0, 'failed' => 0, 'already' => 0];
$missingClients = []; $notes = [];

foreach ($rows as $r) {
    $number = clean($r['ID']);
    if ($only && !in_array(strtolower($number), $only, true)) continue;
    $clientName = clean($r['Client']);
    $cid = $clients[norm($clientName)] ?? null;
    if (!$cid) { $missingClients[$clientName] = ($missingClients[$clientName] ?? 0) + 1; continue; }

    $subtotal = num($r['Subtotal']); $discount = num($r['Discount']); $tax = num($r['Tax']);
    $total = num($r['Invoice Amount']); $paid = num($r['Paid Amount']);
    if (abs(round($subtotal - $discount + $tax, 2) - $total) > 0.01) { $s['mismatch']++; $notes[] = "$number: subtotal-discount+tax != total (check by hand)"; }

    // project: exact code, else strip trailing letters (1001b -> 1001)
    $pid = $projects[$cid . '|' . strtolower($number)] ?? $projects[$cid . '|' . strtolower(preg_replace('/[a-z]+$/', '', $number))] ?? null;
    if (!$pid) $s['noproject']++;

    $pdf = $pdfs[key_of($number)] ?? null;
    if ($pdfDir && !$pdf) { $s['nopdf']++; $notes[] = "$number: no PDF found"; }

    $lines = [['product_key' => 'Services', 'notes' => clean($r['Subject']) ?: "Harvest invoice $number", 'quantity' => 1, 'cost' => $subtotal, 'type_id' => '1']];
    if ($tax > 0) $lines[] = ['product_key' => 'Sales Tax', 'notes' => 'Sales tax (as billed in Harvest)', 'quantity' => 1, 'cost' => $tax, 'type_id' => '1'];

    $overpaid = $paid > $total + 0.001;
    $private = 'Imported from Harvest.' . ($overpaid ? sprintf(' Client paid $%s against $%s (overpaid $%s).', number_format($paid, 2), number_format($total, 2), number_format($paid - $total, 2)) : '')
             . ($paid == 0 && $total > 0 ? ' Closed in Harvest without payment.' : '');

    if (!$live) {
        if (isset($existing[strtolower($number)])) $s['already']++; else $s['created']++;
        if ($paid > 0) $s['paid']++; elseif ($total > 0) $s['cancelled']++;
        if ($pdf) $s['pdf']++;
        continue;
    }

    // 1) invoice
    $inv = $existing[strtolower($number)] ?? null;
    if ($inv) $s['already']++;
    else {
        $payload = array_filter([
            'client_id' => $cid, 'project_id' => $pid, 'number' => $number,
            'date' => $r['Issue Date'], 'due_date' => $r['Issue Date'],
            'po_number' => clean($r['PO Number']) ?: null,
            'discount' => $discount ?: null, 'is_amount_discount' => $discount ? true : null,
            'line_items' => $lines, 'private_notes' => $private, 'auto_bill_enabled' => false,
        ], fn($v) => $v !== null);
        [$code, $json, $err] = api('POST', '/invoices?mark_sent=true', $payload);
        if (!ok($code) || empty($json['data']['id'])) { $s['failed']++; $notes[] = "$number: create failed HTTP $code $err"; echo "  ! $number create failed (HTTP $code)\n"; continue; }
        $inv = ['id' => $json['data']['id'], 'balance' => (float)$json['data']['balance'], 'status' => (string)$json['data']['status_id'], 'docs' => 0];
        $existing[strtolower($number)] = $inv;
        $s['created']++;
        if (abs($inv['balance'] - $total) > 0.01 && $total > 0) $notes[] = "$number: Invoice Ninja total {$inv['balance']} vs Harvest $total";
    }

    // 2) payment (only if still owing and Harvest shows money received)
    if ($paid > 0 && $inv['balance'] > 0.001) {
        $amt = round(min($paid, $inv['balance']), 2);
        [$code, , $err] = api('POST', '/payments?email_receipt=false', [
            'client_id' => $cid, 'date' => $r['Last Payment Date'] ?: $r['Issue Date'], 'amount' => $amt,
            'transaction_reference' => 'Harvest', 'private_notes' => 'Payment imported from Harvest.',
            'invoices' => [['invoice_id' => $inv['id'], 'amount' => $amt]],
        ]);
        if (ok($code)) { $s['paid']++; $existing[strtolower($number)]['balance'] = 0; }
        else { $s['failed']++; $notes[] = "$number: payment failed HTTP $code $err"; echo "  ! $number payment failed (HTTP $code)\n"; }
    }

    // 3) closed without payment -> cancel
    if ($paid == 0 && $total > 0 && $inv['status'] !== '5' && $existing[strtolower($number)]['balance'] > 0.001) {
        [$code, , $err] = api('POST', '/invoices/bulk', ['action' => 'cancel', 'ids' => [$inv['id']]]);
        if (ok($code)) { $s['cancelled']++; $existing[strtolower($number)]['status'] = '5'; }
        else { $s['failed']++; $notes[] = "$number: cancel failed HTTP $code $err"; }
    }

    // 4) original PDF
    if ($pdf && $inv['docs'] == 0) {
        [$code, , $err] = api('POST', "/invoices/{$inv['id']}/upload", ['_method' => 'PUT', 'is_public' => '0', 'documents[]' => new CURLFile($pdf, 'application/pdf', basename($pdf))], true);
        if (ok($code)) { $s['pdf']++; $existing[strtolower($number)]['docs'] = 1; }
        else { $s['failed']++; $notes[] = "$number: PDF upload failed HTTP $code $err"; }
    }

    $done = $s['created'] + $s['already'];
    if ($done % 50 === 0) echo "  $done invoices processed...\n";
    usleep(100000);
}

echo "\n==== " . ($live ? ($only ? 'TEST RUN' : 'DONE') : 'DRY RUN — nothing created') . " ====\n";
echo "Invoices in file:           " . count($rows) . "\n";
echo ($live ? "Created:                    " : "Would create:               ") . $s['created'] . "\n";
echo "Already in Invoice Ninja:   {$s['already']}\n";
echo ($live ? "Payments recorded:          " : "Would record payments:      ") . $s['paid'] . "\n";
echo ($live ? "Cancelled (closed unpaid):  " : "Would cancel (unpaid):      ") . $s['cancelled'] . "\n";
echo ($live ? "PDFs attached:              " : "PDFs matched:               ") . $s['pdf'] . "\n";
echo "No matching project:        {$s['noproject']} (linked to client only)\n";
if ($pdfDir) echo "No PDF found:               {$s['nopdf']}\n";
echo "Total mismatches:           {$s['mismatch']}\n";
if ($live) echo "Failed steps:               {$s['failed']}\n";
if ($missingClients) { echo "\nClients not found:\n"; foreach ($missingClients as $c => $n) echo "  - $c ($n invoices)\n"; }
if ($notes) { file_put_contents('import_invoices_notes.log', implode("\n", $notes) . "\n"); echo "\nDetails written to import_invoices_notes.log (" . count($notes) . " lines)\n"; }
