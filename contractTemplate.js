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

function buildContractData(deal) {
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

function buildContractText(deal) {
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

function buildContractHtml(deal) {
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
      background: #0B1F4A;
      padding: 36px 48px 0 48px;
      margin: -48px -48px 32px -48px;
    }

    .contract-header-inner {
      display: flex;
      align-items: center;
      gap: 18px;
      padding-bottom: 28px;
    }

    .contract-header .wordmark {
      font-family: "Arial", sans-serif;
      font-size: 36px;
      font-weight: 900;
      letter-spacing: -0.5px;
      line-height: 1;
    }

    .contract-header .wordmark .court { color: #C8F135; }
    .contract-header .wordmark .collab { color: #ffffff; }

    .contract-header .subtitle {
      font-family: "Arial", sans-serif;
      font-size: 13px;
      color: rgba(255,255,255,0.55);
      margin-top: 6px;
      letter-spacing: 0.2px;
    }

    .contract-header-bar {
      height: 5px;
      background: #C8F135;
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
    <div class="contract-header-inner">
      <img src="data:image/png;base64,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" alt="CourtCollab" style="height:62px;width:auto;flex-shrink:0;">
      <div>
        <div class="wordmark"><span class="court">Court</span><span class="collab">Collab</span></div>
        <div class="subtitle">Creator &amp; Brand Collaboration Agreement &nbsp;|&nbsp; courtcollab.com</div>
      </div>
    </div>
    <div class="contract-header-bar"></div>
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
