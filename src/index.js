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
import { getState, saveState } from "./state.js";
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
