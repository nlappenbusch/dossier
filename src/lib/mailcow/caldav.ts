import "server-only";

import { randomUUID } from "node:crypto";

import ICAL from "ical.js";

import type { CalendarEvent, InterviewEvent } from "@/lib/google/calendar";
import { GoogleError } from "@/lib/google/errors";
import type { Interval } from "@/lib/google/slots";

import { loadImapConfig, type ImapConfig } from "./config";

// Google Calendar's part done over CalDAV (fork: nlappenbusch/dossier), e.g.
// SOGo in Mailcow, with the same functions calendar.ts offers. An event's id
// is its file name in the collection ("<uuid>.ics"); the application it's for
// is kept in X-DOSSIER-APPLICATION, as Google keeps it in a private property.

const APPLICATION_PROPERTY = "x-dossier-application";

type Target = { config: ImapConfig; collection: string };

/** The collection for `calendarId`: "primary" (or anything not a URL) is the one in Settings, else the URL given. */
async function target(calendarId: string): Promise<Target> {
  const config = await loadImapConfig();
  const collection = /^https?:\/\//.test(calendarId) ? calendarId : config.caldavUrl;
  if (!collection) throw new GoogleError("scope", "No calendar is set up for the mailbox. Add its CalDAV address in Settings → Google.");
  return { config, collection: collection.endsWith("/") ? collection : `${collection}/` };
}

const authHeader = (config: ImapConfig) => `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}`;

async function dav(
  config: ImapConfig,
  url: string,
  { method = "GET", body, headers = {}, signal }: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<Response> {
  const timeout = AbortSignal.timeout(30_000);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { authorization: authHeader(config), ...headers },
      body,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      cache: "no-store",
    });
  } catch {
    throw new GoogleError("unavailable", "Couldn't reach the calendar server. Try again in a moment.");
  }
  const path = new URL(url).pathname;
  if (response.status === 401) throw new GoogleError("revoked", "The calendar server didn't accept the mailbox password.", `${path}: 401`, 401);
  if (response.status === 403) throw new GoogleError("scope", "The calendar server refused that.", `${path}: 403`, 403);
  if (response.status === 404 || response.status === 410) throw new GoogleError("unavailable", "The calendar server couldn't find that.", `${path}: ${response.status}`, response.status);
  if (!response.ok && response.status !== 207) {
    throw new GoogleError("unavailable", "The calendar server had a problem with that. Try again in a moment.", `${path}: HTTP ${response.status}`, response.status);
  }
  return response;
}

/** The web calendar to link to: SOGo's own page when it's SOGo. */
function webLink(collection: string): string {
  const match = /^(https?:\/\/[^/]+)\/SOGo\/dav\/([^/]+)\//.exec(collection);
  return match ? `${match[1]}/SOGo/so/${match[2]}/Calendar/view` : "";
}

// ─── iCalendar ──────────────────────────────────────────────────────────────

