<?php
/*
 * todo_digest.php  v1.2  (2026-10-07: unbilled time uses the 5-minute round-down rule)
 *
 * Morning digest: to-dos + invoice status, emailed at 8:30am (your TIMEZONE in config.php) on weekdays.
 *
 * Cron (Cloudways > Cron Job Management > Advanced) — every 5 minutes; the script itself
 * decides when it's 8:30 in your timezone (handles daylight saving) and sends once per day:
 *   0-59/5 * * * * php /home/master/applications/YOUR_APP/private_html/todo_digest.php >> /home/master/applications/YOUR_APP/private_html/todo_digest.log 2>&1
 *
 *   php todo_digest.php --preview   build it and save todo_digest_preview.html, send nothing
 *   php todo_digest.php --now       send right now (for testing)
 */

(@include __DIR__ . '/config.php') || exit("Copy config.example.php to config.php and fill it in first.\n");
define('SEND_TO', defined('DIGEST_TO') ? DIGEST_TO : CONTACT_EMAIL);   // set DIGEST_TO in config.php
const SEND_AT    = '08:30';
const SEND_DAYS  = [1, 2, 3, 4, 5];          // 1 = Monday … 7 = Sunday. Every day: [1,2,3,4,5,6,7]
const MONEY      = true;                     // invoice + unbilled sections
const DUE_FIELD  = 'custom_value1';          // task custom field 1 "Due"
const RANK_FIELD = 'custom_value2';          // task custom field 2 "To-do rank"
const APP_DIR    = __DIR__ . '/../public_html';         // Invoice Ninja's folder (for its .env mail settings)
const TOKEN_FILE = __DIR__ . '/.in_token';
const STATE_FILE = __DIR__ . '/.todo_digest_state';

date_default_timezone_set(TIMEZONE);
$args = array_slice($argv, 1);
$preview = in_array('--preview', $args, true);
$now = in_array('--now', $args, true);
$state = is_readable(STATE_FILE) ? (json_decode(file_get_contents(STATE_FILE), true) ?: []) : [];
$today = date('Y-m-d');

if (!$preview && !$now) {                    // cron: only once, on a send day, from 8:30 until noon
    if (!in_array((int)date('N'), SEND_DAYS, true)) exit(0);
    if (date('H:i') < SEND_AT || date('H') >= 12) exit(0);
    if (($state['last_day'] ?? '') === $today) exit(0);
}

$token = getenv('IN_TOKEN') ?: (is_readable(TOKEN_FILE) ? trim(file_get_contents(TOKEN_FILE)) : '');
if (!$token) exit("No API token: set IN_TOKEN or create " . TOKEN_FILE . "\n");

