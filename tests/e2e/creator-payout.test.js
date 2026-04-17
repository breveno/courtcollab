'use strict';

/**
 * Creator Payout Flow — End-to-End Tests
 *
 * Covers the full delivery-confirmation + payout-release journey that occurs
 * AFTER a Stripe payment has been captured (payment.status = 'held').
 *
 *   BRAND-SIDE MARK COMPLETE
 *   1.  Brand portal shows "Mark Delivery Complete" button when a held payment exists
 *   2.  Brand clicking the button calls POST /api/deals/:id/mark-complete
 *   3.  First-party confirmation shows a "waiting for creator" toast
 *   4.  Button disables while the request is in-flight
 *   5.  Brand who has already confirmed sees the "waiting" message, no button
 *
 *   CREATOR-SIDE MARK COMPLETE
 *   6.  Creator dashboard shows "Mark Delivery Complete" button when a held payment exists
 *   7.  Creator clicking the button calls POST /api/deals/:id/mark-complete
 *   8.  First-party confirmation shows a "waiting for brand" toast
 *   9.  Creator who has already confirmed sees the "waiting" message, no button
 *
 *   BOTH PARTIES CONFIRMED — PAYOUT TRIGGERS
 *   10. When both confirm, the toast says "🎉 Deal complete! Payout released"
 *   11. Deal status badge updates to "Complete" after payout_complete
 *   12. The mark-complete endpoint is called exactly once per click
 *
 *   EDGE CASES
 *   13. No held payment → mark-complete button is NOT rendered
 *   14. API error on mark-complete shows an error toast and re-enables the button
 *   15. Creator dashboard "In Escrow" stat shows the held payout amount
 *   16. Brand portal does NOT show mark-complete for an already-released payment
 */

const { test, expect } = require('@playwright/test');
const {
  injectBrandSession,
  mockApiRoutes,
  waitForAuth,
  gotoAuthenticated,
} = require('./helpers/setup');
const {
  BRAND_USER,
  CREATOR_USER,
  MOCK_DEAL_WITH_HELD_PAYMENT,
  MOCK_PAYMENT_HELD,
  MOCK_PAYMENTS_BRAND,
  MARK_COMPLETE_FIRST_RESPONSE,
  MARK_COMPLETE_BOTH_RESPONSE,
} = require('./helpers/mock-data');

// ---------------------------------------------------------------------------
// Creator session helpers (payout tests need both roles)
// ---------------------------------------------------------------------------

async function injectCreatorSession(page) {
  await page.addInitScript(() => {
    localStorage.setItem('cc_jwt', 'mock-creator-token-for-tests');
  });
}

