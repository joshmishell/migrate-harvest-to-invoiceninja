// ==UserScript==
// @name         Invoice Ninja – Harvest-style tools
// @namespace    migrate-harvest-to-invoiceninja
// @version      2.3
// @description  Project number hint + Harvest-style "Invoice unbilled time" (one line per task type).
// @match        https://billing.example.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==
// SETUP: change the @match line above to your Invoice Ninja address (keep the /* at the end).

(function () {
  'use strict';

  const API = location.origin + '/api/v1';

  function token() {
    let t = GM_getValue('in_token', '');
    if (!t) {
      t = (prompt('Invoice Ninja API token (stored only in this browser):') || '').trim();
      if (t) GM_setValue('in_token', t);
    }
    return t;
  }
  GM_registerMenuCommand('Reset Invoice Ninja API token', () => { GM_setValue('in_token', ''); alert('Token cleared.'); });

  async function get(path) {
    const r = await fetch(API + path, { headers: { 'X-API-TOKEN': token(), 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' on ' + path);
    return r.json();
  }

  let allProjects = null, loadedAt = 0;
  async function projects() {
    if (allProjects && Date.now() - loadedAt < 60000) return allProjects;
    const out = [];
    for (let page = 1; ; page++) {
      const j = await get(`/projects?per_page=500&page=${page}&status=active,archived`);
      out.push(...(j.data || []));
      if (page >= (j.meta?.pagination?.total_pages || 1)) break;
    }
    allProjects = out; loadedAt = Date.now();
    return out;
  }

  const CODE = /^(.+?)-(\d+)(?:-\d+)?$/;

  async function hintFor(projectId) {
    const all = await projects();
    const me = all.find(p => p.id === projectId);
    if (!me) return 'Project not found';
    const mine = all.filter(p => p.client_id === me.client_id && p.id !== projectId && CODE.test(p.number || '') && !/^TEMP-/i.test(p.number));

    // the client's code = its ID Number field, else its most-used project prefix
    const c = (await get(`/clients/${me.client_id}`)).data;
    let prefix = (c?.id_number || '').trim().toUpperCase();
    if (!prefix) {
      const count = {};
      mine.forEach(p => { const pre = p.number.match(CODE)[1].toUpperCase(); count[pre] = (count[pre] || 0) + 1; });
      prefix = Object.keys(count).sort((a, b) => count[b] - count[a])[0];
      if (!prefix) return 'No project codes for this client yet — add a code in the client’s ID Number field.';
    }

    // highest number with that prefix, across ALL clients (codes like PL360 span two clients)
    let max = 999, maxNum = null;
    all.forEach(p => {
      const m = (p.number || '').match(CODE);
      if (m && m[1].toUpperCase() === prefix && +m[2] > max) { max = +m[2]; maxNum = p.number; }
    });
    const latest = mine.slice().sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0];
    const next = `${prefix}-${max + 1}`;
    return { text: `Highest used: ${maxNum || 'none'}` + (latest && latest.number !== maxNum ? ` · Most recent: ${latest.number}` : '') + ` · Next: `, next };
  }

  function findNumberInput() {
    const label = [...document.querySelectorAll('dt, label, span, div, p')]
      .find(el => el.children.length === 0 && el.textContent.trim() === 'Project Number');
    if (!label) return null;
    let row = label.parentElement;
    for (let i = 0; i < 4 && row && !row.querySelector('input'); i++) row = row.parentElement;
    return row ? row.querySelector('input') : null;
  }

  let busyFor = null;
  async function run() {
    const m = location.pathname.match(/\/projects\/([A-Za-z0-9]+)\/edit/);
    if (!m) return;
    const input = findNumberInput();
    if (!input || input.dataset.h2inHint === m[1] || busyFor === m[1]) return;
    busyFor = m[1];

    document.querySelectorAll('.h2in-number-hint').forEach(e => e.remove());
    const box = document.createElement('div');
    box.className = 'h2in-number-hint';
    box.style.cssText = 'font-size:12px;color:#6b7280;margin-top:6px;';
    box.textContent = 'Looking up project numbers…';
    input.insertAdjacentElement('afterend', box);
    input.dataset.h2inHint = m[1];

    try {
      const h = await hintFor(m[1]);
      if (typeof h === 'string') { box.textContent = h; return; }
      box.textContent = h.text;
      const use = document.createElement('a');
      use.href = '#'; use.textContent = h.next + ' (use)';
      use.style.cssText = 'color:#2563eb;text-decoration:underline;cursor:pointer;';
      use.addEventListener('click', e => {
        e.preventDefault();
        // set the value in a way React notices
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, h.next);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      box.appendChild(use);
    } catch (err) {
      box.textContent = 'Number lookup failed: ' + err.message + ' (check the API token via the Tampermonkey menu)';
    } finally {
      busyFor = null;
    }
  }


  // ======================================================================
  //  Harvest-style invoicing: one line per task type, from unbilled time
  // ======================================================================
  const ROUND_UP_HOURS = 0.25;   // round each time entry UP to the next 15 min, like your Harvest billing
  const INCLUDE_NOTES  = true;   // list each entry's notes under its task-type line

  async function send(method, path, body) {
    const r = await fetch(API + path, { method, headers: { 'X-API-TOKEN': token(), 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (j.message || ''));
    return j;
  }
  async function allPages(path) {
    const out = [];
    for (let page = 1; ; page++) {
      const j = await get(`${path}${path.includes('?') ? '&' : '?'}per_page=500&page=${page}`);
      out.push(...(j.data || []));
      if (page >= (j.meta?.pagination?.total_pages || 1)) break;
    }
    return out;
  }
  const strip = html => { const d = document.createElement('div'); d.innerHTML = html || ''; return d.textContent.replace(/\[Invoiced in Harvest\]/g, '').trim(); };

  async function unbilledTasks(projectId) {
    const tasks = await allPages(`/tasks?status=active,archived&project_tasks=${projectId}`);
    return tasks.filter(t => t.project_id === projectId && !t.invoice_id && !t.is_deleted);
  }

  function buildLines(tasks, fallbackRate) {
    const groups = new Map(); let running = 0;
    for (const t of tasks) {
      let log = []; try { log = JSON.parse(t.time_log || '[]'); } catch (e) {}
      let hours = 0;
      for (const e of log) {
        if (e[3] === false) continue;                  // non-billable entry
        if (!e[1]) { running++; continue; }            // timer still running
        let h = (e[1] - e[0]) / 3600;
        if (ROUND_UP_HOURS) h = Math.ceil(h / ROUND_UP_HOURS - 1e-9) * ROUND_UP_HOURS;
        hours += h;
      }
      if (hours <= 0) continue;
      const tag = (t.tags || [])[0];
      const desc = strip(t.description);
      let type = tag ? (tag.name || tag) : '', note = desc;
      if (!type) { const i = desc.indexOf(' — '); if (i > 0) { type = desc.slice(0, i); note = desc.slice(i + 3); } }
      type = (type || 'Services').trim();
      const rate = +t.rate || fallbackRate || 0;
      const key = type + '|' + rate;
      if (!groups.has(key)) groups.set(key, { type, rate, hours: 0, notes: [] });
      const g = groups.get(key); g.hours += hours;
      if (note && note !== type && !g.notes.includes(note)) g.notes.push(note);
    }
    const lines = [...groups.values()].map(g => ({
      product_key: g.type,
      notes: INCLUDE_NOTES && g.notes.length ? g.type + '\n' + g.notes.map(n => '• ' + n).join('\n') : g.type,
      quantity: Math.round(g.hours * 100) / 100, cost: g.rate, type_id: '1',
    }));
    return { lines, running };
  }

  async function invoiceUnbilled(projectId, btn) {
    btn.disabled = true; btn.textContent = 'Gathering time…';
    try {
      const project = (await get(`/projects/${projectId}`)).data;
      const client = (await get(`/clients/${project.client_id}`)).data;
      const tasks = await unbilledTasks(projectId);
      const fallback = +project.task_rate || +(client.settings?.default_task_rate) || 0;
      const { lines, running } = buildLines(tasks, fallback);
      if (!lines.length) { alert('No unbilled billable time on this project.' + (running ? `\n(${running} timer(s) still running.)` : '')); return; }
      const total = lines.reduce((s, l) => s + l.quantity * l.cost, 0);
      const summary = lines.map(l => `${l.product_key}: ${l.quantity} h × $${l.cost}`).join('\n');
      if (!confirm(`Create a draft invoice for ${project.number || project.name}?\n\n${summary}\n\nTotal: $${total.toFixed(2)}` + (running ? `\n\nNote: ${running} running timer(s) left out.` : ''))) return;

      btn.textContent = 'Creating invoice…';
      const inv = (await send('POST', '/invoices', { client_id: project.client_id, project_id: projectId, line_items: lines })).data;
      btn.textContent = 'Marking time as billed…';
      for (const t of tasks) { t.invoice_id = inv.id; await send('PUT', `/tasks/${t.id}`, t); }
      location.href = `/invoices/${inv.id}/edit`;
    } catch (err) {
      alert('Invoice from time failed: ' + err.message);
    } finally { btn.disabled = false; btn.textContent = 'Invoice unbilled time'; }
  }

  async function releaseTime(invoiceId, btn) {
    if (!confirm('Unlink all tracked time from this invoice so it can be invoiced again?\n(Use before deleting a draft you made from tracked time.)')) return;
    btn.disabled = true; btn.textContent = 'Releasing…';
    try {
      const tasks = (await allPages('/tasks?status=active,archived')).filter(t => t.invoice_id === invoiceId);
      for (const t of tasks) { t.invoice_id = ''; await send('PUT', `/tasks/${t.id}`, t); }
      alert(`Released ${tasks.length} time entries.`);
    } catch (err) { alert('Release failed: ' + err.message); }
    finally { btn.disabled = false; btn.textContent = 'Release tracked time'; }
  }

  function floatingButton(id, label, onClick) {
    let b = document.getElementById(id);
    if (b) return;
    document.querySelectorAll('.h2in-float').forEach(e => e.remove());
    b = document.createElement('button');
    b.id = id; b.className = 'h2in-float'; b.textContent = label;
    b.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:9999;padding:10px 16px;border-radius:6px;border:0;background:#111827;color:#fff;font:600 13px system-ui;box-shadow:0 2px 8px rgba(0,0,0,.25);cursor:pointer;';
    b.addEventListener('click', () => onClick(b));
    document.body.appendChild(b);
  }

  function buttons() {
    const p = location.pathname.match(/^\/projects\/([A-Za-z0-9]{6,})(?:\/(?:edit|view))?$/);
    const i = location.pathname.match(/^\/invoices\/([A-Za-z0-9]{6,})\/edit$/);
    if (p && p[1] !== 'create') floatingButton('h2in-inv-' + p[1], 'Invoice unbilled time', b => invoiceUnbilled(p[1], b));
    else if (i) floatingButton('h2in-rel-' + i[1], 'Release tracked time', b => releaseTime(i[1], b));
    else document.querySelectorAll('.h2in-float').forEach(e => e.remove());
  }

  // ======================================================================
  //  Projects list: hours to the quarter hour instead of whole hours
  // ======================================================================
  // Hours are cached in this browser, so the list fills in instantly from the last visit
  // and quietly refreshes in the background (pages are fetched in parallel).
  let hoursCache = null, hoursAt = 0, hoursBusy = false, refreshing = null;
  try { const c = JSON.parse(GM_getValue('h2in_hours', 'null')); if (c) { hoursCache = c.h; hoursAt = c.at; } } catch (e) {}

  async function fetchAllTasksParallel() {
    const first = await get('/tasks?status=active,archived&per_page=500&page=1');
    const pages = first.meta?.pagination?.total_pages || 1;
    const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => get(`/tasks?status=active,archived&per_page=500&page=${i + 2}`)));
    return [first, ...rest].flatMap(j => j.data || []);
  }
  function sumHours(tasks) {
    const h = {};
    for (const t of tasks) {
      if (t.is_deleted || !t.project_id) continue;
      let log = []; try { log = JSON.parse(t.time_log || '[]'); } catch (e) {}
      for (const e of log) {
        const end = e[1] || Math.floor(Date.now() / 1000);
        let x = (end - e[0]) / 3600;
        if (ROUND_UP_HOURS) x = Math.ceil(x / ROUND_UP_HOURS - 1e-9) * ROUND_UP_HOURS;
        h[t.project_id] = (h[t.project_id] || 0) + x;
      }
    }
    return h;
  }
  function refreshHours() {
    if (!refreshing) refreshing = fetchAllTasksParallel().then(tasks => {
      hoursCache = sumHours(tasks); hoursAt = Date.now();
      GM_setValue('h2in_hours', JSON.stringify({ h: hoursCache, at: hoursAt }));
      fixProjectHours();                                 // repaint with fresh numbers
    }).catch(e => console.warn('project hours:', e)).finally(() => { refreshing = null; });
    return refreshing;
  }
  async function projectHours() {
    if (!hoursCache) await refreshHours();               // very first time: wait once
    else if (Date.now() - hoursAt > 60000) refreshHours();   // otherwise show cached now, refresh behind the scenes
    return hoursCache || {};
  }
  async function fixProjectHours() {
    if (location.pathname !== '/projects' || hoursBusy) return;
    const table = document.querySelector('table');
    if (!table) return;
    const ths = [...table.querySelectorAll('thead th')];
    const col = ths.findIndex(th => /hours/i.test(th.textContent));
    if (col < 0) return;
    const rows = [...table.querySelectorAll('tbody tr')];
    if (!rows.length) return;
    hoursBusy = true;
    try {
      const h = await projectHours();
      for (const tr of rows) {
        const a = tr.querySelector('a[href*="/projects/"]');
        const id = a && (a.getAttribute('href').match(/\/projects\/([A-Za-z0-9]+)/) || [])[1];
        const cell = tr.children[col];
        if (!id || !cell) continue;
        const want = (h[id] || 0).toFixed(2).replace(/\.00$/, '');
        if (cell.textContent.trim() !== want) {        // only write when different, so the page can re-render freely
          cell.textContent = want;
          cell.title = 'Hours to the quarter hour (each entry rounded up to 15 min)';
        }
      }
    } catch (e) { console.warn('project hours:', e); }
    finally { hoursBusy = false; }
  }

  // ======================================================================
  //  Sidebar: your order, and "Tasks" opens the Daily view
  // ======================================================================
  const SIDEBAR_ORDER = ['Dashboard', 'Tasks', 'Projects', 'Invoices', 'Clients', 'Payments', 'Recurring Invoices',
                         'Quotes', 'Expenses', 'Reports', 'Products', 'Credits', 'Recurring Expenses', 'Vendors',
                         'Purchase Orders', 'Transactions', 'Settings'];
  const SIDEBAR_HIDE  = [];        // e.g. ['Vendors', 'Purchase Orders'] — or turn modules off in Settings
  const todayStr = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

  function lca(a, b) { const s = new Set(); for (let x = a; x; x = x.parentElement) s.add(x); for (let y = b; y; y = y.parentElement) if (s.has(y)) return y; return null; }
  function sidebar() {
    const d = document.querySelector('a[href="/dashboard"]'), i = document.querySelector('a[href="/invoices"]');
    return d && i ? lca(d, i) : null;
  }
  function arrangeSidebar() {
    const box = sidebar(); if (!box) return;
    if (getComputedStyle(box).display !== 'flex') { box.style.display = 'flex'; box.style.flexDirection = 'column'; }
    [...box.children].forEach(el => {
      const label = (el.textContent || '').trim();
      const i = SIDEBAR_ORDER.findIndex(n => label === n || label.startsWith(n) && !SIDEBAR_ORDER.some(m => m !== n && m.startsWith(n) && label.startsWith(m)));
      const want = String(i < 0 ? 50 : i);
      if (el.style.order !== want) el.style.order = want;               // CSS order: React's DOM stays untouched
      const hide = SIDEBAR_HIDE.some(n => label.startsWith(n));
      if (hide && el.style.display !== 'none') el.style.display = 'none';
    });
    const t = box.querySelector('a[href="/tasks"]');
    if (t) t.title = 'Opens the Daily view';
  }
  // sidebar "Tasks" -> Daily view for today (other ways into the List view still work)
  window.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a[href="/tasks"]');
    const box = sidebar();
    if (!a || !box || !box.contains(a) || e.metaKey || e.ctrlKey) return;
    e.preventDefault(); e.stopImmediatePropagation();
    location.href = '/tasks/daily?date=' + todayStr();
  }, true);

  // ======================================================================
  //  Daily view: Edit and Delete on every row
  // ======================================================================
  const RANGE = /(\d{1,2}:\d{2}\s?[AP]M)\s*-\s*(\d{1,2}:\d{2}\s?[AP]M)?/i;
  const hhmm = sec => { const d = new Date(sec * 1000); let h = d.getHours(); const ap = h < 12 ? 'AM' : 'PM'; h = h % 12 || 12; return String(h).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ' ' + ap; };
  const normTime = s => { const m = s.trim().toUpperCase().match(/(\d{1,2}):(\d{2})\s?([AP]M)/); return m ? String(+m[1]).padStart(2, '0') + ':' + m[2] + ' ' + m[3] : s; };
  const dayOf = sec => { const d = new Date(sec * 1000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

  let dayTasks = null, dayTasksFor = null, dayBusy = false;
  async function tasksForDay(date, full) {
    if (dayTasks && dayTasksFor === date + full) return dayTasks;
    const list = full ? await fetchAllTasksParallel() : (await get('/tasks?status=active,archived&per_page=300&sort=updated_at|desc')).data || [];
    dayTasks = list.filter(t => !t.is_deleted && (() => { try { return JSON.parse(t.time_log || '[]').some(e => dayOf(e[0]) === date); } catch (e) { return false; } })());
    dayTasksFor = date + full;
    return dayTasks;
  }

  function dailyRows() {
    const hits = [...document.querySelectorAll('main *, #root *')].filter(el => el.children.length === 0 && RANGE.test(el.textContent || ''));
    return hits.map(el => {
      // climb from the "03:44 PM - 03:59 PM" line to the whole row: the first ancestor that also holds the duration (e.g. 0:15)
      const isDur = x => x.children.length === 0 && /^\d{1,3}:\d{2}$/.test((x.textContent || '').trim());
      let row = el;
      for (let i = 0; i < 8 && row.parentElement && ![...row.querySelectorAll('*')].some(isDur); i++) row = row.parentElement;
      if (![...row.querySelectorAll('*')].some(isDur)) return null;
      return { row, rangeEl: el };
    }).filter(Boolean);
  }

  function btn(label, onClick, danger) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.className = 'h2in-row-btn';
    b.style.cssText = 'margin-left:8px;padding:6px 12px;border:1px solid #d1d5db;border-radius:6px;background:#fff;font-size:13px;cursor:pointer;' + (danger ? 'color:#b91c1c;' : 'color:#111827;');
    b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); onClick(); });
    return b;
  }

  async function deleteEntry(t, start) {
    if (t.invoice_id) { alert('This time is already invoiced, so it can\'t be deleted.'); return; }
    const log = JSON.parse(t.time_log || '[]');
    const rest = log.filter(e => e[0] !== start);
    const what = rest.length ? 'this time entry' : 'this task';
    if (!confirm(`Delete ${what}?\n\n${(t.description || '').replace(/<[^>]+>/g, '')}`)) return;
    if (rest.length) { t.time_log = JSON.stringify(rest); await send('PUT', `/tasks/${t.id}`, t); }
    else await send('POST', '/tasks/bulk', { action: 'delete', ids: [t.id] });
    dayTasks = null; hoursCache = null;
    location.reload();
  }

  async function enhanceDaily() {
    if (location.pathname !== '/tasks/daily' || dayBusy) return;
    const date = new URLSearchParams(location.search).get('date') || todayStr();
    const rows = dailyRows().filter(r => !r.row.querySelector('.h2in-row-btn'));
    if (!rows.length) return;
    dayBusy = true;
    try {
      for (const full of [false, true]) {
        const ts = await tasksForDay(date, full);
        let missing = 0;
        for (const r of rows) {
          if (r.row.querySelector('.h2in-row-btn')) continue;
          const m = (r.rangeEl.textContent || '').match(RANGE); if (!m) continue;
          const startTxt = normTime(m[1]);
          const text = r.row.textContent || '';
          const cands = [];
          ts.forEach(t => JSON.parse(t.time_log || '[]').forEach(e => { if (dayOf(e[0]) === date && hhmm(e[0]) === startTxt) cands.push({ t, e }); }));
          const hit = cands.length === 1 ? cands[0] : cands.find(c => text.includes(((c.t.description || '').replace(/<[^>]+>/g, '').split('\n')[0] || '').trim()));
          if (!hit) { missing++; continue; }
          const holder = r.row.querySelector('button') ? r.row.querySelector('button').parentElement : r.row;
          const edit = btn('Edit', () => { location.href = `/tasks/${hit.t.id}/edit`; });
          const del = btn('Delete', () => deleteEntry(hit.t, hit.e[0]), true);
          holder.appendChild(edit); holder.appendChild(del);
        }
        if (!missing) break;                             // everything matched from recent tasks
      }
    } catch (e) { console.warn('daily view:', e); }
    finally { dayBusy = false; }
  }

  new MutationObserver(() => { run(); buttons(); fixProjectHours(); arrangeSidebar(); enhanceDaily(); }).observe(document.body, { childList: true, subtree: true });
  run(); buttons(); fixProjectHours(); arrangeSidebar(); enhanceDaily();
})();
