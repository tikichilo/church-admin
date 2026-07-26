'use strict';

// Use stored URL, or auto-detect: empty string = same origin (works when served by Express/Render)
// Override via the Connect input in the topbar for remote/local dev use.
let API_URL = (localStorage.getItem('sda_admin_api') || '').replace(/\/+$/, '');
let deleteTargetId   = null;
let deleteAnnId      = null;
let deleteEventId    = null;
let deleteRecapId    = null;
let allDonations     = [];
let allDiscussions   = [];
let allAnnouncements = [];
let allEvents        = [];
let allRecaps        = [];
let allVisits        = [];
let selectedEventPoster = null;   // File or null
let selectedRecapFiles  = [];     // File[]

// Clear localhost URLs saved during local dev — they break the deployed app
if (API_URL.includes('localhost') || API_URL.includes('127.0.0.1')) {
  localStorage.removeItem('sda_admin_api');
  API_URL = '';
}

/* ══════════════ AUTH GUARD ══════════════ */
function getToken() {
  return localStorage.getItem('sda_admin_token') || '';
}

function logout() {
  localStorage.removeItem('sda_admin_token');
  localStorage.removeItem('sda_admin_user');
  window.location.href = 'login.html';
}

// Decode JWT payload locally (no network needed)
function decodeToken(token) {
  try { return JSON.parse(atob(token.split('.')[1])); } catch { return null; }
}

// Verify token on load; redirect to login if missing or expired
async function checkAuth() {
  const token = getToken();
  if (!token) { window.location.href = 'login.html'; return false; }

  // Check expiry locally before hitting the network
  const payload = decodeToken(token);
  if (!payload || Date.now() / 1000 > payload.exp) { logout(); return false; }

  try {
    const res = await fetch(API_URL + '/api/auth/me', {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (res.status === 401 || res.status === 403) { logout(); return false; }
    const user = await res.json();

    // Show user name + avatar initial in sidebar footer
    const nameEl   = document.getElementById('admin-user-name');
    const avatarEl = document.getElementById('admin-user-avatar');
    const displayName = user.name || user.email || 'Admin';
    if (nameEl)   nameEl.textContent   = displayName;
    if (avatarEl) avatarEl.textContent = displayName.charAt(0).toUpperCase();

    // Show Super Admin link only for superadmins
    if (user.role === 'superadmin') {
      const link  = document.getElementById('superadmin-nav-link');
      const label = document.getElementById('superadmin-nav-label');
      if (link)  link.style.display  = 'flex';
      if (label) label.style.display = 'block';
    }

    return true;
  } catch (e) {
    // Network error — use local expiry check instead of blindly allowing through
    const p = decodeToken(token);
    if (!p || Date.now() / 1000 > p.exp) { logout(); return false; }
    return true;
  }
}

// Auto-logout exactly when the token expires (handles tab left open)
function startSessionWatcher() {
  const token = getToken();
  if (!token) return;
  const payload = decodeToken(token);
  if (!payload) { logout(); return; }
  const msLeft = (payload.exp * 1000) - Date.now();
  if (msLeft <= 0) { logout(); return; }
  setTimeout(() => {
    toast('Your session has expired. Redirecting to login…', 'danger');
    setTimeout(logout, 1500);
  }, msLeft);
}

// Re-check token when the user switches back to this tab after being away
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const token = getToken();
    if (!token) { logout(); return; }
    const payload = decodeToken(token);
    if (!payload || Date.now() / 1000 > payload.exp) logout();
  }
});

/* ══════════════ INIT ══════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  const authed = await checkAuth();
  if (!authed) return;
  startSessionWatcher();
  el('api-url-input').value    = API_URL;
  el('settings-api-url').value = API_URL;
  setupCharCounters();
  setupImagePreviews();
  await checkStatus();  // wait for connection check before loading data
  loadAll();
});

/* ══════════════ NAVIGATION ══════════════ */
const pageTitles = {
  dashboard:     'Dashboard',
  lesson:        'Lesson of the Week',
  announcements: 'Announcements',
  events:        'Events',
  recaps:        'Event Recaps',
  donations:     'Donations',
  fund:          'Building Fund',
  discussions:   'Youth Discussions',
  visits:        'Plan Your Visit',
  settings:      'Settings',
};
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  el('page-' + name).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(btn => {
    if (btn.getAttribute('onclick')?.includes("'" + name + "'")) btn.classList.add('active');
  });
  el('page-title').textContent = pageTitles[name] || name;
}

