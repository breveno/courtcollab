'use strict';

// ---------------------------------------------------------------------------
// Shared mock data used across all payment E2E tests
// ---------------------------------------------------------------------------

const BRAND_USER = {
  id: 1,
  name: 'Acme Brand',
  email: 'brand@acme.com',
  role: 'brand',
  company_name: 'Acme Pickleball Co.',
  initials: 'AB',
};

/** A fully-active deal that passes every payment gate */
const MOCK_DEAL = {
  id: 99,
  amount: 2500,
  status: 'active',
  contract_status: 'contract_complete',
  campaign_title: 'Summer Pickleball Campaign',
  creator_name: 'Jordan Smith',
  creator_id: 2,
  brand_id: 1,
  brand_name: 'Acme Pickleball Co.',
  deadline: '2024-03-31',
};

/** PaymentIntent returned by POST /api/stripe/payment-intent/:dealId */
const MOCK_PAYMENT_INTENT = {
  client_secret:     'pi_test_mock_secret_xyz',
  payment_intent_id: 'pi_test_mock',
  amount:            2500,
  platform_fee:       375,   // 15 %
  creator_payout:    2125,   // 85 %
};

/** GET /api/stripe/config */
const MOCK_STRIPE_CONFIG = {
  publishable_key:       'pk_test_mock_key',
  platform_fee_percent:  15,
};

/** GET /api/payments — brand view with one held payment */
const MOCK_PAYMENTS_BRAND = [
  {
    id:             10,
    deal_id:        99,
    brand_id:       1,
    creator_id:     2,
    amount:         2500,
    platform_fee:    375,
    creator_payout: 2125,
    status:         'held',
    campaign_title: 'Summer Pickleball Campaign',
    creator_name:   'Jordan Smith',
    brand_name:     'Acme Pickleball Co.',
    deal_status:    'active',
    created_at:     '2024-01-15T10:00:00Z',
  },
];

/** Stripe confirmPayment success result */
const STRIPE_SUCCESS_RESULT = {
  paymentIntent: { id: 'pi_test_mock', status: 'succeeded' },
};

/** Stripe confirmPayment card-declined result */
const STRIPE_DECLINE_RESULT = {
  error: {
    type:    'card_error',
    code:    'card_declined',
    message: 'Your card was declined.',
  },
};

// ---------------------------------------------------------------------------
// Creator payout flow fixtures
// ---------------------------------------------------------------------------

/** Creator user */
const CREATOR_USER = {
  id:       2,
  name:     'Jordan Smith',
  email:    'creator@example.com',
  role:     'creator',
  initials: 'JS',
};

/**
 * A deal in 'active' status with a held payment — the state the app is in
 * after Stripe has captured the brand's payment and the webhook ran.
 * Both parties have NOT yet marked delivery complete.
 */
const MOCK_DEAL_WITH_HELD_PAYMENT = {
  id:                    99,
  amount:                2500,
  status:                'active',
  contract_status:       'contract_complete',
  campaign_title:        'Summer Pickleball Campaign',
  creator_name:          'Jordan Smith',
  creator_id:            2,
  brand_id:              1,
  brand_name:            'Acme Pickleball Co.',
  deadline:              '2024-03-31',
  brand_marked_complete:   0,
  creator_marked_complete: 0,
};

/**
 * Held payment — what GET /api/payments returns while funds are in escrow.
 * Used by both brand and creator dashboard to show the mark-complete button.
 */
const MOCK_PAYMENT_HELD = {
  id:             10,
  deal_id:        99,
  brand_id:       1,
  creator_id:     2,
  amount:         2500,
  platform_fee:    375,
  creator_payout: 2125,
  status:         'held',
  campaign_title: 'Summer Pickleball Campaign',
  creator_name:   'Jordan Smith',
  brand_name:     'Acme Pickleball Co.',
  deal_status:    'active',
  created_at:     '2024-01-15T10:00:00Z',
};

/** POST /api/deals/:id/mark-complete — first party to confirm */
const MARK_COMPLETE_FIRST_RESPONSE = {
  ok:            true,
  both_complete: false,
  brand_marked:  true,
  creator_marked: false,
};

/** POST /api/deals/:id/mark-complete — second party confirms, triggers payout */
const MARK_COMPLETE_BOTH_RESPONSE = {
  ok:            true,
  both_complete: true,
  payout:        2125,
  transfer_id:   'tr_test_mock_payout',
};

module.exports = {
  BRAND_USER,
  CREATOR_USER,
  MOCK_DEAL,
  MOCK_DEAL_WITH_HELD_PAYMENT,
  MOCK_PAYMENT_INTENT,
  MOCK_STRIPE_CONFIG,
  MOCK_PAYMENTS_BRAND,
  MOCK_PAYMENT_HELD,
  MARK_COMPLETE_FIRST_RESPONSE,
  MARK_COMPLETE_BOTH_RESPONSE,
  STRIPE_SUCCESS_RESULT,
  STRIPE_DECLINE_RESULT,
};
