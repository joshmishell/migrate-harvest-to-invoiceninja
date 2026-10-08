// ==UserScript==
// @name         Invoice Ninja – Harvest-style tools
// @namespace    migrate-harvest-to-invoiceninja
// @version      3.7
// @description  To-do list, project number hint, project-code invoice numbers, Harvest-style "Invoice unbilled time", client + project links on Tasks views.
// @match        https://billing.example.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @require      https://cdn.jsdelivr.net/npm/sortablejs@1.15.6/Sortable.min.js
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

  const CODE = /^(.+?)-(\d+)(?:-\d+)?$/;

  // ======================================================================
  //  Project numbers (New Project + Edit Project pages)
  //  • New Project: Client moves above Name, and a Project Number field appears that fills in
  //    the client's next code as soon as you pick the client. It's saved with the project.
  //  • Both pages: "Highest used / Most recent / Next (use)" hint, a "See all projects" popup,
  //    and Save is blocked if the number is already used by another project.
  // ======================================================================
  const PN = { list: null, clients: null, at: 0, busy: null, create: null, saving: null };
  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
  const normNum = s => String(s || '').trim().toUpperCase();

  async function pnLoad(force) {
    if (!force && PN.list && Date.now() - PN.at < 60000) return;
    if (!PN.busy) PN.busy = Promise.all([pagesOf('/projects?status=active,archived,deleted&per_page=500'), pagesOf('/clients?status=active,archived&per_page=500')])
      .then(([ps, cs]) => { PN.list = ps; PN.clients = cs; PN.at = Date.now(); })
      .finally(() => { PN.busy = null; });
    return PN.busy;
  }
  const pnClient = id => (PN.clients || []).find(c => c.id === id) || null;
  const clientName = c => c ? (c.name || c.display_name || '') : '';
  function pnInfo(clientId, selfId) {
    const mine = PN.list.filter(p => p.client_id === clientId && p.id !== selfId && !p.is_deleted && CODE.test(p.number || '') && !/^TEMP-/i.test(p.number));
    let prefix = normNum(pnClient(clientId)?.id_number);
    if (!prefix) {                                   // no client code: the prefix used most on its projects
      const count = {};
      mine.forEach(p => { const pre = p.number.match(CODE)[1].toUpperCase(); count[pre] = (count[pre] || 0) + 1; });
      prefix = Object.keys(count).sort((a, b) => count[b] - count[a])[0] || '';
    }
    if (!prefix) return { prefix: '', next: '' };
    let max = 999, highest = null;                   // across ALL clients and deleted projects, so a number is never reused
    PN.list.forEach(p => { const m = (p.number || '').match(CODE); if (m && m[1].toUpperCase() === prefix && +m[2] > max) { max = +m[2]; highest = p.number; } });
    const recent = mine.slice().sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0];
    return { prefix, next: `${prefix}-${max + 1}`, highest, recent: recent && recent.number };
  }
  const pnDups = (number, selfId) => !normNum(number) ? [] : PN.list.filter(p => p.id !== selfId && normNum(p.number) === normNum(number));

  // ---------- hint box (shared) ----------
  function hintBox(after) {
    let box = after.parentElement.querySelector(':scope > .fs-number-hint');
    if (!box) {
      box = document.createElement('div'); box.className = 'fs-number-hint';
      box.style.cssText = 'font-size:12px;color:#6b7280;margin-top:6px;line-height:1.6;';
      after.insertAdjacentElement('afterend', box);
    }
    return box;
  }
  const LINK = 'color:#2563eb;text-decoration:underline;cursor:pointer;background:none;border:0;padding:0;font:inherit;';
  function paintHint(box, input, clientId, selfId) {
    if (!clientId) { box.innerHTML = 'Pick a client to see its next project number.'; return; }
    const info = pnInfo(clientId, selfId), c = pnClient(clientId);
    box.innerHTML = '';
    const line = document.createElement('div');
    if (!info.prefix) line.append('No project code for this client yet — add one in the client’s ID Number field. ');
    else {
      line.append(`Highest used: ${info.highest || 'none'}` + (info.recent && info.recent !== info.highest ? ` · Most recent: ${info.recent}` : '') + ' · Next: ');
      const use = document.createElement('button'); use.type = 'button'; use.style.cssText = LINK; use.textContent = info.next + ' (use)';
      use.addEventListener('click', e => { e.preventDefault(); setInput(input, info.next); input.dataset.fsDirty = ''; checkDup(input, selfId); });
      line.append(use, ' · ');
    }
    const all = document.createElement('button'); all.type = 'button'; all.style.cssText = LINK; all.textContent = 'See all projects';
    all.addEventListener('click', e => { e.preventDefault(); showAllProjects(clientId, clientName(c)); });
    line.append(all);
    const warn = document.createElement('div'); warn.className = 'fs-dup-warn'; warn.style.cssText = 'color:#b91c1c;font-weight:600;';
    box.append(line, warn);
    checkDup(input, selfId);
  }
  function setInput(input, v) {
    if (input.dataset.fsOwn) { input.value = v; input.dispatchEvent(new Event('input', { bubbles: true })); return; }
    setReactValue(input, v);                          // the native field: set it so React notices
  }
  function checkDup(input, selfId) {
    const warn = input.parentElement.querySelector('.fs-dup-warn');
    const d = PN.list ? pnDups(input.value, selfId) : [];
    if (warn) warn.textContent = d.length ? `${normNum(input.value)} is already used by “${d[0].name}”${d[0].is_deleted ? ' (deleted)' : d[0].archived_at ? ' (archived)' : ''} — pick another number.` : '';
    input.style.borderColor = d.length ? '#dc2626' : '';
    input.style.boxShadow = d.length ? '0 0 0 2px #fecaca' : '';
    return d;
  }

  function showAllProjects(clientId, name) {
    const ps = PN.list.filter(p => p.client_id === clientId && !p.is_deleted)
      .sort((a, b) => String(b.number || '').localeCompare(String(a.number || ''), undefined, { numeric: true }));
    const w = window.open('', 'fs_client_projects', 'popup,width=860,height=760');
    if (!w) { alert('The popup was blocked — allow popups for this site.'); return; }
    const e = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const day = t => t ? new Date(t * 1000).toISOString().slice(0, 10) : '';
    const active = ps.filter(p => !p.archived_at).length;
    w.document.open();
    w.document.write(`<!doctype html><meta charset="utf-8"><title>${e(name)} — all projects</title>
      <style>body{font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#111827;margin:0;padding:24px 28px;background:#f9fafb}
      h1{font-size:20px;margin:0 0 4px} .sub{color:#6b7280;margin-bottom:16px} input{font:inherit;padding:7px 10px;border:1px solid #d1d5db;border-radius:6px;width:280px;margin-bottom:12px}
      table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden} th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;background:#f3f4f6;padding:0}
      th button{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:6px;width:100%;padding:8px 12px;cursor:pointer;font:inherit;letter-spacing:inherit;text-transform:inherit;color:inherit}
      th button:hover{background:#e5e7eb;color:#111827} th button .ar{font-size:10px;opacity:.35} th button.on{color:#111827} th button.on .ar{opacity:1}
      td{padding:8px 12px;border-top:1px solid #f0f1f3;vertical-align:top} td.n{font-weight:600;white-space:nowrap} td.d{color:#6b7280;white-space:nowrap;font-variant-numeric:tabular-nums}
      a{color:#111827;text-decoration:none} a:hover{text-decoration:underline;color:#2563eb} .arch{color:#9ca3af} .tag{font-size:11px;border-radius:4px;padding:1px 6px;background:#dcfce7;color:#166534} .arch .tag{background:#f3f4f6;color:#6b7280}</style>
      <h1>${e(name)}</h1><div class="sub">${ps.length} projects · ${active} active · ${ps.length - active} archived</div>
      <input id="q" placeholder="Filter…" autofocus>
      <table><thead><tr>${[['n', 'Number'], ['p', 'Project'], ['s', 'Status'], ['c', 'Created'], ['d', 'Due']].map(([k, l]) => `<th><button data-k="${k}" title="Sort">${l} <span class="ar">↕</span></button></th>`).join('')}</tr></thead><tbody>
      ${ps.map(p => `<tr class="${p.archived_at ? 'arch' : ''}" data-n="${e(p.number)}" data-p="${e(p.name)}" data-s="${p.archived_at ? 'Archived' : 'Active'}" data-c="${p.created_at || 0}" data-d="${e(p.due_date || '')}"><td class="n"><a href="${location.origin}/projects/${p.id}" target="_blank">${e(p.number)}</a></td><td><a href="${location.origin}/projects/${p.id}" target="_blank">${e(p.name)}</a></td>
        <td><span class="tag">${p.archived_at ? 'Archived' : 'Active'}</span></td><td class="d">${day(p.created_at)}</td><td class="d">${e(p.due_date || '')}</td></tr>`).join('')}
      </tbody></table>
      <script>
      document.getElementById('q').addEventListener('input',e=>{const q=e.target.value.toLowerCase();document.querySelectorAll('tbody tr').forEach(r=>r.style.display=r.textContent.toLowerCase().includes(q)?'':'none');});
      let key='n', dir=-1;   // starts newest number first
      function sortBy(k){ if(k===key) dir=-dir; else { key=k; dir=1; }
        const tb=document.querySelector('tbody'), rows=[...tb.rows];
        rows.sort((a,b)=>{ const x=a.dataset[key]||'', y=b.dataset[key]||'';
          if(!x!==!y) return x?-1:1;   /* blanks always last */
          return dir*(key==='c' ? (+x)-(+y) : x.localeCompare(y,undefined,{numeric:true,sensitivity:'base'})); });
        rows.forEach(r=>tb.appendChild(r)); paint(); }
      function paint(){ document.querySelectorAll('th button').forEach(b=>{ const on=b.dataset.k===key; b.classList.toggle('on',on);
        b.querySelector('.ar').textContent = on ? (dir>0?'▲':'▼') : '↕';
        b.title = on ? (dir>0?'Sorted A–Z / oldest first — click for Z–A':'Sorted Z–A / newest first — click for A–Z') : 'Sort'; }); }
      document.querySelectorAll('th button').forEach(b=>b.addEventListener('click',()=>sortBy(b.dataset.k)));
      paint();
      <\/script>`);
    w.document.close(); w.focus();
  }

  // ---------- Edit Project page ----------
  let pnEditBusy = false;
  async function pnEditTick() {
    const m = location.pathname.match(/^\/projects\/([A-Za-z0-9]{6,})\/edit$/);
    if (!m || pnEditBusy) return;
    const input = findInputByLabel('Project Number') || findInputByLabel('Number');
    if (!input || input.dataset.fsHint === m[1]) return;
    pnEditBusy = true; input.dataset.fsHint = m[1];
    const box = hintBox(input); box.textContent = 'Looking up project numbers…';
    try {
      await pnLoad(true);
      const me = PN.list.find(p => p.id === m[1]);
      paintHint(box, input, me && me.client_id, m[1]);
      input.addEventListener('input', () => checkDup(input, m[1]));
    } catch (e) { box.textContent = 'Number lookup failed: ' + e.message + ' (check the API token via the Tampermonkey menu)'; input.dataset.fsHint = ''; }
    finally { pnEditBusy = false; }
  }

  // ---------- New Project page ----------
  const ownText = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.nodeValue).join('').trim();
  const labelEl = re => [...document.querySelectorAll('main dt, main label, main span, main div, main p, #root dt, #root label, #root span, #root div')]
    .find(el => !el.closest('#fs-todo, .fs-pn-row, nav, aside') && !el.querySelector('input, select, textarea, button')
      && re.test((el.textContent || '').replace(/\*/g, '').trim()) && (el.children.length === 0 || re.test(ownText(el))));
  function rowOf(label, container) { let r = label; while (r && r.parentElement !== container) r = r.parentElement; return r; }
  function readClientId(row) {
    if (!PN.clients) return '';
    const q = new URLSearchParams(location.search).get('client');
    const texts = [...row.querySelectorAll('input')].map(i => i.value)
      .concat([...row.querySelectorAll('*')].filter(el => el.children.length === 0).map(el => el.textContent));
    for (const t of texts.map(x => String(x || '').trim().toLowerCase()).filter(Boolean)) {
      const c = PN.clients.find(c => clientName(c).trim().toLowerCase() === t);
      if (c) return c.id;
    }
    return q && pnClient(q) ? q : '';
  }
  let pnCreateBusy = false;
  async function pnCreateTick() {
    if (location.pathname !== '/projects/create') { PN.create = null; return; }
    if (pnCreateBusy) return;
    const nameL = labelEl(/^(project )?name$/i), clientL = labelEl(/^client$/i);
    if (!nameL || !clientL) return;
    pnCreateBusy = true;
    try {
      if (!PN.list) await pnLoad(true);
      const box = lca(nameL, clientL);
      const nameRow = rowOf(nameL, box), clientRow = rowOf(clientL, box);
      if (!nameRow || !clientRow) return;
      // Client above Name (CSS order only — the page's own markup is left alone)
      if (getComputedStyle(box).display !== 'flex') { box.style.display = 'flex'; box.style.flexDirection = 'column'; }
      if (clientRow.style.order !== '-2') clientRow.style.order = '-2';
      // our Project Number row, right under Client
      let row = box.querySelector(':scope > .fs-pn-row');
      if (!row) {
        row = clientRow.cloneNode(true); row.classList.add('fs-pn-row'); row.style.order = '-1';
        row.querySelectorAll('[id]').forEach(x => x.removeAttribute('id'));
        const lab = [...row.querySelectorAll('*')].find(el => !el.querySelector('input, button') && /^client$/i.test(el.textContent.replace(/\*/g, '').trim()));
        if (lab) lab.textContent = 'Project Number';
        const firstIn = row.querySelector('input');
        let cell = firstIn; while (cell && cell.parentElement !== row) cell = cell.parentElement;
        if (!cell) cell = row.lastElementChild;
        const nameInput = nameRow.querySelector('input');
        cell.innerHTML = '';
        const inp = document.createElement('input');
        inp.type = 'text'; inp.className = (nameInput && nameInput.className) || ''; inp.dataset.fsOwn = '1';
        inp.placeholder = 'Picks itself once you choose a client'; inp.autocomplete = 'off';
        inp.style.width = '100%';
        inp.addEventListener('input', () => { inp.dataset.fsDirty = '1'; checkDup(inp, null); savePending(inp.value); });
        cell.appendChild(inp);
        clientRow.insertAdjacentElement('afterend', row);
        PN.create = { input: inp, clientId: null, box: hintBox(inp) };
        paintHint(PN.create.box, inp, '', null);
      }
      const st = PN.create; if (!st) return;
      const cid = readClientId(clientRow);
      if (cid !== st.clientId) {
        st.clientId = cid;
        const info = cid ? pnInfo(cid, null) : { next: '' };
        if (!st.input.dataset.fsDirty) { st.input.value = info.next || ''; }
        paintHint(st.box, st.input, cid, null);
        savePending(st.input.value);
      }
    } catch (e) { console.warn('new project number:', e); }
    finally { pnCreateBusy = false; }
  }
  function savePending(number) { GM_setValue('fs_pn_pending', JSON.stringify({ number: normNum(number), at: Date.now() })); }
  function pending() { try { const p = JSON.parse(GM_getValue('fs_pn_pending', '') || 'null'); if (p && p.number && Date.now() - p.at < 15 * 60000) return p; } catch (e) {} return null; }

  // Save on New Project carries the number (added to the request the page sends) …
  (function patchXhr() {
    try {
      const X = W.XMLHttpRequest && W.XMLHttpRequest.prototype; if (!X || X.__fsPatched) return;
      const open = X.open, sendFn = X.send;
      X.open = function (m, u) { this.__fsReq = { m: String(m).toUpperCase(), u: String(u) }; return open.apply(this, arguments); };
      X.send = function (body) {
        try {
          const r = this.__fsReq, p = location.pathname === '/projects/create' && pending();
          if (r && p && r.m === 'POST' && /\/api\/v1\/projects(\?|$)/.test(r.u) && typeof body === 'string') {
            const j = JSON.parse(body);
            if (!j.number && !pnDups(p.number, null).length) { j.number = p.number; body = JSON.stringify(j); }
          }
        } catch (e) {}
        return sendFn.call(this, body);
      };
      X.__fsPatched = true;
    } catch (e) { console.warn('xhr patch', e); }
  })();
  // … and if that didn't take, it's set right after the project opens.
  function pnAfterSave() {
    const p = pending(); if (!p || PN.saving) return;
    const m = location.pathname.match(/^\/projects\/([A-Za-z0-9]{6,})(?:\/(?:edit|view))?$/);
    if (location.pathname === '/projects/create') return;
    GM_setValue('fs_pn_pending', '');
    if (!m) return;
    PN.saving = (async () => {
      const proj = (await get(`/projects/${m[1]}`)).data;
      if (!proj || nowSecs() - (proj.created_at || 0) > 15 * 60 || normNum(proj.number) === p.number) return;
      await pnLoad(true);
      if (pnDups(p.number, proj.id).length) { alert(`Project saved, but ${p.number} was taken in the meantime — it kept ${proj.number}.`); return; }
      proj.number = p.number;
      await send('PUT', `/projects/${proj.id}`, proj);
      if (!newProjectDraft()) location.reload();
    })().catch(e => console.warn('set project number:', e)).finally(() => { PN.saving = null; });
  }
  const nowSecs = () => Math.floor(Date.now() / 1000);

  // Save is blocked while the number is a duplicate (New and Edit Project)
  window.addEventListener('click', e => {
    if (!/^\/projects\/(create|[A-Za-z0-9]{6,}\/edit)$/.test(location.pathname) || !PN.list) return;
    const b = e.target.closest && e.target.closest('button'); if (!b || !/^save$/i.test(b.textContent.trim())) return;
    const input = location.pathname === '/projects/create' ? PN.create && PN.create.input : (findInputByLabel('Project Number') || findInputByLabel('Number'));
    if (!input) return;
    const selfId = (location.pathname.match(/^\/projects\/([A-Za-z0-9]{6,})\/edit$/) || [])[1] || null;
    const d = checkDup(input, selfId);
    if (d.length) { e.preventDefault(); e.stopImmediatePropagation(); alert(`${normNum(input.value)} is already used by “${d[0].name}”. Pick another project number before saving.`); input.focus(); }
  }, true);


  // ======================================================================
  //  Harvest-style invoicing: one line per task type, from unbilled time
  // ======================================================================
  const ROUND_UP_HOURS = 0.25;   // each time entry is billed in 15-minute steps (see roundEntry)
  // Billing rounding per time entry: up to the next quarter hour, unless it's within 5 minutes past one —
  // then down to it. 1:04 → 1:00, 1:06 → 1:15. Anything under 5 minutes still counts as 0:15.
  function roundEntry(secs) {
    secs = Math.max(0, Math.round(secs)); if (!secs) return 0;
    const q = 900, over = secs % q, base = secs - over;
    if (!over) return secs;
    return over <= 300 ? Math.max(base, q) : base + q;
  }
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
    const groups = new Map(); let running = 0; const used = [];
    for (const t of tasks) {
      let log = []; try { log = JSON.parse(t.time_log || '[]'); } catch (e) {}
      if (log.some(e => e[0] && !e[1])) { running++; continue; }   // timer still running: leave the whole task for next time
      let hours = 0;
      for (const e of log) {
        if (e[3] === false) continue;                  // non-billable entry
        const h = roundEntry(e[1] - e[0]) / 3600;
        hours += h;
      }
      if (hours <= 0) continue;                        // to-dos and non-billable-only tasks stay unlinked
      used.push(t);
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
    return { lines, running, used };
  }


  // ======================================================================
  //  Invoice numbers from the project code: ACME-1042, then ACME-1042b, c, d…
  //  (the bare code counts as "a"; same rule as auto_numbers.php on the server)
  // ======================================================================
  async function nextInvoiceNumber(code, excludeId) {
    const list = await allPages(`/invoices?status=active,archived,deleted&filter=${encodeURIComponent(code)}`);
    const re = new RegExp('^' + code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([a-z]*)$', 'i');
    const used = list.filter(x => x.id !== excludeId).map(x => (x.number || '').match(re)).filter(Boolean).map(m => m[1].toLowerCase() || 'a');
    if (!used.length) return code;
    const max = used.sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)).pop();
    return code + bumpLetters(max);
  }
  function bumpLetters(s) {            // a -> b ... z -> aa, az -> ba
    const c = s.split(''); let i = c.length - 1;
    while (i >= 0 && c[i] === 'z') { c[i] = 'a'; i--; }
    if (i < 0) return 'a' + c.join('');
    c[i] = String.fromCharCode(c[i].charCodeAt(0) + 1);
    return c.join('');
  }
  const isCode = n => !!n && CODE.test(n) && !/^TEMP-/i.test(n);

  function findInputByLabel(text) {
    const label = [...document.querySelectorAll('dt, label, span, div, p')]
      .find(el => el.children.length === 0 && el.textContent.trim() === text);
    if (!label) return null;
    let row = label.parentElement;
    for (let i = 0; i < 4 && row && !row.querySelector('input'); i++) row = row.parentElement;
    return row ? row.querySelector('input') : null;
  }
  function setReactValue(input, v) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Any invoice still showing TEMP-… with a project on it: fill in the project-code number.
  let invBusy = false;
  async function fillInvoiceNumber() {
    const m = location.pathname.match(/^\/invoices\/(create|[A-Za-z0-9]{6,}\/edit)/);
    if (!m || invBusy) return;
    const invId = m[1] === 'create' ? null : m[1].replace('/edit', '');
    const input = findInputByLabel('Invoice #');
    if (!input || !/^TEMP-/i.test(input.value || '') || input.dataset.fsFilled === input.value) return;
    invBusy = true; input.dataset.fsFilled = input.value;
    const hint = (txt) => {
      let b = document.querySelector('.fs-inv-hint');
      if (!b) { b = document.createElement('div'); b.className = 'fs-inv-hint'; b.style.cssText = 'font-size:12px;color:#6b7280;margin-top:6px;'; input.insertAdjacentElement('afterend', b); }
      b.textContent = txt;
    };
    try {
      const link = [...document.querySelectorAll('main a[href*="/projects/"], #root a[href*="/projects/"]')]
        .map(a => (a.getAttribute('href').match(/\/projects\/([A-Za-z0-9]{6,})/) || [])[1]).find(Boolean);
      const pid = link || (invId ? (await get(`/invoices/${invId}`)).data?.project_id : null);
      if (!pid) { hint('Pick a project and save — the number follows the project code.'); return; }
      const proj = (await get(`/projects/${pid}`)).data;
      if (!isCode(proj?.number)) { hint('This project has no code yet — it gets one within a minute, then reload.'); return; }
      const next = await nextInvoiceNumber(proj.number, invId);
      if (!/^TEMP-/i.test(input.value)) return;                  // you typed your own meanwhile
      setReactValue(input, next); input.dataset.fsFilled = next;
      hint(`Numbered from project ${proj.number}. Click Save to keep it.`);
    } catch (e) { hint('Number lookup failed: ' + e.message); input.dataset.fsFilled = ''; }
    finally { invBusy = false; }
  }

  async function invoiceUnbilled(projectId, btn) {
    btn.disabled = true; btn.textContent = 'Gathering time…';
    try {
      const project = (await get(`/projects/${projectId}`)).data;
      const client = (await get(`/clients/${project.client_id}`)).data;
      const tasks = await unbilledTasks(projectId);
      const fallback = +project.task_rate || +(client.settings?.default_task_rate) || 0;
      const { lines, running, used } = buildLines(tasks, fallback);
      if (!lines.length) { alert('No unbilled billable time on this project.' + (running ? `\n(${running} timer(s) still running.)` : '')); return; }
      const total = lines.reduce((s, l) => s + l.quantity * l.cost, 0);
      const summary = lines.map(l => `${l.product_key}: ${l.quantity} h × $${l.cost}`).join('\n');
      const willBe = isCode(project.number) ? await nextInvoiceNumber(project.number) : null;
      if (!confirm(`Create draft invoice ${willBe || ''} for ${project.number || project.name}?\n\n${summary}\n\nTotal: $${total.toFixed(2)}` + (running ? `\n\nNote: ${running} running timer(s) left out.` : ''))) return;

      btn.textContent = 'Creating invoice…';
      const body = { client_id: project.client_id, project_id: projectId, line_items: lines };
      if (isCode(project.number)) body.number = await nextInvoiceNumber(project.number);
      const inv = (await send('POST', '/invoices', body)).data;
      btn.textContent = 'Marking time as billed…';
      for (const t of used) { t.invoice_id = inv.id; await send('PUT', `/tasks/${t.id}`, t); }
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
    document.querySelectorAll('.fs-float').forEach(e => e.remove());
    b = document.createElement('button');
    b.id = id; b.className = 'fs-float'; b.textContent = label;
    b.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:9999;padding:10px 16px;border-radius:6px;border:0;background:#111827;color:#fff;font:600 13px system-ui;box-shadow:0 2px 8px rgba(0,0,0,.25);cursor:pointer;';
    b.addEventListener('click', () => onClick(b));
    document.body.appendChild(b);
  }

  function buttons() {
    const p = location.pathname.match(/^\/projects\/([A-Za-z0-9]{6,})(?:\/(?:edit|view))?$/);
    const i = location.pathname.match(/^\/invoices\/([A-Za-z0-9]{6,})\/edit$/);
    if (p && p[1] !== 'create') floatingButton('fs-inv-' + p[1], 'Invoice unbilled time', b => invoiceUnbilled(p[1], b));
    else if (i) floatingButton('fs-rel-' + i[1], 'Release tracked time', b => releaseTime(i[1], b));
    else document.querySelectorAll('.fs-float').forEach(e => e.remove());
  }

  // ======================================================================
  //  Projects list: hours to the quarter hour instead of whole hours
  // ======================================================================
  // Hours are cached in this browser, so the list fills in instantly from the last visit
  // and quietly refreshes in the background (pages are fetched in parallel).
  let hoursCache = null, hoursAt = 0, hoursBusy = false, refreshing = null;
  try { const c = JSON.parse(GM_getValue('fs_hours', 'null')); if (c) { hoursCache = c.h; hoursAt = c.at; } } catch (e) {}

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
        const x = roundEntry(end - e[0]) / 3600;
        h[t.project_id] = (h[t.project_id] || 0) + x;
      }
    }
    return h;
  }
  function refreshHours() {
    if (!refreshing) refreshing = fetchAllTasksParallel().then(tasks => {
      hoursCache = sumHours(tasks); hoursAt = Date.now();
      GM_setValue('fs_hours', JSON.stringify({ h: hoursCache, at: hoursAt }));
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
  const SIDEBAR_ORDER = ['Dashboard', 'Tasks', 'To-do', 'Projects', 'Invoices', 'Clients', 'Payments', 'Recurring Invoices',
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
    b.type = 'button'; b.textContent = label; b.className = 'fs-row-btn';
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
    const rows = dailyRows().filter(r => !r.row.querySelector('.fs-row-btn'));
    if (!rows.length) return;
    dayBusy = true;
    try {
      for (const full of [false, true]) {
        const ts = await tasksForDay(date, full);
        let missing = 0;
        for (const r of rows) {
          if (r.row.querySelector('.fs-row-btn')) continue;
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


  // ======================================================================
  //  Tasks views (daily / weekly / monthly / kanban): "Client · Project", project clickable
  // ======================================================================
  // Leaves the page's own text alone: the client name is drawn with CSS and the click is
  // caught before the page sees it, so React re-renders don't break anything.
  const css = document.createElement('style');
  css.textContent = `
    [data-fs-pid] { color:#2563eb !important; cursor:pointer; }
    [data-fs-pid]:hover { text-decoration:underline; }
    [data-fs-client]::before { content: attr(data-fs-client) "  ·  "; color:#6b7280; }`;
  document.documentElement.appendChild(css);

  let projIdx = null, projById = null, projIdxAt = 0, projIdxBusy = null;
  try { const c = JSON.parse(GM_getValue('fs_projidx', 'null')); if (c) { projIdx = c.idx; projById = c.byId || null; projIdxAt = c.at; } } catch (e) {}
  async function allParallel(entity) {
    const q = `/${entity}?status=active,archived&per_page=500`;
    const first = await get(q + '&page=1');
    const pages = first.meta?.pagination?.total_pages || 1;
    const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => get(`${q}&page=${i + 2}`)));
    return [first, ...rest].flatMap(j => j.data || []);
  }
  function rebuildProjIdx() {
    if (!projIdxBusy) projIdxBusy = Promise.all([allParallel('projects'), allParallel('clients')]).then(([ps, cs]) => {
      const cn = {}, cr = {}; cs.forEach(c => { cn[c.id] = c.name || c.display_name || ''; cr[c.id] = +(c.settings?.default_task_rate) || 0; });
      const idx = {}, byId = {};
      ps.filter(p => !p.is_deleted).forEach(p => {
        byId[p.id] = { id: p.id, name: p.name || '', number: p.number || '', client_id: p.client_id, client: cn[p.client_id] || '',
                       active: !p.archived_at, rate: +p.task_rate || cr[p.client_id] || 0 };
        const k = (p.name || '').trim(); if (!k) return;
        (idx[k] = idx[k] || []).push({ id: p.id, client: cn[p.client_id] || '', active: !p.archived_at, at: p.created_at || 0 });
      });
      projIdx = idx; projById = byId; projIdxAt = Date.now();
      GM_setValue('fs_projidx', JSON.stringify({ idx, byId, at: projIdxAt }));
      decorateTasks();
      if (typeof td !== 'undefined' && td.loaded) { td.byId = byId; if (!td.editing) renderTodo(); refreshOpenCombos(); }
    }).catch(e => console.warn('project index:', e)).finally(() => { projIdxBusy = null; });
    return projIdxBusy;
  }
  function pickProject(name) {
    let c = projIdx[name]; if (!c || !c.length) return null;
    if (c.length > 1 && c.some(x => x.active)) c = c.filter(x => x.active);
    c = c.slice().sort((a, b) => b.at - a.at);
    return { id: c[0].id, client: [...new Set(c.map(x => x.client))].join(' / ') };
  }

  const SKIP = '#fs-todo, nav, aside, a, button, select, option, input, textarea, h1, h2, [role="listbox"], [role="option"], [role="menu"], [class*="menu"], [class*="dropdown"], [class*="select"], [class*="Select"]';
  function decorateTasks() {
    if (!/^\/tasks(\/(daily|weekly|monthly|kanban))?$/.test(location.pathname)) return;
    if (!projIdx) { rebuildProjIdx(); return; }
    if (Date.now() - projIdxAt > 10 * 60000) rebuildProjIdx();       // refresh quietly every 10 min
    const root = document.querySelector('main') || document.getElementById('root') || document.body;
    for (const el of root.querySelectorAll('div, span, p, td, small')) {
      if (el.children.length) continue;
      const txt = (el.textContent || '').trim();
      if (el.dataset.fsProj === txt) continue;                       // already done and unchanged
      const hit = txt && projIdx[txt] ? pickProject(txt) : null;
      if (!hit || el.closest(SKIP) || el.closest('.fs-float')) {
        if (el.dataset.fsProj) { delete el.dataset.fsProj; delete el.dataset.fsPid; delete el.dataset.fsClient; }
        continue;
      }
      el.dataset.fsProj = txt; el.dataset.fsPid = hit.id;
      if (hit.client) el.dataset.fsClient = hit.client; else delete el.dataset.fsClient;
      el.title = 'Open project';
    }
  }
  window.addEventListener('click', e => {
    const el = e.target.closest && e.target.closest('[data-fs-pid]');
    if (!el) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const url = '/projects/' + el.dataset.fsPid;
    if (e.metaKey || e.ctrlKey) window.open(url, '_blank'); else location.href = url;
  }, true);
  // swallow the mousedown/pointerdown too, so a row click handler doesn't open the task editor
  ['mousedown', 'pointerdown', 'mouseup'].forEach(t => window.addEventListener(t, e => {
    if (e.target.closest && e.target.closest('[data-fs-pid]')) e.stopImmediatePropagation();
  }, true));

  // ======================================================================
  //  To-do: one prioritized list of what has to be done, by project
  //  Lives at /tasks#todo (sidebar "To-do"). Every to-do is an Invoice Ninja task with
  //  a rank in custom field 2 ("To-do rank") and an optional date in custom field 1 ("Due").
  //  Timers started here create normal time entries on the same project, so invoicing works
  //  exactly as before and a to-do never gets locked to an invoice.
  //  Done items stay in place (crossed out) until "Clear completed". Deleted ones go to Trash
  //  (Invoice Ninja's own soft delete) and can be restored.
  // ======================================================================
  const TD = {
    DUE: 'custom_value1',          // Settings → Custom Fields → Tasks → field 1 "Due" (Date)
    RANK: 'custom_value2',         // Settings → Custom Fields → Tasks → field 2 "To-do rank" (Single line text)
    TYPES: ['Production Design', 'Creative', 'Web Development', 'Client Meeting', 'Project Management',
            'Art Direction', 'Concepting', 'Copywriting', 'Photography', 'Research', 'Video Development', 'Admin'],
    NON_BILLABLE: ['Admin'],
  };
  const td = { tasks: [], all: [], trash: [], st: null, byId: {}, loaded: false, loading: null,
               view: GM_getValue('fs_todo_view', 'projects'), filter: GM_getValue('fs_todo_filter', 'all'), editing: null, editPreset: null, err: '' };

  const ICON = (d, fill) => `<svg width="14" height="14" viewBox="0 0 24 24" fill="${fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px">${d}</svg>`;
  const I = {
    play: ICON('<path d="M7 4.5v15l12-7.5z"/>', true),
    stop: ICON('<rect x="6" y="6" width="12" height="12" rx="1.5"/>', true),
    pause: ICON('<path d="M9 5v14M15 5v14"/>'),
    resume: ICON('<path d="M4 12a8 8 0 1 0 2.5-5.8"/><path d="M4 4v4h4"/>'),
    edit: ICON('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
    plus: ICON('<path d="M12 5v14M5 12h14"/>'),
    stopsign: `<svg width="16" height="16" viewBox="0 0 24 24" style="vertical-align:-3px"><path d="M7.6 2h8.8L22 7.6v8.8L16.4 22H7.6L2 16.4V7.6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="miter"/><path d="M8 12h8" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`,
    stopsignOn: `<svg width="16" height="16" viewBox="0 0 24 24" style="vertical-align:-3px"><path d="M7.6 2h8.8L22 7.6v8.8L16.4 22H7.6L2 16.4V7.6z" fill="#dc2626"/><path d="M8.2 3.5h7.6l4.7 4.7v7.6l-4.7 4.7H8.2l-4.7-4.7V8.2z" fill="none" stroke="#fff" stroke-width="1"/><path d="M8 12h8" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>`,
    trash: ICON('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nowSec = () => Math.floor(Date.now() / 1000);
  const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const addDays = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
  const logOfT = t => { try { return JSON.parse(t.time_log || '[]') || []; } catch (e) { return []; } };
  const isRunning = t => logOfT(t).some(e => e[0] && !e[1]);
  function htmlToText(h) {
    const x = document.createElement('textarea');
    x.innerHTML = String(h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p|li)>/gi, '\n').replace(/<[^>]+>/g, '');
    return x.value.replace(/\n{3,}/g, '\n\n').trim();
  }
  function parseDesc(desc) {
    const text = htmlToText(desc);
    const nl = text.indexOf('\n');
    const first = (nl < 0 ? text : text.slice(0, nl)).trim(), notes = nl < 0 ? '' : text.slice(nl + 1).trim();
    const i = first.indexOf(' — ');
    if (i > 0 && TD.TYPES.includes(first.slice(0, i))) return { type: first.slice(0, i), title: first.slice(i + 3), first, notes };
    if (TD.TYPES.includes(first)) return { type: first, title: '', first, notes };
    return { type: '', title: first, first, notes };
  }
  const firstLine = (type, title) => type ? type + (title ? ' — ' + title : '') : title;
  const hasRank = t => String(t[TD.RANK] || '').trim() !== '';
  const isTodo = t => !t.is_deleted && hasRank(t);
  const isDone = t => t.status_id === td.st.done;
  const rank = t => { const r = parseFloat(t[TD.RANK]); return isNaN(r) ? 1e9 : r; };
  const todayS = () => ymd(new Date());

  // ---------- data ----------
  async function pagesOf(q) {
    const first = await get(q + '&page=1');
    const pages = first.meta?.pagination?.total_pages || 1;
    const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => get(`${q}&page=${i + 2}`)));
    return [first, ...rest].flatMap(j => j.data || []);
  }
  const activeTasks = async () => (await pagesOf('/tasks?status=active&per_page=500')).filter(t => !t.is_deleted);
  const trashedTodos = async () => ((await get('/tasks?status=deleted&per_page=200&sort=updated_at|desc')).data || []).filter(t => t.is_deleted && hasRank(t));
  async function statuses() {
    let list = ((await get('/task_statuses?per_page=100')).data || []).filter(s => !s.is_deleted && !s.archived_at);
    const find = re => list.find(s => re.test(s.name || ''));
    for (const [re, name, color] of [[/wait/i, 'Waiting on client', '#9CA3AF'], [/done|complete/i, 'Done', '#10B981']]) {
      if (!find(re)) { const s = (await send('POST', '/task_statuses', { name, color })).data; if (s) list.push(s); }
    }
    const waiting = find(/wait/i), done = find(/done|complete/i);
    const rest = list.filter(s => s !== waiting && s !== done).sort((a, b) => (a.status_order || 0) - (b.status_order || 0));
    const open = rest.find(s => /ready|to ?do|todo|next/i.test(s.name)) || rest[0] || null;
    const names = {}; list.forEach(s => names[s.id] = s.name);
    return { open: open && open.id, waiting: waiting && waiting.id, done: done && done.id, names };
  }
  async function loadTodo(force) {
    if (td.loading) return td.loading;
    if (td.loaded && !force) return;
    td.loading = (async () => {
      try {
        const back = newProjectDraft();
        if ((back && back.returning) || !projById) await rebuildProjIdx();   // pick up a project you just made
        else rebuildProjIdx();                                              // cached list now, fresh list in a moment
        const [all, st, trash] = await Promise.all([activeTasks(), td.st ? Promise.resolve(td.st) : statuses(), trashedTodos().catch(() => [])]);
        td.all = all; td.st = st; td.byId = projById || {}; td.tasks = all.filter(isTodo); td.trash = trash; td.loaded = true; td.err = '';
        await normalizeRanks();
        if (back && back.returning) restoreDraft(back);
      } catch (e) { td.err = 'Could not load to-dos: ' + e.message; }
      finally { td.loading = null; }
      renderTodo();
    })();
    return td.loading;
  }
  async function saveTask(t) {
    const fresh = (await send('PUT', `/tasks/${t.id}`, t)).data || t;
    const swap = arr => { const i = arr.findIndex(x => x.id === t.id); if (i >= 0) arr[i] = fresh; };
    swap(td.tasks); swap(td.all);
    return fresh;
  }
  async function putMany(list) {             // a few at a time so the server isn't flooded
    for (let i = 0; i < list.length; i += 5) await Promise.all(list.slice(i, i + 5).map(saveTask));
  }
  async function normalizeRanks() {           // unique ranks 10, 20, 30… if anything is missing or duplicated
    const list = td.tasks.slice().sort((a, b) => rank(a) - rank(b) || (a.created_at || 0) - (b.created_at || 0));
    const seen = new Set(); let bad = false;
    list.forEach(t => { const r = rank(t); if (r >= 1e9 || seen.has(r)) bad = true; seen.add(r); });
    if (!bad) return;
    const changed = [];
    list.forEach((t, i) => { const r = String((i + 1) * 10); if (t[TD.RANK] !== r) { t[TD.RANK] = r; changed.push(t); } });
    await putMany(changed);
  }

  // time logged against a to-do = time entries on the same project with the same first line
  function timeFor(t) {
    const d = parseDesc(t.description); let secs = 0, running = null;
    for (const x of td.all) {
      if (x.id === t.id || isTodo(x) || (x.project_id || '') !== (t.project_id || '')) continue;
      if (parseDesc(x.description).first !== d.first) continue;
      for (const e of logOfT(x)) {
        if (!e[0]) continue;
        if (!e[1]) { running = { task: x, since: e[0] }; secs += nowSec() - e[0]; continue; }
        secs += roundEntry(e[1] - e[0]);
      }
    }
    return { hours: secs / 3600, running };
  }

  // ---------- actions ----------
  function splitText(text) {                  // first line = title, the rest = notes
    const s = String(text || '').replace(/\r/g, '').trim(), nl = s.indexOf('\n');
    return nl < 0 ? { title: s, notes: '' } : { title: s.slice(0, nl).trim(), notes: s.slice(nl + 1).trim() };
  }
  async function addTodo(form) {
    const { title, notes } = splitText(form.querySelector('[name=text]').value);
    if (!title) { form.querySelector('[name=text]').focus(); return; }
    const pid = comboPid(form);
    const type = form.querySelector('[name=type]').value;
    const due = form.querySelector('[name=due]').value;
    const p = pid ? td.byId[pid] : null;
    const maxRank = Math.max(0, ...td.tasks.map(rank).filter(r => r < 1e9));
    const body = { description: firstLine(type, title) + (notes ? '\n' + notes : ''), project_id: pid || '', client_id: p ? p.client_id : '',
                   status_id: td.st.open || '', [TD.RANK]: String(maxRank + 10), [TD.DUE]: due || '' };
    const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
    try {
      const t = (await send('POST', '/tasks', body)).data;
      td.tasks.push(t); td.all.push(t);
      form.querySelector('[name=text]').value = ''; form.querySelector('[name=due]').value = ''; form.querySelector('[name=type]').value = '';
      setCombo(form.querySelector('.fst-combo'), '');
      renderTodo();
    } catch (e) { alert('Could not add: ' + e.message); }
    finally { btn.disabled = false; }
  }
  async function setStatus(t, statusId) { t.status_id = statusId || ''; renderTodo(); await saveTask(t); renderTodo(); }
  async function setDue(t, due) { t[TD.DUE] = due || ''; renderTodo(); await saveTask(t); renderTodo(); }
  async function deleteTodo(t) {
    if (!confirm('Move this to-do to the Trash?\n\n' + parseDesc(t.description).first + '\n\nYou can restore it from the Trash at the bottom of the list.')) return;
    await send('POST', '/tasks/bulk', { action: 'delete', ids: [t.id] });
    td.tasks = td.tasks.filter(x => x.id !== t.id); td.all = td.all.filter(x => x.id !== t.id);
    td.trash.unshift(Object.assign({}, t, { is_deleted: true, updated_at: nowSec() }));
    if (td.editing === t.id) td.editing = null;
    renderTodo();
  }
  async function restoreTodo(id) {
    await send('POST', '/tasks/bulk', { action: 'restore', ids: [id] });
    const t = (await get(`/tasks/${id}`)).data;
    td.trash = td.trash.filter(x => x.id !== id);
    if (t && !t.is_deleted) { td.tasks.push(t); td.all.push(t); }
    renderTodo();
  }
  async function clearCompleted() {
    const ids = td.tasks.filter(isDone).map(t => t.id);
    if (!ids.length) return;
    if (!confirm(`Clear ${ids.length} completed to-do${ids.length > 1 ? 's' : ''}?\n\nThey're archived, not deleted (Tasks list → Archived if you ever need one).`)) return;
    await send('POST', '/tasks/bulk', { action: 'archive', ids });
    td.tasks = td.tasks.filter(t => !ids.includes(t.id)); td.all = td.all.filter(t => !ids.includes(t.id));
    renderTodo();
  }
  async function stopRunning() {
    for (const x of td.all.filter(x => !x.invoice_id && isRunning(x))) {
      const l = logOfT(x); l.forEach(e => { if (e[0] && !e[1]) e[1] = nowSec(); });
      x.time_log = JSON.stringify(l); await saveTask(x);
    }
  }
  async function startTimer(t) {
    const d = parseDesc(t.description), p = t.project_id ? td.byId[t.project_id] : null;
    await stopRunning();
    const billable = !TD.NON_BILLABLE.includes(d.type);
    const x = (await send('POST', '/tasks', { description: d.first, project_id: t.project_id || '', client_id: t.client_id || (p && p.client_id) || '',
      rate: p && p.rate ? p.rate : 0, time_log: JSON.stringify([[nowSec(), 0, '', billable]]) })).data;
    td.all.push(x);
    if (t.status_id === td.st.open || !t.status_id) {           // starting work moves it to "In progress" if you have that status
      const ip = Object.entries(td.st.names).find(([, n]) => /progress/i.test(n));
      if (ip) { t.status_id = ip[0]; saveTask(t); }
    }
    hoursCache = null; renderTodo();
  }
  async function stopTimer(run) {
    const l = logOfT(run.task); l.forEach(e => { if (e[0] && !e[1]) e[1] = nowSec(); });
    run.task.time_log = JSON.stringify(l); await saveTask(run.task); hoursCache = null; renderTodo();
  }
  async function saveEdit(t, box) {
    const v = n => box.querySelector(`[name=${n}]`).value;
    const pid = comboPid(box);
    const title = v('title').trim(); if (!title) { alert('A to-do needs a title.'); return; }
    const notes = v('notes').trim();
    t.description = firstLine(v('type'), title) + (notes ? '\n' + notes : '');
    t.project_id = pid || ''; t.client_id = pid ? td.byId[pid].client_id : (t.client_id || '');
    t[TD.DUE] = v('due') || '';
    const wait = box.querySelector('[name=waiting]').checked;
    if (wait && t.status_id !== td.st.waiting && !isDone(t)) t.status_id = td.st.waiting;
    else if (!wait && t.status_id === td.st.waiting) t.status_id = td.st.open;
    td.editing = null; td.editPreset = null; renderTodo();
    try { await saveTask(t); } catch (e) { alert('Save failed: ' + e.message); }
    renderTodo();
  }

  // ---------- ordering ----------
  async function permute(ids) {             // reorder a subset among the ranks it already holds
    const items = ids.map(id => td.tasks.find(t => t.id === id)).filter(Boolean);
    const ranks = items.map(rank).sort((a, b) => a - b);
    const changed = [];
    items.forEach((t, i) => { const r = String(ranks[i]); if (t[TD.RANK] !== r) { t[TD.RANK] = r; changed.push(t); } });
    renderTodo(); await putMany(changed);
  }
  async function moveGroup(movedKey, nextKey) {   // move a whole project block in front of the next group
    const L = td.tasks.slice().sort((a, b) => rank(a) - rank(b));
    const key = t => t.project_id || '_none';
    const block = L.filter(t => key(t) === movedKey), rest = L.filter(t => key(t) !== movedKey);
    let at = nextKey ? rest.findIndex(t => key(t) === nextKey) : rest.length;
    if (at < 0) at = rest.length;
    rest.splice(at, 0, ...block);
    const changed = [];
    rest.forEach((t, i) => { const r = String((i + 1) * 10); if (t[TD.RANK] !== r) { t[TD.RANK] = r; changed.push(t); } });
    renderTodo(); await putMany(changed);
  }

  // ---------- project picker (always shows the full list; "+ New project" on top) ----------
  const projLabel = p => (p.number ? p.number + ' · ' : '') + p.name + (p.client ? ' — ' + p.client : '');
  function comboHtml(pid) {
    const p = pid ? td.byId[pid] : null;
    return `<div class="fst-combo"><input class="fst-combo-in" placeholder="Project (optional)" autocomplete="off" spellcheck="false" value="${esc(p ? projLabel(p) : '')}" data-pid="${esc(pid || '')}">`
      + `<button type="button" class="fst-combo-x" data-act="clearproj" title="Clear project"${p ? '' : ' hidden'}>×</button><div class="fst-combo-list" hidden></div></div>`;
  }
  const comboPid = scope => { const i = scope.querySelector('.fst-combo-in'); return i && i.dataset.pid && td.byId[i.dataset.pid] ? i.dataset.pid : ''; };
  function setCombo(combo, pid) {
    const inp = combo.querySelector('.fst-combo-in'), p = pid ? td.byId[pid] : null;
    inp.dataset.pid = p ? pid : ''; inp.value = p ? projLabel(p) : '';
    combo.querySelector('.fst-combo-x').hidden = !p;
    closeCombo(combo);
  }
  function openCombo(combo, query) {
    const list = combo.querySelector('.fst-combo-list');
    const q = (query || '').trim().toLowerCase();
    const ps = Object.values(td.byId).filter(p => p.active)
      .filter(p => !q || (p.number + ' ' + p.name + ' ' + p.client).toLowerCase().includes(q))
      .sort((a, b) => a.client.localeCompare(b.client) || a.number.localeCompare(b.number, undefined, { numeric: true }));
    let html = `<div class="fst-opt fst-opt-new" data-new="1">${I.plus} New project…</div>`, last = null;
    for (const p of ps) {
      if (p.client !== last) { html += `<div class="fst-optgroup">${esc(p.client || 'No client')}</div>`; last = p.client; }
      html += `<div class="fst-opt" data-pid="${p.id}">${p.number ? `<b>${esc(p.number)}</b> ` : ''}${esc(p.name)}</div>`;
    }
    if (!ps.length) {
      const stale = Date.now() - projIdxAt > 15000;
      html += `<div class="fst-optnone">No open project matches “${esc(query)}”${stale ? ' — checking for new projects…' : ''}</div>`;
      if (stale) rebuildProjIdx();
    }
    list.innerHTML = html; list.hidden = false;
    hiliteCombo(combo, q && ps.length ? 1 : 0);          // typing: Enter picks the first match, not "New project"
  }
  function refreshOpenCombos() {
    document.querySelectorAll('#fs-todo .fst-combo').forEach(c => {
      if (!c.querySelector('.fst-combo-list').hidden) openCombo(c, c.querySelector('.fst-combo-in').dataset.pid ? '' : c.querySelector('.fst-combo-in').value);
    });
  }
  function closeCombo(combo) { const l = combo.querySelector('.fst-combo-list'); if (l) l.hidden = true; }
  function hiliteCombo(combo, idx) {
    const opts = [...combo.querySelectorAll('.fst-opt')];
    opts.forEach(o => o.classList.remove('fst-hi'));
    const pick = opts[Math.max(0, Math.min(idx, opts.length - 1))];
    if (pick) { pick.classList.add('fst-hi'); pick.scrollIntoView({ block: 'nearest' }); }
  }
  function pickOpt(combo, opt) {
    if (opt.dataset.new) { startNewProject(combo); return; }
    setCombo(combo, opt.dataset.pid);
  }

  // "+ New project" opens Invoice Ninja's own New Project page, then comes back here with it selected
  function startNewProject(combo) {
    const edit = combo.closest('.fst-editing');
    const draft = { at: Date.now(), editId: edit ? edit.dataset.id : null };
    const box = edit || combo.closest('form');
    const val = n => box.querySelector(`[name=${n}]`)?.value || '';
    if (edit) Object.assign(draft, { title: val('title'), notes: val('notes'), type: val('type'), due: val('due'), waiting: !!edit.querySelector('[name=waiting]')?.checked });
    else Object.assign(draft, { text: val('text'), type: val('type'), due: val('due') });
    GM_setValue('fs_todo_newproj', JSON.stringify(draft));
    location.href = '/projects/create';
  }
  function newProjectDraft() {
    try { const d = JSON.parse(GM_getValue('fs_todo_newproj', '') || 'null'); if (d && Date.now() - d.at < 60 * 60000) return d; } catch (e) {}
    return null;
  }
  function trackNewProject() {               // runs on every page change
    const d = newProjectDraft(); if (!d) return;
    const path = location.pathname;
    if (path === '/projects/create') { if (!d.seenCreate) { d.seenCreate = true; GM_setValue('fs_todo_newproj', JSON.stringify(d)); } return; }
    const m = path.match(/^\/projects\/([A-Za-z0-9]{6,})(?:\/(?:edit|view))?$/);
    if (d.seenCreate && !d.returning && m) {   // saved: Invoice Ninja opened the new project
      d.returning = true; d.pid = m[1]; GM_setValue('fs_todo_newproj', JSON.stringify(d));
      (PN.saving || Promise.resolve()).finally(() => { location.href = '/tasks#todo'; }); return;
    }
    if (d.seenCreate && !d.returning && !m) GM_setValue('fs_todo_newproj', '');   // cancelled
  }
  function restoreDraft(d) {
    GM_setValue('fs_todo_newproj', '');
    if (d.editId && td.tasks.some(t => t.id === d.editId)) {
      td.editing = d.editId; td.editPreset = { pid: d.pid, title: d.title, notes: d.notes, type: d.type, due: d.due, waiting: d.waiting };
      return;
    }
    const f = document.querySelector('#fs-todo .fst-add'); if (!f) return;
    f.querySelector('[name=text]').value = d.text || '';
    f.querySelector('[name=type]').value = d.type || '';
    f.querySelector('[name=due]').value = d.due || '';
    setCombo(f.querySelector('.fst-combo'), d.pid);
    setTimeout(() => f.querySelector('[name=text]').focus(), 50);
  }
  const typeOptions = sel => '<option value="">Type…</option>' + TD.TYPES.map(x => `<option${x === sel ? ' selected' : ''}>${esc(x)}</option>`).join('');

  // ---------- render ----------
  function dueChip(t) {
    const due = t[TD.DUE] || '', today = todayS();
    if (!due) return `<button class="fst-due fst-due-empty" data-act="due" title="Set a due date">+ Due</button>`;
    const d = new Date(due + 'T12:00:00'), days = Math.round((d - new Date(today + 'T12:00:00')) / 86400000);
    const label = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days < 0 ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ` · ${-days}d late`
      : d.toLocaleDateString(undefined, days < 7 ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' });
    const cls = days < 0 ? 'fst-od' : days <= 6 ? 'fst-soon' : '';
    return `<button class="fst-due ${cls}" data-act="due" title="Change due date">${esc(label)}</button>`;
  }
  const fmtH = h => (Math.round(h * 4) / 4).toFixed(2).replace(/\.?0+$/, '') + 'h';
  const fmtRun = s => { const m = Math.floor((nowSec() - s) / 60); return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0'); };
  const projText = p => (p.client ? p.client + ' · ' : '') + (p.number ? p.number + ' ' : '') + p.name;

  function editHtml(t) {
    const d = parseDesc(t.description), pre = td.editPreset || {};
    const title = pre.title != null ? pre.title : d.title, notes = pre.notes != null ? pre.notes : d.notes;
    const type = pre.type != null ? pre.type : d.type, due = pre.due != null ? pre.due : (t[TD.DUE] || '');
    const pid = pre.pid || t.project_id || '';
    return `<div class="fst-row fst-editing" data-id="${t.id}">
      <div class="fst-edit">
        <div class="fst-edit-line">${comboHtml(pid)}<select name="type">${typeOptions(type)}</select><input name="due" type="date" value="${esc(due)}"></div>
        <input name="title" value="${esc(title)}" placeholder="What has to be done">
        <textarea name="notes" rows="3" placeholder="Notes">${esc(notes)}</textarea>
        <label class="fst-waitbox"><input type="checkbox" name="waiting"${(pre.waiting != null ? pre.waiting : t.status_id === td.st.waiting) ? ' checked' : ''}> Waiting on client</label>
        <div class="fst-edit-line fst-edit-btns"><button type="button" class="fst-btn fst-primary" data-act="save">Save</button><button type="button" class="fst-btn" data-act="cancel">Cancel</button>
          <span class="fst-spacer"></span><button type="button" class="fst-btn fst-danger" data-act="delete">${I.trash} Move to Trash</button></div>
      </div></div>`;
  }

  function rowHtml(t, opts) {
    if (td.editing === t.id) return editHtml(t);
    const d = parseDesc(t.description), done = isDone(t), waiting = t.status_id === td.st.waiting;
    const tm = timeFor(t), p = t.project_id ? td.byId[t.project_id] : null;
    const due = t[TD.DUE] || '', od = !done && due && due < todayS();
    const stName = !done && !waiting && t.status_id && t.status_id !== td.st.open ? td.st.names[t.status_id] : '';
    return `<div class="fst-row${done ? ' fst-done' : ''}${waiting ? ' fst-waiting' : ''}${od ? ' fst-row-od' : ''}" data-id="${t.id}">
      <span class="fst-grip" title="Drag to reorder">⋮⋮</span>
      <input type="checkbox" class="fst-check" data-act="done" ${done ? 'checked' : ''} title="${done ? 'Mark not done' : 'Mark done'}">
      <div class="fst-main" data-act="edit" title="Click to edit">
        <div class="fst-title">${esc(d.title || d.type || '(untitled)')}</div>
        <div class="fst-meta">
          ${d.type && d.title ? `<span class="fst-chip">${esc(d.type)}</span>` : ''}
          ${waiting ? '<span class="fst-chip fst-chip-wait">Waiting on client</span>' : ''}
          ${stName ? `<span class="fst-chip fst-chip-st">${esc(stName)}</span>` : ''}
          ${opts.showProject && p ? `<a class="fst-plink" href="/projects/${p.id}">${esc(projText(p))}</a>` : ''}
          ${opts.showProject && !p ? '<span class="fst-muted">No project</span>' : ''}
          ${d.notes ? `<span class="fst-muted" title="${esc(d.notes)}">✎ notes</span>` : ''}
          ${Math.round(tm.hours * 4) > 0 ? `<span class="fst-muted">${fmtH(tm.hours)} logged</span>` : ''}
        </div>
      </div>
      <span class="fst-duecol">${done ? '' : dueChip(t)}</span>
      <span class="fst-added" title="Date added">${t.created_at ? ymd(new Date(t.created_at * 1000)) : ''}</span>
      <div class="fst-acts">
        ${done ? '' : tm.running ? `<button class="fst-icon fst-running" data-act="stop" title="Pause timer">${I.pause} ${fmtRun(tm.running.since)}</button>`
                     : `<button class="fst-icon fst-playbtn" data-act="start" title="Start timer">${I.play}</button>`}
        ${done ? '' : `<button class="fst-icon fst-waitbtn${waiting ? ' fst-on' : ''}" data-act="wait" title="${waiting ? 'Waiting on client — click to clear' : 'Mark as waiting on client'}">${waiting ? I.stopsignOn : I.stopsign}</button>`}
        <button class="fst-icon" data-act="edit" title="Edit">${I.edit}</button>
        <button class="fst-icon fst-trash" data-act="delete" title="Move to Trash">${I.trash}</button>
      </div>
    </div>`;
  }

  function visible(t) {
    if (td.filter === 'all') return true;
    const due = t[TD.DUE] || ''; if (!due || isDone(t)) return false;
    return td.filter === 'overdue' ? due < todayS() : due <= addDays(todayS(), 6);
  }

  function trashHtml() {
    if (!td.trash.length) return '';
    const rows = td.trash.map(t => {
      const d = parseDesc(t.description), p = t.project_id ? td.byId[t.project_id] : null;
      const when = t.updated_at ? new Date(t.updated_at * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
      return `<div class="fst-row fst-trashrow" data-id="${t.id}"><div class="fst-main fst-nocursor"><div class="fst-title">${esc(d.title || d.first || '(untitled)')}</div>
        <div class="fst-meta">${p ? `<span class="fst-muted">${esc(projText(p))}</span>` : ''}${when ? `<span class="fst-muted">deleted ${esc(when)}</span>` : ''}</div></div>
        <button class="fst-btn" data-act="restore">Restore</button></div>`;
    }).join('');
    return `<details class="fst-trashbox"${GM_getValue('fs_todo_trashopen', false) ? ' open' : ''}><summary>${I.trash} Trash (${td.trash.length})</summary>
      <div class="fst-card"><div class="fst-list-plain">${rows}</div></div></details>`;
  }

  function bodyHtml() {
    const list = td.tasks.filter(visible).sort((a, b) => rank(a) - rank(b));
    let html = '';
    if (!list.length) html += `<div class="fst-empty">${td.filter === 'all' ? 'Nothing on the list. Add a to-do above.' : 'Nothing ' + (td.filter === 'overdue' ? 'overdue' : 'due this week') + '.'}</div>`;
    else if (td.view === 'focus') {
      const main = list.filter(t => t.status_id !== td.st.waiting), wait = list.filter(t => t.status_id === td.st.waiting);
      if (main.length) html += `<div class="fst-card"><div class="fst-list" data-list="focus">${main.map(t => rowHtml(t, { showProject: true })).join('')}</div></div>`;
      if (wait.length) html += `<div class="fst-sub">Waiting on client</div><div class="fst-card"><div class="fst-list" data-list="wait">${wait.map(t => rowHtml(t, { showProject: true })).join('')}</div></div>`;
    } else {
      const groups = new Map();
      list.forEach(t => { const k = t.project_id || '_none'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); });
      html += '<div class="fst-groups">';
      for (const [k, items] of groups) {
        items.sort((a, b) => (a.status_id === td.st.waiting) - (b.status_id === td.st.waiting) || rank(a) - rank(b));
        const p = td.byId[k], openN = items.filter(t => !isDone(t)).length;
        const head = p ? `<span class="fst-gclient">${esc(p.client || '')}</span> <a class="fst-glink" href="/projects/${p.id}">${p.number ? `<b>${esc(p.number)}</b> ` : ''}${esc(p.name)}</a>`
                       : '<span class="fst-gclient">No project</span>';
        html += `<div class="fst-group fst-card" data-key="${esc(k)}">
          <div class="fst-ghead"><span class="fst-grip" title="Drag to move this project up or down">⋮⋮</span>${head}<span class="fst-gcount">${openN}</span>
            ${p ? `<button class="fst-icon fst-gadd" data-act="addto" data-pid="${p.id}" title="Add a to-do to this project">${I.plus}</button>` : ''}</div>
          <div class="fst-list" data-list="group" data-key="${esc(k)}">${items.map(t => rowHtml(t, { showProject: false })).join('')}</div>
        </div>`;
      }
      html += '</div>';
    }
    return html + trashHtml();
  }

  function headerCounts() {
    const open = td.tasks.filter(t => !isDone(t) && t.status_id !== td.st.waiting), today = todayS();
    const od = open.filter(t => t[TD.DUE] && t[TD.DUE] < today).length, dt = open.filter(t => t[TD.DUE] === today).length;
    return `${open.length} open` + (od ? ` · <span class="fst-red">${od} overdue</span>` : '') + (dt ? ` · <span class="fst-amber">${dt} due today</span>` : '');
  }

  function renderTodo() {
    const root = document.getElementById('fs-todo'); if (!root) return;
    const body = root.querySelector('.fst-body');
    if (td.err) { body.innerHTML = `<div class="fst-empty fst-red">${esc(td.err)}</div>`; return; }
    if (!td.loaded) { body.innerHTML = '<div class="fst-empty">Loading to-dos…</div>'; return; }
    root.querySelector('.fst-count').innerHTML = headerCounts();
    root.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('fst-on', b.dataset.view === td.view));
    root.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('fst-on', b.dataset.filter === td.filter));
    const nDone = td.tasks.filter(isDone).length, clr = root.querySelector('[data-act=clear]');
    clr.hidden = !nDone; clr.textContent = `Clear completed (${nDone})`;
    const y = root.scrollTop;
    body.innerHTML = (td.tasks.some(visible) ? '<div class="fst-colhead"><span class="fst-spacer"></span><span class="fst-duecol">Due</span><span class="fst-added">Added</span><span class="fst-acts"></span></div>' : '') + bodyHtml();
    root.scrollTop = y;
    wireSortables(body);
  }

  function wireSortables(body) {
    if (typeof Sortable === 'undefined') return;
    body.querySelectorAll('.fst-list[data-list]').forEach(list => {
      Sortable.create(list, { handle: '.fst-grip', animation: 150, ghostClass: 'fst-ghost',
        onEnd: () => permute([...list.querySelectorAll('.fst-row')].map(r => r.dataset.id)) });
    });
    const groups = body.querySelector('.fst-groups');
    if (groups) Sortable.create(groups, { handle: '.fst-ghead .fst-grip', draggable: '.fst-group', animation: 150, ghostClass: 'fst-ghost',
      onEnd: e => { const next = e.item.nextElementSibling; moveGroup(e.item.dataset.key, next ? next.dataset.key : null); } });
  }

  // ---------- shell ----------
  const TODO_CSS = `
  #fs-todo { position:fixed; top:0; right:0; bottom:0; z-index:40; overflow:auto; background:#f3f4f6; color:#111827; font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  #fs-todo * { box-sizing:border-box; }
  #fs-todo [hidden] { display:none !important; }
  #fs-todo .fst-wrap { max-width:1040px; margin:0 auto; padding:24px 32px 80px; }
  #fs-todo .fst-head { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:16px; }
  #fs-todo h1 { font-size:22px; font-weight:600; margin:0; }
  #fs-todo .fst-count { color:#6b7280; font-size:13px; }
  #fs-todo .fst-spacer { flex:1; }
  #fs-todo .fst-seg { display:inline-flex; border:1px solid #d1d5db; border-radius:6px; overflow:hidden; background:#fff; }
  #fs-todo .fst-seg button { border:0; background:none; padding:6px 12px; font-size:13px; color:#374151; cursor:pointer; }
  #fs-todo .fst-seg button + button { border-left:1px solid #d1d5db; }
  #fs-todo .fst-seg button.fst-on { background:#111827; color:#fff; }
  #fs-todo .fst-card { background:#fff; border:1px solid #e5e7eb; border-radius:8px; }
  #fs-todo .fst-add { display:flex; flex-direction:column; gap:8px; padding:12px; margin-bottom:20px; }
  #fs-todo .fst-add-top { display:flex; gap:8px; flex-wrap:wrap; }
  #fs-todo .fst-add-top .fst-combo { flex:1 1 320px; }
  #fs-todo .fst-add [name=type] { flex:0 1 180px; }
  #fs-todo .fst-add [name=due] { flex:0 0 150px; }
  #fs-todo .fst-add [name=text] { width:100%; resize:vertical; min-height:70px; }
  #fs-todo .fst-add-bottom { display:flex; align-items:center; gap:8px; }
  #fs-todo input, #fs-todo select, #fs-todo textarea { font:inherit; border:1px solid #d1d5db; border-radius:6px; padding:7px 10px; background:#fff; color:#111827; }
  #fs-todo input:focus, #fs-todo select:focus, #fs-todo textarea:focus { outline:2px solid #2563eb33; border-color:#2563eb; }
  #fs-todo .fst-btn { border:1px solid #d1d5db; background:#fff; border-radius:6px; padding:7px 14px; font-size:13px; cursor:pointer; color:#111827; display:inline-flex; align-items:center; gap:6px; }
  #fs-todo .fst-btn:disabled { opacity:.5; cursor:default; }
  #fs-todo .fst-primary { background:#111827; border-color:#111827; color:#fff; font-weight:600; }
  #fs-todo .fst-danger { color:#b91c1c; }
  #fs-todo .fst-combo { position:relative; display:flex; min-width:0; }
  #fs-todo .fst-combo-in { flex:1; min-width:0; padding-right:30px; cursor:pointer; }
  #fs-todo .fst-combo-x { position:absolute; right:4px; top:50%; transform:translateY(-50%); border:0; background:none; color:#9ca3af; font-size:18px; line-height:1; padding:2px 7px; cursor:pointer; border-radius:4px; }
  #fs-todo .fst-combo-x:hover { color:#111827; background:#f3f4f6; }
  #fs-todo .fst-combo-list { position:absolute; left:0; right:0; top:calc(100% + 4px); z-index:5; background:#fff; border:1px solid #e5e7eb; border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,.12); max-height:320px; overflow:auto; padding:4px 0; }
  #fs-todo .fst-opt { padding:6px 12px; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #fs-todo .fst-opt.fst-hi { background:#eff6ff; }
  #fs-todo .fst-opt-new { color:#2563eb; font-weight:600; border-bottom:1px solid #f0f1f3; margin-bottom:4px; display:flex; align-items:center; gap:6px; }
  #fs-todo .fst-optgroup { padding:8px 12px 2px; font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:#9ca3af; }
  #fs-todo .fst-optnone { padding:8px 12px; color:#9ca3af; }
  #fs-todo .fst-group { margin-bottom:14px; }
  #fs-todo .fst-ghead { display:flex; align-items:center; gap:8px; padding:10px 12px; border-bottom:1px solid #f0f1f3; background:#fafafa; border-radius:8px 8px 0 0; }
  #fs-todo .fst-gclient { color:#6b7280; font-size:13px; }
  #fs-todo .fst-glink { color:#111827; text-decoration:none; font-weight:500; }
  #fs-todo .fst-glink:hover { text-decoration:underline; }
  #fs-todo .fst-gcount { color:#9ca3af; font-size:12px; margin-left:4px; }
  #fs-todo .fst-gadd { margin-left:auto; }
  #fs-todo .fst-row { display:flex; align-items:center; gap:10px; padding:9px 12px; border-top:1px solid #f0f1f3; }
  #fs-todo .fst-list .fst-row:first-child, #fs-todo .fst-list-plain .fst-row:first-child { border-top:0; }
  #fs-todo .fst-list .fst-row { background:#fffdf0; }
  #fs-todo .fst-list .fst-row:hover { background:#fef9db; }
  #fs-todo .fst-list .fst-row.fst-done { background:#f0fdf4; }
  #fs-todo .fst-list .fst-row.fst-done:hover { background:#e3f9ea; }
  #fs-todo .fst-list .fst-row.fst-editing { background:#fff; }
  #fs-todo .fst-list .fst-row:last-child { border-radius:0 0 8px 8px; }
  #fs-todo .fst-list[data-list=focus] .fst-row:first-child, #fs-todo .fst-list[data-list=wait] .fst-row:first-child { border-radius:8px 8px 0 0; }
  #fs-todo .fst-list[data-list=focus] .fst-row:only-child, #fs-todo .fst-list[data-list=wait] .fst-row:only-child { border-radius:8px; }
  #fs-todo .fst-trashrow:hover { background:#f9fafb; }
  #fs-todo .fst-added { color:#9ca3af; font-size:12px; font-variant-numeric:tabular-nums; width:78px; text-align:right; flex:0 0 78px; }
  #fs-todo .fst-waitbox { display:inline-flex; align-items:center; gap:6px; font-size:13px; color:#374151; cursor:pointer; }
  #fs-todo .fst-waitbox input[type=checkbox] { width:16px; height:16px; flex-basis:16px; }
  #fs-todo .fst-grip { color:#c4c7cc; cursor:grab; user-select:none; font-size:12px; letter-spacing:-2px; width:14px; flex:0 0 14px; }
  #fs-todo .fst-grip:hover { color:#6b7280; }
  #fs-todo input[type=checkbox] { -webkit-appearance:none; appearance:none; width:18px; height:18px; margin:0; padding:0; flex:0 0 18px; cursor:pointer;
    border:1.5px solid #9ca3af; border-radius:4px; background:#fff none center/14px 14px no-repeat; box-shadow:none; outline:none; color:transparent; }
  #fs-todo input[type=checkbox]:hover { border-color:#16a34a; }
  #fs-todo input[type=checkbox]:checked { background-color:#16a34a; border-color:#16a34a;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 12.5l4.5 4.5L19 7.5'/%3E%3C/svg%3E"); }
  #fs-todo input[type=checkbox]:focus-visible { box-shadow:0 0 0 3px #bbf7d0; }
  #fs-todo .fst-main { flex:1; min-width:0; cursor:pointer; }
  #fs-todo .fst-nocursor { cursor:default; }
  #fs-todo .fst-title { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #fs-todo .fst-meta { display:flex; gap:8px; flex-wrap:wrap; margin-top:2px; font-size:12px; }
  #fs-todo .fst-meta:empty { display:none; }
  #fs-todo .fst-chip { background:#f3f4f6; color:#374151; border-radius:4px; padding:0 6px; }
  #fs-todo .fst-chip-wait { background:#fef3c7; color:#92400e; }
  #fs-todo .fst-chip-st { background:#dbeafe; color:#1e40af; }
  #fs-todo .fst-plink { color:#2563eb; text-decoration:none; }
  #fs-todo .fst-plink:hover { text-decoration:underline; }
  #fs-todo .fst-muted { color:#9ca3af; }
  #fs-todo .fst-due { border:1px solid #e5e7eb; background:#fff; border-radius:999px; padding:2px 10px; font-size:12px; cursor:pointer; color:#374151; white-space:nowrap; }
  #fs-todo .fst-due-empty { color:#9ca3af; border-style:dashed; visibility:hidden; }
  #fs-todo .fst-row:hover .fst-due-empty { visibility:visible; }
  #fs-todo .fst-due.fst-soon { background:#fffbeb; border-color:#fcd34d; color:#92400e; }
  #fs-todo .fst-due.fst-od { background:#fef2f2; border-color:#fca5a5; color:#b91c1c; font-weight:600; }
  #fs-todo .fst-acts { display:flex; gap:2px; flex:0 0 166px; justify-content:flex-end; align-items:center; }
  #fs-todo .fst-duecol { flex:0 0 128px; text-align:right; }
  #fs-todo .fst-colhead { display:flex; align-items:center; gap:10px; padding:0 13px 6px; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:#9ca3af; font-weight:600; position:sticky; top:0; z-index:3; background:#f3f4f6; padding-top:6px; }
  #fs-todo .fst-colhead .fst-added { color:#9ca3af; font-size:11px; }
  #fs-todo .fst-waitbtn:hover { color:#b91c1c; background:#fee2e2; }
  #fs-todo .fst-waitbtn.fst-on { color:#dc2626; }
  #fs-todo .fst-waitbtn.fst-on:hover { color:#b91c1c; background:#fee2e2; }
  #fs-todo .fst-icon { border:0; background:none; color:#6b7280; cursor:pointer; padding:4px 7px; border-radius:5px; font-size:13px; }
  #fs-todo .fst-icon:hover { background:#e5e7eb; color:#111827; }
  #fs-todo .fst-trash:hover { background:#fee2e2; color:#b91c1c; }
  #fs-todo .fst-running, #fs-todo .fst-running:hover { color:#fff; font-weight:600; background:#16a34a; box-shadow:0 0 0 3px #bbf7d0; }
  #fs-todo .fst-running:hover { background:#15803d; }
  #fs-todo .fst-playbtn:hover { color:#16a34a; background:#dcfce7; }
  #fs-todo .fst-waiting .fst-title { color:#9ca3af; }
  #fs-todo .fst-done .fst-title { color:#9ca3af; text-decoration:line-through; }
  #fs-todo .fst-done .fst-meta { opacity:.6; }
  #fs-todo .fst-row-od .fst-title { color:#991b1b; }
  #fs-todo .fst-ghost { opacity:.35; background:#eff6ff; }
  #fs-todo .fst-edit { flex:1; display:flex; flex-direction:column; gap:8px; padding:4px 0; }
  #fs-todo .fst-edit-line { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  #fs-todo .fst-edit-line .fst-combo { flex:1 1 300px; }
  #fs-todo .fst-sub { margin:18px 0 8px; color:#6b7280; font-size:13px; font-weight:600; }
  #fs-todo .fst-trashbox { margin-top:26px; }
  #fs-todo .fst-trashbox summary { cursor:pointer; color:#6b7280; font-size:13px; font-weight:600; margin-bottom:8px; }
  #fs-todo .fst-trashrow .fst-title { color:#6b7280; }
  #fs-todo .fst-empty { padding:40px; text-align:center; color:#6b7280; }
  #fs-todo .fst-red { color:#b91c1c; } #fs-todo .fst-amber { color:#b45309; }
  #fs-todo .fst-hint { color:#9ca3af; font-size:12px; }
  @media (max-width: 760px) { #fs-todo .fst-wrap { padding:16px; } #fs-todo .fst-added { display:none; } }
  `;

  function todoShell() {
    const el = document.createElement('div');
    el.id = 'fs-todo';
    el.innerHTML = `<style>${TODO_CSS}</style><div class="fst-wrap">
      <div class="fst-head"><h1>To-do</h1><span class="fst-count"></span><span class="fst-spacer"></span>
        <button class="fst-btn" data-act="clear" hidden></button>
        <div class="fst-seg"><button data-view="projects">By project</button><button data-view="focus">Focus</button></div>
        <div class="fst-seg"><button data-filter="all">All</button><button data-filter="week">Due this week</button><button data-filter="overdue">Overdue</button></div>
        <button class="fst-btn" data-act="reload" title="Reload">↻</button></div>
      <form class="fst-add fst-card" autocomplete="off">
        <div class="fst-add-top">${comboHtml('')}<select name="type">${typeOptions('')}</select><input name="due" type="date" title="Due date (optional)"></div>
        <textarea name="text" rows="3" placeholder="Add a to-do…  First line is the title; anything below it becomes notes."></textarea>
        <div class="fst-add-bottom"><span class="fst-hint">Drag ⋮⋮ to set priority. In “By project”, drag a project’s header to move the whole project.</span><span class="fst-spacer"></span>
          <button type="submit" class="fst-btn fst-primary">Add to-do</button></div>
      </form>
      <div class="fst-body"></div></div>`;
    el.addEventListener('submit', e => { e.preventDefault(); addTodo(e.target); });
    el.addEventListener('click', onTodoClick);
    el.addEventListener('keydown', onTodoKey);
    el.addEventListener('focusin', e => { if (e.target.matches('.fst-combo-in')) { openCombo(e.target.closest('.fst-combo'), ''); e.target.select(); } });
    el.addEventListener('input', e => { if (e.target.matches('.fst-combo-in')) { e.target.dataset.pid = ''; openCombo(e.target.closest('.fst-combo'), e.target.value); } });
    el.addEventListener('focusout', e => {
      if (!e.target.matches('.fst-combo-in')) return;
      const combo = e.target.closest('.fst-combo');
      setTimeout(() => { if (combo.contains(document.activeElement)) return; setCombo(combo, e.target.dataset.pid); }, 120);
    });
    el.addEventListener('mousedown', e => {                          // pick from the list without losing focus first
      const opt = e.target.closest('.fst-opt'); if (!opt) return;
      e.preventDefault(); pickOpt(opt.closest('.fst-combo'), opt);
    });
    el.addEventListener('toggle', e => { if (e.target.matches('.fst-trashbox')) GM_setValue('fs_todo_trashopen', e.target.open); }, true);
    return el;
  }

  function onTodoKey(e) {
    const t = e.target;
    if (t.matches('.fst-combo-in')) {
      const combo = t.closest('.fst-combo'), list = combo.querySelector('.fst-combo-list');
      const opts = [...combo.querySelectorAll('.fst-opt')], cur = opts.findIndex(o => o.classList.contains('fst-hi'));
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (list.hidden) openCombo(combo, ''); else hiliteCombo(combo, cur + (e.key === 'ArrowDown' ? 1 : -1)); }
      else if (e.key === 'Enter') { e.preventDefault(); if (!list.hidden && opts[cur]) pickOpt(combo, opts[cur]); }
      else if (e.key === 'Escape') { e.preventDefault(); setCombo(combo, t.dataset.pid); t.blur(); }
      return;
    }
    // no Enter-to-add: in the add box Enter is just a new line, and Enter in the other add fields does nothing
    if (e.key === 'Enter' && t.closest('.fst-add') && t.tagName !== 'TEXTAREA') { e.preventDefault(); return; }
    const box = t.closest('.fst-editing');
    if (box && e.key === 'Escape') { td.editing = null; td.editPreset = null; renderTodo(); }
    if (box && e.key === 'Enter' && t.name === 'title') { e.preventDefault(); saveEdit(td.tasks.find(x => x.id === box.dataset.id), box); }
  }

  function onTodoClick(e) {
    if (e.target.matches('.fst-combo-in')) { const c = e.target.closest('.fst-combo'); if (c.querySelector('.fst-combo-list').hidden) openCombo(c, ''); return; }
    const a = e.target.closest('[data-act], [data-view], [data-filter], a');
    if (!a) return;
    if (a.tagName === 'A') return;                                   // project links: normal navigation
    if (a.dataset.view) { td.view = a.dataset.view; GM_setValue('fs_todo_view', td.view); td.editing = null; renderTodo(); return; }
    if (a.dataset.filter) { td.filter = a.dataset.filter; GM_setValue('fs_todo_filter', td.filter); renderTodo(); return; }
    const act = a.dataset.act;
    if (act === 'reload') { td.loaded = false; rebuildProjIdx(); loadTodo(true); return; }
    if (act === 'clear') { clearCompleted().catch(err => alert('Clear failed: ' + err.message)); return; }
    if (act === 'clearproj') { const c = a.closest('.fst-combo'); setCombo(c, ''); c.querySelector('.fst-combo-in').focus(); return; }
    if (act === 'addto') {
      const f = document.querySelector('#fs-todo .fst-add');
      setCombo(f.querySelector('.fst-combo'), a.dataset.pid); f.querySelector('[name=text]').focus();
      document.getElementById('fs-todo').scrollTop = 0; return;
    }
    const row = a.closest('.fst-row'); if (!row) return;
    if (act === 'restore') { a.disabled = true; restoreTodo(row.dataset.id).catch(err => { a.disabled = false; alert('Restore failed: ' + err.message); }); return; }
    const t = td.tasks.find(x => x.id === row.dataset.id); if (!t) return;
    if (act === 'done') { e.preventDefault(); setStatus(t, isDone(t) ? td.st.open : td.st.done); }
    else if (act === 'wait') setStatus(t, t.status_id === td.st.waiting ? td.st.open : td.st.waiting);
    else if (act === 'start') startTimer(t).catch(err => alert('Timer failed: ' + err.message));
    else if (act === 'stop') { const tm = timeFor(t); if (tm.running) stopTimer(tm.running).catch(err => alert('Stop failed: ' + err.message)); }
    else if (act === 'edit') { td.editing = t.id; td.editPreset = null; renderTodo(); document.querySelector(`#fs-todo .fst-editing [name=title]`)?.focus(); }
    else if (act === 'cancel') { td.editing = null; td.editPreset = null; renderTodo(); }
    else if (act === 'save') saveEdit(t, row);
    else if (act === 'delete') deleteTodo(t).catch(err => alert('Delete failed: ' + err.message));
    else if (act === 'due') {
      const inp = document.createElement('input'); inp.type = 'date'; inp.value = t[TD.DUE] || ''; inp.className = 'fst-due';
      a.replaceWith(inp); inp.focus(); try { inp.showPicker(); } catch (x) {}
      let fin = false;
      const finish = () => { if (fin) return; fin = true; if ((inp.value || '') !== (t[TD.DUE] || '')) setDue(t, inp.value); else renderTodo(); };
      inp.addEventListener('change', finish); inp.addEventListener('blur', finish);
    }
  }

  const wantTodo = () => location.pathname === '/tasks' && location.hash === '#todo';
  function placeTodo() {
    let el = document.getElementById('fs-todo');
    if (!wantTodo()) { if (el) el.remove(); markTodoNav(false); return; }
    if (!el) { el = todoShell(); document.body.appendChild(el); renderTodo(); loadTodo(); }
    // start where the sidebar column ends (climb from the menu to the full-height column)
    const sb = sidebar(); let side = sb;
    for (let i = 0; side && i < 6 && side.getBoundingClientRect().height < window.innerHeight * 0.8; i++) side = side.parentElement;
    let l = side ? Math.round(side.getBoundingClientRect().right) : 0;
    if (l > window.innerWidth * 0.5) l = sb ? Math.round(sb.getBoundingClientRect().right) : 0;
    if (el.style.left !== l + 'px') el.style.left = l + 'px';
    markTodoNav(true);
  }
  function goTodo(newTab) {
    if (newTab) { window.open('/tasks#todo', '_blank'); return; }
    if (location.pathname === '/tasks') { location.hash = 'todo'; placeTodo(); }
    else location.href = '/tasks#todo';
  }

  // sidebar entry, cloned from a neighbouring item so it matches the app's look
  function todoNav() {
    const box = sidebar(); if (!box) return;
    if (box.querySelector('[data-fs-todo-nav]')) return;
    const src = [...box.children].find(el => el.querySelector('a[href="/projects"]') && !location.pathname.startsWith('/projects'))
             || [...box.children].find(el => el.querySelector('a[href="/clients"]'));
    if (!src) return;
    const item = src.cloneNode(true);
    item.setAttribute('data-fs-todo-nav', '1');
    item.querySelectorAll('button, a[href$="/create"]').forEach(x => x.remove());
    const a = item.querySelector('a'); if (!a) return;
    a.setAttribute('href', '/tasks#todo');
    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) if (n.nodeValue.trim()) { n.nodeValue = n.nodeValue.replace(/\S.*\S|\S/, 'To-do'); break; }
    const svg = item.querySelector('svg');
    if (svg) {
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('fill', 'none'); icon.setAttribute('stroke', 'currentColor');
      icon.setAttribute('stroke-width', '1.6'); icon.setAttribute('stroke-linecap', 'round'); icon.setAttribute('stroke-linejoin', 'round');
      icon.setAttribute('class', svg.getAttribute('class') || ''); icon.setAttribute('width', svg.getAttribute('width') || '18'); icon.setAttribute('height', svg.getAttribute('height') || '18');
      icon.innerHTML = '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M3.5 6l1.2 1.2L7 5"/><path d="M3.5 12l1.2 1.2L7 11"/><rect x="3.5" y="16.5" width="3" height="3" rx=".5"/>';
      svg.replaceWith(icon);
    }
    item.querySelectorAll('[aria-current]').forEach(x => x.removeAttribute('aria-current'));
    const tasksItem = [...box.children].find(el => el.querySelector('a[href="/tasks"]'));
    (tasksItem && tasksItem.nextSibling) ? box.insertBefore(item, tasksItem.nextSibling) : box.appendChild(item);
  }
  function markTodoNav(on) {
    const item = document.querySelector('[data-fs-todo-nav]'); if (!item) return;
    const a = item.querySelector('a') || item;
    const want = on ? 'rgba(255,255,255,.10)' : '';
    if (a.style.background !== want) a.style.background = want;
  }
  window.addEventListener('click', e => {
    const nav = e.target.closest && e.target.closest('[data-fs-todo-nav]');
    if (!nav) return;
    e.preventDefault(); e.stopImmediatePropagation();
    goTodo(e.metaKey || e.ctrlKey);
  }, true);
  window.addEventListener('hashchange', placeTodo);
  window.addEventListener('popstate', () => setTimeout(placeTodo, 0));
  window.addEventListener('resize', placeTodo);
  setInterval(() => {                                   // keep running-timer labels fresh
    if (!document.getElementById('fs-todo') || td.editing || document.activeElement?.closest?.('#fs-todo')?.matches?.('input, select, textarea') || document.activeElement?.matches?.('#fs-todo input, #fs-todo select, #fs-todo textarea')) return;
    if (td.all.some(isRunning)) renderTodo();
  }, 30000);

  new MutationObserver(() => { pnCreateTick(); pnEditTick(); pnAfterSave(); buttons(); fixProjectHours(); arrangeSidebar(); enhanceDaily(); fillInvoiceNumber(); decorateTasks(); todoNav(); placeTodo(); trackNewProject(); }).observe(document.body, { childList: true, subtree: true });
  pnCreateTick(); pnEditTick(); pnAfterSave(); buttons(); fixProjectHours(); arrangeSidebar(); enhanceDaily(); fillInvoiceNumber(); decorateTasks(); todoNav(); placeTodo(); trackNewProject();
  setInterval(() => { if (location.pathname === '/projects/create') pnCreateTick(); }, 700);   // the client picker doesn't always change the page structure
})();
