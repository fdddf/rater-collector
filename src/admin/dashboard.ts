/**
 * The admin console: single file, no dependencies, no build step — HTML plus vanilla JS.
 *
 * Deliberately framework-free. This console does exactly two things — read feedback and
 * edit copy — and keeping it as a string constant means deploying the Worker deploys the
 * console too, with no second pipeline to maintain.
 */
export const dashboardHTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rater Feedback Console</title>
<style>
  :root {
    --bg: #f6f7f9; --panel: #fff; --border: #e3e6ea; --text: #1c1f23; --muted: #6b7280;
    --accent: #2563eb; --danger: #dc2626; --ok: #16a34a; --warn: #d97706;
    --radius: 10px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14161a; --panel: #1c1f24; --border: #2c3138; --text: #e8eaed; --muted: #9aa3ad;
      --accent: #60a5fa;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
         background: var(--bg); color: var(--text); }
  header { display: flex; gap: 12px; align-items: center; padding: 12px 20px;
           background: var(--panel); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 10; }
  header h1 { font-size: 16px; margin: 0; margin-right: auto; }
  nav button.tab { background: none; border: none; padding: 6px 12px; border-radius: 6px;
                   color: var(--muted); cursor: pointer; font-size: 14px; }
  nav button.tab.on { background: var(--accent); color: #fff; }
  main { padding: 20px; max-width: 1200px; margin: 0 auto; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
           padding: 16px; margin-bottom: 16px; }
  select, input, textarea, button { font: inherit; color: inherit; }
  select, input[type=text], input[type=password], input[type=number], textarea {
    background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 7px 10px; width: 100%; }
  textarea { resize: vertical; min-height: 64px; }
  label { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 4px; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
  .row > * { flex: 1 1 160px; }
  .btn { background: var(--accent); color: #fff; border: none; border-radius: 6px;
         padding: 8px 14px; cursor: pointer; flex: 0 0 auto; }
  .btn.ghost { background: transparent; color: var(--accent); border: 1px solid var(--border); }
  .btn.danger { background: var(--danger); }
  .btn:disabled { opacity: .5; cursor: default; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 9px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { font-size: 12px; color: var(--muted); font-weight: 500; }
  tbody tr { cursor: pointer; }
  tbody tr:hover { background: var(--bg); }
  .tag { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px;
         border: 1px solid var(--border); color: var(--muted); }
  .tag.open { color: var(--warn); border-color: var(--warn); }
  .tag.resolved { color: var(--ok); border-color: var(--ok); }
  .tag.spam { color: var(--danger); border-color: var(--danger); }
  .muted { color: var(--muted); }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; }
  .stat { background: var(--bg); border-radius: 8px; padding: 12px; }
  .stat b { display: block; font-size: 24px; font-weight: 600; }
  .stat span { font-size: 12px; color: var(--muted); }
  dialog { border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel);
           color: var(--text); max-width: 720px; width: calc(100% - 40px); padding: 0; }
  dialog::backdrop { background: rgba(0,0,0,.45); }
  .dlg-body { padding: 20px; max-height: 78vh; overflow: auto; }
  .kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; font-size: 13px; }
  .kv dt { color: var(--muted); }
  .kv dd { margin: 0; word-break: break-all; }
  .shots { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
  .shots img { max-height: 260px; border-radius: 8px; border: 1px solid var(--border); }
  .msg { white-space: pre-wrap; background: var(--bg); border-radius: 8px; padding: 12px; margin: 10px 0; }
  #toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
           background: #111; color: #fff; padding: 9px 18px; border-radius: 999px; opacity: 0;
           transition: opacity .2s; pointer-events: none; }
  #toast.on { opacity: .92; }
  .login { max-width: 340px; margin: 15vh auto; }
  .hide { display: none !important; }
</style>
</head>
<body>

