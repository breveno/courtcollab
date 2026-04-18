'use strict';
/**
 * POST /.netlify/functions/admin-auth
 * Body: { "password": "..." }
 *
 * Validates against process.env.ADMIN_PASSWORD.
 * Returns a stateless HMAC token derived from the password — no DB or session
 * store needed. Token never expires; set a new ADMIN_PASSWORD to invalidate.
 */
const crypto = require('crypto');

const SEED = process.env.ADMIN_TOKEN_SEED || 'courtcollab-admin-session-v1';

function makeToken(password) {
  return crypto.createHmac('sha256', password).update(SEED).digest('hex');
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
  if (!ADMIN_PASSWORD) {
    console.error('[admin-auth] ADMIN_PASSWORD env var is not set');
    return {
      statusCode: 503,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Admin authentication is not configured on this server.' }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  const { password } = body;

  // Constant-time comparison + artificial delay to resist brute force
  const isValid =
    typeof password === 'string' &&
    crypto.timingSafeEqual(
      Buffer.from(password),
      Buffer.from(ADMIN_PASSWORD),
    );

  if (!isValid) {
    await new Promise((r) => setTimeout(r, 600)); // slow down brute force
    return {
      statusCode: 401,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Incorrect password' }),
    };
  }

  return {
    statusCode: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: makeToken(ADMIN_PASSWORD) }),
  };
};