/* ══════════════ API ══════════════ */
// Supports both JSON bodies (plain object) and multipart uploads (FormData).
// Pass options.body as a FormData instance for file uploads — the
// Content-Type header is intentionally omitted so the browser can set
// the correct multipart boundary itself.
async function apiFetch(path, options = {}, _retry = true) {
  try {
    const isFormData = options.body instanceof FormData;
    const headers = { 'Authorization': 'Bearer ' + getToken() };
    if (!isFormData) headers['Content-Type'] = 'application/json';

    const res = await fetch(API_URL + path, {
      ...options,
      headers: { ...headers, ...(options.headers || {}) },
    });
    // If unauthorized, token is missing or expired — redirect to login
    if (res.status === 401) {
      toast('Session expired. Redirecting to login…', 'danger');
      setTimeout(() => logout(), 1500);
      return null;
    }
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      console.error('apiFetch', options.method || 'GET', path, res.status, errBody);
      // Show the server's actual error message when available (e.g. bad file type)
      if (errBody && errBody.error) toast(errBody.error, 'danger');
      // Render free tier returns 502/503 while spinning up — retry once after 4s
      if (_retry && (res.status === 502 || res.status === 503)) {
        console.warn('Server warming up, retrying in 4s…');
        toast('Server waking up, retrying…', 'info');
        await new Promise(r => setTimeout(r, 4000));
        return apiFetch(path, options, false);
      }
      return null;
    }
    return await res.json();
  } catch (e) {
    console.error('apiFetch network error', path, e.message);
    // Network error — also retry once (handles Render cold start TCP timeout)
    if (_retry) {
      console.warn('Network error, retrying in 4s…');
      toast('Connection issue, retrying…', 'info');
      await new Promise(r => setTimeout(r, 4000));
      return apiFetch(path, options, false);
    }
    return null;
  }
}

/* ══════════════ STATUS ══════════════ */
async function checkStatus() {
  const dot  = el('status-dot');
  const text = el('status-text');
  dot.className    = 'status-dot offline';
  text.textContent = 'Checking…';
  const data = await apiFetch('/api/fund', {}, false); // no retry here, loadAll handles it
  if (data !== null) {
    dot.className    = 'status-dot';
    text.textContent = 'Connected';
  } else {
    dot.className    = 'status-dot offline';
    text.textContent = 'Offline — server may be starting up';
  }
}

/* ══════════════ LOAD ALL ══════════════ */
async function loadAll() {
  // If status is offline, wait for server to come up before hammering all endpoints
  const dot = el('status-dot');
  if (dot && dot.classList.contains('offline')) {
    await new Promise(r => setTimeout(r, 2000));
  }
  await Promise.all([
    loadFund(),
    loadDonations(),
    loadDiscussions(),
    loadLesson(),
    loadAnnouncements(),
    loadEvents(),
    loadRecaps(),
    loadVisits(),
  ]);
}

/* ══════════════ FUND ══════════════ */
async function loadFund() {
  const data = await apiFetch('/api/fund');
  if (!data) return;
  const raised = data.raised || 0;
  const goal   = data.goal   || 1;
  const donors = data.donors || 0;
  const pct    = Math.min(Math.round((raised / goal) * 100), 100);
  const fmt = n => 'ZMW ' + n.toLocaleString();

  el('dash-raised').textContent   = fmt(raised);
  el('dash-goal').textContent     = fmt(goal);
  el('dash-donors').textContent   = donors.toLocaleString();
  el('dash-pct').textContent      = pct + '%';
  el('dash-bar').style.width      = pct + '%';
  el('dash-raised-sub').textContent = fmt(raised) + ' raised';
  el('dash-goal-sub').textContent   = fmt(goal) + ' goal';

  el('fund-raised-display').textContent  = fmt(raised);
  el('fund-goal-display').textContent    = fmt(goal);
  el('fund-donors-display').textContent  = donors.toLocaleString();
  el('fund-pct-display').textContent     = pct + '%';
  el('fund-bar-display').style.width     = pct + '%';
  el('fund-goal-input').placeholder      = goal;
}

async function updateFundGoal() {
  const val = parseFloat(el('fund-goal-input').value);
  if (!val || val <= 0) { toast('Enter a valid goal amount', 'danger'); return; }
  const res = await apiFetch('/api/fund/goal', { method: 'POST', body: JSON.stringify({ goal: val }) });
  if (res && res.success) {
    toast('Fund goal updated!', 'success');
    await logAudit('UPDATE_FUND_GOAL', { newGoal: val });
    loadFund();
  } else {
    toast('Update failed — check server connection', 'danger');
  }
}

/* ══════════════ DONATIONS ══════════════ */
async function loadDonations() {
  const data = await apiFetch('/api/donations');
  allDonations = Array.isArray(data) ? data : [];
  el('donations-count').textContent = allDonations.length + ' records';
  renderDonationsTable(allDonations);
  renderRecentDonations(allDonations.slice(0, 5));
}

