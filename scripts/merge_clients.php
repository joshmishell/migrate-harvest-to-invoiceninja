<?php
/*
 * Turns Harvest's client + contact exports into one CSV that Invoice Ninja's client importer understands.
 *
 *   php merge_clients.php harvest_client_list.csv harvest_contact_list.csv
 *
 * Writes:
 *   invoiceninja_clients_import.csv  one row per client: address split into street/city/state/zip,
 *                                    plus the primary contact (Harvest's invoice "Recipient" if marked)
 *   extra_contacts_add_by_hand.csv   every other contact (Invoice Ninja's CSV import takes one per client)
 *
 * Your own company (OWN_COMPANY in config.php) is left out.
 */
@include __DIR__ . '/config.php';
$skip = defined('SKIP_CLIENTS') ? SKIP_CLIENTS : [];

[$clientsFile, $contactsFile] = array_slice($argv, 1) + [null, null];
if (!$clientsFile || !is_readable($clientsFile) || !$contactsFile || !is_readable($contactsFile))
    exit("Usage: php merge_clients.php harvest_client_list.csv harvest_contact_list.csv\n");

$STATES = ['alabama'=>'AL','alaska'=>'AK','arizona'=>'AZ','arkansas'=>'AR','california'=>'CA','colorado'=>'CO','connecticut'=>'CT','delaware'=>'DE',
  'florida'=>'FL','georgia'=>'GA','hawaii'=>'HI','idaho'=>'ID','illinois'=>'IL','indiana'=>'IN','iowa'=>'IA','kansas'=>'KS','kentucky'=>'KY','louisiana'=>'LA',
  'maine'=>'ME','maryland'=>'MD','massachusetts'=>'MA','michigan'=>'MI','minnesota'=>'MN','mississippi'=>'MS','missouri'=>'MO','montana'=>'MT','nebraska'=>'NE',
  'nevada'=>'NV','new hampshire'=>'NH','new jersey'=>'NJ','new mexico'=>'NM','new york'=>'NY','north carolina'=>'NC','north dakota'=>'ND','ohio'=>'OH',
  'oklahoma'=>'OK','oregon'=>'OR','pennsylvania'=>'PA','rhode island'=>'RI','south carolina'=>'SC','south dakota'=>'SD','tennessee'=>'TN','texas'=>'TX',
  'utah'=>'UT','vermont'=>'VT','virginia'=>'VA','washington'=>'WA','west virginia'=>'WV','wisconsin'=>'WI','wyoming'=>'WY','district of columbia'=>'DC'];

function rows(string $f): array {
    $fh = fopen($f, 'r'); $h = fgetcsv($fh); $h[0] = preg_replace('/^\xEF\xBB\xBF/', '', $h[0]);
    $out = []; while (($r = fgetcsv($fh)) !== false) if (count($r) >= count($h)) $out[] = array_combine($h, array_slice($r, 0, count($h)));
    fclose($fh); return $out;
}
// Harvest stores the address as free text; pull out "City, ST 12345" and the street line(s) above it
function parseAddress(string $a, array $STATES): array {
    $lines = array_values(array_filter(array_map('trim', preg_split('/\R/', $a)), fn($l) => $l !== '' && strtolower($l) !== 'united states'));
    $names = implode('|', array_map(fn($s) => preg_quote($s, '/'), array_keys($STATES)));
    foreach ($lines as $i => $l) {
        if (!preg_match('/^(.+?),?\s+([A-Za-z]{2}|' . $names . ')\.?\s+(\d{5}(?:-\d{4})?)\s*$/i', $l, $m)) continue;
        $st = $STATES[strtolower($m[2])] ?? strtoupper($m[2]);
        $pre = array_slice($lines, 0, $i);
        $street = array_values(array_filter($pre, fn($x) => preg_match('/^(\d|p\.?\s*o\.?\s*box|suite|ste\b|unit|#)/i', $x)));
        if (!$street && $pre) $street = [end($pre)];
        $city = rtrim(trim($m[1]), ',');
        if ($city === strtolower($city)) $city = ucwords($city);
        return ['street' => $street[0] ?? '', 'street2' => implode(', ', array_slice($street, 1)), 'city' => $city, 'state' => $st, 'zip' => $m[3]];
    }
    return ['street' => '', 'street2' => '', 'city' => '', 'state' => '', 'zip' => ''];
}

$contacts = [];
foreach (rows($contactsFile) as $c) $contacts[trim($c['Client'])][] = $c;

$out = []; $extra = [];
foreach (rows($clientsFile) as $c) {
    $name = trim($c['Client Name']);
    if (in_array(strtolower($name), $skip, true)) continue;
    $a = parseAddress($c['Address'] ?? '', $STATES);
    $cs = $contacts[$name] ?? [];
    usort($cs, fn($x, $y) => [($x['Invoice Email Default'] ?? '') !== 'Recipient', $x['Email'] === ''] <=> [($y['Invoice Email Default'] ?? '') !== 'Recipient', $y['Email'] === '']);
    $p = $cs[0] ?? [];
    // an email/phone typed into Harvest's address box is a contact, not an address
    if (!$p && preg_match('/[\w.+-]+@[\w-]+\.[\w.]+/', $c['Address'] ?? '', $em)) $p = ['First Name' => '', 'Last Name' => '', 'Email' => $em[0], 'Mobile Phone' => '', 'Office Phone' => ''];
    $out[] = ['Client Name' => $name, 'Street' => $a['street'], 'Apt/Suite' => $a['street2'], 'City' => $a['city'], 'State' => $a['state'], 'Postal Code' => $a['zip'],
        'Country' => $a['city'] ? 'United States' : '', 'Contact First Name' => $p['First Name'] ?? '', 'Contact Last Name' => $p['Last Name'] ?? '',
        'Contact Email' => $p['Email'] ?? '', 'Contact Phone' => ($p['Mobile Phone'] ?? '') ?: ($p['Office Phone'] ?? '')];
    foreach (array_slice($cs, 1) as $e) $extra[] = ['Client Name' => $name, 'First Name' => $e['First Name'], 'Last Name' => $e['Last Name'], 'Email' => $e['Email'],
        'Phone' => $e['Mobile Phone'] ?: $e['Office Phone'], 'Harvest Invoice Setting' => $e['Invoice Email Default'] ?? ''];
}
function write(string $f, array $rows): void { if (!$rows) return; $h = fopen($f, 'w'); fputcsv($h, array_keys($rows[0])); foreach ($rows as $r) fputcsv($h, $r); fclose($h); }
write('invoiceninja_clients_import.csv', $out);
write('extra_contacts_add_by_hand.csv', $extra);
printf("%d clients (%d with an address, %d with a contact email), %d extra contacts to add by hand.\n",
    count($out), count(array_filter($out, fn($r) => $r['City'])), count(array_filter($out, fn($r) => $r['Contact Email'])), count($extra));
echo "Open invoiceninja_clients_import.csv in a text editor or Numbers (not Excel — it drops leading zeros from ZIP codes), trim dead clients if you like, then import it in Invoice Ninja: Clients → Import.\n";
