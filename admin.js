'use strict';

// Use stored URL, or auto-detect: empty string = same origin (works when served by Express/Render)
// Override via the Connect input in the topbar for remote/local dev use.
let API_URL = (localStorage.getItem('sda_admin_api') || '').replace(/\/+$/, '');
let deleteTargetId   = null;
let deleteStoryId    = null;
let deleteAnnId      = null;
let allDonations     = [];
let allDiscussions   = [];
let allStories       = [];
let allAnnouncements = [];

/* ══════════════ INIT ══════════════ */
document.addEventListener('DOMContentLoaded', () => {
  el('api-url-input').value    = API_URL;
  el('settings-api-url').value = API_URL;
  setupCharCounters();
  checkStatus();
  loadAll();
});

/* ══════════════ NAVIGATION ══════════════ */
const pageTitles = {
  dashboard:     'Dashboard',
  lesson:        'Lesson of the Week',
  announcements: 'Announcements',
  stories:       'Kids Bible Stories',
  donations:     'Donations',
  fund:          'Building Fund',
  discussions:   'Youth Discussions',
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
async function apiFetch(path, options = {}) {
  try {
    const res = await fetch(API_URL + path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      console.error('apiFetch', options.method || 'GET', path, res.status, body);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.error('apiFetch network error', path, e.message);
    return null;
  }
}

/* ══════════════ STATUS ══════════════ */
async function checkStatus() {
  const dot  = el('status-dot');
  const text = el('status-text');
  const data = await apiFetch('/api/fund');
  if (data !== null) {
    dot.className    = 'status-dot';
    text.textContent = 'Connected';
  } else {
    dot.className    = 'status-dot offline';
    text.textContent = 'Offline';
  }
}

/* ══════════════ LOAD ALL ══════════════ */
async function loadAll() {
  await Promise.all([
    loadFund(),
    loadDonations(),
    loadDiscussions(),
    loadLesson(),
    loadAnnouncements(),
    loadStories(),
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
  if (res && res.success) { toast('Fund goal updated!', 'success'); loadFund(); }
  else toast('Update failed — check server connection', 'danger');
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
  if (res && res.success) toast('Theme of the Month saved!', 'success');
  else toast('Save failed — check server connection', 'danger');
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
  preview.textContent = list.map(a => '· ' + a.text).join('   ');
}

function renderAnnouncementsList(list) {
  const wrap = el('ann-list');
  if (!list.length) {
    wrap.innerHTML = `<div class="empty-state"><p>No announcements yet. Add one above.</p></div>`;
    return;
  }
  wrap.innerHTML = list.map(a => {
    const expires = a.expiresAt ? new Date(a.expiresAt).toLocaleDateString('en-ZM', { day:'2-digit', month:'short', year:'numeric' }) : 'Always';
    return `<div class="ann-row">
      <div class="ann-dot"></div>
      <div class="ann-text">${esc(a.text)}</div>
      <span class="badge badge-gray" style="margin-right:8px;">Until: ${expires}</span>
      <div class="ann-actions">
        <button class="btn btn-sm btn-danger" onclick="openDeleteAnnModal('${a._id}')">Remove</button>
      </div>
    </div>`;
  }).join('');
}

async function addAnnouncement() {
  const text    = el('ann-text').value.trim();
  const expires = el('ann-expires').value;
  if (!text) { toast('Announcement text is required', 'danger'); return; }
  const payload = { text };
  if (expires) payload.expiresAt = expires;
  const res = await apiFetch('/api/announcements', { method: 'POST', body: JSON.stringify(payload) });
  if (res && res.success) {
    toast('Announcement added!', 'success');
    el('ann-text').value    = '';
    el('ann-expires').value = '';
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
  const res = await apiFetch('/api/announcements/' + deleteAnnId, { method: 'DELETE' });
  closeDeleteAnnModal();
  if (res && res.success) { toast('Announcement removed', 'success'); loadAnnouncements(); }
  else toast('Delete failed — check server connection', 'danger');
}

/* ══════════════ KIDS STORIES ══════════════ */
async function loadStories() {
  const data = await apiFetch('/api/stories');
  allStories = Array.isArray(data) ? data : [];
  const featured = allStories.filter(s => s.featured).length;
  el('stories-total').textContent        = allStories.length;
  el('stories-featured').textContent     = featured;
  el('stories-count-badge').textContent  = allStories.length + ' stories';
  el('dash-stories-count').textContent   = allStories.length + ' stories published';
  renderStoriesList(allStories);
}

function renderStoriesList(list) {
  const wrap = el('stories-list');
  if (!list.length) {
    wrap.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg><p>No stories yet. Add one above!</p></div>`;
    return;
  }
  wrap.innerHTML = list.map(s => {
    const emoji = { 'Noah': '🚢', 'David': '🪨', 'Jonah': '🐋', 'Esther': '👑', 'Creation': '🌍' };
    const icon  = Object.entries(emoji).find(([k]) => s.title.includes(k))?.[1] || '📖';
    return `<div class="story-row">
      <div class="story-thumb">${s.imageUrl ? `<img src="${esc(s.imageUrl)}" style="width:60px;height:60px;border-radius:8px;object-fit:cover;" onerror="this.parentElement.textContent='📖'"/>` : icon}</div>
      <div style="flex:1; min-width:0;">
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          <span class="story-title">${esc(s.title)}</span>
          ${s.featured ? '<span class="badge badge-gold">Featured</span>' : ''}
          ${s.ageGroup ? `<span class="badge badge-gray">${esc(s.ageGroup)}</span>` : ''}
          ${s.tag ? `<span class="badge badge-blue">${esc(s.tag)}</span>` : ''}
        </div>
        <div class="story-meta">${new Date(s.createdAt).toLocaleDateString('en-ZM', { day:'2-digit', month:'short', year:'numeric' })}</div>
        <div class="story-preview">${esc(s.preview || s.body || '').slice(0, 100)}…</div>
      </div>
      <div class="story-actions">
        ${!s.featured ? `<button class="btn btn-sm btn-gold" onclick="featureStory('${s._id}')">Feature</button>` : ''}
        <button class="btn btn-sm btn-danger" onclick="openDeleteStoryModal('${s._id}')">Delete</button>
      </div>
    </div>`;
  }).join('');
}

async function addStory() {
  const payload = {
    title:    el('story-title').value.trim(),
    tag:      el('story-tag').value.trim(),
    ageGroup: el('story-age').value,
    preview:  el('story-preview-text').value.trim(),
    body:     el('story-body').value.trim(),
    imageUrl: el('story-img').value.trim(),
    featured: el('story-featured').value === 'true',
  };
  if (!payload.title || !payload.body) { toast('Title and story body are required', 'danger'); return; }
  const res = await apiFetch('/api/stories', { method: 'POST', body: JSON.stringify(payload) });
  if (res && res.success) {
    toast('Story published!', 'success');
    ['story-title','story-tag','story-preview-text','story-body','story-img'].forEach(id => el(id).value = '');
    el('story-age').value = 'All Ages';
    el('story-featured').value = 'false';
    loadStories();
  } else {
    toast('Publish failed — check server connection', 'danger');
  }
}

async function featureStory(id) {
  const res = await apiFetch('/api/stories/' + id + '/feature', { method: 'POST' });
  if (res && res.success) { toast('Story set as featured!', 'success'); loadStories(); }
  else toast('Failed — check server connection', 'danger');
}

function openDeleteStoryModal(id) {
  deleteStoryId = id;
  const story = allStories.find(s => s._id === id);
  el('delete-story-title').textContent = story ? story.title : id;
  el('delete-story-modal').classList.add('open');
}
function closeDeleteStoryModal() {
  deleteStoryId = null;
  el('delete-story-modal').classList.remove('open');
}
async function confirmDeleteStory() {
  if (!deleteStoryId) return;
  const res = await apiFetch('/api/stories/' + deleteStoryId, { method: 'DELETE' });
  closeDeleteStoryModal();
  if (res !== null) { toast('Story deleted', 'success'); loadStories(); }
  else toast('Delete failed', 'danger');
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
  const res = await apiFetch('/api/discussions/' + deleteTargetId, { method: 'DELETE' });
  closeDeleteModal();
  if (res !== null) { toast('Discussion deleted', 'success'); loadDiscussions(); }
  else toast('Delete failed', 'danger');
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
    ['story-preview-text', 'story-preview-counter', 200],
    ['story-body',   'story-body-counter',   3000],
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