function renderDonationsTable(list) {
  const tbody = el('donations-tbody');
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zM8 12h8M12 8v8"/></svg><p>No donations yet</p></div></td></tr>`;
    return;
  }
  tbody.innerHTML = list.map((d, i) => {
    const date = new Date(d.createdAt);
    return `<tr>
      <td style="color:var(--muted); font-size:12px;">#${i + 1}</td>
      <td><strong style="color:var(--success);">ZMW ${Number(d.amount).toLocaleString()}</strong></td>
      <td><span class="badge badge-gold">${esc(d.currency || 'ZMW')}</span></td>
      <td>${date.toLocaleDateString('en-ZM', { day:'2-digit', month:'short', year:'numeric' })}</td>
      <td style="color:var(--muted);">${date.toLocaleTimeString('en-ZM', { hour:'2-digit', minute:'2-digit' })}</td>
    </tr>`;
  }).join('');
}

function renderRecentDonations(list) {
  const wrap = el('dash-recent-donations');
  if (!list.length) { wrap.innerHTML = '<div class="empty-state"><p>No donations yet</p></div>'; return; }
  wrap.innerHTML = `<table style="width:100%;"><thead><tr><th>Amount</th><th>Date</th></tr></thead><tbody>${list.map(d => {
    const date = new Date(d.createdAt);
    return `<tr><td><strong style="color:var(--success);">ZMW ${Number(d.amount).toLocaleString()}</strong></td><td style="color:var(--muted); font-size:12px;">${date.toLocaleDateString('en-ZM', { day:'2-digit', month:'short' })}</td></tr>`;
  }).join('')}</tbody></table>`;
}

/* ══════════════ DISCUSSIONS ══════════════ */
async function loadDiscussions() {
  const data = await apiFetch('/api/discussions');
  allDiscussions = Array.isArray(data) ? data : [];
  el('disc-count').textContent      = allDiscussions.length + ' posts';
  el('dash-discussions').textContent = allDiscussions.length.toLocaleString();
  renderDiscussions(allDiscussions);
  renderRecentDiscussions(allDiscussions.slice(0, 3));
}

