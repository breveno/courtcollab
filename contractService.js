/**
 * contractService.js — SignWell contract helpers for CourtCollab
 *
 * All SignWell API calls are proxied through the CourtCollab backend.
 * No API keys are ever stored or transmitted from the frontend.
 *
 * Usage:
 *   import * as ContractService from './contractService.js';
 *
 *   // Triggered automatically when deal status → "agreed" / "active":
 *   const result = await ContractService.createDealContract(dealId);
 *
 *   // Manual / low-level helpers:
 *   const doc = await ContractService.sendContract({ dealId, ... });
 */

const BASE = "/api";

// ---------------------------------------------------------------------------
// Internal fetch helper — attaches auth token and handles errors uniformly
// ---------------------------------------------------------------------------

async function _req(method, path, body = null) {
  const token = localStorage.getItem("token");
  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  };
  if (body !== null) {
    opts.body = JSON.stringify(body);
  }
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

// ---------------------------------------------------------------------------
// createDealContract — the primary entry point
//
// Triggers the full 8-step contract pipeline on the backend:
//   1. Pull deal terms from the database
//   2. Populate the contract template
//   3. Generate a PDF
//   4. Create a SignWell document
//   5. Add brand signer (order 1) and creator signer (order 2)
//   6. send_in_order=true — brand must sign before creator receives request
//   7. SignWell emails both parties automatically
//   8. Stores the SignWell document ID and sets deal status to 'contract_sent'
//
// Call this whenever a deal status changes to "agreed" / "active".
//
// Returns: { document_id, contract_status, signers, document }
// ---------------------------------------------------------------------------

export async function createDealContract(dealId) {
  return _req("POST", `/contracts/deals/${dealId}/create`);
}

// ---------------------------------------------------------------------------
// Send a contract for signing
//
// params:
//   dealId       {number}  — deal row ID
//   name         {string}  — document title shown in SignWell
//   subject      {string}  — email subject line for the signing invitation
//   message      {string}  — body text of the signing invitation email
//   signers      {Array}   — [{ name, email }, ...]
//   fileUrls     {Array}   — optional list of public PDF URLs to attach
//   redirectUrl  {string}  — optional URL to redirect signers after signing
// ---------------------------------------------------------------------------

export async function sendContract({
  dealId,
  name,
  subject,
  message,
  signers,
  fileUrls = [],
  redirectUrl = null,
}) {
  return _req("POST", "/contracts/send", {
    deal_id: dealId,
    name,
    subject,
    message,
    signers,
    file_urls: fileUrls,
    redirect_url: redirectUrl,
  });
}

// ---------------------------------------------------------------------------
// Get the current status of a document
// ---------------------------------------------------------------------------

export async function getContract(documentId) {
  return _req("GET", `/contracts/${documentId}`);
}

// ---------------------------------------------------------------------------
// Get an embedded signing URL so a signer can sign inside the app
// ---------------------------------------------------------------------------

export async function getSigningUrl(documentId, recipientId) {
  return _req(
    "GET",
    `/contracts/${documentId}/signing-url/${recipientId}`
  );
}

// ---------------------------------------------------------------------------
// Get the download URL for a completed (fully signed) PDF
// ---------------------------------------------------------------------------

export async function getDownloadUrl(documentId) {
  return _req("GET", `/contracts/${documentId}/download`);
}

// ---------------------------------------------------------------------------
// Cancel / delete a pending document
// ---------------------------------------------------------------------------

export async function cancelContract(documentId) {
  return _req("DELETE", `/contracts/${documentId}`);
}

// ---------------------------------------------------------------------------
// List available SignWell templates
// ---------------------------------------------------------------------------

export async function listTemplates() {
  return _req("GET", "/contracts/templates");
}

// ---------------------------------------------------------------------------
// Send a contract from a pre-built SignWell template
//
// params:
//   dealId       {number}
//   templateId   {string}  — SignWell template ID
//   name         {string}
//   subject      {string}
//   message      {string}
//   signers      {Array}   — [{ name, email, role? }, ...]
//   fields       {Object}  — optional merge-field overrides { field_name: value }
//   redirectUrl  {string}  — optional redirect after signing
// ---------------------------------------------------------------------------

export async function sendContractFromTemplate({
  dealId,
  templateId,
  name,
  subject,
  message,
  signers,
  fields = {},
  redirectUrl = null,
}) {
  return _req("POST", "/contracts/send", {
    deal_id: dealId,
    template_id: templateId,
    name,
    subject,
    message,
    signers,
    fields,
    redirect_url: redirectUrl,
  });
}