<div id="login" class="panel login">
  <h2 style="margin-top:0;font-size:16px">Rater Console</h2>
  <label for="token">Admin password (ADMIN_TOKEN)</label>
  <input id="token" type="password" autocomplete="current-password">
  <button class="btn" style="margin-top:12px;width:100%" onclick="login()">Sign in</button>
  <p id="loginErr" class="muted" style="color:var(--danger)"></p>
</div>

<div id="app" class="hide">
  <header>
    <h1>Rater Feedback Console</h1>
    <select id="appSel" style="max-width:200px" onchange="onAppChange()"></select>
    <nav>
      <button class="tab on" data-tab="feedback" onclick="switchTab('feedback')">Feedback</button>
      <button class="tab" data-tab="stats" onclick="switchTab('stats')">Stats</button>
      <button class="tab" data-tab="prompts" onclick="switchTab('prompts')">Copy</button>
      <button class="tab" data-tab="apps" onclick="switchTab('apps')">Apps</button>
    </nav>
    <button class="btn ghost" onclick="logout()">Sign out</button>
  </header>

  <main>
    <section id="tab-feedback">
      <div class="panel row">
        <div style="flex:0 0 130px">
          <label for="fStatus">Status</label>
          <select id="fStatus" onchange="loadFeedback(true)">
            <option value="">All</option>
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
            <option value="spam">Spam</option>
          </select>
        </div>
        <div>
          <label for="fQuery">Search message or email</label>
          <input id="fQuery" type="text" onchange="loadFeedback(true)">
        </div>
        <button class="btn" onclick="loadFeedback(true)">Refresh</button>
      </div>
      <div class="panel" style="padding:0;overflow-x:auto">
        <table>
          <thead><tr>
            <th>Time</th><th>App</th><th>Category</th><th>Message</th>
            <th>Version / device</th><th>Shots</th><th>Status</th>
          </tr></thead>
          <tbody id="fbBody"></tbody>
        </table>
      </div>
      <button id="moreBtn" class="btn ghost hide" onclick="loadFeedback(false)">Load more</button>
    </section>

    <section id="tab-stats" class="hide">
      <div class="panel">
        <div class="row" style="margin-bottom:14px">
          <div style="flex:0 0 130px">
            <label for="sDays">Time range</label>
            <select id="sDays" onchange="loadStats()">
              <option value="7">Last 7 days</option>
              <option value="30" selected>Last 30 days</option>
              <option value="90">Last 90 days</option>
            </select>
          </div>
        </div>
        <div class="stat-grid" id="statGrid"></div>
        <h3 style="font-size:14px;margin:20px 0 8px">Feedback per day</h3>
        <div id="spark"></div>
      </div>
    </section>

    <section id="tab-prompts" class="hide">
      <div class="panel">
        <p class="muted" style="margin-top:0">
          Copy edited here ships to live clients through <code>/v1/config</code> — no app release needed.
          Set <code>locale</code> to <code>*</code> for the catch-all; <code>min_app_version</code> is the
          lowest app version the row applies to.
        </p>
        <div id="promptList"></div>
        <button class="btn ghost" style="margin-top:12px" onclick="editPrompt(null)">Add copy</button>
      </div>
    </section>

    <section id="tab-apps" class="hide">
      <div class="panel" style="padding:0;overflow-x:auto">
        <table>
          <thead><tr><th>ID</th><th>Name</th><th>App Store ID</th><th>Status</th><th></th></tr></thead>
          <tbody id="appsBody"></tbody>
        </table>
      </div>
      <div class="panel">
        <h3 style="font-size:14px;margin-top:0">Register a new app</h3>
        <div class="row">
          <div><label for="naName">Name</label><input id="naName" type="text" placeholder="My App"></div>
          <div><label for="naId">ID (auto-generated if blank)</label><input id="naId" type="text" placeholder="my-app"></div>
          <div><label for="naStore">App Store ID</label><input id="naStore" type="text" placeholder="123456789"></div>
          <button class="btn" onclick="createApp()">Register</button>
        </div>
        <p class="muted">The API key is shown only once, at registration — save it right away.</p>
      </div>
    </section>
  </main>
</div>