function renderDiscussions(list) {
  const wrap = el('discussions-list');
  if (!list.length) {
    wrap.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><p>No discussions yet</p></div>`;
    return;
  }
  wrap.innerHTML = list.map(d => {
    const initials = d.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    const date     = new Date(d.createdAt).toLocaleDateString('en-ZM', { day:'2-digit', month:'short', year:'numeric' });
    return `<div class="disc-row">
      <div class="disc-avatar">${esc(initials)}</div>
      <div style="flex:1; min-width:0;">
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          <span class="disc-title">${esc(d.title)}</span>
          <span class="badge badge-blue">${esc(d.category)}</span>
        </div>
        <div class="disc-meta">${esc(d.name)} · ${date} · ${d.likes || 0} likes</div>
        <div class="disc-body-preview">${esc(d.body).slice(0, 120)}${d.body.length > 120 ? '…' : ''}</div>
      </div>
      <div class="disc-actions">
        <button class="btn btn-sm btn-danger" onclick="openDeleteModal('${d._id}')">Delete</button>
      </div>
    </div>`;
  }).join('');
}

function renderRecentDiscussions(list) {
  const wrap = el('dash-recent-discussions');
  if (!list.length) { wrap.innerHTML = '<div class="empty-state"><p>No discussions yet</p></div>'; return; }
  wrap.innerHTML = list.map(d => {
    const initials = d.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    return `<div class="disc-row">
      <div class="disc-avatar" style="width:32px;height:32px;font-size:11px;">${esc(initials)}</div>
      <div style="flex:1; min-width:0;">
        <div class="disc-title" style="font-size:13px;">${esc(d.title)}</div>
        <div class="disc-meta">${esc(d.name)} · <span class="badge badge-blue" style="font-size:10px;">${esc(d.category)}</span></div>
      </div>
    </div>`;
  }).join('');
}

/* ══════════════ LESSON OF THE WEEK ══════════════ */
async function loadLesson() {
  const [data, themeData] = await Promise.all([
    apiFetch('/api/lesson'),
    apiFetch('/api/theme'),
  ]);

  // Populate lesson fields
  if (!data) {
    el('dash-lesson-title').textContent = 'Not set';
    el('lp-title').textContent = 'No lesson set yet';
    el('lp-verse').textContent = '';
    el('lp-body').textContent  = '';
  } else {
    el('dash-lesson-title').textContent = data.title || 'Untitled';
    el('lp-title').textContent = data.title || '—';
    el('lp-verse').textContent = data.verse || '';
    el('lp-body').textContent  = data.body  || '';
    el('lesson-title').value = data.title || '';
    el('lesson-verse').value = data.verse || '';
    el('lesson-body').value  = data.body  || '';
    el('lesson-url').value   = data.url   || '';
    updateCharCounter('lesson-title', 'lesson-title-counter', 100);
    updateCharCounter('lesson-body', 'lesson-body-counter', 1000);
  }

  // Populate theme fields independently (theme can exist without a lesson)
  const theme = (data && data.theme) || themeData;
  if (theme) {
    el('theme-heading').value = theme.heading || '';
    el('theme-ref').value     = theme.ref     || '';
    el('theme-body').value    = theme.body    || '';
  }
}

async function saveLesson() {
  const payload = {
    title: el('lesson-title').value.trim(),
    verse: el('lesson-verse').value.trim(),
    body:  el('lesson-body').value.trim(),
    url:   el('lesson-url').value.trim(),
  };
  if (!payload.title || !payload.body) { toast('Title and body are required', 'danger'); return; }
  const res = await apiFetch('/api/lesson', { method: 'POST', body: JSON.stringify(payload) });
  if (res && res.success) {
    toast('Lesson saved!', 'success');
    el('lp-title').textContent = payload.title;
    el('lp-verse').textContent = payload.verse;
    el('lp-body').textContent  = payload.body;
    el('dash-lesson-title').textContent = payload.title;
    await logAudit('SAVE_LESSON', { title: payload.title, verse: payload.verse });
  } else {
    toast('Save failed — check server connection', 'danger');
  }
}

async function saveTheme() {
  const payload = {
    heading: el('theme-heading').value.trim(),
    ref:     el('theme-ref').value.trim(),
    body:    el('theme-body').value.trim(),
  };
  if (!payload.heading) { toast('Theme heading is required', 'danger'); return; }
  const res = await apiFetch('/api/theme', { method: 'POST', body: JSON.stringify(payload) });
  if (res && res.success) {
    toast('Theme of the Month saved!', 'success');
    await logAudit('SAVE_THEME', { heading: payload.heading, ref: payload.ref });
  } else {
    toast('Save failed — check server connection', 'danger');
  }
}

/* ══════════════ ANNOUNCEMENTS ══════════════ */
async function loadAnnouncements() {
  const data = await apiFetch('/api/announcements');
  allAnnouncements = Array.isArray(data) ? data : [];
  el('ann-count-badge').textContent = allAnnouncements.length + ' active';
  el('dash-ann-count').textContent  = allAnnouncements.length + ' announcements';
  renderAnnouncementsList(allAnnouncements);
  renderTickerPreview(allAnnouncements);
}

function renderTickerPreview(list) {
  const preview = el('ann-ticker-preview');
  if (!list.length) { preview.textContent = 'No announcements set'; return; }
  preview.textContent = list.map(a => '· ' + (a.title ? a.title + ': ' : '') + a.text).join('   ');
}

function renderAnnouncementsList(list) {
  const wrap = el('ann-list');
  if (!list.length) {
    wrap.innerHTML = `<div class="empty-state"><p>No announcements yet. Add one above.</p></div>`;
    return;
  }
  wrap.innerHTML = list.map(a => {
    const expires = a.expiresAt ? new Date(a.expiresAt).toLocaleDateString('en-ZM', { day:'2-digit', month:'short', year:'numeric' }) : 'Always';
    const reactionSummary = a.reactions
      ? `🙏 ${a.reactions.amen || 0} · ❤️ ${a.reactions.love || 0} · 🎉 ${a.reactions.praise || 0}`
      : '';
    return `<div class="ann-row">
      <div class="ann-dot"></div>
      <div class="ann-text">
        ${a.title ? `<strong>${esc(a.title)}</strong> — ` : ''}${esc(a.text)}
        ${reactionSummary ? `<div style="font-size:11px; color:var(--muted); margin-top:2px;">${reactionSummary}</div>` : ''}
      </div>
      <span class="badge badge-blue" style="margin-right:6px;">${esc(a.category || 'general')}</span>
      <span class="badge badge-gray" style="margin-right:8px;">Until: ${expires}</span>
      <div class="ann-actions">
        <button class="btn btn-sm btn-danger" onclick="openDeleteAnnModal('${a._id}')">Remove</button>
      </div>
    </div>`;
  }).join('');
}

async function addAnnouncement() {
  const title   = el('ann-title').value.trim();
  const text    = el('ann-text').value.trim();
  const category = el('ann-category').value.trim();
  const expires = el('ann-expires').value;
  if (!text) { toast('Announcement text is required', 'danger'); return; }
  const payload = { text };
  if (title)    payload.title    = title;
  if (category) payload.category = category;
  if (expires)  payload.expiresAt = expires;
  const res = await apiFetch('/api/announcements', { method: 'POST', body: JSON.stringify(payload) });
  if (res && res.success) {
    toast('Announcement added!', 'success');
    el('ann-title').value    = '';
    el('ann-text').value     = '';
    el('ann-category').value = '';
    el('ann-expires').value  = '';
    await logAudit('ADD_ANNOUNCEMENT', { title: payload.title || '', text: payload.text, category: payload.category || 'general' });
    loadAnnouncements();
  } else {
    toast('Failed to add — check server connection', 'danger');
  }
}

function openDeleteAnnModal(id) {
  deleteAnnId = id;
  const ann = allAnnouncements.find(a => a._id === id);
  el('delete-ann-text').textContent = ann ? ann.text : id;
  el('delete-ann-modal').classList.add('open');
}
function closeDeleteAnnModal() {
  deleteAnnId = null;
  el('delete-ann-modal').classList.remove('open');
}
async function confirmDeleteAnn() {
  if (!deleteAnnId) return;
  const ann = allAnnouncements.find(a => a._id === deleteAnnId);
  const res = await apiFetch('/api/announcements/' + deleteAnnId, { method: 'DELETE' });
  closeDeleteAnnModal();
  if (res && res.success) {
    toast('Announcement removed', 'success');
    await logAudit('DELETE_ANNOUNCEMENT', { id: deleteAnnId, text: ann?.text || '' });
    loadAnnouncements();
  } else {
    toast('Delete failed — check server connection', 'danger');
  }
}

/* ══════════════ EVENTS ══════════════ */
// Event posters are now full Cloudinary URLs (https://res.cloudinary.com/...).
// The API_URL prefix only applies to legacy local /uploads/... paths from
// before the Cloudinary migration, if any still exist in the database.
function eventImgUrl(posterUrl) {
  if (!posterUrl) return '';
  return /^https?:\/\//.test(posterUrl) ? posterUrl : API_URL + posterUrl;
}

async function loadEvents() {
  const data = await apiFetch('/api/events');
  allEvents = Array.isArray(data) ? data : [];
  el('events-count-badge').textContent = allEvents.length + ' events';
  el('dash-events-count').textContent  = allEvents.length + ' upcoming';
  renderEventsList(allEvents);
}

function renderEventsList(list) {
  const wrap = el('events-list');
  if (!list.length) {
    wrap.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg><p>No upcoming events. Add one above!</p></div>`;
    return;
  }
  wrap.innerHTML = list.map(ev => {
    const date = new Date(ev.date).toLocaleDateString('en-ZM', { day:'2-digit', month:'short', year:'numeric' });
    return `<div class="item-row">
      <div class="item-thumb">${ev.posterUrl ? `<img src="${esc(eventImgUrl(ev.posterUrl))}" style="width:60px;height:60px;border-radius:8px;object-fit:cover;" onerror="this.parentElement.textContent='📅'"/>` : '📅'}</div>
      <div style="flex:1; min-width:0;">
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          <span class="item-title">${esc(ev.title)}</span>
          ${ev.featured ? '<span class="badge badge-gold">Featured</span>' : ''}
        </div>
        <div class="item-meta">${date}${ev.time ? ' · ' + esc(ev.time) : ''}${ev.location ? ' · ' + esc(ev.location) : ''}</div>
        ${ev.info ? `<div class="item-preview">${esc(ev.info).slice(0, 100)}${ev.info.length > 100 ? '…' : ''}</div>` : ''}
      </div>
      <div class="item-actions">
        ${!ev.featured ? `<button class="btn btn-sm btn-gold" onclick="featureEvent('${ev._id}')">Feature</button>` : ''}
        <button class="btn btn-sm btn-danger" onclick="openDeleteEventModal('${ev._id}')">Delete</button>
      </div>
    </div>`;
  }).join('');
}

