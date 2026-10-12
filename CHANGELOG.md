# Changelog

Each tool is versioned on its own. To get an earlier version, open the file on GitHub → **History** and download it from that commit.

## Browser script — `tools/invoiceninja-tools.user.js`

- **3.7** Billing rounding with a 5-minute grace: each time entry rounds down to the quarter hour when 5 minutes or less past one, otherwise up; anything under 5 minutes bills 0:15. Used by Invoice unbilled time, project-list hours and To-do logged hours.
- **3.6** "See all projects" popup: sortable column headers (A–Z / Z–A), numeric-aware codes, blank dates last.
- **3.5** New Project: Client above Name, Project Number field filled from the client's code as soon as you pick the client, Highest / Most recent / Next (use) hint, "See all projects" popup. Duplicate project numbers are blocked on New and Edit Project (archived and deleted count). Needs the `unsafeWindow` grant.
- **3.4** To-do: project list refreshes on load, on ↻ and when a search finds nothing.
- **3.3** To-do: Waiting-on-client stop-sign button, script-drawn checkboxes, Due / Added column headers.
- **3.2** To-do: row colors (open / done), one play-pause button, Date added column.
- **3.1** To-do: project picker with "+ New project", 3-line add box, done items stay crossed out until "Clear completed", Trash with Restore.
- **3.0** To-do list at `/tasks#todo`: by project or Focus, drag to prioritize, due dates, quick add, timers. Fix: Invoice unbilled time no longer marks running or zero-hour tasks as billed.
- **2.4** Invoice numbers from the project code, set when the draft is created; Tasks views show "Client · Project" with a project link.
- **2.3** First public version: Invoice unbilled time, project number hint, Daily-view Edit/Delete, sidebar order, quarter-hour project hours.

## Menu bar timer — `tools/invoiceninja-timer.10s.sh`

- **2.9** Add time manually: one box with a calendar (any date, including past weeks) and the time field; Return = Add. `caltest` checks it from Terminal.
- **2.8** Notes box is a 3-line native box where Return = OK. Manual time accepts `.25`, `1:30`, `45`, `90m`.
- **2.7** Entry rows are clickable (start / open), so they no longer appear greyed out.
- **2.6** Solid green pill with white text while a timer runs (`./invoiceninja-timer.10s.sh pilltest` checks the drawing).
- **2.3** Errors show Invoice Ninja's own reason; ▶ on an entry Invoice Ninja refuses starts a new entry instead.
- **2.2** Click the running entry to stop it; its other actions sit on an "Edit this entry" row underneath.
- **2.1** First public version: week timesheet, idle detection, token in the macOS Keychain.

## Server scripts — `scripts/`

- `todo_digest.php` **1.2** Morning email; unbilled time uses the 5-minute rule. New: set `DIGEST_TO` in `config.php`.
- `auto_numbers.php` **1.1** Counts deleted invoices when choosing the next letter.
- `set_project_dates.php` **1.0** New. Real created dates for imported projects (Harvest → first time entry → first invoice); dry run, `--live`, `--undo`.
- `harvest_export.php` **1.0** Full Harvest API export.
- Import scripts, `backup_invoiceninja.sh`: **1.0**.
