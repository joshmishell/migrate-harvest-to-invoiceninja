# Harvest → Invoice Ninja

Move a small studio or freelance business off **Harvest** and onto a **self-hosted Invoice Ninja**, keeping your whole history (clients, projects, every time entry, every invoice with its payment and original PDF), and adding back the Harvest workflow bits Invoice Ninja doesn't have out of the box.

Built and used for a real one-person studio migration of ~15 years of data: 136 clients, ~1,200 projects, ~6,000 time entries, ~1,300 invoices.

**Start here → [GUIDE.md](GUIDE.md)**. Using Claude? Point it at [skill/harvest-to-invoice-ninja/SKILL.md](skill/harvest-to-invoice-ninja/SKILL.md) and it will walk you through the whole thing.

## What you get

| | |
|---|---|
| **Full history import** | Clients + contacts, active and archived projects (with codes, rates, budgets), every time entry, every invoice with its payment date and the original Harvest PDF attached. No client emails are sent during import. |
| **No double billing** | Time you already billed in Harvest is linked to its invoice, so "invoice project" never pulls it again. |
| **Harvest-style numbering** | Projects `CLIENT-1000`, invoices named after their project: `ACME-1035`, then `ACME-1035b`, `c`… generated automatically. |
| **Harvest-style invoicing** | One click turns unbilled time into a draft invoice with **one line per task type**, notes listed under each, rounded to 15 minutes. |
| **Menu bar timer (macOS)** | Week timesheet, start/stop/edit entries, add time manually, idle and sleep detection. |
| **Browser tweaks** | Quarter-hour project totals, Edit/Delete on the Daily view, sidebar in your order, "Tasks" opens today's Daily view. |
| **Get everything out** | A Harvest API export for what the CSVs miss: invoice line items, every payment, estimates, expenses and receipts, email history, and per-year totals for taxes. |
| **Backups** | Nightly database and file backup, optionally encrypted to Dropbox. |

## Requirements

- A Harvest account with admin access (for the exports and an API token)
- A server for Invoice Ninja: PHP 8.2+, MySQL/MariaDB, HTTPS, cron, SSH. The guide uses **Cloudways**, but any PHP host or VPS works.
- A payment gateway (the guide covers **Stripe**: cards, ACH, Apple/Google Pay)
- A transactional email service (SMTP)
- Optional: macOS + [SwiftBar](https://swiftbar.app) for the menu bar timer; [Tampermonkey](https://www.tampermonkey.net) for the browser tools

## Layout

```
GUIDE.md                        the migration roadmap, step by step
skill/harvest-to-invoice-ninja/ SKILL.md for Claude
scripts/                        PHP + shell scripts you run on the server (over SSH)
  config.example.php            copy to config.php — your URL, company name, timezone
  harvest_export.php            full Harvest API export (run first; read-only)
  merge_clients.php             Harvest client + contact CSVs → Invoice Ninja import CSV
  import_projects.php           projects (active, then archived with --archive)
  archive_fix.php               verifies/repairs archiving
  import_time.php               time entries → tasks
  import_invoices.php           invoices + payments + original PDFs
  link_invoiced_tasks.php       marks Harvest-billed time as invoiced (prevents double billing)
  set_client_codes.php          fills each client's code (ID Number) from its project codes
  set_client_rates.php          default hourly rate per client from your Harvest history
  set_client_country.php        country/currency on every client (needed for ACH)
  create_products.php           task types as invoice "Service" items
  auto_numbers.php              cron job: Harvest-style project/invoice numbers
  diagnose_projects.php         read-only diagnostics
  backup_invoiceninja.sh        nightly backup (+ optional Dropbox via rclone)
tools/
  invoiceninja-tools.user.js    Tampermonkey script (browser tweaks + "Invoice unbilled time")
  invoiceninja-timer.10s.sh     SwiftBar menu bar timer
```

Every script that writes has a **dry run** by default and needs `--live` to change anything. Imports are **safe to re-run**: they skip what already exists.

## Important

- **Test first.** Every import script can do a dry run and a small test (`--limit` or `--only`). Look at those results in the app before running the full import.
- These scripts use Invoice Ninja's public API, and they were built against Invoice Ninja v5 (2026). A future Invoice Ninja release could change behavior, so check the dry runs.
- **Not affiliated with Harvest or Invoice Ninja.** "Harvest" and "Invoice Ninja" are trademarks of their owners. Invoice Ninja is source-available under the Elastic License 2.0. These scripts don't modify it or its licensing, and the white-label license is theirs to sell.
- No warranty. This is your financial data, so keep backups and your Harvest exports until you've verified everything.

## License

MIT © 2026 Fermentable Sugar LLC. See [LICENSE](LICENSE). Free to use, modify and share. Issues and pull requests welcome, especially fixes for other hosts and newer Invoice Ninja versions.