async function addEvent() {
  const title    = el('event-title').value.trim();
  const date     = el('event-date').value;
  const time     = el('event-time').value.trim();
  const location = el('event-location').value.trim();
  const info     = el('event-info').value.trim();

  if (!title || !date) { toast('Title and date are required', 'danger'); return; }

  const formData = new FormData();
  formData.append('title', title);
  formData.append('date', date);
  formData.append('time', time);
  formData.append('location', location);
  formData.append('info', info);
  if (selectedEventPoster) formData.append('poster', selectedEventPoster);

  const btn = el('event-submit-btn');
  btn.disabled = true; btn.textContent = 'Adding…';
  const res = await apiFetch('/api/events', { method: 'POST', body: formData });
  btn.disabled = false; btn.textContent = 'Add Event';

  if (res && res.success) {
    toast('Event added!', 'success');
    ['event-title','event-time','event-location','event-info'].forEach(id => el(id).value = '');
    el('event-date').value = '';
    clearEventPoster();
    await logAudit('CREATE_EVENT', { title, date });
    loadEvents();
  } else {
    toast('Add failed — check server connection', 'danger');
  }
}

async function featureEvent(id) {
  const ev = allEvents.find(e => e._id === id);
  const res = await apiFetch('/api/events/' + id + '/feature', { method: 'PATCH' });
  if (res && res.success) {
    toast('Event set as featured!', 'success');
    await logAudit('FEATURE_EVENT', { id, title: ev?.title || '' });
    loadEvents();
  } else {
    toast('Failed — check server connection', 'danger');
  }
}