function api(string $method, string $path, ?array $body = null): array {
    global $token;
    $ch = curl_init(BASE_URL . '/api/v1' . $path);
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CUSTOMREQUEST => $method, CURLOPT_TIMEOUT => 90,
        CURLOPT_HTTPHEADER => ['X-API-TOKEN: ' . $token, 'X-Requested-With: XMLHttpRequest', 'Content-Type: application/json', 'Accept: application/json']]);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    $raw = curl_exec($ch); $code = curl_getinfo($ch, CURLINFO_HTTP_CODE); curl_close($ch);
    if ($code < 200 || $code >= 300) throw new RuntimeException("HTTP $code on $path: " . substr((string)$raw, 0, 200));
    return json_decode($raw, true) ?: [];
}
function all(string $path): array {
    $out = []; $page = 1;
    do {
        $j = api('GET', $path . (str_contains($path, '?') ? '&' : '?') . "per_page=500&page=$page");
        $out = array_merge($out, $j['data'] ?? []);
        $pages = $j['meta']['pagination']['total_pages'] ?? 1;
    } while ($page++ < $pages);
    return array_values(array_filter($out, fn($x) => empty($x['is_deleted'])));
}
// per time entry: up to the next quarter hour, or down to it when within 5 minutes past (min 0:15)
function round_entry($secs): int {
    $secs = max(0, (int)round($secs)); if (!$secs) return 0;
    $over = $secs % 900; $base = $secs - $over;
    if (!$over) return $secs;
    return $over <= 300 ? max($base, 900) : $base + 900;
}
function h($s): string { return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8'); }
function money($n): string { return '$' . number_format((float)$n, 2); }
function text_of(?string $html): string {
    $t = preg_replace(['~<br\s*/?>~i', '~</(div|p|li)>~i'], "\n", (string)$html);
    return trim(html_entity_decode(strip_tags($t), ENT_QUOTES, 'UTF-8'));
}
function first_line(?string $desc): string { return trim(strtok(text_of($desc) . "\n", "\n")); }
function title_of(?string $desc): string {   // "Creative — Logo round 2" -> "Logo round 2 (Creative)"
    $f = first_line($desc); $i = mb_strpos($f, ' — ');
    return $i > 0 ? mb_substr($f, $i + 3) . ' (' . mb_substr($f, 0, $i) . ')' : $f;
}
function nice_date(string $ymd): string { return date('D M j', strtotime($ymd . ' 12:00')); }

try {
    // ---------- load ----------
    $clients = []; foreach (all('/clients?status=active,archived') as $c) $clients[$c['id']] = $c;
    $projects = []; foreach (all('/projects?status=active,archived') as $p) $projects[$p['id']] = $p;
    $tasks = all('/tasks?status=active');
    $statuses = api('GET', '/task_statuses?per_page=100')['data'] ?? [];
    $doneId = $waitId = null;
    foreach ($statuses as $s) {
        if (!$doneId && preg_match('/done|complete/i', $s['name'] ?? '')) $doneId = $s['id'];
        if (!$waitId && preg_match('/wait/i', $s['name'] ?? '')) $waitId = $s['id'];
    }
    $cname = fn($id) => $clients[$id]['name'] ?? ($clients[$id]['display_name'] ?? '');
    $plabel = function ($pid) use ($projects, $cname) {
        if (!$pid || empty($projects[$pid])) return 'No project';
        $p = $projects[$pid];
        return trim($cname($p['client_id']) . ' · ' . ($p['number'] ? $p['number'] . ' ' : '') . $p['name']);
    };

    // ---------- to-dos ----------
    $todos = array_filter($tasks, fn($t) => trim((string)($t[RANK_FIELD] ?? '')) !== '');
    $open = array_values(array_filter($todos, fn($t) => $t['status_id'] !== $doneId));
    usort($open, fn($a, $b) => (float)$a[RANK_FIELD] <=> (float)$b[RANK_FIELD]);
    $active = array_values(array_filter($open, fn($t) => $t['status_id'] !== $waitId));
    $waiting = array_values(array_filter($open, fn($t) => $t['status_id'] === $waitId));
    $weekEnd = date('Y-m-d', strtotime('+6 days'));
    $overdue = $dueToday = $dueWeek = $listed = [];
    foreach ($active as $t) {
        $d = (string)($t[DUE_FIELD] ?? '');
        if ($d === '') continue;
        if ($d < $today) $overdue[] = $t; elseif ($d === $today) $dueToday[] = $t; elseif ($d <= $weekEnd) $dueWeek[] = $t; else continue;
        $listed[$t['id']] = true;
    }
    $byDue = fn($a, $b) => strcmp($a[DUE_FIELD], $b[DUE_FIELD]) ?: ((float)$a[RANK_FIELD] <=> (float)$b[RANK_FIELD]);
    usort($overdue, $byDue); usort($dueWeek, $byDue);
    $upNext = array_slice(array_values(array_filter($active, fn($t) => empty($listed[$t['id']]))), 0, 5);

    // ---------- money ----------
    $late = $notDue = $drafts = $paid = $unbilled = [];
    if (MONEY) {
        foreach (all('/invoices?status=active,archived&client_status=unpaid') as $i) {
            if (!in_array((string)$i['status_id'], ['2', '3'], true) || (float)$i['balance'] <= 0) continue;
            if (!empty($i['due_date']) && $i['due_date'] < $today) $late[] = $i; else $notDue[] = $i;
        }
        foreach (all('/invoices?status=active&client_status=draft') as $i) if ((string)$i['status_id'] === '1') $drafts[] = $i;
        usort($late, fn($a, $b) => strcmp($a['due_date'], $b['due_date']));
        usort($notDue, fn($a, $b) => strcmp($a['due_date'] ?: '9999', $b['due_date'] ?: '9999'));

        $since = (int)($state['last_sent'] ?? strtotime('-1 day'));
        $pj = api('GET', '/payments?per_page=100&status=active&sort=created_at|desc&include=invoices');
        foreach ($pj['data'] ?? [] as $p) {
            if (!empty($p['is_deleted']) || (int)$p['created_at'] <= $since || !in_array((string)$p['status_id'], ['4', '5'], true)) continue;
            $paid[] = $p;
        }

        foreach ($tasks as $t) {                          // billable, finished, not yet invoiced time
            if (!empty($t['invoice_id']) || trim((string)($t[RANK_FIELD] ?? '')) !== '') continue;
            $log = json_decode($t['time_log'] ?: '[]', true) ?: [];
            $secs = 0;
            foreach ($log as $e) {
                if (empty($e[0]) || empty($e[1]) || (isset($e[3]) && $e[3] === false)) continue;
                $secs += round_entry($e[1] - $e[0]);
            }
            if ($secs <= 0) continue;
            $pid = $t['project_id'] ?: '_none';
            $p = $projects[$t['project_id']] ?? null;
            $rate = (float)$t['rate'] ?: (float)($p['task_rate'] ?? 0) ?: (float)($clients[$t['client_id']]['settings']['default_task_rate'] ?? 0);
            $unbilled[$pid] ??= ['hours' => 0, 'amount' => 0, 'oldest' => PHP_INT_MAX];
            $unbilled[$pid]['hours'] += $secs / 3600;
            $unbilled[$pid]['amount'] += $secs / 3600 * $rate;
            $unbilled[$pid]['oldest'] = min($unbilled[$pid]['oldest'], (int)($log[0][0] ?? time()));
        }
        uasort($unbilled, fn($a, $b) => $b['amount'] <=> $a['amount']);
    }

    // ---------- email ----------
    $todoUrl = BASE_URL . '/tasks#todo';
    $css = [
        'h2'   => 'font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:#6b7280;margin:26px 0 8px;font-weight:600;',
        'row'  => 'padding:7px 0;border-top:1px solid #f0f1f3;vertical-align:top;',
        'sub'  => 'color:#6b7280;font-size:12px;',
        'a'    => 'color:#111827;text-decoration:none;',
        'right'=> 'text-align:right;white-space:nowrap;padding-left:12px;',
    ];
    $todoRows = function (array $list, string $tag = '') use ($css, $plabel, $todoUrl, $today) {
        $o = '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;">';
        foreach ($list as $t) {
            $d = (string)($t[DUE_FIELD] ?? '');
            $dueTxt = $d === '' ? '' : ($d < $today ? nice_date($d) . ' · ' . (int)round((strtotime($today) - strtotime($d)) / 86400) . 'd late' : ($d === $today ? 'Today' : nice_date($d)));
            $color = $d !== '' && $d < $today ? '#b91c1c' : ($d === $today ? '#b45309' : '#6b7280');
            $o .= '<tr><td style="' . $css['row'] . '"><a href="' . h($todoUrl) . '" style="' . $css['a'] . '">' . h(title_of($t['description'])) . '</a><br><span style="' . $css['sub'] . '">' . h($plabel($t['project_id'])) . '</span></td>'
                . '<td style="' . $css['row'] . $css['right'] . 'color:' . $color . ';font-size:13px;">' . h($dueTxt) . '</td></tr>';
        }
        return $o . '</table>';
    };
    $invRows = function (array $list, bool $isLate) use ($css, $cname, $today) {
        $o = '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;">';
        foreach ($list as $i) {
            $due = $i['due_date'] ?? '';
            $when = $due === '' ? 'no due date' : ($isLate ? (int)round((strtotime($today) - strtotime($due)) / 86400) . ' days late' : 'due ' . nice_date($due));
            $o .= '<tr><td style="' . $css['row'] . '"><a href="' . h(BASE_URL . '/invoices/' . $i['id'] . '/edit') . '" style="' . $css['a'] . '"><b>' . h($i['number']) . '</b></a> · ' . h($cname($i['client_id']))
                . '<br><span style="' . $css['sub'] . ($isLate ? 'color:#b91c1c;' : '') . '">' . h($when) . ((float)$i['balance'] < (float)$i['amount'] ? ' · partly paid' : '') . '</span></td>'
                . '<td style="' . $css['row'] . $css['right'] . '">' . money($i['balance']) . '</td></tr>';
        }
        return $o . '</table>';
    };

    $sum = fn($list, $k) => array_sum(array_map(fn($x) => (float)$x[$k], $list));
    $out = [];
    $out[] = '<div style="font:15px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#111827;max-width:620px;margin:0 auto;padding:8px 4px;">';
    $out[] = '<div style="font-size:20px;font-weight:600;margin-bottom:2px;">' . h(date('l, F j')) . '</div>';
    $out[] = '<div style="color:#6b7280;font-size:13px;">' . count($active) . ' open to-dos' . ($waiting ? ' · ' . count($waiting) . ' waiting on clients' : '')
        . ' · <a href="' . h($todoUrl) . '" style="color:#2563eb;">Open the list</a></div>';

    if ($overdue)  { $out[] = '<div style="' . $css['h2'] . 'color:#b91c1c;">Overdue</div>' . $todoRows($overdue); }
    if ($dueToday) { $out[] = '<div style="' . $css['h2'] . 'color:#b45309;">Due today</div>' . $todoRows($dueToday); }
    if ($dueWeek)  { $out[] = '<div style="' . $css['h2'] . '">Due this week</div>' . $todoRows($dueWeek); }
    if ($upNext)   { $out[] = '<div style="' . $css['h2'] . '">Up next</div>' . $todoRows($upNext); }
    if (!$open)    { $out[] = '<p style="color:#6b7280;margin-top:20px;">Nothing on the to-do list.</p>'; }
    if ($waiting) {
        $names = array_map(fn($t) => title_of($t['description']) . ' (' . $plabel($t['project_id']) . ')', $waiting);
        $out[] = '<div style="' . $css['h2'] . '">Waiting on clients</div><div style="font-size:13px;color:#6b7280;">' . h(implode(' · ', $names)) . '</div>';
    }

    if (MONEY) {
        $out[] = '<div style="border-top:2px solid #111827;margin:30px 0 0;"></div>';
        $outstanding = $sum($late, 'balance') + $sum($notDue, 'balance');
        $out[] = '<div style="font-size:16px;font-weight:600;margin-top:14px;">Invoices: ' . money($outstanding) . ' outstanding'
            . ($late ? ' · <span style="color:#b91c1c;">' . money($sum($late, 'balance')) . ' overdue</span>' : '') . '</div>';
        if ($paid) {
            $o = '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;">';
            foreach ($paid as $p) {
                $nums = implode(', ', array_map(fn($i) => $i['number'], $p['invoices'] ?? []));
                $o .= '<tr><td style="' . $css['row'] . '">' . h($cname($p['client_id'])) . ($nums ? ' · <b>' . h($nums) . '</b>' : '')
                    . '<br><span style="' . $css['sub'] . '">' . h(nice_date($p['date'])) . '</span></td><td style="' . $css['row'] . $css['right'] . 'color:#047857;">' . money($p['amount']) . '</td></tr>';
            }
            $out[] = '<div style="' . $css['h2'] . 'color:#047857;">Paid since last email · ' . money($sum($paid, 'amount')) . '</div>' . $o . '</table>';
        }
        if ($late)   $out[] = '<div style="' . $css['h2'] . 'color:#b91c1c;">Overdue · ' . money($sum($late, 'balance')) . '</div>' . $invRows($late, true);
        if ($notDue) $out[] = '<div style="' . $css['h2'] . '">Outstanding · ' . money($sum($notDue, 'balance')) . '</div>' . $invRows($notDue, false);
        if ($drafts) {
            $o = '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;">';
            foreach ($drafts as $i) $o .= '<tr><td style="' . $css['row'] . '"><a href="' . h(BASE_URL . '/invoices/' . $i['id'] . '/edit') . '" style="' . $css['a'] . '"><b>' . h($i['number']) . '</b></a> · ' . h($cname($i['client_id']))
                . '</td><td style="' . $css['row'] . $css['right'] . '">' . money($i['amount']) . '</td></tr>';
            $out[] = '<div style="' . $css['h2'] . '">Drafts not sent · ' . money($sum($drafts, 'amount')) . '</div>' . $o . '</table>';
        }
        if ($unbilled) {
            $o = '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;">';
            $tot = 0;
            foreach ($unbilled as $pid => $u) {
                $tot += $u['amount'];
                $age = (int)floor((time() - $u['oldest']) / 86400);
                $link = $pid !== '_none' ? BASE_URL . '/projects/' . $pid : BASE_URL . '/tasks';
                $o .= '<tr><td style="' . $css['row'] . '"><a href="' . h($link) . '" style="' . $css['a'] . '">' . h($plabel($pid === '_none' ? '' : $pid)) . '</a><br><span style="' . $css['sub'] . '">'
                    . rtrim(rtrim(number_format($u['hours'], 2), '0'), '.') . 'h · oldest ' . ($age === 0 ? 'today' : $age . ($age === 1 ? ' day' : ' days') . ' ago') . '</span></td><td style="' . $css['row'] . $css['right'] . '">' . money($u['amount']) . '</td></tr>';
            }
            $out[] = '<div style="' . $css['h2'] . '">Unbilled time · ' . money($tot) . '</div>' . $o . '</table>';
        }
        if (!$paid && !$late && !$notDue && !$drafts && !$unbilled) $out[] = '<p style="color:#6b7280;">Nothing outstanding, nothing unbilled.</p>';
    }
    $out[] = '<p style="color:#9ca3af;font-size:12px;margin-top:30px;">Sent by todo_digest.php on your server.</p></div>';
    $html = implode("\n", $out);

    $bits = [];
    if ($overdue) $bits[] = count($overdue) . ' overdue';
    if ($dueToday) $bits[] = count($dueToday) . ' due today';
    $subject = 'To-do: ' . ($bits ? implode(', ', $bits) : count($active) . ' open');
    if (MONEY) {
        $subject .= ' · ' . money($sum($late, 'balance') + $sum($notDue, 'balance')) . ' outstanding';
        if ($late) $subject .= ' (' . count($late) . ' late)';
        if ($paid) $subject .= ' · ' . money($sum($paid, 'amount')) . ' paid';
    }
    $subject = str_replace('.00', '', $subject);

    if ($preview) {
        file_put_contents(__DIR__ . '/todo_digest_preview.html', "<!doctype html><meta charset=utf-8><title>" . h($subject) . "</title>\n" . $html);
        echo "Subject: $subject\nSaved todo_digest_preview.html\n";
        exit(0);
    }

    send_mail($subject, $html);
    file_put_contents(STATE_FILE, json_encode(['last_sent' => time(), 'last_day' => $today]));
    echo date('Y-m-d H:i') . "  sent: $subject\n";

} catch (Throwable $e) {
    echo date('Y-m-d H:i') . "  ERROR: " . $e->getMessage() . "\n";
    exit(1);
}

// Sends through the same SMTP account Invoice Ninja uses (read from its .env), with the mail library it ships.
function send_mail(string $subject, string $html): void {
    if (!is_readable(APP_DIR . '/.env')) throw new RuntimeException('Can\'t read ' . APP_DIR . '/.env — check APP_DIR at the top of this script');
    if (!is_readable(APP_DIR . '/vendor/autoload.php')) throw new RuntimeException('Can\'t find Invoice Ninja\'s vendor folder in ' . APP_DIR);
    $env = [];
    foreach (file(APP_DIR . '/.env', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        $line = trim($line);
        if ($line === '' || $line[0] === '#' || !str_contains($line, '=')) continue;
        [$k, $v] = explode('=', $line, 2);
        $env[trim($k)] = trim(trim($v), "\"'");
    }
    require_once APP_DIR . '/vendor/autoload.php';
    $port = (int)($env['MAIL_PORT'] ?? 587);
    $scheme = ($port === 465 || strtolower($env['MAIL_ENCRYPTION'] ?? '') === 'ssl') ? 'smtps' : 'smtp';
    $dsn = sprintf('%s://%s:%s@%s:%d', $scheme, rawurlencode($env['MAIL_USERNAME'] ?? ''), rawurlencode($env['MAIL_PASSWORD'] ?? ''), $env['MAIL_HOST'] ?? 'localhost', $port);
    $mailer = new Symfony\Component\Mailer\Mailer(Symfony\Component\Mailer\Transport::fromDsn($dsn));
    $from = $env['MAIL_FROM_ADDRESS'] ?? SEND_TO;
    $text = trim(html_entity_decode(strip_tags(preg_replace(['~<br\s*/?>~i', '~</(div|tr|p)>~i'], "\n", $html)), ENT_QUOTES, 'UTF-8'));
    $mail = (new Symfony\Component\Mime\Email())
        ->from(new Symfony\Component\Mime\Address($from, $env['MAIL_FROM_NAME'] ?? 'Invoice Ninja'))
        ->to(SEND_TO)->subject($subject)->html($html)->text(preg_replace("/\n\s*\n+/", "\n\n", $text));
    $mailer->send($mail);
}