<dialog id="detail"><div class="dlg-body" id="detailBody"></div></dialog>
<dialog id="promptDlg"><div class="dlg-body" id="promptBody"></div></dialog>
<div id="toast"></div>

<script>
const $ = (id) => document.getElementById(id);
let apps = [], cursor = null, currentTab = 'feedback';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('on');
  setTimeout(() => t.classList.remove('on'), 2200);
}
function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

async function api(path, options = {}) {
  const res = await fetch('/admin/api' + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (res.status === 401) { showLogin('Session expired — please sign in again.'); throw new Error('unauthorized'); }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error?.message || ('HTTP ' + res.status));
  }
  return res.status === 204 ? null : res.json();
}

// ── Sign in ───────────────────────────────────────────────────────────────────
function showLogin(err) {
  $('login').classList.remove('hide'); $('app').classList.add('hide');
  $('loginErr').textContent = err || '';
}
async function login() {
  try {
    await fetch('/admin/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: $('token').value }),
    }).then((r) => { if (!r.ok) throw new Error('Incorrect password.'); });
    $('token').value = '';
    boot();
  } catch (e) { $('loginErr').textContent = e.message; }
}
async function logout() {
  await fetch('/admin/api/logout', { method: 'POST' });
  showLogin('');
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  let data;
  try { data = await api('/apps'); } catch { return; }
  $('login').classList.add('hide'); $('app').classList.remove('hide');

  apps = data.apps;
  $('appSel').innerHTML = '<option value="">All apps</option>' +
    apps.map((a) => '<option value="' + esc(a.id) + '">' + esc(a.name) + '</option>').join('');
  renderApps();
  loadFeedback(true);
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  ['feedback','stats','prompts','apps'].forEach((t) => $('tab-' + t).classList.toggle('hide', t !== tab));
  if (tab === 'stats') loadStats();
  if (tab === 'prompts') loadPrompts();
}
function onAppChange() {
  if (currentTab === 'feedback') loadFeedback(true);
  if (currentTab === 'stats') loadStats();
  if (currentTab === 'prompts') loadPrompts();
}

// ── Feedback list ─────────────────────────────────────────────────────────────
async function loadFeedback(reset) {
  if (reset) { cursor = null; $('fbBody').innerHTML = ''; }
  const p = new URLSearchParams();
  if ($('appSel').value) p.set('app_id', $('appSel').value);
  if ($('fStatus').value) p.set('status', $('fStatus').value);
  if ($('fQuery').value.trim()) p.set('q', $('fQuery').value.trim());
  if (cursor) p.set('before', cursor);

  let data;
  try { data = await api('/feedback?' + p); } catch (e) { toast(e.message); return; }

  if (reset && data.items.length === 0) {
    $('fbBody').innerHTML = '<tr><td colspan="7" class="muted" style="padding:24px;text-align:center">No feedback yet</td></tr>';
  }
  $('fbBody').insertAdjacentHTML('beforeend', data.items.map(rowHTML).join(''));
  cursor = data.next_before;
  $('moreBtn').classList.toggle('hide', !cursor);
}

function rowHTML(f) {
  const excerpt = f.message.length > 70 ? f.message.slice(0, 70) + '…' : f.message;
  return '<tr onclick="openDetail(\'' + esc(f.id) + '\')">' +
    '<td class="muted" style="white-space:nowrap">' + fmtTime(f.created_at) + '</td>' +
    '<td>' + esc(f.app_name) + '</td>' +
    '<td>' + (f.category ? '<span class="tag">' + esc(f.category) + '</span>' : '—') + '</td>' +
    '<td>' + esc(excerpt) + '</td>' +
    '<td class="muted" style="white-space:nowrap">' + esc(f.app_version || '?') + '<br>' + esc(f.device_model || '?') + '</td>' +
    '<td>' + (f.attachment_count || 0) + '</td>' +
    '<td><span class="tag ' + esc(f.status) + '">' + esc(f.status) + '</span></td>' +
  '</tr>';
}

