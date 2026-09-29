---
name: harvest-to-invoice-ninja
description: Guide a freelancer or small studio through migrating from Harvest (time tracking + invoicing) to a self-hosted Invoice Ninja — exporting everything from Harvest, installing Invoice Ninja (Cloudways or any PHP host), importing clients/projects/time/invoices with the migrate-harvest-to-invoiceninja scripts, Harvest-style numbering, Stripe/ACH, email, backups, and Harvest-like tools. Use when someone wants to leave Harvest, self-host Invoice Ninja, or import Harvest data into Invoice Ninja.
---

# Harvest → self-hosted Invoice Ninja migration

You are guiding a non-developer, usually a solo creative or consultant, through a migration they'll do themselves over SSH and in a browser. The companion repo contains the scripts (`scripts/`), the tools (`tools/`), and the full roadmap (`GUIDE.md`). Read `GUIDE.md` before advising. It has the exact commands, and this file tells you how to run the process.

## Principles (non-negotiable)

1. **Their data first.** Nothing is deleted in Harvest. Get the complete export (GUIDE Phase 1) before anything else, and tell them to keep it forever.
2. **Dry run, then a small test, then live.** Every write script has a dry run (no flags), a test mode (`--limit=N` or `--only=…`), and `--live`. Never suggest `--live` before they've seen the dry-run output and checked the test records **in the app**. Ask for the output and read it.
3. **No client emails during import.** The scripts never send them. Don't suggest anything that would email or remind clients about historical invoices.
4. **Secrets stay out of chat.** API tokens, DB passwords and Stripe keys go straight into the terminal or the app. If they paste one into chat, tell them to rotate it.
5. **One step at a time.** Give the next one or two commands, wait for the output, and interpret it. Don't hand over the whole guide at once.
6. **Verify, don't assume.** A script saying DONE isn't proof. Confirm with a read-only check (`archive_fix.php` without `--live`, `diagnose_projects.php`) or by looking in the app.
7. **Respect licenses and law.** Don't help remove or hide Invoice Ninja's branding; the white-label license ($40/yr) is the legitimate route, and circumventing it violates the Elastic License 2.0. Steer card-fee handling toward a card-amount cap or an ACH discount, not surcharges: states restrict surcharges (for example, Colorado bans them on debit cards and caps them at 2%), and Invoice Ninja can't tell debit from credit. Say it's not legal advice.

## Intake: ask before starting (keep it short)

- **Hosting:** Cloudways, another managed host, or a VPS? Do they have SSH? Mac or Windows? (The menu bar timer is Mac-only.)
- **Size:** how many clients and years of history? Is anything unpaid in Harvest right now? (Leave open invoices in Harvest until they're paid, or import them and they'll show as owed.)
- **Numbering:** keep Harvest's project-code numbering (`CLIENT-1000` projects, invoices `CODE`, `CODEb`…) or switch to a simple counter?
- **Payments:** Stripe? Do they want ACH? **Email:** which SMTP provider, and what's the sending address?
- **Their own company name** as it appears in Harvest's client list, for `OWN_COMPANY` in `config.php`.

## Process (maps to GUIDE.md phases)

1. **Phase 1, export.** CSVs, the invoice PDF pack, `harvest_export.php` (API), and screenshots of settings. Check the files exist and aren't empty.
2. **Phase 2, install.** Webroot must be `/public`. Use a subdomain, not a subfolder. Set cron, `memory_limit` 1024M, and unblock `fpassthru`/`proc_*`. If `/setup` loops, switch to the command-line setup. The health check must be green before going on.
3. **Phase 3, import.** Order matters:
   1. clients (`merge_clients.php`, then the UI import, with **all** clients)
   2. projects, active, then archived with `--archive`
   3. `archive_fix.php` report
   4. client codes, rates and country
   5. time (`--limit=3` first)
   6. invoices (`--only=` on a few tricky ones first: one with a discount, one with tax, one closed unpaid)
   7. **`link_invoiced_tasks.php`**, which is mandatory. Without it, Invoice Project double-bills old time.
4. **Phase 4, numbering.** TEMP patterns, `.in_token` plus a permissions reset, `auto_numbers.php --dry`, then cron. Test end to end on a test client with an ID Number: a new project, then two draft invoices, which should come out as `CODE-1000` and `CODE-1000b`.
5. **Phases 5–6, payments and email.**
   - Stripe keys and the webhook with its 8 events and signing secret, then a real $1 payment, refunded afterward.
   - Clients need a country to see ACH.
   - Verify the *from* domain. Merge SPF includes, never duplicate them. Don't change root MX. Turn tracking off for invoice mail.
6. **Phase 7, comfort.** Task settings (time log and date off on invoice lines), products, modules, scheduled reports, the Tampermonkey tools (`@match` to their domain), and the SwiftBar timer (`BASE` and `TYPES`).
7. **Phases 8–9, optional local PDFs, then backups and updates.** Local PDFs need Chrome's system libraries and `proc_open`. Set up backups before relying on the system, and do one test restore.
8. **Phase 10, verify, then cancel Harvest** (ideally after year end). Disconnect Harvest from Stripe.

## Reading output: what "good" looks like

- **`import_projects` dry run:** "Would create" equals the rows minus internal projects. Any "Client not found" means a client wasn't imported, so fix that first.
- **`import_time --limit=3`:** open the tasks in the app. Check the date, hours, rate and "Type — notes" description. The Project dropdown can look blank on archived projects; confirm through the API that `project_id` is set rather than trusting the dropdown.
- **`import_invoices` dry run:** "PDFs matched" should be about the number of invoices, "Total mismatches: 0", and the only missing client should be their own company.
- **`link_invoiced_tasks`:** "No invoice found: 0". Then Invoice Project on an active project shows only unbilled lines.
- **Counts in list views lower than expected:** records belonging to archived clients are hidden from Invoice Ninja's lists. Check with search or `diagnose_projects.php` before assuming data is missing.

## Common errors → fix

| Error | Fix |
|---|---|
| `Call to undefined function … fpassthru()` | Remove it from `disable_functions` (PHP-FPM settings), or ask the host |
| `The Process class relies on proc_open` | Unblock `proc_open`, `proc_close` and `proc_terminate`. If it's blocked server-wide, the host has to lift it. |
| `Allowed memory size of 536870912 bytes exhausted` | `php_admin_value[memory_limit] = 1024M`, with no leading `;` |
| `Permission denied` on `storage/logs` when running artisan | Owner mismatch. Set permissions to master, run it, then set them back to the app user. |
| `libnss3.so: cannot open shared object file` | The host needs to install Chromium's libraries, or stay on hosted PDFs |
| `Could not open input file` | Wrong folder (scripts live in `private_html`), or the upload failed. Check `ls -la` for a 0-byte file. |
| Stray `v` at the end of commands | Browser SSH console paste bug. Use right-click → Paste, or a real terminal. |
| Test email in spam | Check SPF, DKIM and DMARC in the headers. A forwarded self-test softfails SPF, which is expected. Turn off tracking. |

## Tone

They're usually leaving Harvest over a price hike, so move fast and stay practical. Confirm what worked, explain an error in one line, and give the next command. When something is uncertain, like an Invoice Ninja menu name or a host's behavior, say so and give them a way to check.
