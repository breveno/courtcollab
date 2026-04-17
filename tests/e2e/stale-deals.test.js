'use strict';

/**
 * Stale Deals Safety Mechanism — End-to-End Tests
 *
 * These tests cover the UI behaviour triggered by the staleDealsChecker.py
 * background job. The job itself runs server-side, so we test its *observable
 * effects* by seeding mock API responses with deals/payments that carry the
 * fields the checker writes: reminders_sent, last_reminder_sent, needs_review.
 *
 * REMINDER BADGE (reminders_sent > 0)
 *  1.  Brand portal shows "⚠ Reminder sent N times" badge on a stale deal
 *  2.  Creator dashboard shows the same badge
 *  3.  Brand portal renders "time" (singular) when reminders_sent === 1
 *  4.  No badge when reminders_sent is 0 / absent
 *
 * NEEDS-REVIEW ESCALATION NOTICE (needs_review = 1)
 *  5.  Brand portal shows escalation notice when needs_review = 1
 *  6.  Creator dashboard shows escalation notice when needs_review = 1
 *
 * MARK-COMPLETE STILL WORKS ON STALE DEALS
 *  7.  Mark-complete button is still visible for a stale deal (reminders_sent > 0)
 *  8.  Mark-complete button is still visible for a needs_review deal
 *  9.  Brand clicking mark-complete on a stale deal calls the API
 *  10. Creator clicking mark-complete on a stale deal calls the API
 *  11. Both parties confirming a stale deal still triggers the payout toast
 *
 * ALREADY-MARKED WAITING STATE WITH STALE INDICATORS
 *  12. Brand "already confirmed — waiting" card also shows the reminder badge
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
  MOCK_DEAL_STALE_1_REMINDER,
  MOCK_DEAL_STALE_2_REMINDERS,
  MOCK_DEAL_NEEDS_REVIEW,
  MOCK_PAYMENT_HELD,
  MARK_COMPLETE_FIRST_RESPONSE,
  MARK_COMPLETE_BOTH_RESPONSE,
} = require('./helpers/mock-data');

// ---------------------------------------------------------------------------
// Session / route helpers
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

/** Wait for brand-portal page + stats to fully render. */
async function navigateToBrandPortal(page) {
  await page.evaluate(() => navigate('brand-portal'));
  await page.waitForFunction(
    () => document.getElementById('page-brand-portal')?.classList.contains('active'),
    { timeout: 12_000 },
  );
  await page.waitForFunction(
    () => {
      const stats = document.getElementById('brand-portal-stats');
      return stats && stats.children.length > 0 && !stats.querySelector('.animate-pulse');
    },
    { timeout: 12_000 },
  );
}

/** Wait for creator-dashboard page + stats to fully render. */
async function navigateToCreatorDashboard(page) {
  await page.evaluate(() => navigate('creator-dashboard'));
  await page.waitForFunction(
    () => document.getElementById('page-creator-dashboard')?.classList.contains('active'),
    { timeout: 12_000 },
  );
  await page.waitForFunction(
    () => {
      const stats = document.getElementById('creator-dash-stats');
      return stats && stats.children.length > 0 && !stats.querySelector('.animate-pulse');
    },
    { timeout: 12_000 },
  );
}

// ---------------------------------------------------------------------------
// 1. Brand portal — reminder badge shown when reminders_sent > 0
// ---------------------------------------------------------------------------

test('brand portal shows reminder badge when reminders_sent > 0', async ({ page }) => {
  await injectBrandSession(page);
  await mockApiRoutes(page, {
    '/api/deals':    [MOCK_DEAL_STALE_2_REMINDERS],
    '/api/payments': [MOCK_PAYMENT_HELD],
  });

  await gotoAuthenticated(page);
  await navigateToBrandPortal(page);

  const badge = page.locator('[data-testid="reminder-badge"]').first();
  await expect(badge).toBeVisible({ timeout: 8_000 });
  await expect(badge).toContainText(/reminder sent 2 times/i);
});

// ---------------------------------------------------------------------------
// 2. Creator dashboard — reminder badge shown when reminders_sent > 0
// ---------------------------------------------------------------------------

test('creator dashboard shows reminder badge when reminders_sent > 0', async ({ page }) => {
  await injectCreatorSession(page);
  await mockCreatorRoutes(page, {
    '/api/deals': [MOCK_DEAL_STALE_2_REMINDERS],
  });

  await page.goto('/');
  await waitForAuth(page);
  await navigateToCreatorDashboard(page);

  const badge = page.locator('[data-testid="reminder-badge"]').first();
  await expect(badge).toBeVisible({ timeout: 8_000 });
  await expect(badge).toContainText(/reminder sent 2 times/i);
});