async function mockCreatorRoutes(page, overrides = {}) {
  const staticMocks = {
    '/ping':                         { ok: true },
    '/api/me':                       CREATOR_USER,
    '/api/notifications':            [],
    '/api/campaigns':                [],
    '/api/stripe/connect/status':    { onboarded: true, stripe_account_id: 'acct_test_123' },
    '/api/payments':                 [MOCK_PAYMENT_HELD],
    '/api/deals':                    [MOCK_DEAL_WITH_HELD_PAYMENT],
    ...overrides,
  };

  await page.route('**/{api/**,ping}', async (route) => {
    const url    = new URL(route.request().url());
    const path   = url.pathname;
    const method = route.request().method();

    // POST /api/deals/:id/mark-complete
    if (method === 'POST' && /\/api\/deals\/\d+\/mark-complete$/.test(path)) {
      const body = overrides['/api/deals/mark-complete'] ?? MARK_COMPLETE_FIRST_RESPONSE;
      return route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify(body),
      });
    }

    for (const [key, body] of Object.entries(staticMocks)) {
      if (path === key || path.startsWith(key + '/') || path.startsWith(key + '?')) {
        return route.fulfill({
          status: 200, contentType: 'application/json', body: JSON.stringify(body),
        });
      }
    }

    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

/** Navigate to the brand portal page and wait for the stats row to render. */
async function navigateToBrandPortal(page) {
  await page.evaluate(() => navigate('brand-portal'));
  await page.waitForFunction(
    () => document.getElementById('page-brand-portal')?.classList.contains('active'),
    { timeout: 12_000 },
  );
  // Wait for the async renderBrandPortal() to finish: stats row will have real content
  // (not the skeleton placeholders) once the API calls resolve.
  await page.waitForFunction(
    () => {
      const stats = document.getElementById('brand-portal-stats');
      return stats && stats.children.length > 0 &&
             !stats.querySelector('.animate-pulse');
    },
    { timeout: 12_000 },
  );
}

/** Navigate to the creator dashboard and wait for the stats row to render. */
async function navigateToCreatorDashboard(page) {
  await page.evaluate(() => navigate('creator-dashboard'));
  await page.waitForFunction(
    () => document.getElementById('page-creator-dashboard')?.classList.contains('active'),
    { timeout: 12_000 },
  );
  // Wait for async renderCreatorDashboard() to finish
  await page.waitForFunction(
    () => {
      const stats = document.getElementById('creator-dash-stats');
      return stats && stats.children.length > 0 &&
             !stats.querySelector('.animate-pulse');
    },
    { timeout: 12_000 },
  );
}

// ---------------------------------------------------------------------------
// Shared brand setup: authenticated + held payment
// ---------------------------------------------------------------------------

async function setupBrandWithHeldPayment(page, overrides = {}) {
  await injectBrandSession(page);
  await mockApiRoutes(page, {
    '/api/deals':    [MOCK_DEAL_WITH_HELD_PAYMENT],
    '/api/payments': [MOCK_PAYMENT_HELD],
    // Default mark-complete → first party response
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 1. Brand portal shows "Mark Delivery Complete" button
// ---------------------------------------------------------------------------

test('brand portal shows "Mark Delivery Complete" button when a held payment exists', async ({ page }) => {
  await setupBrandWithHeldPayment(page);
  await gotoAuthenticated(page);
  await navigateToBrandPortal(page);

  const btn = page.locator(`#mark-complete-btn-${MOCK_DEAL_WITH_HELD_PAYMENT.id}`);
  await expect(btn).toBeVisible({ timeout: 8_000 });
  await expect(btn).toContainText(/Mark Delivery Complete/i);
});

// ---------------------------------------------------------------------------
// 2. Brand clicking mark-complete calls the correct API
// ---------------------------------------------------------------------------

test('brand clicking "Mark Delivery Complete" calls POST /api/deals/:id/mark-complete', async ({ page }) => {
  let callCount = 0;

  await injectBrandSession(page);
  await mockApiRoutes(page, {
    '/api/deals':    [MOCK_DEAL_WITH_HELD_PAYMENT],
    '/api/payments': [MOCK_PAYMENT_HELD],
  });

  // Intercept to track the call
  await page.route(`**/api/deals/${MOCK_DEAL_WITH_HELD_PAYMENT.id}/mark-complete`, (route) => {
    if (route.request().method() === 'POST') callCount++;
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(MARK_COMPLETE_FIRST_RESPONSE),
    });
  });

  await gotoAuthenticated(page);
  await navigateToBrandPortal(page);

  const btn = page.locator(`#mark-complete-btn-${MOCK_DEAL_WITH_HELD_PAYMENT.id}`);
  await expect(btn).toBeVisible({ timeout: 8_000 });
  await btn.click();

  // Exactly one API call
  await page.waitForTimeout(500);
  expect(callCount).toBe(1);
});

// ---------------------------------------------------------------------------
// 3. First-party confirmation toast — "waiting for creator"
// ---------------------------------------------------------------------------

test('brand marking complete first shows "waiting for creator" toast', async ({ page }) => {
  await setupBrandWithHeldPayment(page);

  await page.route(`**/api/deals/${MOCK_DEAL_WITH_HELD_PAYMENT.id}/mark-complete`, (route) => {
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(MARK_COMPLETE_FIRST_RESPONSE),
    });
  });

  await gotoAuthenticated(page);
  await navigateToBrandPortal(page);

  const btn = page.locator(`#mark-complete-btn-${MOCK_DEAL_WITH_HELD_PAYMENT.id}`);
  await expect(btn).toBeVisible({ timeout: 8_000 });
  await btn.click();

  const toast = page.locator('#toast');
  await expect(toast).toBeVisible({ timeout: 5_000 });
  await expect(toast).toContainText(/waiting for the creator/i);
});

