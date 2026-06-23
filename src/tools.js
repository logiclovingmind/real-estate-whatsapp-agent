// OpenAI-style tool schemas + thin handlers. The model decides WHAT to call;
// these handlers validate args, talk to Apps Script / state, and return a
// compact result. Errors return { ok: false, reason } so the model can recover.

import appsscript from "./appsscript.js";
import { setField, saveState } from "./state.js";
import { REQUIRED_FIELDS } from "./prompts/system.js";

// Stages reached by an explicit action (booking/handoff/lost). Field collection
// must never silently pull a lead back out of one of these.
const TERMINAL_STAGES = new Set(["booked", "handoff", "lost"]);

// Derive pipeline stage from the fields collected so far, deterministically —
// the model is unreliable about advancing it. All required fields present →
// qualified; some but not all → qualifying; none → leave as-is (new).
function deriveStage(state) {
  if (TERMINAL_STAGES.has(state.stage)) return;
  const known = state.fields || {};
  const have = REQUIRED_FIELDS.filter((f) => known[f]);
  if (have.length === REQUIRED_FIELDS.length) state.stage = "qualified";
  else if (have.length > 0) state.stage = "qualifying";
}

// The only field keys the model is allowed to persist. Anything else is junk
// the model invented and would never map to a Sheet column, so reject it.
const ALLOWED_FIELDS = new Set([
  "name", "intent", "property_type", "configuration", "area_locality",
  "budget_min", "budget_max", "possession", "purpose", "financing",
  "preferred_time", "source", "notes",
]);

// --- Tool schemas (sent to the model) ---

export const toolSchemas = [
  {
    type: "function",
    function: {
      name: "save_field",
      description:
        "Persist one learned lead field to local state. Call immediately whenever you learn something (name, intent, budget, area, etc.).",
      parameters: {
        type: "object",
        properties: {
          field: {
            type: "string",
            description:
              "Field key, e.g. name, intent, property_type, configuration, area_locality, budget_min, budget_max, possession, purpose, financing, preferred_time, source, notes.",
          },
          value: { type: "string", description: "The value to store." },
        },
        required: ["field", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "upsert_lead",
      description:
        "Write the full lead record to the Google Sheet CRM (creates or updates the row keyed by phone).",
      parameters: {
        type: "object",
        properties: {
          stage: {
            type: "string",
            enum: ["new", "qualifying", "qualified", "booked", "lost"],
            description: "Current pipeline stage for this lead.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_slots",
      description:
        "Get real available site-visit slots for a given date. Call before proposing times.",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "Date in YYYY-MM-DD (IST). Use today or a near future date.",
          },
        },
        required: ["date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "book_appointment",
      description:
        "Book a confirmed site visit: creates the Calendar event and writes the booking. Only call after the lead consents to a specific slot.",
      parameters: {
        type: "object",
        properties: {
          datetime: {
            type: "string",
            description: "Start time in ISO 8601 with IST offset, e.g. 2026-06-21T17:00:00+05:30.",
          },
        },
        required: ["datetime"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_appointment",
      description:
        "Cancel the lead's existing site visit: deletes the Calendar event and clears the booking in the CRM. To RESCHEDULE, cancel first, then get_slots and book_appointment for the new time.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "handoff_to_human",
      description:
        "Escalate to a human (owner). Use for anger, confusion, price negotiation, owner requests, or out-of-scope asks.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Short reason for the handoff." },
        },
        required: ["reason"],
      },
    },
  },
];

// --- Handlers ---
// Each handler receives (args, ctx) where ctx = { state }. They mutate/persist
// state as needed and return a compact object for the model.

// Pick two slots spread across the day: one earlier, one later.
function pickTwo(slots) {
  if (slots.length <= 2) return slots;
  return [slots[0], slots[slots.length - 1]];
}

function leadFromState(state, stage) {
  return {
    phone: state.phone,
    language: state.language,
    stage: stage || state.stage || "qualifying",
    ...state.fields,
  };
}

const handlers = {
  async save_field(args, { state }) {
    if (!args?.field) return { ok: false, reason: "missing field" };
    if (!ALLOWED_FIELDS.has(args.field)) {
      return { ok: false, reason: `unknown field: ${args.field}` };
    }
    setField(state, args.field, args.value ?? "");
    deriveStage(state);
    saveState(state);
    return { ok: true, saved: { [args.field]: args.value } };
  },

  async upsert_lead(args, { state }) {
    if (args?.stage) state.stage = args.stage;
    else deriveStage(state);
    const lead = leadFromState(state, state.stage);
    const res = await appsscript.upsertLead(lead);
    saveState(state);
    return res?.ok ? { ok: true } : res;
  },

  async get_slots(args, { state }) {
    if (!args?.date) return { ok: false, reason: "missing date" };
    const res = await appsscript.getSlots(args.date);
    if (res?.ok && Array.isArray(res.slots) && res.slots.length > 0) {
      // Offer at most two, spread across the day, so the agent proposes a
      // concrete either/or instead of dumping the whole list to the lead.
      res.suggested = pickTwo(res.slots);
    }
    return res;
  },

  async book_appointment(args, { state }) {
    if (!args?.datetime) return { ok: false, reason: "missing datetime" };

    // Guard against double-booking the same lead. The Calendar clash check in
    // Apps Script can miss a just-created event (read-after-write lag), so the
    // reliable dedupe is here: if this lead already has a visit, a repeat call
    // is either a duplicate confirm (same slot -> just re-confirm, no new event)
    // or a reschedule (different slot -> must cancel_appointment first).
    const bookedId = state.fields?.visit_event_id;
    const bookedWhen = state.fields?.visit_datetime;
    if (bookedId && bookedWhen) {
      const sameSlot =
        new Date(bookedWhen).getTime() === new Date(args.datetime).getTime();
      if (sameSlot) {
        return { ok: true, already_booked: true, event_id: bookedId, when: bookedWhen };
      }
      return {
        ok: false,
        reason:
          "lead already has a visit booked; call cancel_appointment first to reschedule, then book the new time.",
      };
    }

    const booking = {
      phone: state.phone,
      name: state.fields?.name || "",
      datetime: args.datetime,
      lead: leadFromState(state, "booked"),
    };
    const res = await appsscript.bookAppointment(booking);
    if (res?.ok) {
      state.stage = "booked";
      setField(state, "visit_datetime", args.datetime);
      if (res.event_id) setField(state, "visit_event_id", res.event_id);
      saveState(state);
    }
    return res;
  },

  async cancel_appointment(args, { state }) {
    const res = await appsscript.cancelAppointment({
      phone: state.phone,
      event_id: state.fields?.visit_event_id,
    });
    if (res?.ok) {
      state.stage = "qualified";
      setField(state, "visit_datetime", "");
      setField(state, "visit_event_id", "");
      saveState(state);
    }
    return res;
  },

  async handoff_to_human(args, { state }) {
    state.stage = "handoff";
    setField(state, "notes", `HANDOFF: ${args?.reason || "unspecified"}`);
    saveState(state);
    // The owner notification (WhatsApp to HUMAN_HANDOFF_NUMBER) is fired by the
    // caller in agent.js, which has the messaging client.
    return { ok: true, handoff: true, reason: args?.reason || "" };
  },
};

export async function runTool(name, args, ctx) {
  const handler = handlers[name];
  if (!handler) return { ok: false, reason: `unknown tool: ${name}` };
  try {
    return await handler(args, ctx);
  } catch (err) {
    return { ok: false, reason: `tool error: ${err.message}` };
  }
}

export default { toolSchemas, runTool };