function openDeleteEventModal(id) {
  deleteEventId = id;
  const ev = allEvents.find(e => e._id === id);
  el('delete-event-title').textContent = ev ? ev.title : id;
  el('delete-event-modal').classList.add('open');
}
function closeDeleteEventModal() {
  deleteEventId = null;
  el('delete-event-modal').classList.remove('open');
}
async function confirmDeleteEvent() {
  if (!deleteEventId) return;
  const ev = allEvents.find(e => e._id === deleteEventId);
  const res = await apiFetch('/api/events/' + deleteEventId, { method: 'DELETE' });
  closeDeleteEventModal();
  if (res && res.success) {
    toast('Event deleted', 'success');
    await logAudit('DELETE_EVENT', { id: deleteEventId, title: ev?.title || '' });
    loadEvents();
  } else {
    toast('Delete failed — check server connection', 'danger');
  }
}

/* ══════════════ EVENT RECAPS ══════════════ */
function recapImgUrl(imagePath) {
  if (!imagePath) return '';
  return /^https?:\/\//.test(imagePath) ? imagePath : API_URL + imagePath;
}

async function loadRecaps() {
  const data = await apiFetch('/api/recaps');
  allRecaps = Array.isArray(data) ? data : [];
  el('recaps-count-badge').textContent = allRecaps.length + ' recaps';
  renderRecapsList(allRecaps);
}

