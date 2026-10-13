// The monthly report to each restaurant's owner.
//
// What it reports is what this system records, counted by the database for exactly the
// month in question on the restaurant's own clock. What this system does not record is
// named as not available, with the reason: the website keeps no visitor statistics (it has
// no analytics and sets no cookies), and orders and payments never pass through it (they
// are Clover's). No figure in a report is estimated.
//
// A month is sent once. The database keeps one row per restaurant and month
// (monthly_reports); a call takes the row before it sends and marks it when it has, so the
// scheduler can call every day, twice at once, or again after a failure, and the owner
// still gets one report. A month that could not be sent is tried again at the next call.
import { errorFields } from "../log.ts";
import type { Deps, EmailMessage } from "../types.ts";

interface ReportRestaurant {
  restaurant_id: string;
  name: string;
  slug: string;
  timezone: string;
  to_email: string | null;
}

export interface ReportPeriod {
  period: string; // "2026-09-01"
  label: string; // "September 2026"
  from: string;
  to: string;
  previousFrom: string;
  timeZone: string;
}

// The wall-clock reading of an instant in a zone, as the instant UTC would show it.
function wallClock(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(read("year"), read("month") - 1, read("day"), read("hour"), read("minute"), read("second"));
}

// The instant at which a month begins (midnight on its first day) on a zone's clock.
function monthStart(year: number, month: number, timeZone: string): number {
  const asUtc = Date.UTC(year, month, 1);
  // The zone's offset is taken at the instant itself: once to get close, once to be right.
  const near = asUtc - (wallClock(asUtc, timeZone) - asUtc);
  return asUtc - (wallClock(near, timeZone) - near);
}

// The month a report is owed for at `now`: the one before the current month, on the
// restaurant's own clock. A zone name the runtime does not know is treated as UTC.
export function reportPeriod(now: number, timeZone: string): ReportPeriod {
  let zone = timeZone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    zone = "UTC";
  }
  const local = new Date(wallClock(now, zone));
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth() - 1; // the month before; Date.UTC copes with -1
  const first = new Date(Date.UTC(year, month, 1));
  return {
    period: first.toISOString().slice(0, 10),
    label: new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(first),
    from: new Date(monthStart(year, month, zone)).toISOString(),
    to: new Date(monthStart(year, month + 1, zone)).toISOString(),
    previousFrom: new Date(monthStart(year, month - 1, zone)).toISOString(),
    timeZone: zone,
  };
}

type Line = [string, string];
interface Section {
  title: string;
  lines: Line[];
  note?: string;
}

const STATUS_NAMES: Record<string, string> = {
  new: "New", reviewing: "Reviewing", shortlisted: "Shortlisted", interview: "Interview", hired: "Hired", rejected: "Rejected",
};
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const plural = (number: number, one: string, many = `${one}s`) => `${number} ${number === 1 ? one : many}`;
const day = (value: unknown, timeZone: string) => (typeof value === "string"
  ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(value))
  : "never");
// "ITEM_UPDATED" -> "Item updated"
const actionName = (action: string) => action.charAt(0) + action.slice(1).toLowerCase().replace(/_/g, " ");

// deno-lint-ignore no-explicit-any
type Data = Record<string, any>;