const icsTime = (date: Date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const icsText = (text: string) => text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Lines folded at 75 octets, as iCalendar wants. */
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  for (const char of line) {
    if (Buffer.byteLength(current + char, "utf8") > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = "";
    }
    current += char;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

/** Registers the time zones a calendar file brings, so its times read right. */
function registerZones(calendar: ICAL.Component): void {
  for (const zone of calendar.getAllSubcomponents("vtimezone")) {
    const tzid = zone.getFirstPropertyValue("tzid");
    if (typeof tzid === "string" && !ICAL.TimezoneService.has(tzid)) ICAL.TimezoneService.register(new ICAL.Timezone(zone));
  }
}

function parseCalendar(text: string): ICAL.Component {
  const calendar = new ICAL.Component(ICAL.parse(text));
  registerZones(calendar);
  return calendar;
}

/** The main event of a file (the one without RECURRENCE-ID). */
function masterOf(calendar: ICAL.Component): ICAL.Component | null {
  const events = calendar.getAllSubcomponents("vevent");
  return events.find((event) => !event.hasProperty("recurrence-id")) ?? events[0] ?? null;
}

const dayString = (time: ICAL.Time) => `${time.year}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}`;

function toEvent(id: string, vevent: ICAL.Component, link: string, start: ICAL.Time, end: ICAL.Time): CalendarEvent {
  const allDay = start.isDate;
  const status = String(vevent.getFirstPropertyValue("status") ?? "").toUpperCase();
  const applicationId = vevent.getFirstPropertyValue(APPLICATION_PROPERTY);
  return {
    id,
    title: String(vevent.getFirstPropertyValue("summary") ?? ""),
    cancelled: status === "CANCELLED",
    start: allDay ? null : start.toJSDate(),
    end: allDay ? null : end.toJSDate(),
    startDate: allDay ? dayString(start) : null,
    endDate: allDay ? dayString(end) : null,
    link,
    applicationId: typeof applicationId === "string" && applicationId ? applicationId : null,
  };
}

function singleEvent(id: string, calendar: ICAL.Component, link: string): CalendarEvent | null {
  const master = masterOf(calendar);
  if (!master) return null;
  const event = new ICAL.Event(master);
  if (!event.startDate) return null;
  const end = event.endDate ?? event.startDate;
  return toEvent(id, master, link, event.startDate, end);
}

/** The events of one file between `from` and `to`, repeats expanded. */
function eventsIn(id: string, calendar: ICAL.Component, link: string, from: Date, to: Date): { event: CalendarEvent; opaque: boolean }[] {
  const master = masterOf(calendar);
  if (!master) return [];
  const event = new ICAL.Event(master);
  // Changed occurrences live in their own VEVENT with RECURRENCE-ID.
  for (const exception of calendar.getAllSubcomponents("vevent")) if (exception !== master && exception.hasProperty("recurrence-id")) event.relateException(exception);
  const opaque = String(master.getFirstPropertyValue("transp") ?? "OPAQUE").toUpperCase() !== "TRANSPARENT";
  const found: { event: CalendarEvent; opaque: boolean }[] = [];
  if (!event.isRecurring()) {
    const start = event.startDate;
    const end = event.endDate ?? start;
    if (start && start.toJSDate() < to && end.toJSDate() > from) found.push({ event: toEvent(id, master, link, start, end), opaque });
    return found;
  }
  const iterator = event.iterator();
  for (let next = iterator.next(), count = 0; next && count < 1000; next = iterator.next(), count++) {
    const details = event.getOccurrenceDetails(next);
    const start = details.startDate.toJSDate();
    if (start >= to) break;
    if (details.endDate.toJSDate() <= from) continue;
    found.push({ event: toEvent(`${id}#${next.toString()}`, details.item.component, link, details.startDate, details.endDate), opaque });
  }
  return found;
}

// ─── The calendar ───────────────────────────────────────────────────────────

const decodeXml = (text: string) =>
  text
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1")
    .replace(/&#13;/g, "\r")
    .replace(/&#10;/g, "\n")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

async function query(collection: string, config: ImapConfig, from: Date, to: Date, signal?: AbortSignal): Promise<{ id: string; data: string }[]> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><C:calendar-data/></D:prop>
  <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="${icsTime(from)}" end="${icsTime(to)}"/></C:comp-filter></C:comp-filter></C:filter>
</C:calendar-query>`;
  const response = await dav(config, collection, { method: "REPORT", body, headers: { depth: "1", "content-type": "application/xml; charset=utf-8" }, signal });
  const xml = await response.text();
  const files: { id: string; data: string }[] = [];
  for (const [block] of xml.matchAll(/<(?:[\w-]+:)?response\b[\s\S]*?<\/(?:[\w-]+:)?response>/g)) {
    const href = /<(?:[\w-]+:)?href>([^<]*)</.exec(block)?.[1];
    const data = /<(?:[\w-]+:)?calendar-data\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?calendar-data>/.exec(block)?.[1];
    if (!href || !data) continue;
    files.push({ id: decodeURIComponent(href.split("/").filter(Boolean).pop() ?? ""), data: decodeXml(data.trim()) });
  }
  return files;
}

const fileUrl = (collection: string, eventId: string) => `${collection}${encodeURIComponent(eventId.split("#")[0])}`;

/** Busy times between `from` and `to`: timed events that aren't marked free. */
export async function davBusyTimes(calendarId: string, from: Date, to: Date, signal?: AbortSignal): Promise<Interval[]> {
  const { config, collection } = await target(calendarId);
  const busy: Interval[] = [];
  for (const file of await query(collection, config, from, to, signal)) {
    try {
      for (const { event, opaque } of eventsIn(file.id, parseCalendar(file.data), "", from, to)) {
        if (opaque && !event.cancelled && event.start && event.end) busy.push({ start: event.start, end: event.end });
      }
    } catch {
      // A file the parser can't read doesn't stop the rest.
    }
  }
  return busy.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** The events between `from` and `to`, repeats as single events, in order. */
export async function davListEvents(calendarId: string, from: Date, to: Date, signal?: AbortSignal): Promise<CalendarEvent[]> {
  const { config, collection } = await target(calendarId);
  const link = webLink(collection);
  const events: CalendarEvent[] = [];
  for (const file of await query(collection, config, from, to, signal)) {
    try {
      for (const { event } of eventsIn(file.id, parseCalendar(file.data), link, from, to)) if (!event.cancelled) events.push(event);
    } catch {
      // As above.
    }
  }
  const at = (event: CalendarEvent) => event.start?.getTime() ?? new Date(`${event.startDate}T00:00:00`).getTime();
  return events.sort((a, b) => at(a) - at(b)).slice(0, 1000);
}

/** Adds an interview; returns its id and link. */
export async function davCreateEvent(calendarId: string, event: InterviewEvent): Promise<{ id: string; htmlLink: string }> {
  const { config, collection } = await target(calendarId);
  const uid = randomUUID();
  const id = `${uid}.ics`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Dossier//Mailcow fork//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${icsTime(new Date())}`,
    `DTSTART:${icsTime(event.start)}`,
    `DTEND:${icsTime(event.end)}`,
    `SUMMARY:${icsText(event.summary)}`,
    `DESCRIPTION:${icsText(event.description)}`,
    `X-DOSSIER-APPLICATION:${icsText(event.applicationId)}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsText(event.summary)}`,
    "TRIGGER:-PT30M",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  await dav(config, fileUrl(collection, id), {
    method: "PUT",
    body: `${lines.map(fold).join("\r\n")}\r\n`,
    headers: { "content-type": "text/calendar; charset=utf-8", "if-none-match": "*" },
  });
  return { id, htmlLink: webLink(collection) };
}

async function readFile(collection: string, config: ImapConfig, eventId: string, signal?: AbortSignal): Promise<{ calendar: ICAL.Component; etag: string | null } | null> {
  try {
    const response = await dav(config, fileUrl(collection, eventId), { signal });
    return { calendar: parseCalendar(await response.text()), etag: response.headers.get("etag") };
  } catch (error) {
    if (error instanceof GoogleError && (error.status === 404 || error.status === 410)) return null;
    throw error;
  }
}

/** One event, or null when it's been deleted. */
export async function davGetEvent(calendarId: string, eventId: string, signal?: AbortSignal): Promise<CalendarEvent | null> {
  const { config, collection } = await target(calendarId);
  const file = await readFile(collection, config, eventId, signal);
  if (!file) return null;
  const event = singleEvent(eventId, file.calendar, webLink(collection));
  return event && !event.cancelled ? event : null;
}

/** Moves an event to a new start and end. */
export async function davMoveEvent(calendarId: string, eventId: string, { start, end }: { start: Date; end: Date; timeZone: string }): Promise<CalendarEvent> {
  const { config, collection } = await target(calendarId);
  const file = await readFile(collection, config, eventId);
  const master = file && masterOf(file.calendar);
  if (!file || !master) throw new GoogleError("unavailable", "The calendar server couldn't find that event.", undefined, 404);
  for (const name of ["dtstart", "dtend", "duration"]) master.removeAllProperties(name);
  master.addPropertyWithValue("dtstart", ICAL.Time.fromJSDate(start, true));
  master.addPropertyWithValue("dtend", ICAL.Time.fromJSDate(end, true));
  master.updatePropertyWithValue("dtstamp", ICAL.Time.fromJSDate(new Date(), true));
  const sequence = Number(master.getFirstPropertyValue("sequence") ?? 0);
  master.updatePropertyWithValue("sequence", sequence + 1);
  await dav(config, fileUrl(collection, eventId), {
    method: "PUT",
    body: file.calendar.toString(),
    headers: { "content-type": "text/calendar; charset=utf-8", ...(file.etag ? { "if-match": file.etag } : {}) },
  });
  return { ...singleEvent(eventId, file.calendar, webLink(collection))!, start, end };
}

/** Deletes an event; one that's already gone is fine. */
export async function davDeleteEvent(calendarId: string, eventId: string): Promise<void> {
  const { config, collection } = await target(calendarId);
  try {
    await dav(config, fileUrl(collection, eventId), { method: "DELETE" });
  } catch (error) {
    if (!(error instanceof GoogleError && (error.status === 404 || error.status === 410))) throw error;
  }
}

/** Checks that the calendar collection answers with the password, before it's saved. */
export async function testCalendar(config: ImapConfig): Promise<void> {
  if (!config.caldavUrl) return;
  const response = await dav(config, config.caldavUrl, {
    method: "PROPFIND",
    body: `<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>`,
    headers: { depth: "0", "content-type": "application/xml; charset=utf-8" },
  });
  if (!/calendar/i.test(await response.text())) throw new GoogleError("rejected", "That CalDAV address isn't a calendar. Check it, or leave it empty for mail only.");
}
