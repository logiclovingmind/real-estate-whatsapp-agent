/**
 * Google Apps Script Web App — Calendar only.
 * Handles site-visit slot availability and booking via Google Calendar.
 * Google Sheets has been removed; lead records now live in the Standard CRM.
 *
 * SECURITY: client secrets are read from Script Properties, NOT stored here.
 * Set them once after pasting: fill setup() below, Run it once, then clear.
 * (Or use Project Settings → Script Properties directly.)
 * SHARED_SECRET must match APPS_SCRIPT_SHARED_SECRET in the Node .env.
 *
 * Deploy as a Web App (execute as: Me, access: Anyone) and copy the /exec URL
 * into APPS_SCRIPT_WEBAPP_URL in the Node .env.
 */

// One-time per client: fill these in, Run `setup`, then clear back to "".
function setup() {
  PropertiesService.getScriptProperties().setProperties({
    SHARED_SECRET: "",
    CALENDAR_ID: "",
  });
}

// Non-secret defaults — override per client via Script Properties.
var CONFIG = {
  BUSINESS_HOURS: "10:00-19:00",
  WORKING_DAYS: "Mon,Tue,Wed,Thu,Fri,Sat",
  VISIT_DURATION_MIN: "45",
  TIMEZONE: "Asia/Kolkata",
};

var TZ = prop("TIMEZONE");

// Title prefix for owner availability blocks so we can list/remove only blocks.
var BLOCK_PREFIX = "[BLOCKED]";

function prop(key, fallback) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (v == null || v === "") v = CONFIG[key];
  return v == null ? fallback : v;
}

