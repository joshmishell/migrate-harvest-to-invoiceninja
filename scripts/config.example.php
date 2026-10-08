<?php
/*
 * Copy this file to config.php (same folder) and fill it in. config.php is git-ignored.
 * Every script in this folder reads it.
 */

// Your Invoice Ninja address (no trailing slash)
const BASE_URL = 'https://billing.example.com';

// Your own business, exactly as it appears in Harvest's client list.
// Harvest often has a "client" for internal time; those projects/time are skipped on import.
const OWN_COMPANY = ['Your Company LLC'];

// Timezone for imported time entries (Harvest exports dates, not clock times; entries start at 9:00 here)
const TIMEZONE = 'America/Chicago';

// Used only in the User-Agent header Harvest asks API clients to send
const CONTACT_EMAIL = 'you@example.com';

// Where the morning to-do / invoice digest (todo_digest.php) is emailed
const DIGEST_TO = 'you@example.com';

// ---- no need to edit below ----
define('SKIP_CLIENTS', array_map(fn($n) => strtolower(trim($n)), OWN_COMPANY));
// Scripts read the Invoice Ninja API token from $IN_TOKEN, or from a .in_token file next to this one (chmod 600).
if (!getenv('IN_TOKEN') && is_readable(__DIR__ . '/.in_token')) putenv('IN_TOKEN=' . trim(file_get_contents(__DIR__ . '/.in_token')));