// ── Feedback detail ───────────────────────────────────────────────────────────
async function openDetail(id) {
  let data;
  try { data = await api('/feedback/' + id); } catch (e) { return toast(e.message); }
  const f = data.feedback;

  const meta = f.metadata ? Object.entries(f.metadata) : [];
  const kv = [
    ['App', f.app_name], ['Time', fmtTime(f.created_at)], ['Category', f.category || '—'],
    ['Email', f.email || 'not provided'], ['App version', (f.app_version || '?') + ' (' + (f.build || '?') + ')'],
    ['Bundle ID', f.bundle_id || '—'], ['OS', f.os_version || '—'], ['Device', f.device_model || '—'],
    ['Language / region', (f.locale || '?') + ' / ' + (f.region || '?')], ['Time zone', f.timezone || '—'],
    ['Days installed', f.install_days ?? '—'], ['Launches', f.launch_count ?? '—'],
    ['Country', f.ip_country || '—'],
    ...meta.map(([k, v]) => ['· ' + k, v]),
  ];

  $('detailBody').innerHTML =
    '<div style="display:flex;align-items:center;gap:10px">' +
      '<h2 style="font-size:16px;margin:0;margin-right:auto">Feedback detail</h2>' +
      '<button class="btn ghost" onclick="detail.close()">Close</button>' +
    '</div>' +
    '<div class="msg">' + esc(f.message) + '</div>' +
    (data.attachments.length
      ? '<div class="shots">' + data.attachments.map((a) =>
          '<a href="/admin/api/attachments/' + a.r2_key.split('/').map(encodeURIComponent).join('/') + '" target="_blank">' +
          '<img src="/admin/api/attachments/' + a.r2_key.split('/').map(encodeURIComponent).join('/') + '" alt="Screenshot ' + a.idx + '"></a>'
        ).join('') + '</div>'
      : '') +
    '<dl class="kv" style="margin-top:16px">' +
      kv.map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>').join('') +
    '</dl>' +
    '<label for="dNote">Internal note</label>' +
    '<textarea id="dNote">' + esc(f.admin_note || '') + '</textarea>' +
    '<div class="row" style="margin-top:12px">' +
      '<div style="flex:0 0 150px"><label for="dStatus">Status</label>' +
      '<select id="dStatus">' +
        ['open','resolved','spam','pending'].map((s) =>
          '<option value="' + s + '"' + (f.status === s ? ' selected' : '') + '>' + s + '</option>').join('') +
      '</select></div>' +
      '<button class="btn" onclick="saveDetail(\'' + esc(f.id) + '\')">Save</button>' +
      (f.email ? '<a class="btn ghost" style="text-decoration:none" href="mailto:' + esc(f.email) +
                 '?subject=' + encodeURIComponent('Re: your feedback · ' + f.app_name) + '">Reply by email</a>' : '') +
    '</div>';
  $('detail').showModal();
}

async function saveDetail(id) {
  try {
    await api('/feedback/' + id, {
      method: 'PATCH',
      body: JSON.stringify({ status: $('dStatus').value, admin_note: $('dNote').value }),
    });
    $('detail').close(); toast('Saved'); loadFeedback(true);
  } catch (e) { toast(e.message); }
}