// ---------------------------------------------------------------------------
// 4. Button disables while the request is in-flight
// ---------------------------------------------------------------------------

test('mark-complete button is disabled immediately after click', async ({ page }) => {
  await setupBrandWithHeldPayment(page);

  // Slow response so we can assert disabled state
  await page.route(`**/api/deals/${MOCK_DEAL_WITH_HELD_PAYMENT.id}/mark-complete`, async (route) => {
    await new Promise(r => setTimeout(r, 400));
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(MARK_COMPLETE_FIRST_RESPONSE),
    });
  });

  await gotoAuthenticated(page);
  await navigateToBrandPortal(page);

  const btn = page.locator(`#mark-complete-btn-${MOCK_DEAL_WITH_HELD_PAYMENT.id}`);
  await expect(btn).toBeVisible({ timeout: 8_000 });
  await btn.click();

  // Button should be disabled immediately
  await expect(btn).toBeDisabled({ timeout: 2_000 });
});

// ---------------------------------------------------------------------------
// 5. Already-confirmed brand sees "waiting" message instead of button
// ---------------------------------------------------------------------------

test('brand who already confirmed sees waiting message, not the button', async ({ page }) => {
  // Deal with brand_marked_complete = 1 (brand already confirmed, waiting for creator)
  const dealAlreadyMarked = {
    ...MOCK_DEAL_WITH_HELD_PAYMENT,
    brand_marked_complete:   1,
    creator_marked_complete: 0,
  };

  await injectBrandSession(page);
  await mockApiRoutes(page, {
    '/api/deals':    [dealAlreadyMarked],
    '/api/payments': [MOCK_PAYMENT_HELD],
  });

  await gotoAuthenticated(page);
  await navigateToBrandPortal(page);

  // Button should NOT be present (deal is in the "alreadyBrandMarked" list which still renders)
  const btn = page.locator(`#mark-complete-btn-${MOCK_DEAL_WITH_HELD_PAYMENT.id}`);
  await expect(btn).not.toBeVisible({ timeout: 5_000 });

  // The UI renders "✓ You've marked this complete — waiting for {name} to confirm"
  const contractsSection = page.locator('#brand-portal-contracts');
  await expect(contractsSection).toContainText(
    /you've marked this complete|waiting for.*to confirm/i,
    { timeout: 8_000 },
  );
});

// ---------------------------------------------------------------------------
// 6. Creator dashboard shows "Mark Delivery Complete" button
// ---------------------------------------------------------------------------

test('creator dashboard shows "Mark Delivery Complete" button when a held payment exists', async ({ page }) => {
  await injectCreatorSession(page);
  await mockCreatorRoutes(page);

  await page.goto('/');
  await waitForAuth(page);
  await navigateToCreatorDashboard(page);

  const btn = page.locator(`#mark-complete-btn-${MOCK_DEAL_WITH_HELD_PAYMENT.id}`);
  await expect(btn).toBeVisible({ timeout: 8_000 });
  await expect(btn).toContainText(/Mark Delivery Complete/i);
});

// ---------------------------------------------------------------------------
// 7. Creator clicking mark-complete calls the correct API
// ---------------------------------------------------------------------------

