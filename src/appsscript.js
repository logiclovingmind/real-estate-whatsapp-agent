// HTTPS client for the Google Apps Script web app.
// After removing the Google Sheet, this only handles Calendar operations:
// get_slots, book_appointment, cancel_appointment, and availability blocks.

import { log } from "./log.js";

const WEBAPP_URL = process.env.APPS_SCRIPT_WEBAPP_URL;
const SHARED_SECRET = process.env.APPS_SCRIPT_SHARED_SECRET;

async function call(action, payload = {}) {
  if (!WEBAPP_URL) {
    return { ok: false, reason: "APPS_SCRIPT_WEBAPP_URL not configured" };
  }

  const body = JSON.stringify({ action, secret: SHARED_SECRET, ...payload });

  try {
    const res = await fetch(WEBAPP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      redirect: "follow",
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return {
        ok: false,
        reason: `non-JSON response (${res.status}): ${text.slice(0, 200)}`,
      };
    }

    if (!res.ok) {
      const reason = data.reason || `HTTP ${res.status}`;
      log.warn("appsscript_error", { action, status: res.status, reason });
      return { ok: false, reason };
    }
    return data;
  } catch (err) {
    log.error("appsscript_request_failed", { action, error: err.message });
    return { ok: false, reason: `request failed: ${err.message}` };
  }
}

export function getSlots(date) {
  return call("get_slots", { date });
}

export function bookAppointment(booking) {
  return call("book_appointment", { booking });
}

export function cancelAppointment(booking) {
  return call("cancel_appointment", { booking });
}

export default {
  getSlots,
  bookAppointment,
  cancelAppointment,
  call,
};