// ---------------------------------------------------------------------------
// 3. Singular "time" label when reminders_sent === 1
// ---------------------------------------------------------------------------

test('brand portal renders singular "time" when exactly 1 reminder sent', async ({ page }) => {
  await injectBrandSession(page);
  await mockApiRoutes(page, {
    '/api/deals':    [MOCK_DEAL_STALE_1_REMINDER],
    '/api/payments': [MOCK_PAYMENT_HELD],
  });

  await gotoAuthenticated(page);
  await navigateToBrandPortal(page);

  const badge = page.locator('[data-testid="reminder-badge"]').first();
  await expect(badge).toBeVisible({ timeout: 8_000 });
  // Should say "1 time" not "1 times"
  await expect(badge).toContainText(/reminder sent 1 time[^s]/i);
});

// ---------------------------------------------------------------------------
// 4. No badge when reminders_sent is 0 or absent (sanity check)
// ---------------------------------------------------------------------------

test('no reminder badge when reminders_sent is 0', async ({ page }) => {
  await injectBrandSession(page);
  await mockApiRoutes(page, {
    '/api/deals':    [MOCK_DEAL_WITH_HELD_PAYMENT],   // reminders_sent absent / 0
    '/api/payments': [MOCK_PAYMENT_HELD],
  });

  await gotoAuthenticated(page);
  await navigateToBrandPortal(page);

  // Mark-complete section should render (held payment exists)
  const btn = page.locator(`#mark-complete-btn-${MOCK_DEAL_WITH_HELD_PAYMENT.id}`);
  await expect(btn).toBeVisible({ timeout: 8_000 });

  // But no reminder badge
  await expect(page.locator('[data-testid="reminder-badge"]')).not.toBeVisible();
});

// ---------------------------------------------------------------------------
// 5. Brand portal — needs-review escalation notice shown
// ---------------------------------------------------------------------------

test('brand portal shows escalation notice when needs_review = 1', async ({ page }) => {
  await injectBrandSession(page);
  await mockApiRoutes(page, {
    '/api/deals':    [MOCK_DEAL_NEEDS_REVIEW],
    '/api/payments': [MOCK_PAYMENT_HELD],
  });

  await gotoAuthenticated(page);
  await navigateToBrandPortal(page);

  const notice = page.locator('[data-testid="needs-review-notice"]').first();
  await expect(notice).toBeVisible({ timeout: 8_000 });
  await expect(notice).toContainText(/escalated for manual review/i);
});

// ---------------------------------------------------------------------------
// 6. Creator dashboard — needs-review escalation notice shown
// ---------------------------------------------------------------------------

test('creator dashboard shows escalation notice when needs_review = 1', async ({ page }) => {
  await injectCreatorSession(page);
  await mockCreatorRoutes(page, {
    '/api/deals': [MOCK_DEAL_NEEDS_REVIEW],
  });

  await page.goto('/');
  await waitForAuth(page);
  await navigateToCreatorDashboard(page);

  const notice = page.locator('[data-testid="needs-review-notice"]').first();
  await expect(notice).toBeVisible({ timeout: 8_000 });
  await expect(notice).toContainText(/escalated for manual review/i);
});

// ---------------------------------------------------------------------------
// 7. Mark-complete button still visible on a stale deal (reminders sent)
// ---------------------------------------------------------------------------

test('mark-complete button still rendered on stale deal with reminders_sent > 0', async ({ page }) => {
  await injectBrandSession(page);
  await mockApiRoutes(page, {
    '/api/deals':    [MOCK_DEAL_STALE_2_REMINDERS],
    '/api/payments': [MOCK_PAYMENT_HELD],
  });

  await gotoAuthenticated(page);
  await navigateToBrandPortal(page);

  const btn = page.locator(`#mark-complete-btn-${MOCK_DEAL_STALE_2_REMINDERS.id}`);
  await expect(btn).toBeVisible({ timeout: 8_000 });
  await expect(btn).toContainText(/Mark Delivery Complete/i);
});

// ---------------------------------------------------------------------------
// 8. Mark-complete button still visible when needs_review = 1
// ---------------------------------------------------------------------------

test('mark-complete button still rendered when deal is needs_review', async ({ page }) => {
  await injectBrandSession(page);
  await mockApiRoutes(page, {
    '/api/deals':    [MOCK_DEAL_NEEDS_REVIEW],
    '/api/payments': [MOCK_PAYMENT_HELD],
  });

  await gotoAuthenticated(page);
  await navigateToBrandPortal(page);

  const btn = page.locator(`#mark-complete-btn-${MOCK_DEAL_NEEDS_REVIEW.id}`);
  await expect(btn).toBeVisible({ timeout: 8_000 });
  await expect(btn).toContainText(/Mark Delivery Complete/i);
});