test('creator clicking "Mark Delivery Complete" calls POST /api/deals/:id/mark-complete', async ({ page }) => {
  let called = false;

  await injectCreatorSession(page);
  await mockCreatorRoutes(page);

  await page.route(`**/api/deals/${MOCK_DEAL_WITH_HELD_PAYMENT.id}/mark-complete`, (route) => {
    if (route.request().method() === 'POST') called = true;
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(MARK_COMPLETE_FIRST_RESPONSE),
    });
  });

  await page.goto('/');
  await waitForAuth(page);
  await navigateToCreatorDashboard(page);

  const btn = page.locator(`#mark-complete-btn-${MOCK_DEAL_WITH_HELD_PAYMENT.id}`);
  await expect(btn).toBeVisible({ timeout: 8_000 });
  await btn.click();

  await page.waitForTimeout(300);
  expect(called).toBe(true);
});

// ---------------------------------------------------------------------------
// 8. First-party confirmation toast — "waiting for brand"
// ---------------------------------------------------------------------------

test('creator marking complete first shows "waiting for brand" toast', async ({ page }) => {
  await injectCreatorSession(page);
  await mockCreatorRoutes(page, {
    '/api/deals/mark-complete': { ok: true, both_complete: false, brand_marked: false, creator_marked: true },
  });

  await page.route(`**/api/deals/${MOCK_DEAL_WITH_HELD_PAYMENT.id}/mark-complete`, (route) => {
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, both_complete: false, brand_marked: false, creator_marked: true }),
    });
  });

  await page.goto('/');
  await waitForAuth(page);
  await navigateToCreatorDashboard(page);

  const btn = page.locator(`#mark-complete-btn-${MOCK_DEAL_WITH_HELD_PAYMENT.id}`);
  await expect(btn).toBeVisible({ timeout: 8_000 });
  await btn.click();

  const toast = page.locator('#toast');
  await expect(toast).toBeVisible({ timeout: 5_000 });
  await expect(toast).toContainText(/waiting for the brand/i);
});

// ---------------------------------------------------------------------------
// 9. Creator who already confirmed sees "waiting" message, not the button
// ---------------------------------------------------------------------------

test('creator who already confirmed sees waiting message, not the button', async ({ page }) => {
  const dealCreatorMarked = {
    ...MOCK_DEAL_WITH_HELD_PAYMENT,
    creator_marked_complete: 1,
    brand_marked_complete:   0,
  };

  await injectCreatorSession(page);
  await mockCreatorRoutes(page, {
    '/api/deals': [dealCreatorMarked],
  });

  await page.goto('/');
  await waitForAuth(page);
  await navigateToCreatorDashboard(page);

  const btn = page.locator(`#mark-complete-btn-${MOCK_DEAL_WITH_HELD_PAYMENT.id}`);
  await expect(btn).not.toBeVisible({ timeout: 5_000 });

  const contractsSection = page.locator('#creator-dash-contracts');
  await expect(contractsSection).toContainText(
    /you've marked this complete|waiting for.*to confirm/i,
    { timeout: 8_000 },
  );
});

// ---------------------------------------------------------------------------
// 10. Both parties confirmed → payout-released toast
// ---------------------------------------------------------------------------

test('both parties confirming shows the payout-released toast', async ({ page }) => {
  // Simulate scenario: brand already confirmed, creator is the second to confirm
  const dealBrandMarked = {
    ...MOCK_DEAL_WITH_HELD_PAYMENT,
    brand_marked_complete:   1,
    creator_marked_complete: 0,
  };

  await injectCreatorSession(page);
  await mockCreatorRoutes(page, {
    '/api/deals': [dealBrandMarked],
  });

  // Mock: creator's click is the final confirmation → both_complete = true
  await page.route(`**/api/deals/${MOCK_DEAL_WITH_HELD_PAYMENT.id}/mark-complete`, (route) => {
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(MARK_COMPLETE_BOTH_RESPONSE),
    });
  });

  await page.goto('/');
  await waitForAuth(page);
  await navigateToCreatorDashboard(page);

  const btn = page.locator(`#mark-complete-btn-${MOCK_DEAL_WITH_HELD_PAYMENT.id}`);
  await expect(btn).toBeVisible({ timeout: 8_000 });
  await btn.click();

  const toast = page.locator('#toast');
  await expect(toast).toBeVisible({ timeout: 5_000 });
  await expect(toast).toContainText(/deal complete.*payout released|payout released/i);
});