// ── Stats ─────────────────────────────────────────────────────────────────────
async function loadStats() {
  const p = new URLSearchParams({ days: $('sDays').value });
  if ($('appSel').value) p.set('app_id', $('appSel').value);

  let s;
  try { s = await api('/stats?' + p); } catch (e) { return toast(e.message); }
  const pct = (v) => v === null ? '—' : (v * 100).toFixed(1) + '%';

  $('statGrid').innerHTML = [
    ['Prompts shown', s.funnel.shown], ['Tapped positive', s.funnel.positive],
    ['Tapped negative', s.funnel.negative], ['Dismissed', s.funnel.dismissed],
    ['Feedback submitted', s.funnel.submitted], ['Positive rate', pct(s.funnel.positive_rate)],
    ['Open', s.feedback_by_status.open || 0], ['Resolved', s.feedback_by_status.resolved || 0],
  ].map(([k, v]) => '<div class="stat"><b>' + esc(v) + '</b><span>' + esc(k) + '</span></div>').join('');

  const days = s.feedback_daily;
  const max = Math.max(1, ...days.map((d) => d.n));
  $('spark').innerHTML = days.length
    ? '<div style="display:flex;align-items:flex-end;gap:3px;height:90px">' +
      days.map((d) => '<div title="' + esc(d.day) + ': ' + d.n + '" style="flex:1;background:var(--accent);' +
        'border-radius:2px 2px 0 0;height:' + Math.round((d.n / max) * 100) + '%;min-height:2px"></div>').join('') +
      '</div><div class="muted" style="display:flex;justify-content:space-between;font-size:12px;margin-top:4px">' +
      '<span>' + esc(days[0].day) + '</span><span>' + esc(days[days.length-1].day) + '</span></div>'
    : '<p class="muted">No feedback in this period</p>';
}

// ── Prompt copy ───────────────────────────────────────────────────────────────
let prompts = [];
async function loadPrompts() {
  const appID = $('appSel').value;
  if (!appID) {
    $('promptList').innerHTML = '<p class="muted">Pick an app from the selector above first.</p>';
    prompts = []; return;
  }
  try { prompts = (await api('/apps/' + appID + '/prompts')).prompts; }
  catch (e) { return toast(e.message); }

  $('promptList').innerHTML = prompts.length
    ? '<table><thead><tr><th>Locale</th><th>Min version</th><th>Title</th><th>Enabled</th><th></th></tr></thead><tbody>' +
      prompts.map((p, i) =>
        '<tr><td>' + esc(p.locale) + '</td><td>' + esc(p.min_app_version) + '</td>' +
        '<td>' + esc(p.title) + '</td><td>' + (p.enabled ? '✓' : '✕') + '</td>' +
        '<td style="white-space:nowrap"><button class="btn ghost" onclick="editPrompt(' + i + ')">Edit</button> ' +
        '<button class="btn danger" onclick="delPrompt(\'' + esc(p.id) + '\')">Delete</button></td></tr>').join('') +
      '</tbody></table>'
    : '<p class="muted">No copy configured yet — clients will use their built-in fallback.</p>';
}

function editPrompt(i) {
  if (!$('appSel').value) return toast('Pick an app from the selector above first');
  const p = i === null ? {
    locale: '*', min_app_version: '0', enabled: true, variant: 'default',
    title: 'Enjoying this app?', message: 'Your opinion matters to us — it only takes a few seconds.',
    positive_label: 'I like it', negative_label: 'Not quite', later_label: 'Maybe later',
    feedback_title: '', feedback_message: '', email_required: false,
    categories: [{ id: 'bug', label: "Something's broken" }, { id: 'feature', label: 'Feature request' }, { id: 'other', label: 'Something else' }],
    rules: null,
  } : prompts[i];

  const field = (id, label, value, type) =>
    '<div><label for="' + id + '">' + label + '</label>' +
    (type === 'area'
      ? '<textarea id="' + id + '">' + esc(value ?? '') + '</textarea>'
      : '<input id="' + id + '" type="text" value="' + esc(value ?? '') + '">') + '</div>';

  $('promptBody').innerHTML =
    '<h2 style="font-size:16px;margin-top:0">' + (i === null ? 'Add copy' : 'Edit copy') + '</h2>' +
    '<div class="row">' + field('pLocale', 'Locale (* = catch-all)', p.locale) +
      field('pVer', 'Min app version', p.min_app_version) + field('pVariant', 'Experiment variant', p.variant) + '</div>' +
    field('pTitle', 'Prompt title', p.title) +
    field('pMsg', 'Prompt message', p.message, 'area') +
    '<div class="row">' + field('pPos', 'Positive button', p.positive_label) +
      field('pNeg', 'Negative button', p.negative_label) + field('pLater', 'Later button', p.later_label) + '</div>' +
    field('pFbTitle', 'Feedback form title (optional)', p.feedback_title) +
    field('pFbMsg', 'Feedback form description (optional)', p.feedback_message, 'area') +
    field('pCats', 'Feedback categories JSON', JSON.stringify(p.categories || []), 'area') +
    field('pRules', 'Trigger rule overrides JSON (optional)', p.rules ? JSON.stringify(p.rules) : '', 'area') +
    '<div class="row" style="margin-top:12px">' +
      '<label style="flex:0 0 auto"><input type="checkbox" id="pEnabled" style="width:auto"' +
        (p.enabled ? ' checked' : '') + '> Enabled</label>' +
      '<label style="flex:0 0 auto"><input type="checkbox" id="pEmailReq" style="width:auto"' +
        (p.email_required ? ' checked' : '') + '> Email required</label>' +
      '<button class="btn" onclick="savePrompt()">Save</button>' +
      '<button class="btn ghost" onclick="promptDlg.close()">Cancel</button>' +
    '</div>';
  $('promptDlg').showModal();
}