function renderRecapsList(list) {
  const wrap = el('recaps-list');
  if (!list.length) {
    wrap.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg><p>No recaps yet. Publish one above!</p></div>`;
    return;
  }
  wrap.innerHTML = list.map(r => {
    const cover = (r.images && r.images[0]) || '';
    return `<div class="item-row">
      <div class="item-thumb">${cover ? `<img src="${esc(recapImgUrl(cover))}" style="width:60px;height:60px;border-radius:8px;object-fit:cover;" onerror="this.parentElement.textContent='🖼️'"/>` : '🖼️'}</div>
      <div style="flex:1; min-width:0;">
        <div class="item-title">${esc(r.title)}</div>
        <div class="item-meta">${new Date(r.createdAt).toLocaleDateString('en-ZM', { day:'2-digit', month:'short', year:'numeric' })} · ${(r.images || []).length} image${(r.images || []).length === 1 ? '' : 's'}</div>
        ${r.description ? `<div class="item-preview">${esc(r.description).slice(0, 100)}${r.description.length > 100 ? '…' : ''}</div>` : ''}
      </div>
      <div class="item-actions">
        <button class="btn btn-sm btn-danger" onclick="openDeleteRecapModal('${r._id}')">Delete</button>
      </div>
    </div>`;
  }).join('');
}

async function addRecap() {
  const title       = el('recap-title').value.trim();
  const description = el('recap-description').value.trim();

  if (!title) { toast('Recap title is required', 'danger'); return; }
  if (!selectedRecapFiles.length) { toast('At least one image is required', 'danger'); return; }
  if (selectedRecapFiles.length > 10) { toast('Max 10 images per recap', 'danger'); return; }

  const formData = new FormData();
  formData.append('title', title);
  formData.append('description', description);
  selectedRecapFiles.forEach(f => formData.append('images', f));

  const btn = el('recap-submit-btn');
  btn.disabled = true; btn.textContent = 'Publishing…';
  const res = await apiFetch('/api/recaps', { method: 'POST', body: formData });
  btn.disabled = false; btn.textContent = 'Publish Recap';

  if (res && res.success) {
    toast('Recap published!', 'success');
    el('recap-title').value = '';
    el('recap-description').value = '';
    clearRecapFiles();
    await logAudit('CREATE_RECAP', { title, images: selectedRecapFiles.length });
    loadRecaps();
  } else {
    toast('Publish failed — check server connection', 'danger');
  }
}

function openDeleteRecapModal(id) {
  deleteRecapId = id;
  const r = allRecaps.find(x => x._id === id);
  el('delete-recap-title').textContent = r ? r.title : id;
  el('delete-recap-modal').classList.add('open');
}
function closeDeleteRecapModal() {
  deleteRecapId = null;
  el('delete-recap-modal').classList.remove('open');
}
async function confirmDeleteRecap() {
  if (!deleteRecapId) return;
  const r = allRecaps.find(x => x._id === deleteRecapId);
  const res = await apiFetch('/api/recaps/' + deleteRecapId, { method: 'DELETE' });
  closeDeleteRecapModal();
  if (res && res.success) {
    toast('Recap deleted', 'success');
    await logAudit('DELETE_RECAP', { id: deleteRecapId, title: r?.title || '' });
    loadRecaps();
  } else {
    toast('Delete failed — check server connection', 'danger');
  }
}

/* ══════════════ IMAGE PREVIEWS (before upload) ══════════════ */
const MAX_IMAGE_MB = 5;
const ALLOWED_IMAGE_RE = /\.(jpe?g|png|webp|heic|heif)$/i;

function humanFileSize(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
}

function setupImagePreviews() {
  const posterInput = el('event-poster');
  if (posterInput) {
    posterInput.addEventListener('change', e => {
      const file = e.target.files[0] || null;
      if (file && !ALLOWED_IMAGE_RE.test(file.name)) {
        toast('Unsupported file type — use JPG, PNG, WEBP, or HEIC/HEIF', 'danger');
        posterInput.value = '';
        return;
      }
      if (file && file.size > MAX_IMAGE_MB * 1024 * 1024) {
        toast(`"${file.name}" is over ${MAX_IMAGE_MB}MB`, 'danger');
        posterInput.value = '';
        return;
      }
      selectedEventPoster = file;
      renderEventPosterPreview();
    });
  }

  const recapInput = el('recap-images');
  if (recapInput) {
    recapInput.addEventListener('change', e => {
      const incoming = Array.from(e.target.files);
      for (const file of incoming) {
        if (selectedRecapFiles.length >= 10) {
          toast('Max 10 images per recap — extra files skipped', 'danger');
          break;
        }
        if (!ALLOWED_IMAGE_RE.test(file.name)) {
          toast(`Skipped "${file.name}" — unsupported type`, 'danger');
          continue;
        }
        if (file.size > MAX_IMAGE_MB * 1024 * 1024) {
          toast(`Skipped "${file.name}" — over ${MAX_IMAGE_MB}MB`, 'danger');
          continue;
        }
        const isDupe = selectedRecapFiles.some(f =>
          f.name === file.name && f.size === file.size && f.lastModified === file.lastModified
        );
        if (!isDupe) selectedRecapFiles.push(file);
      }
      syncRecapInputFiles();
      renderRecapPreview();
    });
  }
}

// Selecting files a second time replaces the browser's native FileList,
// so we rebuild it via DataTransfer to keep everything picked so far —
// this is what lets you add images across a few separate selections
// and still see (and remove) all of them before hitting Publish.
function syncRecapInputFiles() {
  const dt = new DataTransfer();
  selectedRecapFiles.forEach(f => dt.items.add(f));
  el('recap-images').files = dt.files;
}

function renderEventPosterPreview() {
  const wrap = el('event-poster-preview');
  if (!selectedEventPoster) { wrap.innerHTML = ''; return; }
  const url = URL.createObjectURL(selectedEventPoster);
  wrap.innerHTML = `<div class="preview-thumb">
    <img src="${url}" onload="URL.revokeObjectURL(this.src)"/>
    <button type="button" class="preview-remove" onclick="clearEventPoster()">✕</button>
    <span class="preview-name">${esc(selectedEventPoster.name)}</span>
  </div>`;
}

function clearEventPoster() {
  selectedEventPoster = null;
  el('event-poster').value = '';
  el('event-poster-preview').innerHTML = '';
}

function renderRecapPreview() {
  const wrap  = el('recap-images-preview');
  const count = el('recap-images-count');

  if (!selectedRecapFiles.length) {
    wrap.innerHTML  = '';
    count.textContent = '';
    return;
  }

  wrap.innerHTML = selectedRecapFiles.map((f, i) => {
    const url = URL.createObjectURL(f);
    return `<div class="preview-thumb">
      <img src="${url}" onload="URL.revokeObjectURL(this.src)"/>
      <button type="button" class="preview-remove" onclick="removeRecapFile(${i})">✕</button>
      <span class="preview-name">${esc(f.name)}</span>
    </div>`;
  }).join('');

  count.textContent = `${selectedRecapFiles.length} / 10 selected`;
  count.classList.toggle('warn', selectedRecapFiles.length >= 10);
}

function removeRecapFile(index) {
  selectedRecapFiles.splice(index, 1);
  syncRecapInputFiles();
  renderRecapPreview();
}

function clearRecapFiles() {
  selectedRecapFiles = [];
  syncRecapInputFiles();
  renderRecapPreview();
}

/* ══════════════ VISITS (read-only) ══════════════ */
async function loadVisits() {
  const data = await apiFetch('/api/visits?upcoming=true');
  allVisits = Array.isArray(data) ? data : [];
  el('visits-count').textContent = allVisits.length + ' submissions';
  renderVisitsTable(allVisits);
}

function renderVisitsTable(list) {
  const tbody = el('visits-tbody');
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg><p>No upcoming visit submissions</p></div></td></tr>`;
    return;
  }
  tbody.innerHTML = list.map(v => {
    const visitDate = new Date(v.date).toLocaleDateString('en-ZM', { day:'2-digit', month:'short', year:'numeric' });
    const submitted = new Date(v.createdAt).toLocaleDateString('en-ZM', { day:'2-digit', month:'short', year:'numeric' });
    const needs = (v.needs || []).map(n => `<span class="badge badge-gray" style="margin-right:4px;">${esc(n)}</span>`).join('') || '—';
    return `<tr>
      <td><strong>${visitDate}</strong></td>
      <td><span class="badge badge-blue">${esc(v.service)}</span></td>
      <td>${esc(v.time || '—')}</td>
      <td>${esc(v.name || 'Anonymous')}</td>
      <td>${needs}</td>
      <td style="color:var(--muted); font-size:12px;">${submitted}</td>
    </tr>`;
  }).join('');
}