// ---------------------------------------------------------------------------
// 11. Same test from brand side — both complete shows payout toast
// ---------------------------------------------------------------------------

test('brand as final confirmer also sees the payout-released toast', async ({ page }) => {
  // Creator already confirmed, brand is the second to confirm
  const dealCreatorMarked = {
    ...MOCK_DEAL_WITH_HELD_PAYMENT,
    creator_marked_complete: 1,
    brand_marked_complete:   0,
  };

  await injectBrandSession(page);
  await mockApiRoutes(page, {
    '/api/deals':    [dealCreatorMarked],
    '/api/payments': [MOCK_PAYMENT_HELD],
  });

  await page.route(`**/api/deals/${MOCK_DEAL_WITH_HELD_PAYMENT.id}/mark-complete`, (route) => {
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(MARK_COMPLETE_BOTH_RESPONSE),
    });
  });

  await gotoAuthenticated(page);
  await navigateToBrandPortal(page);

  const btn = page.locator(`#mark-complete-btn-${MOCK_DEAL_WITH_HELD_PAYMENT.id}`);
  await expect(btn).toBeVisible({ timeout: 8_000 });
  await btn.click();

  const toast = page.locator('#toast');
  await expect(toast).toBeVisible({ timeout: 5_000 });
  await expect(toast).toContainText(/deal complete.*payout released|payout released/i);
});

// ---------------------------------------------------------------------------
// 12. Endpoint called exactly once per click (no duplicate calls)
// ---------------------------------------------------------------------------

test('mark-complete endpoint is called exactly once per button click', async ({ page }) => {
  let calls = 0;

  await injectCreatorSession(page);
  await mockCreatorRoutes(page);

  await page.route(`**/api/deals/${MOCK_DEAL_WITH_HELD_PAYMENT.id}/mark-complete`, (route) => {
    calls++;
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(MARK_COMPLETE_FIRST_RESPONSE),
    });
  });

  await page.goto('/');
  await waitForAuth(page);
  await navigateToCreatorDashboard(page);

  const btn = page.locator(`#mark-complete-btn-${MOCK_DEAL_WITH_HELD_PAYMENT.id}`);
  await expect(btn).toBeVisible({ timeout: 8_000 });
  await btn.click();

  await page.waitForTimeout(500);
  expect(calls).toBe(1);
});

// ---------------------------------------------------------------------------
// 13. No held payment → mark-complete button is NOT rendered
// ---------------------------------------------------------------------------

test('no "Mark Delivery Complete" button when no held payment exists', async ({ page }) => {
  // Payments list is empty — brand has not yet paid
  await injectBrandSession(page);
  await mockApiRoutes(page, {
    '/api/deals':    [MOCK_DEAL_WITH_HELD_PAYMENT],
    '/api/payments': [],
  });

  await gotoAuthenticated(page);
  await navigateToBrandPortal(page);

  const btn = page.locator(`#mark-complete-btn-${MOCK_DEAL_WITH_HELD_PAYMENT.id}`);
  await expect(btn).not.toBeVisible({ timeout: 5_000 });
});

test('no mark-complete button for creator when no held payment exists', async ({ page }) => {
  await injectCreatorSession(page);
  await mockCreatorRoutes(page, {
    '/api/payments': [],
  });

  await page.goto('/');
  await waitForAuth(page);
  await navigateToCreatorDashboard(page);

  const btn = page.locator(`#mark-complete-btn-${MOCK_DEAL_WITH_HELD_PAYMENT.id}`);
  await expect(btn).not.toBeVisible({ timeout: 5_000 });
});

