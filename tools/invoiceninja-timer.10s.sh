#!/bin/bash
# <xbar.title>Invoice Ninja timer</xbar.title>
# <xbar.version>2.9</xbar.version>
# <xbar.author>migrate-harvest-to-invoiceninja</xbar.author>
# <xbar.desc>Harvest-style week timesheet + timer for self-hosted Invoice Ninja.</xbar.desc>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideDisablePlugin>true</swiftbar.hideDisablePlugin>
# <swiftbar.hideLastUpdated>true</swiftbar.hideLastUpdated>
#
# Setup (once), in Terminal:
#   security add-generic-password -s invoiceninja-swiftbar -a "$USER" -w 'YOUR_API_TOKEN'
#
# Each entry is an Invoice Ninja task on a project, described "Task Type — notes",
# which the "Invoice unbilled time" browser button groups into one line per task type.

exec /usr/bin/osascript -l JavaScript - "$0" "$@" <<'JXA'
ObjC.import('Foundation');
ObjC.import('AppKit');

const BASE  = 'https://billing.example.com';
const TYPES = ['Production Design', 'Creative', 'Web Development', 'Client Meeting', 'Project Management',
               'Art Direction', 'Concepting', 'Copywriting', 'Photography', 'Research', 'Video Development', 'Admin'];
const NON_BILLABLE = ['Admin'];
const CACHE_MIN = 10;               // project list refresh
const IDLE_MIN  = 10;               // ask about idle time after this many minutes away (0 = off)
const MONO = 'font=SFMono-Regular size=13';
const GRAY = 'color=#8E8E93';

const app = Application.currentApplication();
app.includeStandardAdditions = true;
const cacheDir = $.NSHomeDirectory().js + '/Library/Caches/invoiceninja-swiftbar';

// ---------------- plumbing ----------------
const shq = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
const sh  = cmd => app.doShellScript(cmd);
let TOKEN = null;
function token() {
  if (TOKEN === null) { try { TOKEN = sh('security find-generic-password -s invoiceninja-swiftbar -w'); } catch (e) { TOKEN = ''; } }
  return TOKEN;
}
function api(method, path, body) {
  let cmd = 'curl -sS --max-time 20 -X ' + method + ' ' + shq(BASE + '/api/v1' + path) +
    ' -H ' + shq('X-API-TOKEN: ' + token()) + ' -H "X-Requested-With: XMLHttpRequest" -H "Accept: application/json"' +
    ' -H "Content-Type: application/json" -w "\\n%{http_code}"';
  if (body) cmd += ' --data-binary ' + shq(JSON.stringify(body));
  const out = sh(cmd).split(/\r\n|\r|\n/);
  const code = +out.pop(); const text = out.join('\n');
  if (code < 200 || code >= 300) {
    let why = '';
    try {
      const j = JSON.parse(text);
      const errs = j.errors ? Object.keys(j.errors).map(k => k + ': ' + [].concat(j.errors[k]).join(' ')).join('\n') : '';
      why = [j.message, errs].filter(Boolean).join('\n');
    } catch (e) { why = text.slice(0, 200); }
    const err = new Error('HTTP ' + code + ' on ' + path + (why ? '\n\n' + why : ''));
    err.code = code; throw err;
  }
  return text ? JSON.parse(text) : {};
}
function readFile(p) { const s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null); return s.isNil() ? null : s.js; }
function writeFile(p, s) { sh('mkdir -p ' + shq(cacheDir)); $(s).writeToFileAtomicallyEncodingError(p, true, $.NSUTF8StringEncoding, null); }
function state(patch) {
  const f = cacheDir + '/state.json'; let s = {};
  try { s = JSON.parse(readFile(f) || '{}'); } catch (e) {}
  if (patch) { Object.assign(s, patch); writeFile(f, JSON.stringify(s)); }
  return s;
}
const now = () => Math.floor(Date.now() / 1000);

