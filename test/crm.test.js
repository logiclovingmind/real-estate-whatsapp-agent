import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point state at a throwaway DB before importing the modules that open it.
process.env.CONVERSATIONS_DB = join(mkdtempSync(join(tmpdir(), "re-crm-")), "t.db");
process.env.CRM_URL = "http://crm.test";
process.env.CRM_BOT_TOKEN = "test-token";

const { buildPayload, syncLead } = await import("../src/crm.js");
const { getState } = await import("../src/state.js");

// Capture CRM pushes without hitting the network.
let fetchCalls = [];
let fetchResponse = () => ({ status: 201, body: { lead_id: 7, created: true } });
globalThis.fetch = async (url, opts) => {
  const call = { url, opts, body: JSON.parse(opts.body) };
  fetchCalls.push(call);
  const r = fetchResponse(call);
  return {
    ok: r.status < 400,
    status: r.status,
    json: async () => r.body,
  };
};

function qualifiedState(phone) {
  const state = getState(phone);
  state.stage = "qualified";
  state.language = "hinglish";
  state.fields = {
    name: "Ramesh",
    intent: "buy",
    property_type: "flat",
    configuration: "2BHK",
    area_locality: "Wakad",
    budget_min: "60L",
    budget_max: "80L",
  };
  return state;
}

test("buildPayload maps state to the CRM intake contract", () => {
  const state = qualifiedState("919876543210");
  const p = buildPayload(state);
  assert.equal(p.name, "Ramesh");
  assert.equal(p.phone, "919876543210");
  assert.equal(p.source, "whatsapp");
  assert.equal(p.requirement, "buy, 2BHK flat, Wakad, budget 60L-80L");
  assert.match(p.conversation_summary, /Stage: qualified/);
  assert.equal(p.site_visit_requested, undefined);
});

test("buildPayload returns null until a name is known (CRM requires it)", () => {
  const state = getState("919876500000");
  state.stage = "qualifying";
  state.fields = { intent: "rent" };
  assert.equal(buildPayload(state), null);
});

test("booking sets site_visit_requested once, not on later updates", () => {
  const state = qualifiedState("919876511111");
  state.fields.visit_datetime = "2026-07-15T11:00:00+05:30";

  const first = buildPayload(state, "");
  assert.equal(first.site_visit_requested, true);
  assert.equal(first.preferred_slot, "2026-07-15T11:00:00+05:30");

  // Same slot already announced -> no visit fields on subsequent pushes.
  const later = buildPayload(state, "2026-07-15T11:00:00+05:30");
  assert.equal(later.site_visit_requested, undefined);
  assert.equal(later.preferred_slot, undefined);
});

test("syncLead pushes once, then skips while nothing changed", async () => {
  fetchCalls = [];
  const state = qualifiedState("919876522222");

  const r1 = await syncLead(state);
  assert.equal(r1.ok, true);
  assert.equal(r1.lead_id, 7);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "http://crm.test/api/integrations/whatsapp/lead");
  assert.equal(fetchCalls[0].opts.headers.Authorization, "Bearer test-token");

  const r2 = await syncLead(state);
  assert.equal(r2.ok, true);
  assert.equal(r2.skipped, true);
  assert.equal(fetchCalls.length, 1);

  // A field change makes it push again.
  state.fields = { ...state.fields, notes: "wants corner unit" };
  const r3 = await syncLead(state);
  assert.equal(r3.ok, true);
  assert.equal(fetchCalls.length, 2);
});

test("syncLead skips new-stage and nameless leads without touching the network", async () => {
  fetchCalls = [];
  const fresh = getState("919876533333");
  assert.equal((await syncLead(fresh)).skipped, true);

  fresh.stage = "qualifying";
  fresh.fields = { intent: "buy" };
  assert.equal((await syncLead(fresh)).skipped, true);
  assert.equal(fetchCalls.length, 0);
});

test("syncLead reports failure without saving the hash (retries next turn)", async () => {
  fetchCalls = [];
  fetchResponse = () => ({ status: 401, body: { error: "unauthorized" } });
  const state = qualifiedState("919876544444");

  const r1 = await syncLead(state);
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, "unauthorized");

  fetchResponse = () => ({ status: 201, body: { lead_id: 9, created: true } });
  const r2 = await syncLead(state);
  assert.equal(r2.ok, true);
  assert.equal(fetchCalls.length, 2);
});