async function savePrompt() {
  let categories, rules;
  try { categories = JSON.parse($('pCats').value || '[]'); }
  catch { return toast('Categories JSON is malformed'); }
  try { rules = $('pRules').value.trim() ? JSON.parse($('pRules').value) : undefined; }
  catch { return toast('Rules JSON is malformed'); }

  try {
    await api('/apps/' + $('appSel').value + '/prompts', {
      method: 'PUT',
      body: JSON.stringify({
        locale: $('pLocale').value, min_app_version: $('pVer').value, variant: $('pVariant').value,
        enabled: $('pEnabled').checked, email_required: $('pEmailReq').checked,
        title: $('pTitle').value, message: $('pMsg').value,
        positive_label: $('pPos').value, negative_label: $('pNeg').value, later_label: $('pLater').value,
        feedback_title: $('pFbTitle').value || undefined, feedback_message: $('pFbMsg').value || undefined,
        categories, rules,
      }),
    });
    $('promptDlg').close(); toast('Saved — live on the client’s next config fetch'); loadPrompts();
  } catch (e) { toast(e.message); }
}

async function delPrompt(id) {
  if (!confirm('Delete this copy configuration?')) return;
  try { await api('/prompts/' + id, { method: 'DELETE' }); toast('Deleted'); loadPrompts(); }
  catch (e) { toast(e.message); }
}

// ── Apps ──────────────────────────────────────────────────────────────────────
function renderApps() {
  $('appsBody').innerHTML = apps.map((a) =>
    '<tr><td><code>' + esc(a.id) + '</code></td><td>' + esc(a.name) + '</td>' +
    '<td>' + esc(a.app_store_id || '—') + '</td>' +
    '<td>' + (a.enabled ? '<span class="tag resolved">Enabled</span>' : '<span class="tag spam">Disabled</span>') + '</td>' +
    '<td><button class="btn ghost" onclick="toggleApp(\'' + esc(a.id) + '\',' + (a.enabled ? 'false' : 'true') + ')">' +
      (a.enabled ? 'Disable' : 'Enable') + '</button></td></tr>').join('');
}

async function createApp() {
  const name = $('naName').value.trim();
  if (!name) return toast('Name is required');
  try {
    const r = await api('/apps', {
      method: 'POST',
      body: JSON.stringify({ name, id: $('naId').value.trim() || undefined,
                             app_store_id: $('naStore').value.trim() || undefined }),
    });
    prompt('API key for ' + r.name + '. This is shown only once — save it now:', r.api_key);
    $('naName').value = $('naId').value = $('naStore').value = '';
    boot();
  } catch (e) { toast(e.message); }
}

async function toggleApp(id, enabled) {
  try { await api('/apps/' + id, { method: 'PATCH', body: JSON.stringify({ enabled }) }); boot(); }
  catch (e) { toast(e.message); }
}

// Go straight in if the cookie is still valid; otherwise show the sign-in page.
boot().catch(() => showLogin(''));
</script>
</body>
</html>`;