// ---------------- dates ----------------
const DAY = 86400000;
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function weekStart(offset) { const t = startOfDay(new Date()); const dow = (t.getDay() + 6) % 7; return new Date(t.getTime() - dow * DAY + (offset || 0) * 7 * DAY); }
const dayKey = d => { const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = d => DOW[d.getDay()] + ' ' + MON[d.getMonth()] + ' ' + d.getDate();
const fmt = s => { s = Math.max(0, Math.round(s / 60) * 60); return Math.floor(s / 3600) + ':' + String(Math.floor(s % 3600 / 60)).padStart(2, '0'); };
function parseDuration(txt) {                      // "1:30", "1.5", "90m", "45" (minutes if > 12)
  txt = String(txt).trim().toLowerCase();
  let m;
  if ((m = txt.match(/^(\d+):(\d{1,2})$/))) return (+m[1]) * 3600 + (+m[2]) * 60;
  if ((m = txt.match(/^(\d+\.?\d*|\.\d+)\s*h?$/))) { const v = +m[1]; return v > 12 ? v * 60 : v * 3600; }   // also ".25"
  if ((m = txt.match(/^(\d+)\s*m(in)?$/))) return (+m[1]) * 60;
  return null;
}

// ---------------- data ----------------
function projects(force) {
  const f = cacheDir + '/projects.json'; const cached = readFile(f);
  if (cached && !force) { const c = JSON.parse(cached); if (now() - c.at < CACHE_MIN * 60) return c.list; }
  const clients = {};
  api('GET', '/clients?per_page=500&status=active').data.forEach(c => clients[c.id] = { name: c.display_name || c.name, rate: +(c.settings && c.settings.default_task_rate) || 0 });
  const list = api('GET', '/projects?per_page=500&status=active').data.filter(p => clients[p.client_id])
    .map(p => ({ id: p.id, client_id: p.client_id, client: clients[p.client_id].name, number: p.number || '', name: p.name, rate: +p.task_rate || clients[p.client_id].rate }))
    .sort((a, b) => (a.client + a.number).localeCompare(b.client + b.number));
  writeFile(f, JSON.stringify({ at: now(), list }));
  return list;
}
function tasks(count) { return api('GET', '/tasks?per_page=' + (count || 100) + '&status=active,archived&sort=updated_at|desc').data.filter(t => !t.is_deleted); }
const logOf = t => { try { return JSON.parse(t.time_log || '[]'); } catch (e) { return []; } };
const openIdx = t => { const l = logOf(t); for (let i = l.length - 1; i >= 0; i--) if (l[i][0] && !l[i][1]) return i; return -1; };
function split(desc) {
  const d = String(desc || '').replace(/<[^>]+>/g, '').replace(/\[Invoiced in Harvest\]/g, '').trim();
  const i = d.indexOf(' — ');
  if (i > 0 && TYPES.indexOf(d.slice(0, i)) >= 0) return { type: d.slice(0, i), notes: d.slice(i + 3) };
  if (TYPES.indexOf(d) >= 0) return { type: d, notes: '' };
  return { type: '', notes: d };
}
const joinDesc = (type, notes) => (type || 'Services') + (notes ? ' — ' + notes : '');

// one timesheet row per task per day, like Harvest
function rowsForWeek(ts, ws) {
  const we = ws.getTime() + 7 * DAY; const rows = [];
  ts.forEach(t => {
    const byDay = {};
    logOf(t).forEach((e, i) => {
      const ms = e[0] * 1000; if (ms < ws.getTime() || ms >= we) return;
      const k = dayKey(ms);
      (byDay[k] = byDay[k] || { secs: 0, running: false, idx: [] });
      byDay[k].secs += (e[1] || now()) - e[0]; byDay[k].idx.push(i);
      if (!e[1]) byDay[k].running = true;
    });
    Object.keys(byDay).forEach(k => rows.push(Object.assign({ task: t, day: k }, byDay[k])));
  });
  return rows.sort((a, b) => a.task.id < b.task.id ? -1 : 1);
}

// ---------------- dialogs ----------------
function front() { app.activate(); }
function chooseType(current, title) {
  front();
  const r = app.chooseFromList(TYPES, { withTitle: title || 'Task type', withPrompt: 'Task type:', defaultItems: [current && TYPES.indexOf(current) >= 0 ? current : TYPES[0]] });
  return r ? r[0] : null;
}
function askText(prompt, title, def) {
  front();
  try { return app.displayDialog(prompt, { withTitle: title, defaultAnswer: def || '', buttons: ['Cancel', 'OK'], defaultButton: 'OK' }).textReturned.trim(); }
  catch (e) { return null; }
}
// Notes: a 3-line box where Return clicks OK (a native alert; falls back to a one-line box if that can't open)
function askNotes(prompt, title, def) {
  try { return notesAlert(prompt, title, def); }
  catch (e) {
    front();
    try { return app.displayDialog(prompt, { withTitle: title, defaultAnswer: String(def || '').replace(/\s*\n+\s*/g, ' '), buttons: ['Cancel', 'OK'], defaultButton: 'OK' }).textReturned.trim(); }
    catch (x) { return null; }
  }
}
function notesAlert(prompt, title, def) {
  const nsapp = $.NSApplication.sharedApplication;
  front(); nsapp.activateIgnoringOtherApps(true);
  const alert = $.NSAlert.alloc.init;
  alert.setMessageText($(title || 'Notes'));
  alert.setInformativeText($(prompt || ''));
  alert.addButtonWithTitle($('OK'));          // first button = Return
  alert.addButtonWithTitle($('Cancel'));      // second = Escape
  const f = $.NSTextField.alloc.initWithFrame($.NSMakeRect(0, 0, 360, 58));   // ~3 lines; text wraps
  f.setStringValue($(String(def || '').replace(/\s*\n+\s*/g, ' ')));
  f.setPlaceholderString($('Notes'));
  f.setUsesSingleLineMode(false);
  f.cell.setWraps(true);
  f.cell.setScrollable(false);
  alert.setAccessoryView(f);
  alert.window.setInitialFirstResponder(f);
  const r = alert.runModal;
  if (Number(r) !== 1000) return null;
  return String(f.stringValue.js || '').trim();
}
// Add time manually: one box with a calendar (any date) and the time field. Return = OK.
function askTimeAndDay(title, defDay) {
  let typed = '';
  for (;;) {
    const nsapp = $.NSApplication.sharedApplication;
    front(); nsapp.activateIgnoringOtherApps(true);
    const alert = $.NSAlert.alloc.init;
    alert.setMessageText($(title || 'Add time'));
    alert.setInformativeText($('Pick the day, then enter the time (1:30, 1.5, .25, 45, 90m).'));
    alert.addButtonWithTitle($('Add'));
    alert.addButtonWithTitle($('Cancel'));
    const cal = $.NSDatePicker.alloc.initWithFrame($.NSMakeRect(0, 0, 10, 10));
    cal.setDatePickerStyle(1);                 // graphical calendar
    cal.setDatePickerElements(0x00e0);         // year, month, day
    cal.setDateValue($.NSDate.dateWithTimeIntervalSince1970(defDay.getTime() / 1000 + 12 * 3600));
    cal.sizeToFit;
    const cw = cal.frame.size.width, ch = cal.frame.size.height;
    const W = Math.max(260, cw), FH = 24, GAP = 10;
    const box = $.NSView.alloc.initWithFrame($.NSMakeRect(0, 0, W, ch + GAP + FH));
    cal.setFrameOrigin($.NSMakePoint(Math.round((W - cw) / 2), FH + GAP));
    const f = $.NSTextField.alloc.initWithFrame($.NSMakeRect(0, 0, W, FH));
    f.setPlaceholderString($('Time, e.g. 1:30 or .25'));
    if (typed) f.setStringValue($(typed));
    box.addSubview(cal); box.addSubview(f);
    alert.setAccessoryView(box);
    alert.window.setInitialFirstResponder(f);
    if (Number(alert.runModal) !== 1000) return null;
    typed = String(f.stringValue.js || '').trim();
    const secs = parseDuration(typed);
    if (secs !== null && secs > 0) return { secs, day: new Date(cal.dateValue.timeIntervalSince1970 * 1000) };
    front(); app.displayAlert('Couldn\'t read "' + typed + '" as a time.');
  }
}
// Fallback if the calendar box can't open: time, then a list of the last 14 days
function askTimeAndDayList(defDay) {
  const secs = askDuration(''); if (!secs) return null;
  const days = []; for (let i = 0; i < 14; i++) days.push(new Date(startOfDay(new Date()).getTime() - i * DAY));
  const labels = days.map(dayLabel); const want = dayLabel(startOfDay(defDay));
  front();
  const pick = app.chooseFromList(labels, { withTitle: 'Day', withPrompt: 'Which day?', defaultItems: [labels.indexOf(want) >= 0 ? want : labels[0]] });
  if (!pick) return null;
  return { secs, day: days[labels.indexOf(pick[0])] };
}
function askDuration(def) {
  for (;;) {
    const t = askText('Time (e.g. 1:30, 1.5, 45m):', 'Time', def || '');
    if (t === null) return null;
    const s = parseDuration(t); if (s !== null && s > 0) return s;
    front(); app.displayAlert('Couldn\'t read "' + t + '" as a time.');
  }
}

// ---------------- actions ----------------
function save(t) { return api('PUT', '/tasks/' + t.id, t).data; }
function stopTask(t) { const l = logOf(t); const i = openIdx(t); if (i < 0) return; l[i][1] = now(); t.time_log = JSON.stringify(l); save(t); }
function stopAll() { tasks(40).forEach(t => { if (!t.invoice_id && openIdx(t) >= 0) stopTask(t); }); }
function guardInvoiced(t) { if (!t.invoice_id) return false; front(); app.displayAlert('This time is already invoiced, so it can\'t be changed.'); return true; }

function newEntry(projectId, timer) {
  const p = projects().find(x => x.id === projectId) || projects(true).find(x => x.id === projectId);
  if (!p) throw new Error('Project not found — try Refresh projects');
  const label = (p.number ? p.number + ' · ' : '') + p.name;
  const type = chooseType(null, label); if (!type) return;
  const notes = askNotes('Notes (optional):', type + ' · ' + label, ''); if (notes === null) return;
  const billable = NON_BILLABLE.indexOf(type) < 0;
  let entry;
  if (timer) { stopAll(); entry = [now(), 0, notes, billable]; }
  else {
    // default day: today, or the same weekday in the week you're looking at
    const off = state().week || 0;
    const def = new Date(startOfDay(new Date()).getTime() + off * 7 * DAY);
    let picked = null;
    try { picked = askTimeAndDay(type + ' · ' + label, def); } catch (e) { picked = askTimeAndDayList(def); }
    if (!picked) return;
    const start = Math.floor(startOfDay(picked.day).getTime() / 1000) + 9 * 3600;   // entries start at 9:00 that day
    entry = [start, start + picked.secs, notes, billable];
  }
  api('POST', '/tasks', { client_id: p.client_id, project_id: p.id, rate: p.rate, description: joinDesc(type, notes), time_log: JSON.stringify([entry]) });
}
function startTask(id) {                            // Harvest's "▶" on an existing row: continue it today
  const t = api('GET', '/tasks/' + id).data; if (guardInvoiced(t)) return;
  stopAll();
  const l = logOf(t); const last = l[l.length - 1] || [];
  const entry = [now(), 0, last[2] || '', last.length > 3 ? last[3] : true];
  l.push(entry);
  t.time_log = JSON.stringify(l);
  try { save(t); }
  catch (e) {
    if (e.code !== 422) throw e;
    // Invoice Ninja refused the change to this task (it validates the whole time log), so the timer
    // starts as a new entry with the same project, type and notes — same as Harvest's ▶ on an old row.
    api('POST', '/tasks', { client_id: t.client_id, project_id: t.project_id, rate: t.rate, description: t.description, time_log: JSON.stringify([entry]) });
  }
}
function editNotes(id) {
  const t = api('GET', '/tasks/' + id).data; if (guardInvoiced(t)) return;
  const d = split(t.description);
  const notes = askNotes('Notes:', 'Edit notes', d.notes); if (notes === null) return;
  t.description = joinDesc(d.type, notes);
  t.time_log = JSON.stringify(logOf(t).map(e => { e[2] = notes; return e; }));
  save(t);
}
function editType(id) {
  const t = api('GET', '/tasks/' + id).data; if (guardInvoiced(t)) return;
  const d = split(t.description);
  const type = chooseType(d.type, 'Change task type'); if (!type) return;
  t.description = joinDesc(type, d.notes);
  const billable = NON_BILLABLE.indexOf(type) < 0;
  t.time_log = JSON.stringify(logOf(t).map(e => { e[3] = billable; return e; }));
  save(t);
}
function editTime(id, day) {                        // set that day's total, like typing into Harvest's hours box
  const t = api('GET', '/tasks/' + id).data; if (guardInvoiced(t)) return;
  const l = logOf(t); const idx = []; let cur = 0;
  l.forEach((e, i) => { if (dayKey(e[0] * 1000) === day) { idx.push(i); cur += (e[1] || now()) - e[0]; } });
  if (!idx.length) return;
  if (idx.some(i => !l[i][1])) { front(); app.displayAlert('Stop the timer before editing its time.'); return; }
  const secs = askDuration(fmt(cur)); if (!secs) return;
  const first = l[idx[0]]; const keep = l.filter((e, i) => idx.indexOf(i) < 0);
  keep.push([first[0], first[0] + secs, first[2] || '', first.length > 3 ? first[3] : true]);
  keep.sort((a, b) => a[0] - b[0]);
  t.time_log = JSON.stringify(keep); save(t);
}
function moveProject(id) {
  const t = api('GET', '/tasks/' + id).data; if (guardInvoiced(t)) return;
  const ps = projects(); const labels = ps.map(p => p.client + ' — ' + (p.number ? p.number + ' ' : '') + p.name);
  front();
  const pick = app.chooseFromList(labels, { withTitle: 'Move to project', withPrompt: 'Project:' }); if (!pick) return;
  const p = ps[labels.indexOf(pick[0])];
  t.client_id = p.client_id; t.project_id = p.id; t.rate = p.rate; save(t);
}
function deleteDay(id, day) {
  const t = api('GET', '/tasks/' + id).data; if (guardInvoiced(t)) return;
  front();
  try { app.displayDialog('Delete this entry (' + day + ')?', { withTitle: 'Delete', buttons: ['Cancel', 'Delete'], defaultButton: 'Cancel', withIcon: 'caution' }); } catch (e) { return; }
  const keep = logOf(t).filter(e => dayKey(e[0] * 1000) !== day);
  if (keep.length) { t.time_log = JSON.stringify(keep); save(t); }
  else api('POST', '/tasks/bulk', { action: 'delete', ids: [t.id] });
}


// ---------------- idle detection (Harvest/Toggl style) ----------------
function idleSeconds() {
  try { return +sh("ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print int($NF/1000000000); exit}'") || 0; } catch (e) { return 0; }
}
// Called on every menu refresh. Notes when you went idle (or the Mac slept) while a timer ran,
// and once you're back, pops the question in a separate process so the menu isn't blocked.
function checkIdle(self, running) {
  if (!IDLE_MIN) return;
  const st = state(); const t = now(); const idle = idleSeconds();
  const patch = { lastRun: t };
  if (!running) { if (st.idleSince || st.idleTask) Object.assign(patch, { idleSince: null, idleTask: null }); state(patch); return; }
  let since = st.idleSince || null;
  if (st.lastRun && t - st.lastRun > IDLE_MIN * 60) since = since || st.lastRun;          // Mac was asleep
  if (idle >= IDLE_MIN * 60) since = Math.min(since || Infinity, t - idle);                  // away from the keyboard
  if (since) { patch.idleSince = since; patch.idleTask = running.id; }
  state(patch);
  const back = idle < 30;
  if (since && back && (!st.idlePrompting || t - st.idlePrompting > 7200) && t - since >= IDLE_MIN * 60) {
    state({ idlePrompting: t });
    sh('nohup ' + shq(self) + ' idle >/dev/null 2>&1 &');
  }
}
function idlePrompt() {
  const st = state();
  try {
    if (!st.idleSince || !st.idleTask) return;
    const t = api('GET', '/tasks/' + st.idleTask).data; const i = openIdx(t);
    if (i < 0) return;                                             // timer already stopped
    const log = logOf(t); const since = Math.max(st.idleSince, log[i][0]);
    const mins = Math.round((now() - since) / 60); if (mins < IDLE_MIN) return;
    const at = new Date(since * 1000); const hh = at.getHours() % 12 || 12, mm = String(at.getMinutes()).padStart(2, '0');
    const d = split(t.description);
    front();
    let r;
    try {
      r = app.displayDialog('You\'ve been idle since ' + hh + ':' + mm + (at.getHours() < 12 ? ' AM' : ' PM') + ' (' + fmt(mins * 60) + ').\n\n' +
        'Timer running: ' + (d.type || 'Services') + (d.notes ? ' — ' + d.notes : ''),
        { withTitle: 'Idle time', buttons: ['Keep idle time', 'Discard & stop', 'Discard & continue'], defaultButton: 'Discard & continue', withIcon: 'caution', givingUpAfter: 3600 }).buttonReturned;
    } catch (e) { r = 'Keep idle time'; }
    if (r === 'Discard & continue') { log[i][1] = since; log.push([now(), 0, log[i][2] || '', log[i].length > 3 ? log[i][3] : true]); }
    else if (r === 'Discard & stop') { log[i][1] = since; }
    else return;
    t.time_log = JSON.stringify(log); save(t);
  } finally { state({ idleSince: null, idleTask: null, idlePrompting: null, lastRun: now() }); }
}

// ---------------- menu ----------------
function menu(self) {
  const act = (args, extra) => ' | bash="' + self + '" ' + args.map((a, i) => 'param' + (i + 1) + '=' + a).join(' ') + ' terminal=false refresh=true' + (extra ? ' ' + extra : '');
  const clean = s => String(s || '').replace(/\|/g, '/').replace(/\s*[\r\n]+\s*/g, ' · ').trim();
  const cut = (s, n) => { s = clean(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

  if (!token()) return 'Timer | sfimage=timer\n---\nAdd your API token in Terminal: | ' + GRAY + '\nsecurity add-generic-password -s invoiceninja-swiftbar -a "$USER" -w \'TOKEN\' | font=Menlo size=11';
  const offset = state().week || 0;
  let ts, projs;
  try { ts = tasks(offset ? 300 : 100); projs = projects(); }
  catch (e) { return '⚠ | sfimage=exclamationmark.triangle\n---\nCan\'t reach Invoice Ninja: ' + clean(e.message) + '\nOpen Invoice Ninja | href=' + BASE; }

  const byProj = {}; projs.forEach(p => byProj[p.id] = p);
  const ws = weekStart(offset); const todayK = dayKey(Date.now());
  const rows = rowsForWeek(ts, ws);
  const runningTask = ts.find(t => openIdx(t) >= 0);
  try { checkIdle(self, runningTask); } catch (e) {}
  const totalFor = k => rows.filter(r => r.day === k).reduce((s, r) => s + r.secs, 0);
  const weekTotal = rows.reduce((s, r) => s + r.secs, 0);
  const billableWeek = rows.filter(r => { const l = logOf(r.task); return r.idx.some(i => l[i][3] !== false); }).reduce((s, r) => s + r.secs, 0);
  const projLabel = t => { const p = byProj[t.project_id]; return p ? (p.number || p.name) : 'No project'; };
  const projName  = t => { const p = byProj[t.project_id]; return p ? p.name + ' · ' + p.client : ''; };

  const out = [];
  // title
  if (runningTask) {
    const r = rows.find(x => x.task === runningTask && x.running);
    const label = (r ? fmt(r.secs) : '') + '  ' + cut(projLabel(runningTask), 18);
    let png = null; try { png = pillImage(label); } catch (e) {}
    out.push(png ? ' | image=' + png : label + ' | sfimage=timer color=#34C759');
  }
  else out.push((todayK >= dayKey(ws) ? fmt(totalFor(todayK)) : '') + ' | sfimage=timer');
  out.push('---');

  // week header + day strip (Harvest's Mon–Sun tabs)
  const we = new Date(ws.getTime() + 6 * DAY);
  out.push('Week of ' + MON[ws.getMonth()] + ' ' + ws.getDate() + ' – ' + MON[we.getMonth()] + ' ' + we.getDate() + '    ' + fmt(weekTotal) + ' | font=HelveticaNeue-Bold size=14');
  let strip = '';
  for (let i = 0; i < 7; i++) { const d = new Date(ws.getTime() + i * DAY); const k = dayKey(d); const s = totalFor(k); strip += (k === todayK ? '•' : ' ') + DOW[d.getDay()].slice(0, 2) + ' ' + (s ? fmt(s) : ' –  ') + '  '; }
  out.push(strip.trimEnd() + ' | ' + MONO + ' ' + GRAY);
  out.push('Billable ' + fmt(billableWeek) + '  ·  Non-billable ' + fmt(weekTotal - billableWeek) + ' | size=11 ' + GRAY);
  out.push('---');

  // one row: status icon, time, project · type — notes, with an actions submenu
  const row = (r, depth) => {
    const pre = '--'.repeat(depth); const t = r.task; const d = split(t.description); const locked = !!t.invoice_id;
    const icon = r.running ? 'sfimage=stop.circle.fill color=#34C759' : locked ? 'sfimage=lock.fill' : 'sfimage=play.circle';
    const line = pre + fmt(r.secs).padStart(5, ' ') + '   ' + cut(projLabel(t), 14).padEnd(14, ' ') + '  ' + cut((d.type || 'Services') + (d.notes ? ' — ' + d.notes : ''), 44);
    const tip = clean(projName(t) + (d.notes ? ' — ' + d.notes : '')).replace(/"/g, "'");
    if (r.running && !locked) {        // the running entry: one click stops it
      out.push(line + act(['stop', t.id], MONO + ' ' + icon + ' tooltip="Click to stop the timer · ' + tip + '"'));
      out.push(pre + '          Edit this entry | size=12 ' + GRAY + ' sfimage=ellipsis.circle');
    } else if (locked) out.push(line + ' | href=' + BASE + '/tasks/' + t.id + '/edit ' + MONO + ' ' + icon + ' tooltip="Invoiced · ' + tip + '"');
    // every row carries an action — SwiftBar greys out (and won't open) rows that have none
    else out.push(line + act(['start', t.id], MONO + ' ' + icon + ' tooltip="Click ▶ to start · hover for options · ' + tip + '"'));
    const sub = pre + '--';
    out.push(sub + cut(projName(t), 60) + ' | ' + GRAY);
    if (d.notes) out.push(sub + cut(d.notes, 80) + ' | ' + GRAY + ' size=12');
    out.push(sub + '---');
    if (locked) { out.push(sub + 'Invoiced — locked | sfimage=lock.fill ' + GRAY); }
    else {
      if (r.running) out.push(sub + 'Stop timer' + act(['stop', t.id], 'sfimage=stop.fill'));
      else out.push(sub + 'Start timer' + act(['start', t.id], 'sfimage=play.fill'));
      out.push(sub + 'Edit notes…' + act(['notes', t.id], 'sfimage=square.and.pencil'));
      out.push(sub + 'Edit time…' + act(['time', t.id, r.day], 'sfimage=clock'));
      out.push(sub + 'Change task type…' + act(['type', t.id], 'sfimage=tag'));
      out.push(sub + 'Move to project…' + act(['move', t.id], 'sfimage=folder'));
      out.push(sub + '---');
      out.push(sub + 'Delete…' + act(['delete', t.id, r.day], 'sfimage=trash'));
    }
    out.push(sub + 'Open in Invoice Ninja | href=' + BASE + '/tasks/' + t.id + '/edit sfimage=safari');
  };

  // today first, expanded; other days of the week as submenus
  const days = []; for (let i = 0; i < 7; i++) days.push(new Date(ws.getTime() + i * DAY));
  const todayInWeek = days.some(d => dayKey(d) === todayK);
  if (todayInWeek) {
    const tr = rows.filter(r => r.day === todayK);
    out.push('Today · ' + dayLabel(new Date()) + '    ' + fmt(totalFor(todayK)) + ' | font=HelveticaNeue-Bold size=13');
    if (tr.length) tr.forEach(r => row(r, 0)); else out.push('No time yet today | ' + GRAY);
    out.push('---');
  }
  days.slice().reverse().forEach(d => {
    const k = dayKey(d); if (k === todayK) return;
    const dr = rows.filter(r => r.day === k); if (!dr.length) return;
    out.push(dayLabel(d) + '    ' + fmt(totalFor(k)) + ' | sfimage=calendar');
    dr.forEach(r => row(r, 1));
  });
  if (!rows.length && !todayInWeek) out.push('No time this week | ' + GRAY);

  // new entries (Harvest's "+")
  out.push('---');
  const projMenu = (label, cmd, icon) => {
    out.push(label + ' | sfimage=' + icon);
    let last = null;
    projs.forEach(p => {
      if (p.client !== last) { out.push('--' + cut(p.client, 50)); last = p.client; }
      out.push('----' + cut((p.number ? p.number + '  ' : '') + p.name, 60) + act([cmd, p.id]));
    });
  };
  projMenu('Start new timer', 'new', 'plus.circle.fill');
  projMenu('Add time manually', 'add', 'plus.circle');

  // week navigation
  out.push('---');
  out.push('Previous week' + act(['week', offset - 1], 'sfimage=chevron.left'));
  if (offset !== 0) out.push('This week' + act(['week', 0], 'sfimage=calendar.circle'));
  if (offset < 0) out.push('Next week' + act(['week', offset + 1], 'sfimage=chevron.right'));
  out.push('---');
  out.push('Open Invoice Ninja | href=' + BASE + '/tasks sfimage=safari');
  out.push('Refresh projects' + act(['refresh'], 'sfimage=arrow.clockwise'));
  return out.filter((l, i) => !(l === '---' && out[i - 1] === '---')).join('\n');
}

// Menu bar title while timing: white text on a solid green pill (drawn as a small Retina image)
function pillImage(text) {
  let step = 'start';
  try { return drawPill(text, s => { step = s; }); }
  catch (e) { const msg = 'pill failed at "' + step + '": ' + e.message; try { writeFile(cacheDir + '/pill-error.txt', new Date().toISOString() + '  ' + msg + '\n'); } catch (x) {} throw new Error(msg); }
}
function drawPill(text, at) {
  at('app');   $.NSApplication.sharedApplication;
  const H = 22, PAD = 8, ICON = 14, GAP = 5;
  at('font');  const white = $.NSColor.whiteColor;
  const font = $.NSFont.monospacedDigitSystemFontOfSizeWeight(13, 0.3);
  const attrs = $.NSDictionary.dictionaryWithObjectsForKeys($([font, white]), $([$.NSFontAttributeName, $.NSForegroundColorAttributeName]));
  // plain NSString drawing (NSAttributedString's initializer isn't reachable from JXA on some macOS versions)
  const ns = $.NSString.stringWithString(text);
  at('measure'); const ts = ns.sizeWithAttributes(attrs);
  const W = Math.ceil(PAD + ICON + GAP + ts.width + PAD);
  at('bitmap'); const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
    null, W * 2, H * 2, 8, 4, true, false, $.NSCalibratedRGBColorSpace, 0, 0);
  rep.setSize($.NSMakeSize(W, H));
  at('context'); const ctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext(ctx);
  at('pill');  $.NSColor.colorWithSRGBRedGreenBlueAlpha(0.13, 0.63, 0.29, 1).setFill;          // #21A04A
  $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius($.NSMakeRect(0, 1, W, H - 2), 5, 5).fill;
  at('icon');  let sym = $.NSImage.imageWithSystemSymbolNameAccessibilityDescription('stopwatch', 'Timer');   // a real string: null arrives as NSNull
  if (sym && !sym.isNil()) try {
    try { sym = sym.imageWithSymbolConfiguration($.NSImageSymbolConfiguration.configurationWithPaletteColors($([white]))); } catch (e) {}
    sym.drawInRectFromRectOperationFraction($.NSMakeRect(PAD, (H - ICON) / 2, ICON, ICON), $.NSMakeRect(0, 0, 0, 0), 2, 1);
  } catch (e) {}
  at('text');  ns.drawAtPointWithAttributes($.NSMakePoint(PAD + ICON + GAP, (H - ts.height) / 2), attrs);
  $.NSGraphicsContext.restoreGraphicsState;
  at('png');   const png = rep.representationUsingTypeProperties(4, $.NSDictionary.dictionary);
  return png.base64EncodedStringWithOptions(0).js;
}

function run(argv) {
  const self = argv[0], cmd = argv[1], a = argv[2], b = argv[3];
  try {
    switch (cmd) {
      case 'new':     newEntry(a, true);  return '';
      case 'add':     newEntry(a, false); return '';
      case 'start':   startTask(a);       return '';
      case 'stop':    stopTask(api('GET', '/tasks/' + a).data); return '';
      case 'notes':   editNotes(a);       return '';
      case 'time':    editTime(a, b);     return '';
      case 'type':    editType(a);        return '';
      case 'move':    moveProject(a);     return '';
      case 'delete':  deleteDay(a, b);    return '';
      case 'week':    state({ week: +a || 0 }); return '';
      case 'refresh': projects(true);     return '';
      case 'idle':    idlePrompt();       return '';
      case 'caltest': {                     // Terminal: ./invoiceninja.10s.sh caltest
        const r = askTimeAndDay('Calendar test', new Date());
        return r ? 'OK — ' + r.secs / 3600 + 'h on ' + r.day.toDateString() : 'Cancelled';
      }
      case 'pilltest': {                    // Terminal: ./invoiceninja.10s.sh pilltest
        const b64 = pillImage('0:03  FERM-2026');
        const f = $.NSHomeDirectory().js + '/Desktop/pill-test.png';
        $.NSData.alloc.initWithBase64EncodedStringOptions($(b64), 0).writeToFileAtomically(f, true);
        return 'OK — drew the pill (' + b64.length + ' chars). Saved ' + f;
      }
      default:        return menu(self);
    }
  } catch (e) {
    if (cmd === 'pilltest' || cmd === 'caltest') return 'FAILED — ' + e.message;
    if (cmd) { front(); app.displayAlert('Invoice Ninja timer', { message: e.message }); return ''; }
    return '⚠ | sfimage=exclamationmark.triangle\n---\n' + e.message;
  }
}
JXA
