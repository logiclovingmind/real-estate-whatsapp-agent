// Client for the Logic Loving Mind "Standard" CRM — pushes leads to its
// WhatsApp bot intake endpoint (POST /api/integrations/whatsapp/lead, static
// bearer token). This runs ALONGSIDE the Google Sheet sync, not instead of it.
//
// Optional by design: if CRM_URL / CRM_BOT_TOKEN are unset, every call is a
// cheap no-op so the agent runs fine without a CRM deployment.

import { createHash } from "node:crypto";
import { saveState } from "./state.js";

const INTAKE_PATH = "/api/integrations/whatsapp/lead";

function config() {
  const url = (process.env.CRM_URL || "").replace(/\/+$/, "");
  const token = process.env.CRM_BOT_TOKEN || "";
  return url && token ? { url, token } : null;
}

// One-line requirement the CRM shows on the lead card,
// e.g. "buy, 2BHK flat, Wakad, budget 60L-80L, ready".
function buildRequirement(fields = {}) {
  const budget =
    fields.budget_min && fields.budget_max
      ? `budget ${fields.budget_min}-${fields.budget_max}`
      : fields.budget_max
        ? `budget up to ${fields.budget_max}`
        : fields.budget_min
          ? `budget from ${fields.budget_min}`
          : "";
  const type = [fields.configuration, fields.property_type].filter(Boolean).join(" ");
  return [fields.intent, type, fields.area_locality, budget, fields.possession]
    .filter(Boolean)
    .join(", ");
}

function buildSummary(state) {
  const f = state.fields || {};
  const parts = [`Stage: ${state.stage || "new"}`];
  if (f.purpose) parts.push(`Purpose: ${f.purpose}`);
  if (f.financing) parts.push(`Financing: ${f.financing}`);
  if (f.preferred_time) parts.push(`Preferred time: ${f.preferred_time}`);
  if (f.visit_datetime) parts.push(`Site visit: ${f.visit_datetime}`);
  if (state.language) parts.push(`Language: ${state.language}`);
  if (f.notes) parts.push(`Notes: ${f.notes}`);
  return parts.join(" · ");
}

// Build the intake payload, or null if the lead isn't pushable yet (the CRM
// requires a name). `lastVisitSlot` gates site_visit_requested so a booking is
// announced to the CRM exactly once, not on every later field update.
export function buildPayload(state, lastVisitSlot) {
  const name = (state.fields?.name || "").trim();
  if (!name || !state.phone) return null;

  const payload = {
    name,
    phone: state.phone,
    source: "whatsapp",
    requirement: buildRequirement(state.fields) || null,
    conversation_summary: buildSummary(state),
  };

  const slot = state.fields?.visit_datetime || "";
  if (slot && slot !== lastVisitSlot) {
    payload.site_visit_requested = true;
    payload.preferred_slot = slot;
  }
  return payload;
}

// Push the lead to the CRM if anything changed since the last successful push.
// Called once per turn from the agent loop (and safe to call any time) — the
// payload hash stored in state makes repeat calls free, so the CRM's activity
// log doesn't get spammed with identical "repeat contact" entries.
export async function syncLead(state) {
  const crm = config();
  if (!crm) return { ok: false, skipped: true, reason: "CRM not configured" };
  if (!state?.stage || state.stage === "new") {
    return { ok: false, skipped: true, reason: "nothing to sync yet" };
  }

  const sync = state.crm || {};
  const payload = buildPayload(state, sync.visitSlot);
  if (!payload) return { ok: false, skipped: true, reason: "name not known yet" };

  const hash = createHash("sha1").update(JSON.stringify(payload)).digest("hex");
  if (sync.hash === hash) return { ok: true, skipped: true };

  try {
    const res = await fetch(crm.url + INTAKE_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${crm.token}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, reason: data.error || `HTTP ${res.status}` };
    }
    state.crm = {
      hash,
      visitSlot: payload.preferred_slot || sync.visitSlot || "",
      leadId: data.lead_id ?? sync.leadId ?? null,
    };
    saveState(state);
    return { ok: true, lead_id: data.lead_id, created: data.created };
  } catch (err) {
    return { ok: false, reason: `crm request failed: ${err.message}` };
  }
}

export default { syncLead, buildPayload };
