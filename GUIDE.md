# Migrating from Harvest to self-hosted Invoice Ninja

This is the full roadmap, in the order that works. Plan on **a day** for the setup and imports (most of it is waiting on imports to run), plus a few evenings to make it feel like home.

Phases 1–2 are the only part that is slow or tricky. Phases 3–4 are just running scripts. Phases 5–9 are settings and conveniences.

- [Phase 0: Decide and prepare](#phase-0-decide-and-prepare)
- [Phase 1: Get everything out of Harvest](#phase-1-get-everything-out-of-harvest)
- [Phase 2: Install Invoice Ninja](#phase-2-install-invoice-ninja)
- [Phase 3: Import your history](#phase-3-import-your-history)
- [Phase 4: Project-code numbering (optional)](#phase-4-project-code-numbering-optional)
- [Phase 5: Payments (Stripe)](#phase-5-payments-stripe)
- [Phase 6: Email](#phase-6-email)
- [Phase 7: Make it feel like Harvest](#phase-7-make-it-feel-like-harvest)
- [Phase 8: PDFs on your own server (optional)](#phase-8-pdfs-on-your-own-server-optional)
- [Phase 9: Backups and updates](#phase-9-backups-and-updates)
- [Phase 10: Verify, then cancel Harvest](#phase-10-verify-then-cancel-harvest)
- [Troubleshooting](#troubleshooting)

---

## Phase 0: Decide and prepare

**Costs, roughly:**
- **Hosting:** the cost of a small managed server. You can also host it alongside sites you already run.
- **Invoice Ninja self-hosted:** free. Every feature is included.
- **White-label license:** $40/yr, optional. It removes Invoice Ninja's branding from the client portal, emails and PDFs.
- **Stripe:** its normal processing fees. Nothing goes to Invoice Ninja.
- **Transactional email:** usually free or a few dollars a month at low volume.

**What you give up compared with Harvest:**
- A weekly timesheet grid. The menu bar timer in this repo covers most of it.
- Grouped invoice lines out of the box. The browser tool in this repo adds them.
- Project progress emails to clients.

**Things to decide now:**
1. **Where to host.** The guide assumes Cloudways (managed, with SSH). Any host with PHP 8.2+, MySQL, cron and SSH works.
2. **Address.** Invoice Ninja must live at the root of a domain or subdomain, for example `billing.yourdomain.com`. It can't live in a subfolder.
3. **Timing.** Keep Harvest until your year-end records are done. Run both side by side for a while.

---

## Phase 1: Get everything out of Harvest

Do this first, while your subscription is active. Harvest's menus move around, so if a label below doesn't match, look for **Export** on that page.

### 1a. CSV exports (the imports use these)

| File | Where in Harvest |
|---|---|
| `harvest_client_list.csv` | Manage → Clients → Export |
| `harvest_contact_list.csv` | Manage → Clients → Export contacts |
| `harvest_project_list.csv` | Projects → Export (**active** projects) |
| `harvest_project_list_archived.csv` | Projects → filter **Archived** → Export |
| `harvest_time_report.csv` | Reports → Time → **Detailed report**, all time, all clients → Export CSV |
| `harvest_invoice_report.csv` | Invoices → filter **All** invoices, all time → Export CSV |
| `harvest_invoice_pack.zip` | Invoices → select all → download PDFs. Filenames look like `123456_yourco_invoice_ABC_1000.pdf` |

Rename your files to match the names above, or pass your own names to the scripts.

### 1b. The API export (everything the CSVs miss)

The CSVs leave out invoice line items, individual payments (dates, Stripe IDs), estimates, expenses and receipts, email history, and **which invoice each time entry was billed on**. `scripts/harvest_export.php` pulls all of it through Harvest's API. It's read-only.

1. Create a personal access token at **id.getharvest.com/developers**. The same page shows your **Account ID**.
2. Run the export. It can go on the server after Phase 2, or on any computer with PHP:
   ```bash
   php harvest_export.php
   ```
   It asks for the token and Account ID, and writes `harvest_export/DATE/`:
   - one full JSON file per data type
   - `invoice_line_items.csv`, `invoice_payments.csv`, `time_entries.csv`, `estimates.csv`, `expenses.csv`
   - `totals_by_year.csv`: invoiced, cash received and hours per year. Your accountant will like this one.
   - estimate PDFs and expense receipts

### 1c. Things you copy by hand

Screenshot or copy these, since no export includes them: invoice and estimate email templates, default invoice notes and terms, tax rates, reminder settings, and your task list with its billable/non-billable settings.

**Store all of it somewhere permanent** (NAS, cloud drive) before you go further. It's your whole business history.

---

## Phase 2: Install Invoice Ninja

### 2a. Create the app (Cloudways)
1. **Add Application → Custom PHP**, on a server running **PHP 8.2+**. On Cloudways the PHP version is server-wide, so check your other sites are compatible.
2. **Application Settings → Webroot:** `public_html/public`.
3. **DNS:** add an A record `billing` pointing to the server IP. Then **Domain Management:** set `billing.yourdomain.com` as the primary domain, and **SSL:** issue a Let's Encrypt certificate.

### 2b. Upload over SSH
Use Mac Terminal, not the browser SSH console; see [Troubleshooting](#troubleshooting). Log in with the **Master Credentials**.
```bash
cd ~/applications/YOUR_APP_FOLDER/public_html    # folder name = the app's DB name in Access Details
rm -rf public index.php                            # Cloudways placeholder
wget https://github.com/invoiceninja/invoiceninja/releases/latest/download/invoiceninja.tar
tar -xf invoiceninja.tar && rm invoiceninja.tar
cp .env.example .env
```
Then in Cloudways: **Application Settings → Reset File Permissions → application user**.

### 2c. Setup
Open `https://billing.yourdomain.com/setup`. Database host: `localhost`. The database name, user and password are in the app's **Access Details**. **Type the password by hand**, because pasting often breaks it.

**If setup just reloads itself,** finish it from the command line instead:
1. Set permissions to the **master user**.
2. Run:
   ```bash
   php artisan migrate --force
   php artisan db:seed --force
   php artisan ninja:create-account --email=you@yourdomain.com --password='TEMPORARY'
   php artisan optimize
   ```
3. Set permissions back to the **app user**.
4. Log in and **change that password immediately**.

### 2d. Server settings (Cloudways PHP-FPM settings box)
```
php_admin_value[memory_limit] = 1024M
```
Lines starting with `;` are ignored, so check the line has none. Then, in the `disable_functions` line, **remove** `proc_open`, `proc_close`, `proc_terminate` and `fpassthru` if they're present. Invoice Ninja needs them:
- `fpassthru` lets you view or download attached files. Without it you get "Server not reachable".
- The `proc_*` functions are needed for local PDFs (Phase 8).

If they're blocked server-wide, ask Cloudways support to enable them for your app.

### 2e. Cron (required)
Add this in **Cron Job Management → Advanced**:
```
* * * * * cd /home/master/applications/YOUR_APP_FOLDER/public_html && php artisan schedule:run >> /dev/null 2>&1
```

### 2f. Health check
Click the ⓘ icon at the bottom left of Invoice Ninja. Everything should be green, and **Memory** should show 1024M.

---

## Phase 3: Import your history

### 3a. Put the scripts on the server
Upload `scripts/` into `~/applications/YOUR_APP_FOLDER/private_html/`. That folder isn't reachable from the web, which keeps your client data private. Upload your Harvest CSVs and the PDF zip there too. Then:
```bash
cd ~/applications/YOUR_APP_FOLDER/private_html
cp config.example.php config.php && nano config.php      # your URL, your company name, timezone
```
Create an API token in Invoice Ninja: **Settings → Account Management → API Tokens**. Then store it for this session:
```bash
read -s IN_TOKEN && export IN_TOKEN       # paste token, press Enter (nothing shows)
```

**How every import script works:**
- Run it with no flags for a **dry run** that changes nothing.
- Add `--limit=N` or `--only=…` to create a few records, then check them in the app.
- Add `--live` to run the whole thing.
- Each script is **safe to re-run**; it skips what already exists.

### 3b. Clients
```bash
php merge_clients.php harvest_client_list.csv harvest_contact_list.csv
```
This makes `invoiceninja_clients_import.csv`. It splits Harvest's free-text addresses into street, city, state and ZIP, and picks each client's primary contact, preferring whoever Harvest marked as the invoice recipient. Import it in Invoice Ninja under **Clients → Import**, mapping each column to the matching **Client** or **Contact** field. **Import all clients, dead ones too,** or old projects and invoices will have nothing to attach to. Contacts beyond the first go in `extra_contacts_add_by_hand.csv`.

Open the CSV in a text editor or Numbers, **not Excel**, which strips the leading zeros from ZIP codes.

### 3c. Projects
```bash
php import_projects.php harvest_project_list.csv                     # dry run
php import_projects.php harvest_project_list.csv --live
php import_projects.php harvest_project_list_archived.csv --live --archive
php archive_fix.php harvest_project_list_archived.csv                # report; add --live to repair
```
Each project gets:
- its Harvest code as the project number (duplicate codes get `-2` added)
- an hourly rate worked out from its billable amount and hours
- the Harvest history in its private notes: dates, hours, amount billed and invoiced, budget

### 3d. Client codes, rates, country, task types
```bash
php set_client_codes.php --live        # client "ID Number" = its project code prefix (ACME, GLOBEX…)
php set_client_rates.php harvest_time_report.csv --live   # default rate = last rate you billed them
php set_client_country.php --live      # US + USD where missing (clients need a country to see ACH)
php create_products.php --live         # your task types in the invoice "Service" picker
```
Check the dry-run output of `set_client_codes.php` for codes you don't recognize before running it with `--live`.

### 3e. Time
```bash
php import_time.php harvest_time_report.csv              # dry run
php import_time.php harvest_time_report.csv --limit=3    # then look at 3 tasks in the app
php import_time.php harvest_time_report.csv --live       # ~5,000 entries ≈ 30–45 min
```
- Each time entry becomes a task, using Harvest's **rounded** hours at 9:00 am on its date. Harvest's CSV doesn't include clock times.
- **Unbilled, billable time on active projects stays active,** ready to invoice.
- **Everything else is archived:** time already invoiced, non-billable time, and time on old projects.
- The script keeps a log file, so if it stops partway, run it again and it picks up where it left off.

### 3f. Invoices
```bash
unzip -q harvest_invoice_pack.zip -d invoice_pdfs && ls invoice_pdfs | wc -l
php import_invoices.php harvest_invoice_report.csv --pdfs=invoice_pdfs                          # dry run
php import_invoices.php harvest_invoice_report.csv --pdfs=invoice_pdfs --only=ABC-1000,ABC-1001b
php import_invoices.php harvest_invoice_report.csv --pdfs=invoice_pdfs --live
```
For each invoice it:
- keeps its Harvest invoice number and issue date
- links it to the project whose code matches the invoice number (`ABC-1001b` links to `ABC-1001`)
- records the payment on Harvest's payment date
- cancels invoices that were **closed without payment**, so they show no balance and trigger no reminders
- attaches the original PDF as a private document

It **sends no email**: invoices are marked as sent without being emailed, and payments use `email_receipt=false`.

Harvest's CSV has totals only, so each invoice gets one summary line, plus a tax line where there was tax. The attached PDF has the full detail, and the line items are in your API export.

### 3g. Link billed time to invoices ← don't skip this
```bash
php link_invoiced_tasks.php               # dry run
php link_invoiced_tasks.php --limit=3
php link_invoiced_tasks.php --live
```
Without this step, Invoice Ninja's **Invoice project** pulls your **already-billed Harvest time onto new invoices**. The script links each billed entry to the most likely imported invoice: the project's first invoice dated on or after the time entry, falling back to the same client.

---

### Real project dates
The API can't set created dates, so every imported project shows the import day. `set_project_dates.php` fixes that in the database: Harvest's own created date (from `harvest_export/<date>/projects.json`), otherwise the project's first time entry or first invoice. It only moves dates earlier, and a live run writes an undo file first. Take a server backup before running it live.
```bash
php set_project_dates.php --harvest=harvest_export/2026-10-02/projects.json          # dry run
php set_project_dates.php --harvest=harvest_export/2026-10-02/projects.json --live   # apply
```

## Phase 4: Project-code numbering (optional)

Your imported projects and invoices keep whatever numbers they had in Harvest. This phase is about numbering **new** ones.

Harvest itself numbers invoices with a simple counter, and project codes are whatever you type in. If that's how you worked, a counter in Invoice Ninja (**Settings → Generated Numbers**, for example `{$counter}` or `{$year}-{$counter}`) is all you need, so skip this phase.

This phase is for a convention some people layer on top of Harvest: **project codes per client** (`ACME-1000`, `ACME-1001`…), with **each invoice named after its project**. The first invoice gets the bare code, `ACME-1035`, and follow-ups get `ACME-1035b`, `ACME-1035c`… That fits ongoing projects billed in installments.

Invoice Ninja's number patterns can't use a project's number, so a cron job does it:
1. **Settings → Generated Numbers:**
   - **Projects** pattern: `TEMP-{$counter}`
   - **Invoices** pattern: `TEMP-{$counter}`
   - If there's a **Generate Number** option, set it to **When Saved**.
2. **Store the token for cron:**
   ```bash
   printf '%s' "$IN_TOKEN" > .in_token && chmod 600 .in_token
   ```
   Then **Reset File Permissions** to the app user.
3. **Test it:** `php auto_numbers.php --dry`
4. **Add the cron line:**
   ```
   * * * * * cd /home/master/applications/YOUR_APP_FOLDER/private_html && php auto_numbers.php >> auto_numbers.log 2>&1
   ```

How it behaves:
- New projects get the client's code (its **ID Number** field) followed by the next free number.
- **Draft** invoices with a project get renamed within a minute. **Save as draft, wait for the number, then send.** It never renames an invoice that's already been sent.
- For a new client, put their code in the **ID Number** field first.

---

## Phase 5: Payments (Stripe)

1. **Settings → Online Payments → Add Gateway → Stripe.**
   - **API Key** = your secret key (`sk_live_…`). **Publishable Key** = `pk_live_…`.
   - If Harvest connected to Stripe for you, you never saw these keys. Get them from **Stripe → Developers → API keys**.
2. **Enable Credit Card and ACH.** Also enable **ACH Direct Debit** in **Stripe → Settings → Payment methods**. ACH only appears for clients with a **country** set.
3. **Webhook:**
   - In **Stripe → Developers → Webhooks** (the Workbench), add a destination with the URL shown on Invoice Ninja's Stripe gateway screen.
   - Select these events: `source.chargeable`, `charge.succeeded`, `charge.failed`, `customer.source.updated`, `payment_intent.processing`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.partially_funded`.
   - Paste the destination's **Signing secret** (`whsec_…`) into Invoice Ninja's **Webhook Secret** field.
4. **Apple Pay (optional):** register your billing domain in **Stripe → Payment method domains**. If it shows as enabled, you're done.
5. **Receipts and alerts:**
   - **Settings → Payment Settings:** turn on **Client Online Payment Notification**, so clients get receipts.
   - **Settings → User Details → Notifications:** turn on Payment Success, Payment Failure and Invoice Viewed, so you get alerts.
6. **Test with a real $1 payment,** then refund it in Stripe.

**Cutting card fees:**
- Standard Stripe cards cost 2.9% + 30¢. ACH costs 0.8%, capped at $5, so on an $8,000 invoice that's about $232 by card versus $5 by ACH.
- The best lever is setting a **maximum amount for Credit Card** on the gateway's **Limits/Fees** tab. Above it, clients only see ACH.
- Apple Pay and Google Pay are card payments, at card prices.
- **Be careful with surcharges.** Rules vary by state; for example, Colorado caps them at 2% and bans them on debit cards. Invoice Ninja's fee setting can't tell debit from credit. A discount for paying by ACH is the safer approach. This isn't legal advice.

---

## Phase 6: Email

- **Settings → Email Settings → SMTP**, using your transactional email provider (Postmark, Mailgun, SES, Brevo, Elastic Email…).
- **Verify the domain you send *from*,** such as `you@yourdomain.com`, not the billing subdomain.
- Add the provider's DKIM record. **Merge** its SPF include into your existing SPF record; never create two SPF records.
- **Don't change your root MX records** to satisfy a provider's checklist, or your mailbox stops receiving mail.
- **Turn off open and click tracking and the unsubscribe link** for invoice mail. Those make invoices look like marketing and push them toward spam.
- Test by sending to an address that isn't yours and isn't forwarded. Mail you send to yourself and then forward is a poor test of spam filtering.

---

## Phase 7: Make it feel like Harvest

### Settings checklist
- **Payment Settings:** Payment Terms (for example Net 15).
- **Task Settings:**
  - Turn **off** "time log" and "date" on invoice lines. Otherwise invoice lines show raw `<div>` time details.
  - Turn **on** task description and hours.
- **Product Settings:** **Fill Products** on, **Update Products** off. With Update on, every typed line item becomes a product.
- **Localization:** timezone and date format.
- **Account Management → Enabled Modules:** turn off what you don't use (Vendors, Purchase Orders…) to clean up the sidebar.
- **Schedules → Email Report:** a weekly Tasks report (your hours) and a monthly aging report (who owes you).
- **Invoice Design → Custom Designs:** your own HTML/CSS invoice. Keep a copy of the code outside the app.

### Browser tools (`tools/invoiceninja-tools.user.js`)
Install [Tampermonkey](https://www.tampermonkey.net). In Chrome, also turn on **Allow User Scripts** under the extension's details. Create a new script, paste the file in, change the `@match` line to your address, and save. It asks for your API token once. It adds:
- **Invoice unbilled time** (bottom-right of a project page): one line per task type with the notes listed underneath, each entry in 15-minute steps (up to the next quarter hour, or down when 5 minutes or less past one; under 5 minutes bills 0:15 — change `roundEntry` if your contract says otherwise). With project-code numbering on, the draft is numbered from the project (`ACME-1035`, then `b`, `c`…). The time is marked as billed and a draft opens. **Release tracked time** on a draft invoice undoes it.
- Project hours to the quarter hour on the Projects list.
- **Edit** and **Delete** on each row of the Tasks Daily view.
- Sidebar in your order, set in `SIDEBAR_ORDER`, and **Tasks** opens today's Daily view.
- **Project numbers:** on New Project, Client moves above Name and a Project Number field fills in the client's next code as soon as you pick the client; Edit Project gets the same hint. Both have a **See all projects** popup (sortable) and block duplicate numbers. Tampermonkey will ask to allow `unsafeWindow`; that's how the number is saved with the project.
- **Tasks pages** show "Client · Project" with the project clickable.
- **To-do list** (sidebar **To-do**): see below.

### To-do list
A prioritized list of what has to be done, kept as Invoice Ninja tasks so it's backed up with everything else.
1. **Settings → Custom Fields → Tasks:** field 1 **Due** (type *Date*), field 2 **To-do rank** (type *Single line text*).
2. Open **To-do** in the sidebar. Add to-dos with a project, type and due date; the first line is the title, anything below it notes.
3. Drag ⋮⋮ to set priority (drag a project header to move the whole project); **Focus** shows one list across projects.
4. ▶ starts a timer as a normal time entry on that project, so the to-do itself never gets locked to an invoice. The stop sign marks it *waiting on client*; the checkbox crosses it out until **Clear completed**; the trash can moves it to a Trash you can restore from.

### Morning email (`scripts/todo_digest.php`)
An 8:30am weekday email with to-dos overdue / due today / this week / up next, invoices outstanding, overdue and paid since the last email, unsent drafts and unbilled time. It sends through the SMTP account in Invoice Ninja's `.env`. Set `DIGEST_TO` in `config.php`, check it with `php todo_digest.php --preview`, send a test with `--now`, then add the cron line from the top of the file (every 5 minutes; the script sends once a day at 8:30 in your `TIMEZONE`).

### Menu bar timer (`tools/invoiceninja-timer.10s.sh`, macOS)
1. Install [SwiftBar](https://swiftbar.app).
2. Store the token in your Keychain:
   ```bash
   security add-generic-password -s invoiceninja-swiftbar -a "$USER" -w 'TOKEN'
   ```
3. Set `BASE` at the top of the file to your address, and edit `TYPES` to your task types.
4. Drop the file in SwiftBar's plugins folder and run `chmod +x` on it.

It gives you a week timesheet with daily totals, start/stop (click the running entry to stop it), editing of notes, time, type and project, deleting entries, adding time manually on any date from a calendar (`1:30`, `1.5`, `.25`, `45`, `90m`), a solid green pill in the menu bar while timing, and an idle/sleep prompt after 10 minutes (`IDLE_MIN`). If the pill doesn't appear, run `./invoiceninja-timer.10s.sh pilltest` in Terminal; it says which drawing step failed. Time saved as "Type — notes" is grouped by the **Invoice unbilled time** button.

**On a phone,** open your billing address in Safari, use **Share → Add to Home Screen**, and use the web app's timer.

---

## Phase 8: PDFs on your own server (optional)

By default Invoice Ninja renders PDFs on **its own servers** (`pdf.invoicing.co`), which means each invoice's content leaves your server. To keep it local, use Snappdf, which needs Chrome running on your server.

1. **Download Chrome and move it** somewhere updates won't delete it:
   ```bash
   cd ~/applications/YOUR_APP_FOLDER/public_html
   ./vendor/bin/snappdf download
   mkdir -p ../private_html/chromium && cp -r vendor/beganovich/snappdf/versions/* ../private_html/chromium/
   find ../private_html/chromium -name chrome -type f          # note the full path
   ```
2. **Test it:**
   ```bash
   /FULL/PATH/chrome --headless --no-sandbox --dump-dom about:blank
   ```
   - **Success** prints `<html><head></head><body></body></html>`. The WARNING lines around it are normal.
   - **"error while loading shared libraries: libnss3.so"** means you need your host to install Chromium's system libraries: libnss3, libnspr4, libatk1.0-0, libatk-bridge2.0-0, libcups2, libxkbcommon0, libxcomposite1, libxdamage1, libxrandr2, libgbm1, libpango-1.0-0, libasound2.
3. **Set it in `.env`,** then run `php artisan optimize`:
   ```
   PDF_GENERATOR=snappdf
   SNAPPDF_EXECUTABLE_PATH=/FULL/PATH/chrome
   ```
4. **Check it:** view an invoice PDF, and the health check should say Snappdf. If it fails, `storage/logs/laravel.log` usually says `proc_open` is disabled (see Phase 2d). To roll back, set `PDF_GENERATOR=hosted_ninja`.

---

## Phase 9: Backups and updates

**Backups.** `scripts/backup_invoiceninja.sh` runs nightly and saves:
- a full database dump
- `storage/app` (your uploaded PDFs and logo)
- `.env` (which holds `APP_KEY`, needed to restore)

It keeps 14 days, and can also copy each night's backup to Dropbox with rclone, encrypted with an rclone `crypt` remote. The setup is in the comments at the top of the script. Cron line:
```
15 2 * * * bash /home/master/applications/YOUR_APP_FOLDER/private_html/backup_invoiceninja.sh >> /home/master/applications/YOUR_APP_FOLDER/private_html/backups/backup.log 2>&1
```
Do a test restore at least once: unzip a dump and look for your clients.

**Updates.** Use the in-app updater. Before each update:
1. Back up.
2. **Reset File Permissions** to the app user. The updater fails silently on files owned by another user.
3. Check memory is 1024M.

After updating, make a draft invoice on a test project and check that the numbering, **Invoice unbilled time** and the timer still work. Everything in this repo lives outside the app folder, so updates don't overwrite it.

---

## Phase 10: Verify, then cancel Harvest

- [ ] Client, project, invoice and task counts match your Harvest exports
- [ ] A few old invoices: right total, paid date, PDF attached. Check one with a discount, one with tax, and one closed without payment.
- [ ] **Invoice project** or **Invoice unbilled time** on an active project shows only unbilled time
- [ ] `totals_by_year.csv` from the API export matches Invoice Ninja's reports for past years
- [ ] A real client payment by ACH marks itself paid (checks the webhook)
- [ ] The backup ran, and a restore works
- [ ] **Stripe → connected apps:** disconnect Harvest once its last invoices are paid
- [ ] Keep your Harvest exports forever. Cancel after year end.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Commands end in a stray `v` (`downloadv`, `.logv`) | The Cloudways **browser** SSH console registers Cmd+V's `v` as a keystroke. Use right-click → Paste, or Mac Terminal. |
| "Login incorrect" or "Access denied" with correct credentials | Pasting mangles passwords. Type them by hand. Too many failures can also lock out your IP for a while. |
| `/setup` keeps reloading | Wrong DB password, or a permissions clash. Use the command-line setup in Phase 2c. |
| `Permission denied` on `storage/logs` when running `artisan` | Files are owned by the app user and you're logged in as master. Reset permissions to master, run the command, then reset back to the app user. |
| Only a few languages in the setup dropdown | The seed step didn't run. Run `php artisan db:seed --force`, then `php artisan cache:clear`, then log out and back in. |
| Redirected to `/setup` after changing the DB password | `.env` still has the old password, and it's cached. Update `.env`, then run `php artisan optimize:clear && php artisan optimize`. |
| "Server not reachable" when viewing a PDF or document | `fpassthru` is disabled (Phase 2d). |
| "Allowed memory size … exhausted" | Set `memory_limit` to 1024M, and check the line doesn't start with `;`. |
| Archived projects or invoices missing from lists, but search finds them | Invoice Ninja hides records belonging to **archived clients** from list views. Unarchive the client, or use search or the client's page. |
| Invoice project pulls old Harvest time | You skipped Phase 3g. |
| Number stays `TEMP-…` | The cron isn't running, `.in_token` is missing or unreadable, the invoice was sent before the rename, or it has no project. Check `auto_numbers.log`. |
| No ACH option for a client | The client has no country, or ACH isn't enabled on the gateway or in Stripe. |
| Test email goes to spam | Tracking is on, the sending domain isn't verified, or you're forwarding to yourself. Check SPF, DKIM and DMARC in the message headers. |
