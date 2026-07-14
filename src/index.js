// Express webhook service — "the brain". Verifies + parses inbound WhatsApp
// messages, runs them through the agent, and replies. ACKs Meta with 200
// immediately and processes async so Meta doesn't retry.

import "dotenv/config";
import express from "express";
import {
  verifySignature,
  parseInbound,
  sendText,
  stripMarkdown,
} from "./whatsapp.js";
import { getState, saveState, deleteState, getConversation } from "./state.js";
import { handleMessage } from "./agent.js";

const app = express();
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const HANDOFF_NUMBER = process.env.HUMAN_HANDOFF_NUMBER;

// Capture the raw body so we can verify X-Hub-Signature-256.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// Health check.
app.get("/", (_req, res) => res.send("ok"));

// --- Simulator API (used by the CRM's Train page) ------------------------
// Bearer-auth'd endpoint that reuses the exact same handleMessage() loop
// as the WhatsApp webhook, so what you see here is what a real lead gets.
function simulateAuth(req, res, next) {
  const token = process.env.SIMULATE_TOKEN;
  if (!token) return res.status(503).json({ error: "SIMULATE_TOKEN not configured on agent" });
  const auth = req.get("authorization") || "";
  if (auth !== `Bearer ${token}`) return res.status(401).json({ error: "unauthorized" });
  next();
}

function snapshotState(state) {
  return {
    phone: state.phone,
    stage: state.stage,
    fields: state.fields || {},
    crm: state.crm || {},
    messageCount: (state.history || []).filter((m) => m.role === "user" || m.role === "assistant").length,
    updatedAt: state.updated_at,
  };
}

app.post("/api/simulate", simulateAuth, async (req, res) => {
  const { phone, message } = req.body || {};
  if (typeof phone !== "string" || !phone.trim()) return res.status(400).json({ error: "phone required" });
  if (typeof message !== "string" || !message.trim()) return res.status(400).json({ error: "message required" });
  const state = getState(phone.trim());
  try {
    const { reply, handoff, handoffReason } = await handleMessage(state, message);
    res.json({ reply, handoff: !!handoff, handoffReason: handoffReason || null, state: snapshotState(state) });
  } catch (err) {
    console.error("simulate failed:", err);
    res.status(500).json({ error: err.message || "internal error" });
  }
});

app.post("/api/simulate/reset", simulateAuth, (req, res) => {
  const { phone } = req.body || {};
  if (typeof phone !== "string" || !phone.trim()) return res.status(400).json({ error: "phone required" });
  deleteState(phone.trim());
  res.json({ ok: true });
});

app.get("/api/simulate/conversation", simulateAuth, (req, res) => {
  const phone = String(req.query.phone || "").trim();
  if (!phone) return res.status(400).json({ error: "phone required" });
  const convo = getConversation(phone);
  if (!convo) return res.json({ phone, messages: [], state: null });
  const state = snapshotState(getState(phone));
  res.json({ phone, messages: convo.messages, state });
});
// --------------------------------------------------------------------------

// Webhook verification (Meta calls this once during setup).
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Inbound messages.
app.post("/webhook", (req, res) => {
  const signature = req.get("X-Hub-Signature-256");
  if (!verifySignature(req.rawBody, signature)) {
    return res.sendStatus(401);
  }

  // ACK immediately so Meta doesn't retry; process async.
  res.sendStatus(200);

  for (const inbound of parseInbound(req.body)) {
    if (!inbound.from) continue;
    if (alreadySeen(inbound.messageId)) continue;
    enqueue(inbound.from, () => processInbound(inbound)).catch((err) => {
      console.error("processInbound failed:", err);
    });
  }
});

// --- Idempotency: drop messages Meta has already delivered ---
const SEEN_MAX = 5000;
const seenIds = new Map();
function alreadySeen(id) {
  if (!id) return false;
  if (seenIds.has(id)) return true;
  seenIds.set(id, Date.now());
  if (seenIds.size > SEEN_MAX) {
    seenIds.delete(seenIds.keys().next().value);
  }
  return false;
}

// --- Per-phone serialization: chain work onto a per-phone promise ---
const queues = new Map();
function enqueue(phone, task) {
  const prev = queues.get(phone) || Promise.resolve();
  const next = prev.then(task, task);
  queues.set(phone, next);
  next.finally(() => {
    if (queues.get(phone) === next) queues.delete(phone);
  });
  return next;
}

async function processInbound(inbound) {
  const phone = inbound.from;
  const state = getState(phone);

  if (state.fields?.name == null && inbound.contactName) {
    state.fields = { ...state.fields, name: inbound.contactName };
    saveState(state);
  }

  if (inbound.unsupported) {
    await sendText(phone, "I can only read text messages here. Could you type your query?");
    return;
  }

  const { reply } = await handleMessage(state, inbound.text, {
    onHandoff: notifyOwner,
  });

  if (reply) await sendText(phone, stripMarkdown(reply));
}

async function notifyOwner(reason, state) {
  if (!HANDOFF_NUMBER) return;
  const name = state.fields?.name || "Unknown";
  await sendText(HANDOFF_NUMBER, `Handoff needed for ${name} (${state.phone}): ${reason}`);
}

app.listen(PORT, () => {
  console.log(`Real estate WhatsApp agent listening on :${PORT}`);
});

export default app;