/* ══════════════ DISCUSSION DELETE ══════════════ */
function openDeleteModal(id) {
  deleteTargetId = id;
  const disc = allDiscussions.find(d => d._id === id);
  el('delete-disc-title').textContent  = disc ? disc.title : id;
  el('delete-disc-author').textContent = disc ? 'by ' + disc.name : '';
  el('delete-modal').classList.add('open');
}
function closeDeleteModal() {
  deleteTargetId = null;
  el('delete-modal').classList.remove('open');
}
async function confirmDelete() {
  if (!deleteTargetId) return;
  const disc = allDiscussions.find(d => d._id === deleteTargetId);
  const res = await apiFetch('/api/discussions/' + deleteTargetId, { method: 'DELETE' });
  closeDeleteModal();
  if (res && res.success) {
    toast('Discussion deleted', 'success');
    await logAudit('DELETE_DISCUSSION', { id: deleteTargetId, title: disc?.title || '', author: disc?.name || '' });
    loadDiscussions();
  } else {
    toast('Delete failed — check server connection', 'danger');
  }
}

/* ══════════════ CONNECT / SETTINGS ══════════════ */
function connectAndRefresh() {
  const raw = el('api-url-input').value.trim().replace(/\/+$/, '');
  API_URL = raw;
  localStorage.setItem('sda_admin_api', raw);
  el('settings-api-url').value = raw;
  toast('Connecting' + (raw ? ' to ' + raw : ' (same origin)') + '…');
  checkStatus();
  loadAll();
}
function saveApiUrl() {
  const raw = el('settings-api-url').value.trim().replace(/\/+$/, '');
  API_URL = raw;
  localStorage.setItem('sda_admin_api', raw);
  el('api-url-input').value = raw;
  toast('API URL saved', 'success');
  checkStatus();
  loadAll();
}

/* ══════════════ CHAR COUNTERS ══════════════ */
function setupCharCounters() {
  const pairs = [
    ['lesson-title', 'lesson-title-counter', 100],
    ['lesson-body',  'lesson-body-counter',  1000],
    ['ann-text',     'ann-text-counter',     200],
  ];
  pairs.forEach(([inputId, counterId, max]) => {
    const input   = el(inputId);
    const counter = el(counterId);
    if (!input || !counter) return;
    input.addEventListener('input', () => updateCharCounter(inputId, counterId, max));
  });
}
function updateCharCounter(inputId, counterId, max) {
  const len = (el(inputId)?.value || '').length;
  const counter = el(counterId);
  if (!counter) return;
  counter.textContent = `${len} / ${max}`;
  counter.classList.toggle('warn', len > max * 0.9);
}

/* ══════════════ HELPERS ══════════════ */
function el(id) { return document.getElementById(id); }
function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}
function toast(msg, type = 'info') {
  const wrap = el('toast-container');
  const t    = document.createElement('div');
  t.className    = 'toast t-' + type;
  t.textContent  = msg;
  wrap.appendChild(t);
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('show')));
  setTimeout(() => {
    t.classList.remove('show');
    t.addEventListener('transitionend', () => t.remove(), { once: true });
  }, 3200);
}