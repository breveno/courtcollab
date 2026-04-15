/**
 * stripeService.js — Stripe helpers for CourtCollab
 *
 * Architecture:
 *   • All secret-key operations (charges, payouts, Connect account creation)
 *     run on the Python backend and are accessed through the /api/stripe/* endpoints.
 *   • The frontend only holds the *publishable* key (fetched at runtime from
 *     /api/stripe/config — never hardcoded) and uses it solely to initialise
 *     Stripe.js for secure card-element rendering.
 *   • PLATFORM_FEE_PERCENT is also fetched from the server so it is always in
 *     sync with the backend constant without duplication.
 *
 * Usage:
 *   import * as StripeService from './stripeService.js';
 *
 *   // Initialise (call once, e.g. in DOMContentLoaded):
 *   await StripeService.init();
 *
 *   // Creator: start Stripe Connect onboarding
 *   const { url } = await StripeService.startConnectOnboard();
 *   window.location.href = url;
 *
 *   // Creator: check onboarding status
 *   const { onboarded } = await StripeService.getConnectStatus();
 *
 *   // Brand: pay for a deal (redirects to Stripe Checkout)
 *   await StripeService.startCheckout(dealId);
 */

const BASE = "/api";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _stripe          = null;   // Stripe.js instance (initialised lazily)
let _publishableKey  = null;   // fetched from /api/stripe/config
export let PLATFORM_FEE_PERCENT = null;  // fetched from /api/stripe/config

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Attach the auth token and parse JSON; throw on non-2xx.
 */
async function _req(method, path, body = null) {
  const token = localStorage.getItem("token");
  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  };
  if (body !== null) opts.body = JSON.stringify(body);

  const resp = await fetch(`${BASE}${path}`, opts);
  if (!resp.ok) {
    let msg = `${resp.status} ${resp.statusText}`;
    try {
      const err = await resp.json();
      if (err.detail) msg = err.detail;
    } catch (_) {}
    throw new Error(msg);
  }
  return resp.status === 204 ? null : resp.json();
}

/**
 * Ensure Stripe.js is loaded (loaded from CDN on first call).
 */
async function _loadStripeJs() {
  if (window.Stripe) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://js.stripe.com/v3/";
    s.onload  = resolve;
    s.onerror = () => reject(new Error("Failed to load Stripe.js"));
    document.head.appendChild(s);
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * init() — fetch config from the server and initialise Stripe.js.
 * Safe to call multiple times (no-ops after the first successful call).
 *
 * @returns {{ publishableKey: string, platformFeePercent: number }}
 */
export async function init() {
  if (_stripe) return { publishableKey: _publishableKey, platformFeePercent: PLATFORM_FEE_PERCENT };

  const config = await _req("GET", "/stripe/config");
  _publishableKey      = config.publishable_key;
  PLATFORM_FEE_PERCENT = config.platform_fee_percent;

  if (_publishableKey) {
    await _loadStripeJs();
    _stripe = window.Stripe(_publishableKey);
  }

  return { publishableKey: _publishableKey, platformFeePercent: PLATFORM_FEE_PERCENT };
}

/**
 * getStripe() — returns the initialised Stripe.js instance.
 * Calls init() automatically if not yet initialised.
 */
export async function getStripe() {
  if (!_stripe) await init();
  return _stripe;
}

// ---------------------------------------------------------------------------
// Creator — Stripe Connect
// ---------------------------------------------------------------------------

/**
 * Start (or resume) the Stripe Connect Express onboarding flow.
 * The returned URL should be used to redirect the creator to Stripe.
 *
 * @returns {{ url: string, stripe_account_id: string }}
 */
export async function startConnectOnboard() {
  return _req("POST", "/stripe/connect/onboard");
}

/**
 * Check whether the creator's Connect account is fully verified.
 *
 * @returns {{ onboarded: boolean, stripe_account_id: string|null }}
 */
export async function getConnectStatus() {
  return _req("GET", "/stripe/connect/status");
}

// ---------------------------------------------------------------------------
// Brand — Checkout / Payments
// ---------------------------------------------------------------------------

/**
 * Create a Stripe Checkout Session for a deal and redirect the brand to pay.
 * Stripe will handle PCI-compliant card collection and return the brand to
 * the success/cancel URLs configured on the server.
 *
 * @param {number} dealId
 */
export async function startCheckout(dealId) {
  const { checkout_url } = await _req("POST", `/stripe/checkout/${dealId}`);
  if (!checkout_url) throw new Error("No checkout URL returned from server");
  window.location.href = checkout_url;
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

/**
 * Calculate the platform fee and creator payout for a given amount.
 * Uses the PLATFORM_FEE_PERCENT fetched from the server (never hardcoded).
 * Calls init() automatically if PLATFORM_FEE_PERCENT is not yet loaded.
 *
 * @param {number} amountCents  — total amount in cents
 * @returns {{ platformFeeCents: number, creatorPayoutCents: number, platformFeePercent: number }}
 */
export async function calcFees(amountCents) {
  if (PLATFORM_FEE_PERCENT === null) await init();
  const platformFeeCents   = Math.round(amountCents * (PLATFORM_FEE_PERCENT / 100));
  const creatorPayoutCents = amountCents - platformFeeCents;
  return { platformFeeCents, creatorPayoutCents, platformFeePercent: PLATFORM_FEE_PERCENT };
}

/**
 * Format cents as a USD dollar string (e.g. 1500 → "$15.00").
 *
 * @param {number} cents
 * @returns {string}
 */
export function formatCents(cents) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}
