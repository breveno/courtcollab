/**
 * contractTemplate.js — CourtCollab Brand Deal Contract Template
 *
 * Generates a formatted, professional legal document from deal data
 * pulled from the CourtCollab deals table.
 *
 * Usage:
 *   import { buildContractHtml, buildContractText } from './contractTemplate.js';
 *   const html = buildContractHtml(deal);
 */

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function _formatCurrency(amount) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(amount);
}

function _formatDate(dateStr) {
  if (!dateStr) return "________________";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function _today() {
  return _formatDate(new Date().toISOString());
}

function _creatorPayment(dealAmount) {
  return dealAmount * 0.85;
}

function _platformFee(dealAmount) {
  return dealAmount * 0.15;
}

// ---------------------------------------------------------------------------
// Build contract data object from raw deal row
//
// Expected deal shape (fields from the deals / related tables):
//   deal.id
//   deal.amount                     — agreed deal amount (number)
//   deal.deliverables               — content deliverables description (string)
//   deal.num_posts                  — number of posts / videos required (number)
//   deal.deadline                   — posting deadline (ISO date string)
//   deal.usage_rights_duration      — e.g. "12 months", "perpetual"
//   deal.exclusivity_terms          — e.g. "None" or description
//   deal.creator_name               — creator full name
//   deal.creator_handle             — @handle (without @)
//   deal.creator_platform           — e.g. "Instagram", "TikTok", "YouTube"
//   deal.brand_company              — brand company name
//   deal.brand_contact_name         — brand contact full name
// ---------------------------------------------------------------------------

export function buildContractData(deal) {
  const amount = Number(deal.amount || 0);
  return {
    dealId:              deal.id,
    effectiveDate:       _today(),
    creatorName:         deal.creator_name        || "________________",
    creatorHandle:       deal.creator_handle      || "________________",
    creatorPlatform:     deal.creator_platform    || "________________",
    brandCompany:        deal.brand_company       || "________________",
    brandContact:        deal.brand_contact_name  || "________________",
    dealAmount:          _formatCurrency(amount),
    creatorPayment:      _formatCurrency(_creatorPayment(amount)),
    platformFee:         _formatCurrency(_platformFee(amount)),
    deliverables:        deal.deliverables        || "As agreed between the parties.",
    numPosts:            deal.num_posts           || "________________",
    deadline:            _formatDate(deal.deadline),
    usageRights:         deal.usage_rights_duration || "________________",
    exclusivity:         deal.exclusivity_terms   || "None",
  };
}

// ---------------------------------------------------------------------------
// Plain-text contract body (used for PDF generation)
// ---------------------------------------------------------------------------

export function buildContractText(deal) {
  const d = buildContractData(deal);

  return `
BRAND DEAL AGREEMENT
CourtCollab Platform

Agreement ID: ${d.dealId || "________________"}
Effective Date: ${d.effectiveDate}

This Brand Deal Agreement ("Agreement") is entered into as of the Effective Date above
by and between:

  Creator:  ${d.creatorName} ("Creator")
            ${d.creatorPlatform} — @${d.creatorHandle}

  Brand:    ${d.brandCompany} ("Brand")
            Represented by: ${d.brandContact}

  Platform: CourtCollab, LLC ("CourtCollab")

The parties agree as follows:

────────────────────────────────────────────────────────────────────────────────

1. SCOPE OF WORK

   1.1  Content Deliverables
        Creator agrees to produce and publish the following content on behalf of Brand:

        ${d.deliverables}

   1.2  Required Posts / Videos
        Total pieces of content required: ${d.numPosts}

   1.3  Posting Deadline
        All content must be published no later than: ${d.deadline}

────────────────────────────────────────────────────────────────────────────────

2. COMPENSATION

   2.1  Agreed Deal Amount
        The total compensation for this engagement is ${d.dealAmount}.

   2.2  Creator Payment (85%)
        Creator will receive ${d.creatorPayment}, representing 85% of the agreed
        deal amount, within seven (7) calendar days following confirmed deal
        completion and Brand approval of all deliverables.

   2.3  CourtCollab Platform Fee (15%)
        CourtCollab retains ${d.platformFee}, representing 15% of the agreed deal
        amount, as a platform service fee for facilitating this engagement.

   2.4  Payment Method
        Payment will be disbursed through CourtCollab's secure payment processing
        system to Creator's verified payout account on file.

────────────────────────────────────────────────────────────────────────────────

3. CONTENT USAGE RIGHTS

   3.1  License Grant
        Creator grants Brand a non-exclusive, worldwide license to use, reproduce,
        distribute, and display the deliverables created under this Agreement for
        a period of: ${d.usageRights}

   3.2  Ownership
        Creator retains full ownership and copyright of all content produced.
        This license does not constitute a transfer of intellectual property rights.

   3.3  Permitted Uses
        Brand may use licensed content for organic social media posts, paid
        advertising (boosted posts), and Brand-owned media channels unless
        otherwise agreed in writing.

────────────────────────────────────────────────────────────────────────────────

4. EXCLUSIVITY

   4.1  Exclusivity Terms
        ${d.exclusivity === "None"
          ? "No exclusivity is required under this Agreement. Creator is free to work with other brands during and after this engagement."
          : d.exclusivity}

────────────────────────────────────────────────────────────────────────────────

5. FTC DISCLOSURE & COMPLIANCE

   5.1  Mandatory Disclosure
        Creator must clearly and conspicuously disclose that all content produced
        under this Agreement constitutes a paid partnership with Brand. Required
        disclosures include, but are not limited to:
          •  Using the hashtag #ad, #sponsored, or #paidpartnership
          •  Enabling Instagram/TikTok/YouTube native "Paid Partnership" labels
             where available on the applicable platform
          •  Verbally disclosing the partnership at the start of video content

   5.2  FTC Guidelines
        All disclosures must comply with current Federal Trade Commission (FTC)
        Endorsement Guidelines (16 C.F.R. Part 255). Creator is solely responsible
        for compliance with applicable advertising disclosure laws and platform
        policies.

   5.3  Liability
        Creator agrees to indemnify and hold harmless CourtCollab and Brand from
        any claims, penalties, or fines arising from Creator's failure to make
        required disclosures.

────────────────────────────────────────────────────────────────────────────────

6. REVISIONS

   6.1  Revision Policy
        Brand is entitled to request up to two (2) rounds of revisions on each
        piece of content before final approval. Revision requests must be submitted
        within three (3) business days of receiving the content for review.

   6.2  Additional Revisions
        Requests beyond two (2) rounds of revisions may be subject to additional
        compensation, to be negotiated in good faith between Creator and Brand
        through the CourtCollab platform.

────────────────────────────────────────────────────────────────────────────────

7. CANCELLATION POLICY

   7.1  Notice Requirement
        Either party may cancel this Agreement by providing a minimum of forty-eight
        (48) hours written notice through the CourtCollab messaging platform.

   7.2  Cancellation After Content Submission
        If Brand cancels after Creator has submitted any deliverable for review,
        Creator is entitled to a pro-rated payment based on the portion of work
        completed, as determined by CourtCollab.

   7.3  Creator Cancellation
        If Creator cancels without completing agreed deliverables and without
        providing the required notice, no payment will be issued for uncompleted
        deliverables.

────────────────────────────────────────────────────────────────────────────────

8. DISPUTE RESOLUTION

   8.1  CourtCollab Mediation (First Step)
        In the event of any dispute arising out of or relating to this Agreement,
        the parties agree to first submit the dispute to CourtCollab for mediation.
        CourtCollab will review the matter and issue a non-binding recommendation
        within five (5) business days.

   8.2  Binding Arbitration (Second Step)
        If mediation does not resolve the dispute within fifteen (15) days, the
        parties agree to resolve the matter through binding arbitration administered
        under the rules of the American Arbitration Association (AAA). The
        arbitration shall be conducted in English and the arbitrator's decision
        shall be final and binding.

   8.3  Class Action Waiver
        The parties waive any right to participate in a class action lawsuit or
        class-wide arbitration relating to this Agreement.

────────────────────────────────────────────────────────────────────────────────

9. GENERAL TERMS

   9.1  Entire Agreement
        This Agreement constitutes the entire agreement between the parties with
        respect to the subject matter hereof and supersedes all prior discussions,
        negotiations, and agreements.

   9.2  Amendments
        Any amendments to this Agreement must be made in writing and agreed to by
        all parties through the CourtCollab platform.

   9.3  Governing Law
        This Agreement shall be governed by and construed in accordance with the
        laws of the State of Delaware, without regard to its conflict of law
        principles.

   9.4  Severability
        If any provision of this Agreement is found to be unenforceable, the
        remaining provisions shall continue in full force and effect.

────────────────────────────────────────────────────────────────────────────────

SIGNATURES

By signing below, each party acknowledges they have read, understood, and agreed
to the terms of this Brand Deal Agreement.


Creator:  ${d.creatorName}
          @${d.creatorHandle} on ${d.creatorPlatform}

          Signature: ________________________________  Date: ________________


Brand:    ${d.brandContact}
          ${d.brandCompany}

          Signature: ________________________________  Date: ________________


CourtCollab, LLC

          Signature: ________________________________  Date: ________________


────────────────────────────────────────────────────────────────────────────────
CourtCollab, LLC  |  courtcollab.com
© ${new Date().getFullYear()} CourtCollab. All rights reserved.
This document was generated by the CourtCollab platform.
`.trim();
}

// ---------------------------------------------------------------------------
// HTML version — styled for in-app preview or PDF rendering
// ---------------------------------------------------------------------------

export function buildContractHtml(deal) {
  const text = buildContractText(deal);
  const d    = buildContractData(deal);

  // Escape HTML entities then convert structure to HTML
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Brand Deal Agreement — ${d.brandCompany} × ${d.creatorName}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: "Georgia", serif;
      font-size: 14px;
      line-height: 1.75;
      color: #1a1a2e;
      background: #ffffff;
      padding: 48px;
      max-width: 860px;
      margin: 0 auto;
    }

    .contract-header {
      text-align: center;
      border-bottom: 3px solid #1a1a2e;
      padding-bottom: 24px;
      margin-bottom: 32px;
    }

    .contract-header .logo {
      font-family: "Arial", sans-serif;
      font-size: 22px;
      font-weight: 900;
      color: #1a1a2e;
      letter-spacing: 1px;
      margin-bottom: 8px;
    }

    .contract-header .logo span {
      color: #C8F135;
      background: #1a1a2e;
      padding: 0 4px;
      border-radius: 3px;
    }

    .contract-header h1 {
      font-size: 20px;
      font-weight: bold;
      text-transform: uppercase;
      letter-spacing: 2px;
      margin-bottom: 4px;
    }

    .contract-header .meta {
      font-size: 13px;
      color: #555;
    }

    .parties {
      background: #f8f9fa;
      border-left: 4px solid #C8F135;
      padding: 20px 24px;
      margin-bottom: 32px;
      border-radius: 0 6px 6px 0;
    }

    .parties h2 {
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #555;
      margin-bottom: 12px;
    }

    .parties table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }

    .parties td {
      padding: 4px 8px;
      vertical-align: top;
    }

    .parties td:first-child {
      font-weight: bold;
      width: 100px;
      color: #1a1a2e;
    }

    .section {
      margin-bottom: 32px;
    }

    .section-title {
      font-family: "Arial", sans-serif;
      font-size: 13px;
      font-weight: bold;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      color: #1a1a2e;
      border-bottom: 1px solid #ddd;
      padding-bottom: 6px;
      margin-bottom: 16px;
    }

    .section-number {
      display: inline-block;
      background: #1a1a2e;
      color: #C8F135;
      font-size: 11px;
      font-weight: bold;
      width: 22px;
      height: 22px;
      line-height: 22px;
      text-align: center;
      border-radius: 50%;
      margin-right: 8px;
      vertical-align: middle;
    }

    .subsection {
      margin: 12px 0 12px 24px;
    }

    .subsection-title {
      font-weight: bold;
      font-size: 13px;
      color: #333;
      margin-bottom: 4px;
    }

    .highlight-box {
      background: #f0fcd4;
      border: 1px solid #C8F135;
      border-radius: 6px;
      padding: 16px 20px;
      margin: 12px 0;
      font-size: 13px;
    }

    .highlight-box .amount {
      font-size: 18px;
      font-weight: bold;
      color: #1a1a2e;
    }

    .payment-table {
      width: 100%;
      border-collapse: collapse;
      margin: 12px 0;
      font-size: 13px;
    }

    .payment-table th {
      background: #1a1a2e;
      color: #C8F135;
      text-align: left;
      padding: 8px 12px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .payment-table td {
      padding: 8px 12px;
      border-bottom: 1px solid #eee;
    }

    .payment-table tr:last-child td {
      border-bottom: none;
      font-weight: bold;
    }

    .disclosure-box {
      background: #fff8e1;
      border-left: 4px solid #f59e0b;
      padding: 16px 20px;
      border-radius: 0 6px 6px 0;
      margin: 12px 0;
      font-size: 13px;
    }

    .disclosure-box .disclosure-title {
      font-weight: bold;
      font-size: 13px;
      color: #92400e;
      margin-bottom: 6px;
    }

    ul {
      padding-left: 20px;
      margin: 8px 0;
    }

    ul li {
      margin-bottom: 4px;
    }

    .signature-block {
      margin-top: 48px;
      border-top: 2px solid #1a1a2e;
      padding-top: 32px;
    }

    .signature-block h2 {
      font-family: "Arial", sans-serif;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      margin-bottom: 24px;
      color: #555;
    }

    .signature-row {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 32px;
      margin-top: 16px;
    }

    .sig-box {
      border: 1px solid #ddd;
      border-radius: 6px;
      padding: 16px;
    }

    .sig-box .sig-role {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #777;
      margin-bottom: 4px;
    }

    .sig-box .sig-name {
      font-weight: bold;
      font-size: 14px;
      margin-bottom: 2px;
    }

    .sig-box .sig-sub {
      font-size: 12px;
      color: #555;
      margin-bottom: 16px;
    }

    .sig-box .sig-line {
      border-bottom: 1px solid #333;
      margin-bottom: 6px;
      height: 36px;
    }

    .sig-box .sig-label {
      font-size: 11px;
      color: #999;
    }

    .footer {
      margin-top: 48px;
      text-align: center;
      font-size: 11px;
      color: #aaa;
      border-top: 1px solid #eee;
      padding-top: 16px;
    }

    @media print {
      body { padding: 24px; }
      .signature-row { grid-template-columns: 1fr 1fr 1fr; }
    }
  </style>
</head>
<body>

  <div class="contract-header">
    <div class="logo">Court<span>Collab</span></div>
    <h1>Brand Deal Agreement</h1>
    <div class="meta">Agreement ID: ${d.dealId || "—"} &nbsp;|&nbsp; Effective Date: ${d.effectiveDate}</div>
  </div>

  <div class="parties">
    <h2>Parties to this Agreement</h2>
    <table>
      <tr>
        <td>Creator</td>
        <td><strong>${d.creatorName}</strong><br>${d.creatorPlatform} — @${d.creatorHandle}</td>
      </tr>
      <tr>
        <td>Brand</td>
        <td><strong>${d.brandCompany}</strong><br>Represented by: ${d.brandContact}</td>
      </tr>
      <tr>
        <td>Platform</td>
        <td><strong>CourtCollab, LLC</strong></td>
      </tr>
    </table>
  </div>

  <!-- Section 1: Scope of Work -->
  <div class="section">
    <div class="section-title"><span class="section-number">1</span> Scope of Work</div>

    <div class="subsection">
      <div class="subsection-title">1.1 Content Deliverables</div>
      <p>Creator agrees to produce and publish the following content on behalf of Brand:</p>
      <p style="margin-top:8px; padding:12px 16px; background:#f8f9fa; border-radius:4px;">${d.deliverables}</p>
    </div>

    <div class="subsection">
      <div class="subsection-title">1.2 Required Posts / Videos</div>
      <p>Total pieces of content required: <strong>${d.numPosts}</strong></p>
    </div>

    <div class="subsection">
      <div class="subsection-title">1.3 Posting Deadline</div>
      <p>All content must be published no later than: <strong>${d.deadline}</strong></p>
    </div>
  </div>

  <!-- Section 2: Compensation -->
  <div class="section">
    <div class="section-title"><span class="section-number">2</span> Compensation</div>

    <div class="highlight-box">
      <div>Agreed Deal Amount</div>
      <div class="amount">${d.dealAmount}</div>
    </div>

    <table class="payment-table">
      <thead>
        <tr>
          <th>Recipient</th>
          <th>Percentage</th>
          <th>Amount</th>
          <th>Timing</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>${d.creatorName} (Creator)</td>
          <td>85%</td>
          <td><strong>${d.creatorPayment}</strong></td>
          <td>Within 7 days of deal completion</td>
        </tr>
        <tr>
          <td>CourtCollab (Platform Fee)</td>
          <td>15%</td>
          <td><strong>${d.platformFee}</strong></td>
          <td>Retained at deal completion</td>
        </tr>
      </tbody>
    </table>

    <div class="subsection">
      <div class="subsection-title">2.4 Payment Method</div>
      <p>Payment will be disbursed through CourtCollab's secure payment processing system to Creator's verified payout account on file.</p>
    </div>
  </div>

  <!-- Section 3: Content Usage Rights -->
  <div class="section">
    <div class="section-title"><span class="section-number">3</span> Content Usage Rights</div>

    <div class="subsection">
      <div class="subsection-title">3.1 License Grant</div>
      <p>Creator grants Brand a non-exclusive, worldwide license to use, reproduce, distribute, and display the deliverables created under this Agreement for a period of: <strong>${d.usageRights}</strong></p>
    </div>

    <div class="subsection">
      <div class="subsection-title">3.2 Ownership</div>
      <p>Creator retains full ownership and copyright of all content produced. This license does not constitute a transfer of intellectual property rights.</p>
    </div>

    <div class="subsection">
      <div class="subsection-title">3.3 Permitted Uses</div>
      <p>Brand may use licensed content for organic social media posts, paid advertising (boosted posts), and Brand-owned media channels unless otherwise agreed in writing.</p>
    </div>
  </div>

  <!-- Section 4: Exclusivity -->
  <div class="section">
    <div class="section-title"><span class="section-number">4</span> Exclusivity</div>
    <div class="subsection">
      <p>${d.exclusivity === "None"
        ? "No exclusivity is required under this Agreement. Creator is free to work with other brands during and after this engagement."
        : d.exclusivity}</p>
    </div>
  </div>

  <!-- Section 5: FTC Disclosure -->
  <div class="section">
    <div class="section-title"><span class="section-number">5</span> FTC Disclosure &amp; Compliance</div>

    <div class="disclosure-box">
      <div class="disclosure-title">Required Disclosure — Paid Partnership</div>
      <p>Creator must clearly and conspicuously disclose that all content produced under this Agreement constitutes a paid partnership with ${d.brandCompany}.</p>
    </div>

    <div class="subsection">
      <div class="subsection-title">5.1 Required Disclosures Include</div>
      <ul>
        <li>Using the hashtag <strong>#ad</strong>, <strong>#sponsored</strong>, or <strong>#paidpartnership</strong></li>
        <li>Enabling the native "Paid Partnership" label on ${d.creatorPlatform} where available</li>
        <li>Verbally disclosing the partnership at the start of any video content</li>
      </ul>
    </div>

    <div class="subsection">
      <div class="subsection-title">5.2 FTC Guidelines</div>
      <p>All disclosures must comply with current Federal Trade Commission (FTC) Endorsement Guidelines (16 C.F.R. Part 255). Creator is solely responsible for compliance with applicable advertising disclosure laws and platform policies.</p>
    </div>

    <div class="subsection">
      <div class="subsection-title">5.3 Liability</div>
      <p>Creator agrees to indemnify and hold harmless CourtCollab and Brand from any claims, penalties, or fines arising from Creator's failure to make required disclosures.</p>
    </div>
  </div>

  <!-- Section 6: Revisions -->
  <div class="section">
    <div class="section-title"><span class="section-number">6</span> Revisions</div>

    <div class="subsection">
      <div class="subsection-title">6.1 Revision Policy</div>
      <p>Brand is entitled to request up to <strong>two (2) rounds of revisions</strong> on each piece of content before final approval. Revision requests must be submitted within three (3) business days of receiving the content for review.</p>
    </div>

    <div class="subsection">
      <div class="subsection-title">6.2 Additional Revisions</div>
      <p>Requests beyond two (2) rounds of revisions may be subject to additional compensation, to be negotiated in good faith between Creator and Brand through the CourtCollab platform.</p>
    </div>
  </div>

  <!-- Section 7: Cancellation -->
  <div class="section">
    <div class="section-title"><span class="section-number">7</span> Cancellation Policy</div>

    <div class="subsection">
      <div class="subsection-title">7.1 Notice Requirement</div>
      <p>Either party may cancel this Agreement by providing a minimum of <strong>forty-eight (48) hours</strong> written notice through the CourtCollab messaging platform.</p>
    </div>

    <div class="subsection">
      <div class="subsection-title">7.2 Cancellation After Content Submission</div>
      <p>If Brand cancels after Creator has submitted any deliverable for review, Creator is entitled to a pro-rated payment based on the portion of work completed, as determined by CourtCollab.</p>
    </div>

    <div class="subsection">
      <div class="subsection-title">7.3 Creator Cancellation</div>
      <p>If Creator cancels without completing agreed deliverables and without providing the required notice, no payment will be issued for uncompleted deliverables.</p>
    </div>
  </div>

  <!-- Section 8: Dispute Resolution -->
  <div class="section">
    <div class="section-title"><span class="section-number">8</span> Dispute Resolution</div>

    <div class="subsection">
      <div class="subsection-title">8.1 CourtCollab Mediation (First Step)</div>
      <p>In the event of any dispute arising out of or relating to this Agreement, the parties agree to first submit the dispute to CourtCollab for mediation. CourtCollab will review the matter and issue a non-binding recommendation within five (5) business days.</p>
    </div>

    <div class="subsection">
      <div class="subsection-title">8.2 Binding Arbitration (Second Step)</div>
      <p>If mediation does not resolve the dispute within fifteen (15) days, the parties agree to resolve the matter through binding arbitration administered under the rules of the American Arbitration Association (AAA). The arbitrator's decision shall be final and binding.</p>
    </div>

    <div class="subsection">
      <div class="subsection-title">8.3 Class Action Waiver</div>
      <p>The parties waive any right to participate in a class action lawsuit or class-wide arbitration relating to this Agreement.</p>
    </div>
  </div>

  <!-- Section 9: General Terms -->
  <div class="section">
    <div class="section-title"><span class="section-number">9</span> General Terms</div>

    <div class="subsection">
      <div class="subsection-title">9.1 Entire Agreement</div>
      <p>This Agreement constitutes the entire agreement between the parties with respect to the subject matter hereof and supersedes all prior discussions, negotiations, and agreements.</p>
    </div>

    <div class="subsection">
      <div class="subsection-title">9.2 Amendments</div>
      <p>Any amendments to this Agreement must be made in writing and agreed to by all parties through the CourtCollab platform.</p>
    </div>

    <div class="subsection">
      <div class="subsection-title">9.3 Governing Law</div>
      <p>This Agreement shall be governed by and construed in accordance with the laws of the State of Delaware, without regard to its conflict of law principles.</p>
    </div>

    <div class="subsection">
      <div class="subsection-title">9.4 Severability</div>
      <p>If any provision of this Agreement is found to be unenforceable, the remaining provisions shall continue in full force and effect.</p>
    </div>
  </div>

  <!-- Signatures -->
  <div class="signature-block">
    <h2>Signatures</h2>
    <p style="margin-bottom:24px; font-size:13px;">By signing below, each party acknowledges they have read, understood, and agreed to the terms of this Brand Deal Agreement.</p>

    <div class="signature-row">
      <div class="sig-box">
        <div class="sig-role">Creator</div>
        <div class="sig-name">${d.creatorName}</div>
        <div class="sig-sub">@${d.creatorHandle} · ${d.creatorPlatform}</div>
        <div class="sig-line"></div>
        <div class="sig-label">Signature &amp; Date</div>
      </div>

      <div class="sig-box">
        <div class="sig-role">Brand</div>
        <div class="sig-name">${d.brandContact}</div>
        <div class="sig-sub">${d.brandCompany}</div>
        <div class="sig-line"></div>
        <div class="sig-label">Signature &amp; Date</div>
      </div>

      <div class="sig-box">
        <div class="sig-role">Platform</div>
        <div class="sig-name">CourtCollab, LLC</div>
        <div class="sig-sub">Authorized Representative</div>
        <div class="sig-line"></div>
        <div class="sig-label">Signature &amp; Date</div>
      </div>
    </div>
  </div>

  <div class="footer">
    CourtCollab, LLC &nbsp;|&nbsp; courtcollab.com<br>
    &copy; ${new Date().getFullYear()} CourtCollab. All rights reserved. &nbsp;|&nbsp;
    This document was generated by the CourtCollab platform.
  </div>

</body>
</html>`;
}
