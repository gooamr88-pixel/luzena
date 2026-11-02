// Rules about special offers that the home page and the dashboard both have to agree on:
// what an offer's dates mean, and how they are put into words.
//
// The owner chooses days, not moments. A first day starts at midnight at the restaurant, and
// a last day is shown until the midnight that ends it; both are stored as moments
// (timestamptz) so that the database alone decides what is live. Midnight "at the
// restaurant" is worked out in its time zone, wherever the browser happens to be.

// The parts of a moment's date and time as a clock in `timeZone` shows them.
function wallClock(instant, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant);
  const get = (type) => Number(parts.find((part) => part.type === type).value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
}

// "2026-11-08" -> the moment that day begins in `timeZone`, as an ISO string. Twice round,
// so that a day on which the clocks change still lands on its own midnight.
export function dayStart(day, timeZone) {
  const [year, month, date] = day.split("-").map(Number);
  const target = Date.UTC(year, month - 1, date);
  let instant = target;
  for (let round = 0; round < 2; round++) instant = target - (wallClock(new Date(instant), timeZone) - instant);
  return new Date(instant).toISOString();
}

// The day after "2026-11-08": "2026-11-09".
export function nextDay(day) {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
}

// A moment -> the day it falls on in `timeZone`, as "YYYY-MM-DD".
export function dayOf(moment, timeZone) {
  return new Date(wallClock(new Date(moment), timeZone)).toISOString().slice(0, 10);
}

// The last day an offer is shown: the day before the midnight it stops at.
export const lastDayOf = (endsAt, timeZone) => dayOf(new Date(Date.parse(endsAt) - 1), timeZone);

// Where an offer stands at `now`: "off" (switched off), "scheduled" (not yet), "ended", or "live".
export function offerStatus(offer, now = Date.now()) {
  if (offer.active === false) return "off";
  if (offer.starts_at && Date.parse(offer.starts_at) > now) return "scheduled";
  if (offer.ends_at && Date.parse(offer.ends_at) <= now) return "ended";
  return "live";
}

// "Valid through Sunday, Nov 8", from the moment an offer stops. A last day within the
// coming week is named by its weekday alone ("Valid through Sunday"), as a menu board would.
export function validThrough(endsAt, { locale = "en-US", timeZone, now = Date.now() } = {}) {
  if (!endsAt) return "";
  const last = new Date(Date.parse(endsAt) - 1);
  const daysAway = (Date.parse(endsAt) - now) / 86_400_000;
  const options = daysAway <= 7
    ? { weekday: "long", timeZone }
    : { weekday: "long", month: "short", day: "numeric", timeZone };
  return `Valid through ${new Intl.DateTimeFormat(locale, options).format(last)}`;
}
