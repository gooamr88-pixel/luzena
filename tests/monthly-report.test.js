// The monthly report to the owner, and the function the scheduler calls: which month a
// report is for on the restaurant's own clock, what it counts, that a month is sent once
// however often it is asked for, what happens when it cannot be sent, and who may call.
//
// Real handlers and real SQL (PGlite). The clock is the real one: every row is placed
// relative to the month that is owed today, so the tests do not depend on the date.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { monthlyReportEmail, reportPeriod, reportSections, sendMonthlyReports } from "../supabase/functions/_shared/scheduled/monthly-report.ts";
import { handleScheduled } from "../supabase/functions/_shared/scheduled/tasks.ts";
import { createHarness, ORIGIN, TEST_ENV } from "./helpers/harness.js";

const at = (iso) => Date.parse(iso);
const iso = (instant) => new Date(instant).toISOString();
const DAY = 86_400_000;

describe("the month a report is for", () => {
  it("is the month before, from midnight to midnight on the restaurant's clock", () => {
    // 1 October, eight in the morning in San Diego (which is seven hours behind UTC then).
    expect(reportPeriod(at("2026-10-01T15:00:00Z"), "America/Los_Angeles")).toEqual({
      period: "2026-09-01", label: "September 2026", timeZone: "America/Los_Angeles",
      from: "2026-09-01T07:00:00.000Z", to: "2026-10-01T07:00:00.000Z", previousFrom: "2026-08-01T07:00:00.000Z",
    });
    // The same answer on any later day of October.
    expect(reportPeriod(at("2026-10-31T23:00:00Z"), "America/Los_Angeles").period).toBe("2026-09-01");
  });

  it("changes at midnight there, not at midnight UTC", () => {
    // 06:59:59 UTC on 1 October is still 30 September in San Diego: August is what is owed.
    expect(reportPeriod(at("2026-10-01T06:59:59Z"), "America/Los_Angeles").period).toBe("2026-08-01");
    expect(reportPeriod(at("2026-10-01T07:00:00Z"), "America/Los_Angeles").period).toBe("2026-09-01");
    // The same instant is already 1 October in Tokyo and in UTC.
    expect(reportPeriod(at("2026-10-01T06:59:59Z"), "Asia/Tokyo").period).toBe("2026-09-01");
    expect(reportPeriod(at("2026-10-01T00:00:00Z"), "UTC").period).toBe("2026-09-01");
    expect(reportPeriod(at("2026-09-30T23:59:59Z"), "UTC").period).toBe("2026-08-01");
  });

  it("is as long as the month really was when the clocks changed during it", () => {
    // The clocks go back on 1 November 2026 at two in the morning: October starts and ends
    // on summer time, November ends on winter time and is an hour longer.
    const october = reportPeriod(at("2026-11-15T12:00:00Z"), "America/Los_Angeles");
    expect([october.from, october.to]).toEqual(["2026-10-01T07:00:00.000Z", "2026-11-01T07:00:00.000Z"]);
    const november = reportPeriod(at("2026-12-15T12:00:00Z"), "America/Los_Angeles");
    expect([november.from, november.to]).toEqual(["2026-11-01T07:00:00.000Z", "2026-12-01T08:00:00.000Z"]);
    expect(at(november.to) - at(november.from)).toBe(30 * DAY + 3_600_000);
    // And forward on 8 March 2026: March is an hour shorter.
    const march = reportPeriod(at("2026-04-15T12:00:00Z"), "America/Los_Angeles");
    expect([march.from, march.to]).toEqual(["2026-03-01T08:00:00.000Z", "2026-04-01T07:00:00.000Z"]);
    expect(at(march.to) - at(march.from)).toBe(31 * DAY - 3_600_000);
  });

  it("goes back over the turn of a year, and through February of a leap year", () => {
    expect(reportPeriod(at("2027-01-05T12:00:00Z"), "America/Los_Angeles")).toMatchObject({
      period: "2026-12-01", label: "December 2026", from: "2026-12-01T08:00:00.000Z", to: "2027-01-01T08:00:00.000Z", previousFrom: "2026-11-01T07:00:00.000Z",
    });
    expect(reportPeriod(at("2027-02-03T12:00:00Z"), "UTC")).toMatchObject({ period: "2027-01-01", previousFrom: "2026-12-01T00:00:00.000Z" });
    const february = reportPeriod(at("2028-03-10T12:00:00Z"), "UTC");
    expect(february).toMatchObject({ period: "2028-02-01", label: "February 2028" });
    expect(at(february.to) - at(february.from)).toBe(29 * DAY);
  });

  it("works on clocks ahead of UTC and off the hour, and takes an unknown zone as UTC", () => {
    expect(reportPeriod(at("2026-10-10T00:00:00Z"), "Asia/Kolkata")).toMatchObject({ from: "2026-08-31T18:30:00.000Z", to: "2026-09-30T18:30:00.000Z" });
    expect(reportPeriod(at("2026-10-10T00:00:00Z"), "Pacific/Kiritimati")).toMatchObject({ from: "2026-08-31T10:00:00.000Z", to: "2026-09-30T10:00:00.000Z" });
    expect(reportPeriod(at("2026-10-10T00:00:00Z"), "Mars/Olympus_Mons")).toMatchObject({ timeZone: "UTC", from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" });
    expect(reportPeriod(at("2026-10-10T00:00:00Z"), "")).toMatchObject({ timeZone: "UTC", period: "2026-09-01" });
  });
});

describe("what a report says", () => {
  const period = reportPeriod(at("2026-10-05T12:00:00Z"), "America/Los_Angeles");
  const quiet = { clover: { connected: true, status: "active", merchant_name: "Alpha POS", last_success_at: "2026-09-30T20:00:00Z" } };
  const line = (sections, title, term) => sections.find((section) => section.title === title).lines.find(([name]) => name === term)[1];

  it("names what this system does not measure as not available, with the reason, and invents no figure", () => {
    const { sections } = reportSections(quiet, period);
    const unmeasured = sections.find((section) => section.title === "Not measured by this website");
    expect(unmeasured.lines.map(([term]) => term)).toEqual(["Website visitors and traffic", "Online orders and sales", "Website releases and maintenance"]);
    expect(line(sections, "Not measured by this website", "Website visitors and traffic")).toMatch(/^Not available\. The website keeps no visitor statistics/);
    expect(line(sections, "Not measured by this website", "Online orders and sales")).toMatch(/^Not available\. Ordering and payment happen in Clover/);
    for (const [, value] of unmeasured.lines) expect(value).not.toMatch(/\d/);

    const email = monthlyReportEmail("Alpha Kitchen", period, quiet, `${ORIGIN}/dashboard/`);
    expect(email.text).toContain("Website visitors and traffic: Not available.");
    expect(email.text).toContain("Nothing is estimated.");
    expect(email.text).not.toMatch(/visitors: \d|revenue|sales: \$|orders: \d/i);
  });

  it("reports nothing as zero, and says that nothing needs attention when nothing does", () => {
    const { sections, attention } = reportSections(quiet, period);
    expect(attention).toEqual([]);
    expect(line(sections, "Job applications", "Received")).toBe("0 (the same as the month before)");
    expect(line(sections, "Job applications", "Positions applied for")).toBe("None");
    expect(line(sections, "Job applications", "Where this month's applications stand")).toBe("None received");
    expect(line(sections, "Clover and the menu", "Clover connection")).toBe("Connected (Alpha POS)");
    expect(monthlyReportEmail("Alpha Kitchen", period, quiet, null).text).toContain("NEEDS ATTENTION\n- Nothing in this month's figures needs attention.");
    // Figures that are missing altogether are zero and "never", not a crash and not a guess.
    const empty = reportSections({}, period);
    expect(line(empty.sections, "Clover and the menu", "Clover connection")).toBe("Not connected");
    expect(line(empty.sections, "Clover and the menu", "Last successful synchronisation")).toBe("never");
    expect(empty.attention).toEqual(["Clover is not connected, so the menu is not being kept up to date."]);
  });

  it("puts each thing that needs someone's attention at the top, in plain words", () => {
    const { attention } = reportSections({
      clover: { connected: true, status: "needs_reauth" }, sync: { failed: 3, history_from: "2026-09-04T00:00:00Z" },
      applications: { new_waiting_over_14_days: 1, notifications_failed: 2 }, messages: { not_delivered: 1 },
      menu: { without_description: 4 }, errors: { logged: 5 }, team: { invitations_waiting: 1 },
    }, period);
    expect(attention).toEqual([
      "Clover needs reconnecting in the dashboard: the stored authorisation is no longer accepted.",
      "3 synchronisations with Clover failed this month.",
      "1 application has been waiting as New for more than two weeks.",
      "2 new-application emails to the restaurant could not be sent. The applications themselves are in the dashboard.",
      "1 message to applicants did not reach them. Each is marked on its application.",
      "4 dishes on the website have no description.",
      "The system logged 5 errors this month.",
      "1 invitation to the dashboard is waiting to be accepted.",
    ]);
  });

  it("says when the synchronisation history does not reach back to the start of the month", () => {
    const section = (data) => reportSections(data, period).sections.find((entry) => entry.title === "Clover and the menu");
    expect(section({ ...quiet, sync: { history_from: "2026-09-03T00:00:00Z" } }).note).toMatch(/kept for thirty days/);
    expect(section({ ...quiet, sync: { history_from: "2026-08-20T00:00:00Z" } }).note).toBeUndefined();
    expect(section(quiet).note).toBeUndefined();
  });

  it("is laid out under the restaurant's name, which is text whatever it holds", () => {
    const email = monthlyReportEmail('Tom & "Jerry\'s" <Grill>', period, { ...quiet, applications: { by_position: [{ position: "<b>Chef</b>", count: 2 }] } }, `${ORIGIN}/dashboard/`);
    expect(email.subject).toBe('Tom & "Jerry\'s" <Grill>: monthly report for September 2026');
    expect(email.html).toContain("Tom &amp; &quot;Jerry&#39;s&quot; &lt;Grill&gt;");
    expect(email.html).toContain("&lt;b&gt;Chef&lt;/b&gt; 2");
    expect(email.html).not.toMatch(/<Grill>|<b>Chef/);
    expect(email.html).toContain(`<a href="${ORIGIN}/dashboard/"`);
    expect(email.html.match(/<a /g)).toHaveLength(1);
    expect(email.text).toContain(`Dashboard: ${ORIGIN}/dashboard/`);
    expect(monthlyReportEmail("Alpha", period, quiet, null).html).not.toContain("<a ");
  });
});

describe("sending the reports", () => {
  let h, alpha, beta, owner, P, B, NOW;
  const run = () => sendMonthlyReports(h.deps);
  const reports = async (restaurant) =>
    (await h.pg.query("select *, to_char(period, 'YYYY-MM-DD') as month from public.monthly_reports where restaurant_id = $1 order by period", [restaurant])).rows;
  const audits = async () => (await h.pg.query("select * from public.audit_logs where action like 'MONTHLY_REPORT%' order by id")).rows;
  const field = (text, term) => new RegExp(`^${term.replace(/[/()]/g, "\\$&")}: (.*)$`, "m").exec(text)?.[1];

  let number = 0;
  const application = async (restaurant, fullName, position, status, instant, cv = false) => {
    number += 1;
    const { rows } = await h.pg.query(
      `insert into public.job_applications (restaurant_id, full_name, email, phone, position, status, created_at, employment_type, experience_level,
         ip_hash, submission_id, availability, start_when, work_authorized, cv_path)
       values ($1, $2, $3, '+1 619 555 0000', $4, $5, $6, 'part_time', '1_2', 'iphash', gen_random_uuid(), '{weekday_days}', 'immediately', true, $7)
       returning id`,
      [restaurant, fullName, `private${number}@applicant.test`, position, status, iso(instant), cv ? `${restaurant}/cv-${number}.pdf` : null]);
    return rows[0].id;
  };
  const event = (restaurant, applicationId, kind, instant) => h.pg.query(
    "insert into public.job_application_events (application_id, restaurant_id, kind, created_at) values ($1, $2, $3, $4)", [applicationId, restaurant, kind, iso(instant)]);
  const message = (restaurant, applicationId, status, instant) => h.pg.query(
    `insert into public.job_application_messages (application_id, restaurant_id, kind, to_email, subject, body, status, created_at)
     values ($1, $2, 'reply', 'private@applicant.test', 'Private subject', 'Private words', $3, $4)`, [applicationId, restaurant, status, iso(instant)]);
  const audit = (restaurant, action, result, instant) => h.pg.query(
    "insert into public.audit_logs (restaurant_id, action, entity_type, result, created_at) values ($1, $2, 'item', $3, $4)", [restaurant, action, result, iso(instant)]);

  beforeAll(async () => {
    h = await createHarness();
    NOW = Date.now();
    alpha = await h.createRestaurant("alpha");
    beta = await h.createRestaurant("beta");
    await h.pg.query("update public.restaurants set name = 'Alpha Kitchen', recruitment_email = 'hiring@alpha.test', report_email = 'owner@alpha.test' where id = $1", [alpha]);
    // No address of its own for the report: the recruitment address is used. Its own clock.
    await h.pg.query("update public.restaurants set name = 'Beta Bistro', recruitment_email = 'hiring@beta.test', timezone = 'Pacific/Kiritimati' where id = $1", [beta]);
    owner = await h.addUser(alpha, "owner");
    await h.addUser(alpha, "manager");
    P = reportPeriod(NOW, "America/Los_Angeles");
    B = reportPeriod(NOW, "Pacific/Kiritimati");
    const [from, to, previous] = [at(P.from), at(P.to), at(P.previousFrom)];

    // Alpha's month: three applications in it (the first and the last instant of the month
    // among them), two in the month before, one after it.
    const first = await application(alpha, "Inna First", "Barista", "new", from, true);
    await application(alpha, "Inna Last", "Barista", "hired", to - 1000);
    const middle = await application(alpha, "Inna Middle", "Line Cook", "interview", from + 10 * DAY, true);
    await application(alpha, "Bea Fore", "Barista", "rejected", from - 1000);
    await application(alpha, "Prue Vious", "Line Cook", "new", previous + 5 * DAY);
    await application(alpha, "Afton Later", "Barista", "new", to);
    await event(alpha, middle, "status_changed", from + 11 * DAY);
    await event(alpha, middle, "status_changed", from + 12 * DAY);
    await event(alpha, middle, "status_changed", to + 1000);
    await event(alpha, first, "email_failed", from + 60_000);
    await message(alpha, middle, "delivered", from + 12 * DAY);
    await message(alpha, middle, "sent", from + 13 * DAY);
    await message(alpha, first, "bounced", from + 13 * DAY);
    await message(alpha, first, "failed", from + 14 * DAY);
    await message(alpha, first, "delivered", to + 1000);

    await h.connect(alpha);
    await h.pg.query("update public.clover_connections set merchant_name = 'Alpha POS', last_success_at = $2 where restaurant_id = $1", [alpha, iso(to - DAY)]);
    for (const [status, instant] of [["succeeded", from + DAY], ["succeeded", from + 2 * DAY], ["failed", from + 3 * DAY], ["succeeded", to + 1000], ["failed", from - 1000]]) {
      await h.pg.query("insert into public.sync_runs (restaurant_id, trigger, status, started_at, error_code) values ($1, 'manual', $2, $3, $4)",
        [alpha, status, iso(instant), status === "failed" ? "clover_unavailable" : null]);
    }
    const items = [
      ["ITEMSHOWN0001", { web_description: "Described", web_image_path: "a.webp" }],
      ["ITEMSHOWN0002", { web_description: "Described" }],
      ["ITEMSHOWN0003", { available: false }],
      ["ITEMWEBHID001", { web_hidden: true }],
      ["ITEMPOSHID001", { hidden: true }],
      ["ITEMARCHIVED1", { archived_at: iso(from) }],
      ["ITEMREMOVED01", { removed_from_clover_at: iso(from) }],
    ];
    for (const [id, fields] of items) {
      const item = { hidden: false, available: true, web_hidden: false, web_description: null, web_image_path: null, archived_at: null, removed_from_clover_at: null, ...fields };
      await h.pg.query(
        `insert into public.menu_items (restaurant_id, clover_id, name, hidden, available, web_hidden, web_description, web_image_path, archived_at, removed_from_clover_at)
         values ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [alpha, id, item.hidden, item.available, item.web_hidden, item.web_description, item.web_image_path, item.archived_at, item.removed_from_clover_at]);
    }
    await audit(alpha, "ITEM_UPDATED", "success", from + DAY);
    await audit(alpha, "ITEM_UPDATED", "success", from + 2 * DAY);
    await audit(alpha, "ITEM_UPDATED", "failed", from + 3 * DAY);
    await audit(alpha, "MEMBER_REMOVED", "success", from + 4 * DAY);
    await audit(alpha, "ITEM_UPDATED", "success", to + 1000);
    await h.pg.query("insert into public.integration_logs (restaurant_id, level, event, created_at) values ($1, 'error', 'sync_failed', $2), ($1, 'info', 'sync_done', $2), ($1, 'error', 'sync_failed', $3)",
      [alpha, iso(from + 3 * DAY), iso(to + 1000)]);
    await h.pg.query("update public.restaurant_users set created_at = $2 where restaurant_id = $1 and user_id = $3", [alpha, iso(from + 5 * DAY), owner.id]);

    // Beta: one application, an hour into ITS month. On Alpha's clock that instant falls
    // in another month altogether.
    await application(beta, "Zed Other", "Host", "new", at(B.from) + 3_600_000);
  });

  beforeEach(() => {
    h.sent.length = 0;
    h.logs.length = 0;
    h.state.emailFails = false;
    h.deps.now = () => NOW;
  });

  it("records a month the email provider refused as not sent, and still owed", async () => {
    h.state.emailFails = true;
    expect(await run()).toEqual({ sent: 0, failed: 2, skipped: 0, not_configured: 0 });
    expect(h.sent).toHaveLength(0);
    expect(await reports(alpha)).toMatchObject([{ month: P.period, status: "failed", error: "The email service did not accept the report.", attempts: 1, sent_at: null, provider_message_id: null }]);
    expect((await audits()).map((entry) => [entry.action, entry.result, entry.entity_id])).toEqual(
      expect.arrayContaining([["MONTHLY_REPORT_FAILED", "failed", P.period], ["MONTHLY_REPORT_FAILED", "failed", B.period]]));
    expect(h.logs.filter((line) => line.event === "monthly_report_send_failed")).toHaveLength(2);
  });

  it("sends a month that failed at the next call, to the report address, once", async () => {
    expect(await run()).toEqual({ sent: 2, failed: 0, skipped: 0, not_configured: 0 });
    expect(h.sent.map((email) => email.to).sort()).toEqual(["hiring@beta.test", "owner@alpha.test"]);
    const [report] = await reports(alpha);
    expect(report).toMatchObject({ month: P.period, status: "sent", to_email: "owner@alpha.test", error: null, attempts: 2 });
    expect(report.provider_message_id).toMatch(/^provider-message-\d+$/);
    expect(Date.parse(report.sent_at)).toBeGreaterThan(Date.now() - 60_000);
    expect((await audits()).at(-1)).toMatchObject({ action: "MONTHLY_REPORT_SENT", result: "success", entity_type: "monthly_report", actor_email: null, new_values: { period: expect.any(String) } });
  });

  it("counts exactly the restaurant's own month, from its first instant to its last", async () => {
    h.sent.length = 0;
    await h.pg.query("delete from public.monthly_reports");
    await run();
    const email = h.sent.find((entry) => entry.to === "owner@alpha.test");
    expect(email.subject).toBe(`Alpha Kitchen: monthly report for ${P.label}`);
    expect(email.text).toContain(`ALPHA KITCHEN: MONTHLY REPORT\n${P.label} (America/Los_Angeles time)`);
    expect(email.replyTo).toBeUndefined();
    expect(email.attachment).toBeUndefined();

    expect(field(email.text, "Received")).toBe("3 (2 the month before)");
    expect(field(email.text, "With a CV")).toBe("2");
    expect(field(email.text, "Positions applied for")).toBe("Barista 2, Line Cook 1");
    expect(field(email.text, "Where this month's applications stand").split(", ").sort()).toEqual(["Hired 1", "Interview 1", "New 1"]);
    expect(field(email.text, "Stage changes made")).toBe("2");
    expect(field(email.text, "Still open, from any month")).toBe("4");
    expect(field(email.text, "Messages written to applicants")).toBe("4 (1 confirmed delivered, 2 not delivered)");
    expect(field(email.text, "Clover connection")).toBe("Connected (Alpha POS)");
    expect(field(email.text, "Synchronisations")).toBe("2 succeeded, 1 failed");
    expect(field(email.text, "Dishes")).toBe("5 in all, 3 shown on the website, 1 marked out of stock");
    expect(field(email.text, "Shown without a description / without a photo")).toBe("1 / 2");
    expect(field(email.text, "Changes recorded")).toBe("4 (1 did not complete)");
    expect(field(email.text, "Item updated")).toBe("3");
    expect(field(email.text, "Errors logged by the system")).toBe("1");
    expect(field(email.text, "People with access")).toBe("2");
    expect(field(email.text, "Joined / removed this month")).toBe("1 / 1");
    expect(field(email.text, "Website visitors and traffic")).toMatch(/^Not available\./);

    for (const expected of [
      "1 synchronisation with Clover failed this month.", "2 applications have been waiting as New for more than two weeks.",
      "1 new-application email to the restaurant could not be sent.", "2 messages to applicants did not reach them.",
      "1 dish on the website has no description.", "The system logged 1 error this month.",
    ]) expect(email.text).toContain(`- ${expected}`);
    expect(email.html).toContain("Barista 2, Line Cook 1");
    expect(email.html).toContain(`<a href="${ORIGIN}/dashboard/"`);
  });

  it("names no applicant and carries no address, message or secret", async () => {
    await h.pg.query("delete from public.monthly_reports");
    await run();
    expect(h.sent).toHaveLength(2);
    for (const email of h.sent) {
      for (const part of [email.subject, email.text, email.html]) {
        expect(part).not.toMatch(/Inna|Bea Fore|Prue|Afton|Zed Other|applicant\.test|Private|619 555|iphash|cv-\d|enc-|jwt-|secret/i);
      }
    }
    // The figures a report was made from are kept with it. They are counts, as it was.
    const { summary } = (await reports(alpha))[0];
    expect(summary.applications.received).toBe(3);
    expect(JSON.stringify(summary)).not.toMatch(/Inna|applicant\.test|Private|619 555/);
  });

  it("gives each restaurant its own figures on its own clock, and nothing of another's", async () => {
    await h.pg.query("delete from public.monthly_reports");
    h.sent.length = 0;
    await run();
    const email = h.sent.find((entry) => entry.to === "hiring@beta.test");
    expect(email.subject).toBe(`Beta Bistro: monthly report for ${B.label}`);
    expect(email.text).toContain(`${B.label} (Pacific/Kiritimati time)`);
    expect(field(email.text, "Received")).toBe("1 (0 the month before)");
    expect(field(email.text, "Positions applied for")).toBe("Host 1");
    expect(field(email.text, "Clover connection")).toBe("Not connected");
    expect(field(email.text, "Dishes")).toBe("0 in all, 0 shown on the website, 0 marked out of stock");
    expect(field(email.text, "Changes recorded")).toBe("0 (0 did not complete)");
    expect(field(email.text, "People with access")).toBe("0");
    expect(email.text).not.toMatch(/Alpha|Barista|Line Cook/);
    const mine = (await reports(beta))[0];
    expect(mine).toMatchObject({ month: B.period, status: "sent", to_email: "hiring@beta.test" });
  });

  it("does not send a month twice: not at the next call, not from two calls at once", async () => {
    h.sent.length = 0;
    expect(await run()).toEqual({ sent: 0, failed: 0, skipped: 2, not_configured: 0 });
    expect(await run()).toEqual({ sent: 0, failed: 0, skipped: 2, not_configured: 0 });
    expect(h.sent).toHaveLength(0);

    await h.pg.query("delete from public.monthly_reports");
    const both = await Promise.all([run(), run(), run()]);
    expect(both.reduce((sum, tally) => sum + tally.sent, 0)).toBe(2);
    expect(h.sent.map((email) => email.to).sort()).toEqual(["hiring@beta.test", "owner@alpha.test"]);
    expect(await reports(alpha)).toHaveLength(1);
  });

  it("leaves a month that another call is sending alone, and takes it over if that call never finished", async () => {
    await h.pg.query("delete from public.monthly_reports");
    h.sent.length = 0;
    const claim = () => h.db.rpc("monthly_report_claim", { p_restaurant: alpha, p_period: P.period });
    expect(await claim()).toBe(true);
    expect(await claim()).toBe(false);
    expect((await run()).skipped).toBe(1);
    expect(h.sent.map((email) => email.to)).toEqual(["hiring@beta.test"]);
    // Sixteen minutes later, the call that took it has plainly died.
    await h.pg.query("update public.monthly_reports set claimed_at = now() - interval '16 minutes' where restaurant_id = $1", [alpha]);
    expect(await run()).toEqual({ sent: 1, failed: 0, skipped: 1, not_configured: 0 });
    expect(h.sent.map((email) => email.to)).toEqual(["hiring@beta.test", "owner@alpha.test"]);
    // A month that has gone cannot be taken again, however long ago.
    await h.pg.query("update public.monthly_reports set claimed_at = now() - interval '40 days'");
    expect(await claim()).toBe(false);
    await h.db.rpc("monthly_report_finish", { p_restaurant: alpha, p_period: P.period, p_sent: false, p_to: null, p_provider_id: null, p_error: "late", p_summary: null });
    expect((await reports(alpha))[0]).toMatchObject({ status: "sent", to_email: "owner@alpha.test", error: null });
  });

  it("sends the next month's report when that month has ended, and only that one", async () => {
    h.sent.length = 0;
    const later = at(P.to) + 32 * DAY;
    h.deps.now = () => later;
    const next = reportPeriod(later, "America/Los_Angeles");
    expect(next.period).not.toBe(P.period);
    expect(next.from).toBe(P.to);
    await run();
    const email = h.sent.find((entry) => entry.to === "owner@alpha.test");
    expect(email.subject).toBe(`Alpha Kitchen: monthly report for ${next.label}`);
    // The application that came in the instant the first month ended belongs to this one.
    expect(field(email.text, "Received")).toBe("1 (3 the month before)");
    expect((await reports(alpha)).map((report) => [report.month, report.status])).toEqual([[P.period, "sent"], [next.period, "sent"]]);
    h.sent.length = 0;
    expect((await run()).sent).toBe(0);
    expect(h.sent).toHaveLength(0);
  });

  it("waits, without recording a failure, for a restaurant that has nowhere to send its report", async () => {
    await h.pg.query("delete from public.monthly_reports");
    await h.pg.query("delete from public.audit_logs where action like 'MONTHLY_REPORT%'");
    await h.pg.query("update public.restaurants set recruitment_email = '  ', report_email = null where id = $1", [beta]);
    expect(await run()).toEqual({ sent: 1, failed: 0, skipped: 0, not_configured: 1 });
    expect(await reports(beta)).toEqual([]);
    expect((await audits()).map((entry) => entry.restaurant_id)).toEqual([alpha]);
    expect(h.logs.some((line) => line.event === "monthly_report_no_address" && line.restaurant === "beta")).toBe(true);
    // The address is given later: the month that was owed all along goes then.
    await h.pg.query("update public.restaurants set report_email = 'owner@beta.test' where id = $1", [beta]);
    h.sent.length = 0;
    expect(await run()).toEqual({ sent: 1, failed: 0, skipped: 1, not_configured: 0 });
    expect(h.sent.map((email) => email.to)).toEqual(["owner@beta.test"]);
  });

  it("waits in the same way while no email provider is set up", async () => {
    await h.pg.query("delete from public.monthly_reports");
    const email = h.deps.email;
    h.deps.email = null;
    try {
      expect(await run()).toEqual({ sent: 0, failed: 0, skipped: 0, not_configured: 2 });
      expect(await reports(alpha)).toEqual([]);
      expect(h.logs.some((line) => line.event === "monthly_report_email_not_configured" && line.level === "error")).toBe(true);
    } finally {
      h.deps.email = email;
    }
  });

  it("is listed for the restaurant it was made for, with when it went and to whom", async () => {
    await run();
    const listed = await h.db.rpc("monthly_reports_list", { p_restaurant: alpha });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ period: P.period, status: "sent", to_email: "owner@alpha.test", error: null });
    expect(await h.db.rpc("monthly_reports_list", { p_restaurant: "00000000-0000-4000-8000-00000000dead" })).toEqual([]);
  });

  it("keeps its tables and functions closed to the browser's own database roles", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const privilege of ["select", "insert", "update", "delete"]) {
        const { rows } = await h.pg.query("select has_table_privilege($1, 'public.monthly_reports', $2) as allowed", [role, privilege]);
        expect(rows[0].allowed, `${role} ${privilege}`).toBe(false);
      }
      const { rows } = await h.pg.query(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname like 'monthly_report%' and has_function_privilege($1, p.oid, 'execute')`, [role]);
      expect(rows).toEqual([]);
    }
    const { rows } = await h.pg.query("select relrowsecurity from pg_class where oid = 'public.monthly_reports'::regclass");
    expect(rows[0].relrowsecurity).toBe(true);
  });

  describe("the function the scheduler calls", () => {
    const SECRET = TEST_ENV.CRON_SECRET;
    const call = async (headers = {}, method = "POST", deps = h.deps) => {
      const response = await handleScheduled(new Request("https://fn.test/functions/v1/scheduled-tasks", { method, headers }), deps);
      return { status: response.status, body: await response.json() };
    };

    it("does nothing for a caller without the secret", async () => {
      await h.pg.query("delete from public.monthly_reports");
      h.sent.length = 0;
      for (const headers of [
        {}, { "x-cron-secret": "" }, { "x-cron-secret": "wrong" }, { "x-cron-secret": `${SECRET}x` }, { "x-cron-secret": SECRET.slice(0, -1) },
        { authorization: `Bearer ${SECRET}` }, { "x-cron-secret": SECRET.toUpperCase() }, { authorization: `Bearer ${owner.token}` },
      ]) {
        const response = await call(headers);
        expect(response.status, JSON.stringify(headers).slice(0, 40)).toBe(401);
        expect(response.body.error).toMatchObject({ code: "unauthenticated" });
      }
      expect((await call({ "x-cron-secret": SECRET }, "GET")).status).toBe(405);
      expect(h.sent).toHaveLength(0);
      expect(await reports(alpha)).toEqual([]);
    });

    it("refuses every call until a secret of a proper length has been set", async () => {
      for (const cronSecret of [null, ""]) {
        const response = await call({ "x-cron-secret": cronSecret ?? "" }, "POST", { ...h.deps, env: { ...h.deps.env, cronSecret } });
        expect(response.status).toBe(503);
      }
      expect(h.sent).toHaveLength(0);
      // A secret that is too short to be one is not taken from the environment at all.
      const { loadEnv } = await import("../supabase/functions/_shared/env.ts");
      expect(loadEnv((name) => ({ ...TEST_ENV, CRON_SECRET: "short-secret" })[name]).cronSecret).toBeNull();
      expect(loadEnv((name) => ({ ...TEST_ENV, CRON_SECRET: undefined })[name]).cronSecret).toBeNull();
      expect(loadEnv((name) => TEST_ENV[name]).cronSecret).toBe(SECRET);
    });

    it("runs the day's work for the scheduler, answers with counts alone, and can be called again safely", async () => {
      const first = await call({ "x-cron-secret": SECRET });
      expect(first.status).toBe(200);
      expect(first.body).toEqual({
        ok: true, applications_purged: 0, housekeeping: true, category_photos_purged: 0,
        reports: { sent: 2, failed: 0, skipped: 0, not_configured: 0 },
      });
      expect(h.sent).toHaveLength(2);
      expect(JSON.stringify(first.body)).not.toMatch(/alpha|beta|@|Kitchen/i);

      const second = await call({ "x-cron-secret": SECRET });
      expect(second.body.reports).toEqual({ sent: 0, failed: 0, skipped: 2, not_configured: 0 });
      expect(h.sent).toHaveLength(2);
      // The secret is in no log line and in no answer.
      expect(JSON.stringify(h.logs)).not.toContain(SECRET);
      expect(JSON.stringify([first.body, second.body])).not.toContain(SECRET);
    });

    it("still does the rest of the day's work when the reports cannot be made", async () => {
      const broken = { ...h.deps, db: { rpc: (name, args) => (name === "monthly_report_restaurants" ? Promise.reject(new Error("database down")) : h.db.rpc(name, args)) } };
      const response = await call({ "x-cron-secret": SECRET }, "POST", broken);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ ok: true, housekeeping: true, reports: { sent: 0, failed: 1, skipped: 0, not_configured: 0 } });
      expect(h.logs.some((line) => line.event === "monthly_reports_failed" && line.level === "error")).toBe(true);
    });
  });
});