// ---------------------------------------------------------------------------
// 9. Brand clicking mark-complete on a stale deal calls the API
// ---------------------------------------------------------------------------

test('brand can click mark-complete on a stale deal and API is called', async ({ page }) => {
  let called = false;

  await injectBrandSession(page);
  await mockApiRoutes(page, {
    '/api/deals':    [MOCK_DEAL_STALE_2_REMINDERS],
    '/api/payments': [MOCK_PAYMENT_HELD],
  });
  await page.route(
    `**/api/deals/${MOCK_DEAL_STALE_2_REMINDERS.id}/mark-complete`,
    (route) => {
      if (route.request().method() === 'POST') called = true;
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(MARK_COMPLETE_FIRST_RESPONSE),
      });
    },
  );

  await gotoAuthenticated(page);
  await navigateToBrandPortal(page);

  const btn = page.locator(`#mark-complete-btn-${MOCK_DEAL_STALE_2_REMINDERS.id}`);
  await expect(btn).toBeVisible({ timeout: 8_000 });
  await btn.click();

  await page.waitForTimeout(400);
  expect(called).toBe(true);
});

// ---------------------------------------------------------------------------
// 10. Creator clicking mark-complete on a stale deal calls the API
// ---------------------------------------------------------------------------

test('creator can click mark-complete on a stale deal and API is called', async ({ page }) => {
  let called = false;

  await injectCreatorSession(page);
  await mockCreatorRoutes(page, {
    '/api/deals': [MOCK_DEAL_STALE_2_REMINDERS],
  });
  await page.route(
    `**/api/deals/${MOCK_DEAL_STALE_2_REMINDERS.id}/mark-complete`,
    (route) => {
      if (route.request().method() === 'POST') called = true;
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(MARK_COMPLETE_FIRST_RESPONSE),
      });
    },
  );

  await page.goto('/');
  await waitForAuth(page);
  await navigateToCreatorDashboard(page);

  const btn = page.locator(`#mark-complete-btn-${MOCK_DEAL_STALE_2_REMINDERS.id}`);
  await expect(btn).toBeVisible({ timeout: 8_000 });
  await btn.click();

  await page.waitForTimeout(400);
  expect(called).toBe(true);
});

// ---------------------------------------------------------------------------
// 11. Both parties confirming a stale deal still triggers the payout toast
// ---------------------------------------------------------------------------

test('both parties confirming a stale deal triggers the payout-released toast', async ({ page }) => {
  // Brand has already confirmed; creator is the second party
  const staleCreatorAlreadyConfirmed = {
    ...MOCK_DEAL_STALE_2_REMINDERS,
    brand_marked_complete:   1,
    creator_marked_complete: 0,
  };

  await injectCreatorSession(page);
  await mockCreatorRoutes(page, {
    '/api/deals': [staleCreatorAlreadyConfirmed],
  });
  await page.route(
    `**/api/deals/${MOCK_DEAL_STALE_2_REMINDERS.id}/mark-complete`,
    (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(MARK_COMPLETE_BOTH_RESPONSE),
    }),
  );

  await page.goto('/');
  await waitForAuth(page);
  await navigateToCreatorDashboard(page);

  const btn = page.locator(`#mark-complete-btn-${MOCK_DEAL_STALE_2_REMINDERS.id}`);
  await expect(btn).toBeVisible({ timeout: 8_000 });
  await btn.click();

  const toast = page.locator('#toast');
  await expect(toast).toBeVisible({ timeout: 5_000 });
  await expect(toast).toContainText(/deal complete.*payout released|payout released/i);
});

// ---------------------------------------------------------------------------
// 12. "Already marked" waiting card also shows the reminder badge
// ---------------------------------------------------------------------------

test('"waiting for other party" card also shows reminder badge when reminders_sent > 0', async ({ page }) => {
  // Brand has already marked — show the teal waiting card (no button)
  const staleBrandMarked = {
    ...MOCK_DEAL_STALE_2_REMINDERS,
    brand_marked_complete:   1,
    creator_marked_complete: 0,
  };

  await injectBrandSession(page);
  await mockApiRoutes(page, {
    '/api/deals':    [staleBrandMarked],
    '/api/payments': [MOCK_PAYMENT_HELD],
  });

  await gotoAuthenticated(page);
  await navigateToBrandPortal(page);

  // No mark-complete button (brand already confirmed)
  const btn = page.locator(`#mark-complete-btn-${MOCK_DEAL_STALE_2_REMINDERS.id}`);
  await expect(btn).not.toBeVisible({ timeout: 5_000 });

  // Reminder badge still visible in the waiting card
  const badge = page.locator('[data-testid="reminder-badge"]').first();
  await expect(badge).toBeVisible({ timeout: 8_000 });
  await expect(badge).toContainText(/reminder sent 2 times/i);
});