function doGet() {
  return json({ ok: true, service: "real-estate-agent", status: "healthy", version: "v13-calendar-only" });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, reason: "invalid JSON" });
  }

  if (body.secret !== prop("SHARED_SECRET")) {
    return json({ ok: false, reason: "unauthorized" });
  }

  try {
    switch (body.action) {
      case "get_slots":
        return json(getSlots(body.date));
      case "book_appointment":
        return json(bookAppointment(body.booking || {}));
      case "cancel_appointment":
        return json(cancelAppointment(body.booking || {}));
      // CRM → Calendar sync
      case "create_event":
        return json(createCalendarEvent(body.event || {}));
      case "update_event":
        return json(updateCalendarEvent(body.event || {}));
      case "delete_event":
        return json(deleteCalendarEvent(body.event_id));
      // Admin only — never exposed as agent tools
      case "block_time":
        return json(blockTime(body.block || {}));
      case "list_blocks":
        return json(listBlocks(body.days));
      case "remove_block":
        return json(removeBlock(body.id));
      default:
        return json({ ok: false, reason: "unknown action: " + body.action });
    }
  } catch (err) {
    return json({ ok: false, reason: "server error: " + err.message });
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

/* ---------------- Calendar ---------------- */

function getCalendar() {
  var id = prop("CALENDAR_ID", "primary");
  return id === "primary"
    ? CalendarApp.getDefaultCalendar()
    : CalendarApp.getCalendarById(id);
}

function eventLinkFor(cal, event) {
  try {
    var shortId = event.getId().split("@")[0];
    var eid = Utilities.base64Encode(shortId + " " + cal.getId()).replace(/=+$/, "");
    return "https://www.google.com/calendar/event?eid=" + eid;
  } catch (e) {
    return "";
  }
}

function parseHours() {
  var hours = prop("BUSINESS_HOURS", "10:00-19:00").split("-");
  return {
    startH: parseInt(hours[0].split(":")[0], 10),
    startM: parseInt(hours[0].split(":")[1], 10),
    endH: parseInt(hours[1].split(":")[0], 10),
    endM: parseInt(hours[1].split(":")[1], 10),
  };
}

function isWorkingDay(date) {
  var days = prop("WORKING_DAYS", "Mon,Tue,Wed,Thu,Fri,Sat").split(",");
  var name = Utilities.formatDate(date, TZ, "EEE");
  return days.indexOf(name) !== -1;
}

function getSlots(dateStr) {
  if (!dateStr) return { ok: false, reason: "missing date" };
  var duration = parseInt(prop("VISIT_DURATION_MIN", "45"), 10);
  var h = parseHours();

  var parts = dateStr.split("-");
  var dayStart = new Date(parts[0], parts[1] - 1, parts[2], h.startH, h.startM, 0);
  var dayEnd = new Date(parts[0], parts[1] - 1, parts[2], h.endH, h.endM, 0);

  if (!isWorkingDay(dayStart)) {
    return { ok: true, date: dateStr, slots: [], reason: "non-working day" };
  }

  var cal = getCalendar();
  var events = cal.getEvents(dayStart, dayEnd);

  var slots = [];
  var nowTs = new Date().getTime();
  var cursor = new Date(dayStart.getTime());

  while (cursor.getTime() + duration * 60000 <= dayEnd.getTime()) {
    var slotStart = new Date(cursor.getTime());
    var slotEnd = new Date(cursor.getTime() + duration * 60000);

    if (slotStart.getTime() > nowTs) {
      var busy = false;
      for (var i = 0; i < events.length; i++) {
        if (
          slotStart.getTime() < events[i].getEndTime().getTime() &&
          slotEnd.getTime() > events[i].getStartTime().getTime()
        ) {
          busy = true;
          break;
        }
      }
      if (!busy) {
        slots.push({
          start: Utilities.formatDate(slotStart, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"),
          label: Utilities.formatDate(slotStart, TZ, "EEE d MMM, h:mm a"),
        });
      }
    }
    cursor = new Date(cursor.getTime() + duration * 60000);
  }

  return { ok: true, date: dateStr, slots: slots };
}

function bookAppointment(booking) {
  if (!booking.datetime) return { ok: false, reason: "missing datetime" };
  if (!booking.phone) return { ok: false, reason: "missing phone" };

  var start = new Date(booking.datetime);
  if (isNaN(start.getTime())) return { ok: false, reason: "invalid datetime" };
  if (start.getTime() < new Date().getTime()) {
    return { ok: false, reason: "cannot book a past time" };
  }

  var duration = parseInt(prop("VISIT_DURATION_MIN", "45"), 10);
  var end = new Date(start.getTime() + duration * 60000);

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    return { ok: false, reason: "busy, please retry" };
  }
  try {
    return createBooking(booking, start, end);
  } finally {
    lock.releaseLock();
  }
}

function createBooking(booking, start, end) {
  var cal = getCalendar();

  var clashes = cal.getEvents(start, end);
  if (clashes.length > 0) {
    return { ok: false, reason: "slot just got taken", taken: true };
  }

  var lead = booking.lead || {};
  var name = booking.name || lead.name || "Lead";
  var title = "Site Visit — " + name + " (" + booking.phone + ")";
  var desc =
    "Intent: " + (lead.intent || "") +
    "\nConfig: " + (lead.configuration || "") +
    "\nArea: " + (lead.area_locality || "") +
    "\nBudget: " + (lead.budget_min || "") + " - " + (lead.budget_max || "") +
    "\nPhone: " + booking.phone;

  var event = cal.createEvent(title, start, end, { description: desc });
  var eventId = event.getId();
  var eventLink = eventLinkFor(cal, event);

  return {
    ok: true,
    event_id: eventId,
    event_link: eventLink,
    when: Utilities.formatDate(start, TZ, "EEE d MMM yyyy, h:mm a"),
  };
}

function cancelAppointment(booking) {
  if (!booking.phone) return { ok: false, reason: "missing phone" };
  if (!booking.event_id) return { ok: false, reason: "missing event_id" };

  var cal = getCalendar();
  try {
    var ev = cal.getEventById(String(booking.event_id));
    if (ev) ev.deleteEvent();
  } catch (err) {
    // Event may already be gone — still return success so state clears.
  }

  return { ok: true, cancelled: true };
}

/* ---------------- CRM Calendar sync ---------------- */
// Called by the Standard CRM when a site visit is created, updated, or cancelled.
// event: { name, phone, datetime, agent (optional), property (optional), event_id (for update) }

function buildEventDetails(event) {
  var start = new Date(event.datetime);
  var duration = parseInt(prop("VISIT_DURATION_MIN", "45"), 10);
  var end = new Date(start.getTime() + duration * 60000);
  var title = "Site Visit — " + (event.name || "Lead") + " (" + (event.phone || "") + ")";
  var descParts = ["Lead: " + (event.name || "") + " (" + (event.phone || "") + ")"];
  if (event.agent) descParts.push("Agent: " + event.agent);
  if (event.property) descParts.push("Property: " + event.property);
  return { start: start, end: end, title: title, desc: descParts.join("\n") };
}

function createCalendarEvent(event) {
  if (!event.datetime) return { ok: false, reason: "missing datetime" };
  var d = buildEventDetails(event);
  var cal = getCalendar();
  var ev = cal.createEvent(d.title, d.start, d.end, { description: d.desc });
  return {
    ok: true,
    event_id: ev.getId(),
    when: Utilities.formatDate(d.start, TZ, "EEE d MMM yyyy, h:mm a"),
  };
}

function updateCalendarEvent(event) {
  if (!event.event_id) return { ok: false, reason: "missing event_id" };
  if (!event.datetime) return { ok: false, reason: "missing datetime" };
  var cal = getCalendar();
  var ev;
  try { ev = cal.getEventById(String(event.event_id)); } catch (e) { ev = null; }
  if (!ev) return createCalendarEvent(event); // event gone — recreate
  var d = buildEventDetails(event);
  ev.setTitle(d.title);
  ev.setDescription(d.desc);
  ev.setTime(d.start, d.end);
  return { ok: true };
}

function deleteCalendarEvent(eventId) {
  if (!eventId) return { ok: false, reason: "missing event_id" };
  var cal = getCalendar();
  try {
    var ev = cal.getEventById(String(eventId));
    if (ev) ev.deleteEvent();
  } catch (e) { /* already gone */ }
  return { ok: true, deleted: true };
}

/* ---------------- Availability blocks (ADMIN ONLY) ---------------- */

function blockTime(block) {
  if (!block.date) return { ok: false, reason: "missing date" };
  var parts = String(block.date).split("-");
  if (parts.length !== 3) return { ok: false, reason: "bad date (want yyyy-MM-dd)" };
  var y = parseInt(parts[0], 10), mo = parseInt(parts[1], 10) - 1, d = parseInt(parts[2], 10);

  var cal = getCalendar();
  var reason = block.reason ? String(block.reason).trim() : "";
  var title = reason ? BLOCK_PREFIX + " " + reason : BLOCK_PREFIX;

  var event;
  if (block.allDay) {
    event = cal.createAllDayEvent(title, new Date(y, mo, d));
  } else {
    if (!block.start || !block.end) {
      return { ok: false, reason: "missing start/end time" };
    }
    var s = String(block.start).split(":"), e = String(block.end).split(":");
    var start = new Date(y, mo, d, parseInt(s[0], 10), parseInt(s[1] || 0, 10), 0);
    var end = new Date(y, mo, d, parseInt(e[0], 10), parseInt(e[1] || 0, 10), 0);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return { ok: false, reason: "invalid time" };
    }
    if (end.getTime() <= start.getTime()) {
      return { ok: false, reason: "end must be after start" };
    }
    event = cal.createEvent(title, start, end);
  }

  return { ok: true, id: event.getId(), label: blockLabel(event) };
}

