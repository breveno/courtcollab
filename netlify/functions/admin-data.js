'use strict';
/**
 * GET /.netlify/functions/admin-data
 * Header: Authorization: Bearer <token>
 *
 * Validates the HMAC token, then queries Supabase for all payments, users,
 * and deals. Joins them in memory and returns a single JSON payload.
 *
 * Required env vars (set in Netlify dashboard):
 *   ADMIN_PASSWORD      — used to validate the bearer token
 *   SUPABASE_URL        — e.g. https://xyz.supabase.co
 *   SUPABASE_SERVICE_KEY — service role key (full read access)
 */
const crypto = require('crypto');

const SEED = process.env.ADMIN_TOKEN_SEED || 'courtcollab-admin-session-v1';

function makeToken(password) {
  return crypto.createHmac('sha256', password).update(SEED).digest('hex');
}

function validateToken(token) {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw || !token) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(makeToken(pw)));
  } catch {
    return false; // length mismatch throws in timingSafeEqual
  }
}

async function supaFetch(path) {
  const base = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key  = process.env.SUPABASE_SERVICE_KEY || '';
  const url  = `${base}/rest/v1/${path}`;

  const resp = await fetch(url, {
    headers: {
      apikey:          key,
      Authorization:   `Bearer ${key}`,
      'Content-Type':  'application/json',
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Supabase ${resp.status} on ${path}: ${text}`);
  }
  return resp.json();
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  // ── Auth ─────────────────────────────────────────────────────────────────
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (!validateToken(token)) {
    return {
      statusCode: 401,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Unauthorized' }),
    };
  }

  // ── Config check ─────────────────────────────────────────────────────────
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return {
      statusCode: 503,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'SUPABASE_URL / SUPABASE_SERVICE_KEY not configured in Netlify env vars.' }),
    };
  }

  // ── Fetch from Supabase ───────────────────────────────────────────────────
  try {
    const [payments, users, deals] = await Promise.all([
      supaFetch('payments?select=*&order=created_at.desc'),
      supaFetch('users?select=id,name'),
      supaFetch('deals?select=id,status,reminders_sent,needs_review,last_reminder_sent'),
    ]);

    const userMap = Object.fromEntries(users.map((u) => [String(u.id), u.name || `User #${u.id}`]));
    const dealMap = Object.fromEntries(deals.map((d) => [String(d.id), d]));

    const transactions = payments.map((p) => {
      const deal = dealMap[String(p.deal_id)] || {};
      return {
        id:             p.id,
        deal_id:        p.deal_id,
        brand_name:     userMap[String(p.brand_id)]   || `User #${p.brand_id}`,
        creator_name:   userMap[String(p.creator_id)] || `User #${p.creator_id}`,
        amount:         p.amount         || 0,
        platform_fee:   p.platform_fee   || 0,
        creator_payout: p.creator_payout || 0,
        payment_status: p.status,
        created_at:     p.created_at,
        released_at:    p.released_at || null,
        deal_status:    deal.status            || 'unknown',
        reminders_sent: deal.reminders_sent    || 0,
        needs_review:   deal.needs_review      || 0,
        last_reminder_sent: deal.last_reminder_sent || null,
      };
    });

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions }),
    };
  } catch (err) {
    console.error('[admin-data] Supabase query failed:', err.message);
    return {
      statusCode: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `Data fetch failed: ${err.message}` }),
    };
  }
};