// The report's sections, from the database's figures. Kept apart from how they are laid
// out, so that what a report says can be read (and tested) without reading HTML.
export function reportSections(data: Data, period: ReportPeriod): { sections: Section[]; attention: string[] } {
  const a = data.applications ?? {};
  const received = count(a.received);
  const before = count(a.received_previous);
  const change = received === before ? "the same as the month before" : `${before} the month before`;
  const positions = (a.by_position ?? []) as { position: string; count: number }[];
  const stages = Object.entries((a.by_status ?? {}) as Record<string, number>)
    .map(([status, number]) => `${STATUS_NAMES[status] ?? status} ${number}`).join(", ");
  const m = data.messages ?? {};
  const clover = data.clover ?? {};
  const sync = data.sync ?? {};
  const menu = data.menu ?? {};
  const activity = data.activity ?? {};
  const errors = data.errors ?? {};
  const team = data.team ?? {};
  const historyStarts = typeof sync.history_from === "string" && sync.history_from > period.from;

  const sections: Section[] = [
    {
      title: "Job applications",
      lines: [
        ["Received", `${received} (${change})`],
        ["With a CV", String(count(a.with_cv))],
        ["Positions applied for", positions.length > 0 ? positions.slice(0, 8).map((entry) => `${entry.position} ${entry.count}`).join(", ") : "None"],
        ["Where this month's applications stand", stages || "None received"],
        ["Stage changes made", String(count(a.status_changes))],
        ["Still open, from any month", String(count(a.open_now))],
        ["Messages written to applicants", `${count(m.written)} (${count(m.delivered)} confirmed delivered, ${count(m.not_delivered)} not delivered)`],
      ],
    },
    {
      title: "Clover and the menu",
      lines: [
        ["Clover connection", !clover.connected ? "Not connected" : clover.status === "active" ? `Connected${clover.merchant_name ? ` (${clover.merchant_name})` : ""}` : "Needs reconnecting"],
        ["Last successful synchronisation", day(clover.last_success_at, period.timeZone)],
        ["Synchronisations", `${count(sync.succeeded)} succeeded, ${count(sync.failed)} failed`],
        ["Dishes", `${count(menu.items)} in all, ${count(menu.on_website)} shown on the website, ${count(menu.out_of_stock)} marked out of stock`],
        ["Shown without a description / without a photo", `${count(menu.without_description)} / ${count(menu.without_photo)}`],
      ],
      note: historyStarts
        ? "Synchronisation history is kept for thirty days, so these counts may not include the first days of the month."
        : undefined,
    },
    {
      title: "Changes made in the dashboard",
      lines: [
        ["Changes recorded", `${count(activity.changes)} (${count(activity.not_completed)} did not complete)`],
        ...((activity.by_action ?? []) as { action: string; count: number }[]).slice(0, 8).map((entry): Line => [actionName(entry.action), String(entry.count)]),
        ["Errors logged by the system", String(count(errors.logged))],
      ],
    },
    {
      title: "Team",
      lines: [
        ["People with access", String(count(team.members))],
        ["Joined / removed this month", `${count(team.joined)} / ${count(team.removed)}`],
        ["Invitations waiting", String(count(team.invitations_waiting))],
      ],
    },
    {
      title: "Not measured by this website",
      lines: [
        ["Website visitors and traffic", "Not available. The website keeps no visitor statistics: it has no analytics and sets no cookies."],
        ["Online orders and sales", "Not available. Ordering and payment happen in Clover and never pass through this website. Clover's own reports have them."],
        ["Website releases and maintenance", "Not recorded by this system. Changes to the website's content made in the dashboard are counted above."],
      ],
    },
  ];

  // What the figures say needs someone's attention. Each line states a fact from above.
  const attention: string[] = [];
  if (!clover.connected) attention.push("Clover is not connected, so the menu is not being kept up to date.");
  else if (clover.status !== "active") attention.push("Clover needs reconnecting in the dashboard: the stored authorisation is no longer accepted.");
  if (count(sync.failed) > 0) attention.push(`${plural(count(sync.failed), "synchronisation")} with Clover failed this month.`);
  if (count(a.new_waiting_over_14_days) > 0) attention.push(`${plural(count(a.new_waiting_over_14_days), "application")} ${count(a.new_waiting_over_14_days) === 1 ? "has" : "have"} been waiting as New for more than two weeks.`);
  if (count(a.notifications_failed) > 0) attention.push(`${plural(count(a.notifications_failed), "new-application email")} to the restaurant could not be sent. The applications themselves are in the dashboard.`);
  if (count(m.not_delivered) > 0) attention.push(`${plural(count(m.not_delivered), "message")} to applicants did not reach them. Each is marked on its application.`);
  if (count(menu.without_description) > 0) attention.push(`${plural(count(menu.without_description), "dish", "dishes")} on the website ${count(menu.without_description) === 1 ? "has" : "have"} no description.`);
  if (count(errors.logged) > 0) attention.push(`The system logged ${plural(count(errors.logged), "error")} this month.`);
  if (count(team.invitations_waiting) > 0) attention.push(`${plural(count(team.invitations_waiting), "invitation")} to the dashboard ${count(team.invitations_waiting) === 1 ? "is" : "are"} waiting to be accepted.`);
  return { sections, attention };
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function monthlyReportEmail(
  restaurantName: string, period: ReportPeriod, data: Data, dashboardUrl: string | null,
): Pick<EmailMessage, "subject" | "text" | "html"> {
  const { sections, attention } = reportSections(data, period);
  const needs = attention.length > 0 ? attention : ["Nothing in this month's figures needs attention."];
  const text = [
    `${restaurantName.toUpperCase()}: MONTHLY REPORT`,
    `${period.label} (${period.timeZone} time)`,
    "",
    "NEEDS ATTENTION",
    ...needs.map((line) => `- ${line}`),
    ...sections.flatMap((section) => [
      "", section.title.toUpperCase(),
      ...section.lines.map(([term, value]) => `${term}: ${value}`),
      ...(section.note ? [`(${section.note})`] : []),
    ]),
    "",
    ...(dashboardUrl ? [`Dashboard: ${dashboardUrl}`] : []),
    "Every figure here is counted from the website's own records for this month. Nothing is estimated.",
  ].join("\n");

  const cell = "padding:8px 0;border-bottom:1px solid #e6dfd3;font-size:14px;line-height:1.45;vertical-align:top;";
  const html = [
    '<!doctype html><html lang="en"><body style="margin:0;padding:0;background:#f6f4f0;font-family:Arial,Helvetica,sans-serif;color:#2b211e;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f4f0;padding:24px 12px;"><tr><td align="center">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#ffffff;border:1px solid #e6dfd3;border-radius:12px;overflow:hidden;">',
    '<tr><td style="background:#18120f;padding:24px 28px;">',
    '<p style="margin:0;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#c9a063;font-weight:bold;">Monthly report</p>',
    `<p style="margin:6px 0 0;font-size:22px;color:#ffffff;font-family:Georgia,'Times New Roman',serif;">${escapeHtml(restaurantName)}</p>`,
    `<p style="margin:6px 0 0;font-size:13px;color:#d9cfc2;">${escapeHtml(period.label)} &middot; ${escapeHtml(period.timeZone)} time</p>`,
    "</td></tr>",
    '<tr><td style="padding:22px 28px 6px;">',
    '<p style="margin:0 0 8px;font-size:11px;letter-spacing:1.6px;text-transform:uppercase;color:#835f20;font-weight:bold;">Needs attention</p>',
    `<ul style="margin:0 0 6px;padding-left:18px;font-size:14px;line-height:1.55;">${needs.map((line) => `<li style="margin-bottom:4px;">${escapeHtml(line)}</li>`).join("")}</ul>`,
    "</td></tr>",
    ...sections.map((section) => [
      '<tr><td style="padding:18px 28px 0;">',
      `<p style="margin:0 0 4px;font-size:11px;letter-spacing:1.6px;text-transform:uppercase;color:#835f20;font-weight:bold;">${escapeHtml(section.title)}</p>`,
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">',
      ...section.lines.map(([term, value]) =>
        `<tr><td style="${cell}color:#6e645c;width:44%;padding-right:12px;">${escapeHtml(term)}</td><td style="${cell}font-weight:bold;">${escapeHtml(value)}</td></tr>`),
      "</table>",
      section.note ? `<p style="margin:8px 0 0;font-size:12px;line-height:1.5;color:#6e645c;">${escapeHtml(section.note)}</p>` : "",
      "</td></tr>",
    ].join("")),
    '<tr><td style="padding:22px 28px 26px;">',
    dashboardUrl ? `<a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;background:#c9a063;color:#18120f;font-size:15px;font-weight:bold;text-decoration:none;padding:12px 20px;border-radius:6px;">Open the dashboard</a>` : "",
    '<p style="margin:14px 0 0;font-size:12px;line-height:1.5;color:#6e645c;">Every figure here is counted from the website\'s own records for this month. Nothing is estimated.</p>',
    "</td></tr>",
    "</table></td></tr></table></body></html>",
  ].join("");
  return { subject: `${restaurantName}: monthly report for ${period.label}`, text, html };
}

export interface ReportTally {
  sent: number; // accepted by the email provider
  failed: number; // tried and not accepted: tried again at the next call
  skipped: number; // not owed: already sent, or being sent by another call
  not_configured: number; // cannot be sent yet: no address for the restaurant, or no email provider
}

// Sends every report that is owed and has not been sent, and says how many of each outcome
// there were. Never throws: one restaurant's failure does not stop the next one's report.
//
// A restaurant with nowhere to send its report, or a backend with no email provider, is a
// matter of configuration and not an attempt: nothing is recorded against the month, which
// is sent in full at the first call after the configuration is there.
export async function sendMonthlyReports(deps: Deps): Promise<ReportTally> {
  const tally: ReportTally = { sent: 0, failed: 0, skipped: 0, not_configured: 0 };
  const restaurants = await deps.db.rpc<ReportRestaurant[]>("monthly_report_restaurants");
  const dashboardUrl = deps.env.allowedOrigins[0] ? `${deps.env.allowedOrigins[0]}/dashboard/` : null;
  const email = deps.email;
  if (!email) {
    deps.log.error("monthly_report_email_not_configured", { restaurants: restaurants.length });
    return { ...tally, not_configured: restaurants.length };
  }

  for (const restaurant of restaurants) {
    const period = reportPeriod(deps.now(), restaurant.timezone);
    try {
      if (!restaurant.to_email) {
        tally.not_configured += 1;
        deps.log.warn("monthly_report_no_address", { restaurant: restaurant.slug, period: period.period });
        continue;
      }
      const mine = await deps.db.rpc<boolean>("monthly_report_claim", { p_restaurant: restaurant.restaurant_id, p_period: period.period });
      if (!mine) {
        tally.skipped += 1;
        continue;
      }
      const data = await deps.db.rpc<Data>("monthly_report_data", {
        p_restaurant: restaurant.restaurant_id, p_from: period.from, p_to: period.to, p_previous_from: period.previousFrom,
      });

      let providerId: string | null = null;
      let failure: string | null = null;
      try {
        const result = await email.send({ to: restaurant.to_email, ...monthlyReportEmail(restaurant.name, period, data, dashboardUrl) });
        providerId = result?.id ?? null;
      } catch (error) {
        failure = "The email service did not accept the report.";
        deps.log.error("monthly_report_send_failed", { restaurant: restaurant.slug, period: period.period, ...errorFields(error) });
      }

      await deps.db.rpc("monthly_report_finish", {
        p_restaurant: restaurant.restaurant_id, p_period: period.period, p_sent: failure === null, p_to: restaurant.to_email,
        p_provider_id: providerId, p_error: failure, p_summary: data,
      });
      // In the activity log, so that the owner can see in the dashboard that it went.
      await deps.db.rpc("audit_write", {
        p_restaurant: restaurant.restaurant_id, p_user: null, p_actor_email: null,
        p_action: failure === null ? "MONTHLY_REPORT_SENT" : "MONTHLY_REPORT_FAILED", p_entity_type: "monthly_report", p_entity_id: period.period,
        p_old: null, p_new: { period: period.period }, p_result: failure === null ? "success" : "failed", p_sync_status: null, p_request_id: null,
      }).catch((error) => deps.log.error("audit_write_failed", { action: "MONTHLY_REPORT", error_message: String(error) }));
      if (failure === null) tally.sent += 1;
      else tally.failed += 1;
      deps.log.info("monthly_report_done", { restaurant: restaurant.slug, period: period.period, sent: failure === null });
    } catch (error) {
      tally.failed += 1;
      deps.log.error("monthly_report_failed", { restaurant: restaurant.slug, period: period.period, ...errorFields(error) });
    }
  }
  return tally;
}