// ---------------------------------------------------------------------------
// 14. API error re-enables button and shows error toast
// ---------------------------------------------------------------------------

test('API error on mark-complete shows an error toast and re-enables the button', async ({ page }) => {
  await injectCreatorSession(page);
  await mockCreatorRoutes(page);

  await page.route(`**/api/deals/${MOCK_DEAL_WITH_HELD_PAYMENT.id}/mark-complete`, (route) => {
    route.fulfill({
      status: 500, contentType: 'application/json',
      body: JSON.stringify({ detail: 'Internal server error' }),
    });
  });

  await page.goto('/');
  await waitForAuth(page);
  await navigateToCreatorDashboard(page);

  const btn = page.locator(`#mark-complete-btn-${MOCK_DEAL_WITH_HELD_PAYMENT.id}`);
  await expect(btn).toBeVisible({ timeout: 8_000 });
  await btn.click();

  // Error toast visible
  const toast = page.locator('#toast');
  await expect(toast).toBeVisible({ timeout: 5_000 });
  await expect(toast).toContainText(/could not mark deal complete|error/i);

  // Button re-enabled so the user can retry
  await expect(btn).toBeEnabled({ timeout: 5_000 });
  await expect(btn).toContainText(/Mark Delivery Complete/i);
});

// ---------------------------------------------------------------------------
// 15. Creator dashboard "In Escrow" stat shows the held payout amount
// ---------------------------------------------------------------------------

test('creator dashboard shows the held payout in the "In Escrow" stat', async ({ page }) => {
  await injectCreatorSession(page);
  await mockCreatorRoutes(page);

  await page.goto('/');
  await waitForAuth(page);
  await navigateToCreatorDashboard(page);

  // Stats section should show $2,125 in escrow (MOCK_PAYMENT_HELD.creator_payout)
  const statsEl = page.locator('#creator-dash-stats');
  await expect(statsEl).toBeVisible({ timeout: 8_000 });
  await expect(statsEl).toContainText('2,125');
});

// ---------------------------------------------------------------------------
// 16. Already-released payment does NOT show mark-complete button
// ---------------------------------------------------------------------------

test('no mark-complete button when payment is already released', async ({ page }) => {
  const releasedPayment = { ...MOCK_PAYMENT_HELD, status: 'released' };
  const completedDeal   = { ...MOCK_DEAL_WITH_HELD_PAYMENT, status: 'payout_complete' };

  await injectBrandSession(page);
  await mockApiRoutes(page, {
    '/api/deals':    [completedDeal],
    '/api/payments': [releasedPayment],
  });

  await gotoAuthenticated(page);
  await navigateToBrandPortal(page);

  const btn = page.locator(`#mark-complete-btn-${MOCK_DEAL_WITH_HELD_PAYMENT.id}`);
  await expect(btn).not.toBeVisible({ timeout: 5_000 });
});

test('payout_complete deal shows "Complete" badge on creator dashboard', async ({ page }) => {
  const completedDeal    = { ...MOCK_DEAL_WITH_HELD_PAYMENT, status: 'payout_complete' };
  const releasedPayment  = { ...MOCK_PAYMENT_HELD, status: 'released' };

  await injectCreatorSession(page);
  await mockCreatorRoutes(page, {
    '/api/deals':    [completedDeal],
    '/api/payments': [releasedPayment],
  });

  await page.goto('/');
  await waitForAuth(page);
  await navigateToCreatorDashboard(page);

  const dealsEl = page.locator('#creator-dash-deals');
  await expect(dealsEl).toBeVisible({ timeout: 8_000 });
  await expect(dealsEl).toContainText(/complete/i);
  // Payout label should show released state
  await expect(dealsEl).toContainText(/payout released|paid/i);
});