function listBlocks(days) {
  var n = parseInt(days, 10);
  if (isNaN(n) || n <= 0) n = 30;
  var cal = getCalendar();
  var from = new Date();
  var to = new Date(from.getTime() + n * 24 * 60 * 60000);
  var events = cal.getEvents(from, to);
  var out = [];
  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    if (ev.getTitle().indexOf(BLOCK_PREFIX) !== 0) continue;
    out.push({
      id: ev.getId(),
      allDay: ev.isAllDayEvent(),
      reason: ev.getTitle().slice(BLOCK_PREFIX.length).trim(),
      start: Utilities.formatDate(ev.getStartTime(), TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"),
      end: Utilities.formatDate(ev.getEndTime(), TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"),
      label: blockLabel(ev),
    });
  }
  return { ok: true, blocks: out };
}

function removeBlock(id) {
  if (!id) return { ok: false, reason: "missing id" };
  var cal = getCalendar();
  var ev;
  try {
    ev = cal.getEventById(String(id));
  } catch (e) {
    return { ok: false, reason: "event not found" };
  }
  if (!ev) return { ok: false, reason: "event not found" };
  if (ev.getTitle().indexOf(BLOCK_PREFIX) !== 0) {
    return { ok: false, reason: "not a block event" };
  }
  ev.deleteEvent();
  return { ok: true, removed: true };
}

function blockLabel(ev) {
  if (ev.isAllDayEvent()) {
    return Utilities.formatDate(ev.getAllDayStartDate(), TZ, "EEE d MMM") + " — all day";
  }
  return Utilities.formatDate(ev.getStartTime(), TZ, "EEE d MMM, h:mm a") +
    " – " + Utilities.formatDate(ev.getEndTime(), TZ, "h:mm a");
}
