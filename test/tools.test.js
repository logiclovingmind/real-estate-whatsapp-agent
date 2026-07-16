import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point state at a throwaway DB before importing the modules that open it.
process.env.CONVERSATIONS_DB = join(mkdtempSync(join(tmpdir(), "re-")), "t.db");

// A brochure catalog for send_brochure tests. Must be set before importing
// tools.js so brochures.js parses it.
process.env.BROCHURES = JSON.stringify([
  { project: "Skyline Heights", aliases: ["skyline"], url: "https://cdn.example.com/skyline.pdf", filename: "Skyline Heights.pdf" },
]);

const { runTool, flushLeadToSheet } = await import("../src/tools.js");
const { getState } = await import("../src/state.js");
const appsscript = (await import("../src/appsscript.js")).default;
const whatsapp = (await import("../src/whatsapp.js")).default;
// Stub network calls so tests don't hit the real Calendar.
appsscript.bookAppointment = async () => ({ ok: true, event_id: "evt-1", when: "Mon 1 Jan 2026, 11:00 AM" });
appsscript.cancelAppointment = async () => ({ ok: true, cancelled: true });
// Stub the outbound WhatsApp document send so tests don't hit the Graph API.
let _lastDoc = null;
whatsapp.sendDocument = async (to, link, filename, caption) => {
  _lastDoc = { to, link, filename, caption };
  return { ok: true, data: {} };
};

test("flushLeadToSheet is a no-op (lead storage moved to CRM)", async () => {
  const state = getState("t-flush-qual");
  await runTool("save_field", { field: "intent", value: "buy" }, { state });
  assert.equal(state.stage, "qualifying");
  const res = await flushLeadToSheet(state);
  assert.equal(res.ok, true);
  assert.equal(res.skipped, true);
});

test("save_field persists a known field", async () => {
  const state = getState("t-known");
  const res = await runTool("save_field", { field: "intent", value: "buy" }, { state });
  assert.equal(res.ok, true);
  assert.equal(state.fields.intent, "buy");
});

test("save_field rejects an unknown field key", async () => {
  const state = getState("t-unknown");
  const res = await runTool("save_field", { field: "hacker", value: "x" }, { state });
  assert.equal(res.ok, false);
  assert.equal(state.fields.hacker, undefined);
});

test("save_field requires a field name", async () => {
  const state = getState("t-missing");
  const res = await runTool("save_field", { value: "x" }, { state });
  assert.equal(res.ok, false);
});

test("get_slots requires a date", async () => {
  const state = getState("t-slots");
  const res = await runTool("get_slots", {}, { state });
  assert.equal(res.ok, false);
});

test("book_appointment requires a datetime", async () => {
  const state = getState("t-book");
  const res = await runTool("book_appointment", {}, { state });
  assert.equal(res.ok, false);
});

test("handoff_to_human flags the escalation and stage", async () => {
  const state = getState("t-handoff");
  const res = await runTool("handoff_to_human", { reason: "angry" }, { state });
  assert.equal(res.ok, true);
  assert.equal(res.handoff, true);
  assert.equal(state.stage, "handoff");
});

test("save_field advances stage qualifying -> qualified as fields fill in", async () => {
  const state = getState("t-stage");
  assert.equal(state.stage, "new");

  await runTool("save_field", { field: "intent", value: "buy" }, { state });
  assert.equal(state.stage, "qualifying");

  await runTool("save_field", { field: "budget_max", value: "80 lakh" }, { state });
  await runTool("save_field", { field: "area_locality", value: "Wakad" }, { state });
  assert.equal(state.stage, "qualifying");

  await runTool("save_field", { field: "configuration", value: "3BHK" }, { state });
  assert.equal(state.stage, "qualified");
});

test("field collection never pulls a lead back out of a terminal stage", async () => {
  const state = getState("t-stage-terminal");
  state.stage = "booked";
  await runTool("save_field", { field: "notes", value: "called back" }, { state });
  assert.equal(state.stage, "booked");
});

test("send_brochure sends a matching project's PDF to the lead", async () => {
  _lastDoc = null;
  const state = getState("t-broch-ok");
  const res = await runTool("send_brochure", { project: "skyline" }, { state });
  assert.equal(res.ok, true);
  assert.equal(res.sent, true);
  assert.equal(res.project, "Skyline Heights");
  assert.equal(_lastDoc.to, "t-broch-ok");
  assert.equal(_lastDoc.link, "https://cdn.example.com/skyline.pdf");
});

test("send_brochure refuses an unknown project and lists what's available", async () => {
  _lastDoc = null;
  const state = getState("t-broch-miss");
  const res = await runTool("send_brochure", { project: "Nonexistent Towers" }, { state });
  assert.equal(res.ok, false);
  assert.deepEqual(res.available, ["Skyline Heights"]);
  assert.equal(_lastDoc, null); // nothing sent
});

test("send_brochure requires a project", async () => {
  const state = getState("t-broch-none");
  const res = await runTool("send_brochure", {}, { state });
  assert.equal(res.ok, false);
});

test("unknown tool returns a clean error", async () => {
  const state = getState("t-nope");
  const res = await runTool("does_not_exist", {}, { state });
  assert.equal(res.ok, false);
  assert.match(res.reason, /unknown tool/);
});
