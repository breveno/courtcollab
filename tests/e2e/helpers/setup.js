'use strict';

/**
 * Shared test-setup helpers for CourtCollab Playwright E2E tests.
 *
 * Three entry-points:
 *   injectBrandSession(page)   — sets cc_jwt + injects Stripe mock via addInitScript
 *   mockApiRoutes(page, overrides?) — intercepts /api/** and /ping with stub data
 *   waitForAuth(page)          — waits until the app has completed its auth check
 */

const {
  BRAND_USER,
  MOCK_DEAL,
  MOCK_PAYMENT_INTENT,
  MOCK_STRIPE_CONFIG,
  MOCK_PAYMENTS_BRAND,
} = require('./mock-data');

// ---------------------------------------------------------------------------
// injectBrandSession
// ---------------------------------------------------------------------------

/**
 * Call this BEFORE page.goto().
 * 1. Writes the auth token to localStorage so getToken() returns a value.
 * 2. Injects a fully-controllable Stripe.js mock so the real SDK never loads.
 *
 * Tests control confirmPayment() by setting window.__mockStripeResult before
 * clicking Pay Now.  If not set, the mock returns a succeeded PaymentIntent.
 */
async function injectBrandSession(page) {
  // -- Auth token --
  await page.addInitScript(() => {
    localStorage.setItem('cc_jwt', 'mock-brand-token-for-tests');
  });

  // -- Stripe.js mock --
  // addInitScript runs before any page scripts, so _ensureStripeJs() will see
  // window.Stripe already defined and skip loading the real SDK.
  await page.addInitScript(() => {
    /**
     * window.__mockStripeResult
     *   null  → confirmPayment resolves with a succeeded PaymentIntent (default)
     *   object → returned as-is so tests can inject errors or other states
     */
    window.__mockStripeResult = null;

    window.Stripe = function mockStripe(/* publishableKey */) {
      return {
        elements: function({ clientSecret }) {
          return {
            create: function(type /*, opts */) {
              const readyCallbacks = [];

              const element = {
                mount: function(/* selector */) {
                  // Fire 'ready' on next tick so the Pay Now button enables
                  setTimeout(() => readyCallbacks.forEach(cb => cb()), 80);
                },
                on: function(event, cb) {
                  if (event === 'ready') readyCallbacks.push(cb);
                },
              };

              return element;
            },
          };
        },

        confirmPayment: async function({ elements, redirect, confirmParams }) {
          const result = window.__mockStripeResult;
          // Default: payment succeeded (no 3DS redirect needed)
          return result ?? { paymentIntent: { id: 'pi_test_mock', status: 'succeeded' } };
        },
      };
    };
  });
}

// ---------------------------------------------------------------------------
// mockApiRoutes
// ---------------------------------------------------------------------------

/**
 * Call this BEFORE page.goto().
 *
 * Intercepts every /api/** and /ping request and returns canned JSON responses.
 * Pass an `overrides` map of { path: responseBody } to override specific routes
 * for a single test.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Record<string, unknown>} [overrides]
 */
async function mockApiRoutes(page, overrides = {}) {
  // Static route → response body map
  const staticMocks = {
    '/ping':                         { ok: true },
    '/api/me':                       BRAND_USER,
    '/api/notifications':            [],
    '/api/campaigns':                [],
    '/api/brand/portal':             { campaigns: [], creators: [] },
    '/api/payments':                 MOCK_PAYMENTS_BRAND,
    '/api/stripe/config':            MOCK_STRIPE_CONFIG,
    [`/api/deals/${MOCK_DEAL.id}`]:  MOCK_DEAL,
    ...overrides,
  };

  await page.route('**/{api/**,ping}', async (route) => {
    const url    = new URL(route.request().url());
    const path   = url.pathname;
    const method = route.request().method();

    // POST /api/stripe/payment-intent/:dealId
    if (method === 'POST' && /\/api\/stripe\/payment-intent\/\d+$/.test(path)) {
      const body = overrides['/api/stripe/payment-intent'] ?? MOCK_PAYMENT_INTENT;
      return route.fulfill({
        status:      200,
        contentType: 'application/json',
        body:        JSON.stringify(body),
      });
    }

    // Check static map (prefix match so /api/campaigns/1 hits /api/campaigns)
    for (const [key, body] of Object.entries(staticMocks)) {
      if (path === key || path.startsWith(key + '/') || path.startsWith(key + '?')) {
        return route.fulfill({
          status:      200,
          contentType: 'application/json',
          body:        JSON.stringify(body),
        });
      }
    }

    // Fallback: return empty 200 so the app doesn't crash on unmocked routes
    return route.fulfill({
      status:      200,
      contentType: 'application/json',
      body:        '{}',
    });
  });
}

// ---------------------------------------------------------------------------
// waitForAuth
// ---------------------------------------------------------------------------

/**
 * Waits until the DOMContentLoaded auth bootstrap has completed.
 * Specifically waits for auth-gate to be hidden (user is logged in).
 */
async function waitForAuth(page) {
  await page.waitForFunction(
    () => {
      const gate = document.getElementById('auth-gate');
      if (!gate) return false;
      return gate.classList.contains('hidden');
    },
    { timeout: 15_000 },
  );
}

/**
 * Navigate to a URL and wait for auth to resolve.
 */
async function gotoAuthenticated(page, path = '/') {
  await page.goto(path);
  await waitForAuth(page);
}

/**
 * Navigate to the Payments page using the app's own navigate() function.
 * Avoids clicking through the dropdown nav (which requires hover state).
 */
async function navigateToPayments(page) {
  await page.evaluate(() => navigate('payments'));
  await page.waitForFunction(
    () => document.getElementById('page-payments')?.classList.contains('active'),
    { timeout: 10_000 },
  );
}

module.exports = {
  injectBrandSession,
  mockApiRoutes,
  waitForAuth,
  gotoAuthenticated,
  navigateToPayments,
};
