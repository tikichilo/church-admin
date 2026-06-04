/**
 * audit.js — Makeni Central SDA Church
 * Client-side helper that logs admin actions to the server audit trail.
 * Include this script in admin.html BEFORE admin.js.
 *
 * Usage:
 *   await logAudit('ACTION_NAME', { key: 'value' });
 */

'use strict';

async function logAudit(action, details = {}) {
  const token  = localStorage.getItem('sda_admin_token') || '';
  const apiUrl = (localStorage.getItem('sda_admin_api') || '').replace(/\/+$/, '');
  if (!token) return; // not signed in — nothing to log

  try {
    await fetch(apiUrl + '/api/audit', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + token,
      },
      body: JSON.stringify({ action, details }),
    });
  } catch (e) {
    // Audit failures are silent — never block the main action
    console.warn('[audit] log failed:', e.message);
  }
}