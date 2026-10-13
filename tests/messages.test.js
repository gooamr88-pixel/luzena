// Writing to an applicant from the dashboard, on the real handlers and real SQL (PGlite):
// who may write, where a message can go, what is put into the email, what is recorded, and
// what the dashboard says became of it.
//
// Requests are sent straight to the API, with ids and bodies no dashboard would send. The
// email provider is a stand-in that accepts a message, gives it an id, and answers for that
// id only what a test tells it to: "delivered" is never assumed.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applicantEmail, MESSAGE_KINDS, statusEmail, statusEmails } from "../supabase/functions/_shared/dashboard/messages.ts";
import { purgeExpiredApplications } from "../supabase/functions/_shared/public/retention.ts";
import { createHarness, ORIGIN } from "./helpers/harness.js";

let h, alpha, beta, owner, manager, staff, betaOwner, outsider;
const ids = {};
const NOBODY = "00000000-0000-4000-8000-00000000dead";

const add = async (restaurant, fullName, position = "Barista", daysAgo = 0) => {
  const { rows } = await h.pg.query(
    `insert into public.job_applications (restaurant_id, full_name, email, phone, position, status, created_at,
       employment_type, experience_level, ip_hash, submission_id, availability, start_when, work_authorized)
     values ($1, $2, $3, '+1 619 555 0000', $4, 'new', now() - make_interval(days => $5), 'part_time', '1_2', 'iphash', gen_random_uuid(),
       '{weekday_days}', 'immediately', true)
     returning id`,
    [restaurant, fullName, `${fullName.toLowerCase().replace(/[^a-z]+/g, ".")}@example.test`, position, daysAgo]);
  ids[fullName] = rows[0].id;
  return rows[0].id;
};
const write = (user, id, body = {}, headers) =>
  h.api(user, "POST", `/applications/${id}/messages`, { kind: "reply", subject: "Your application", body: "Dear Ana,\n\nThank you.", ...body }, headers);
const retry = (user, id, messageId) => h.api(user, "POST", `/applications/${id}/messages/${messageId}/retry`);
const read = async (user, id) => (await h.api(user, "GET", `/applications/${id}`)).body.application;
const rows = async (applicationId) =>
  (await h.pg.query("select * from public.job_application_messages where application_id = $1 order by created_at, id", [applicationId])).rows;
const audits = async () =>
  (await h.pg.query("select * from public.audit_logs where action = 'APPLICATION_MESSAGE_SENT' order by id")).rows;

beforeAll(async () => {
  h = await createHarness();
  alpha = await h.createRestaurant("alpha");
  beta = await h.createRestaurant("beta");
  await h.pg.query("update public.restaurants set name = 'Alpha Kitchen', recruitment_email = 'hiring@alpha.test' where id = $1", [alpha]);
  await h.pg.query("update public.restaurants set name = 'Beta Bistro', recruitment_email = 'hiring@beta.test' where id = $1", [beta]);
  owner = await h.addUser(alpha, "owner");
  manager = await h.addUser(alpha, "manager");
  staff = await h.addUser(alpha, "staff");
  betaOwner = await h.addUser(beta, "owner");
  outsider = await h.addUser(null);
  await add(alpha, "Ana Reyes");
  await add(alpha, "Ben Carter", "Line Cook");
  await add(beta, "Zed Other");
});

beforeEach(async () => {
  await h.pg.query("delete from public.rate_limits");
  h.sent.length = 0;
  h.asked.length = 0;
  h.logs.length = 0;
  Object.assign(h.state, { emailFails: false, statusFails: false });
});

describe("a message to an applicant", () => {
  let message;

  it("is emailed to the applicant under the restaurant's name, with answers going to the restaurant", async () => {
    const response = await write(owner, ids["Ana Reyes"], {
      kind: "interview", subject: "Interview for the Barista position",
      body: "Dear Ana,\n\nWe would like to invite you to an interview.\nDate and time: Thursday at 3 PM\n\nKind regards,\nAlpha Kitchen",
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ result: "sent", notice: "Your message has been sent to ana.reyes@example.test." });
    message = response.body.message;
    expect(message).toMatchObject({
      kind: "interview", to_email: "ana.reyes@example.test", subject: "Interview for the Barista position", status: "sent",
      status_detail: null, attempts: 1, sent_by_email: owner.email, delivered_at: null,
    });
    expect(Date.parse(message.sent_at)).toBeGreaterThan(Date.now() - 60_000);

    expect(h.sent).toHaveLength(1);
    const email = h.sent[0];
    expect(email.to).toBe("ana.reyes@example.test");
    expect(email.replyTo).toBe("hiring@alpha.test");
    expect(email.subject).toBe("Interview for the Barista position");
    expect(email.attachment).toBeUndefined();
    // What was written, as written; then the restaurant, its website and how to answer.
    expect(email.text).toBe([
      "Dear Ana,", "We would like to invite you to an interview.\nDate and time: Thursday at 3 PM", "Kind regards,\nAlpha Kitchen",
      `-- \nAlpha Kitchen\n${ORIGIN}/\nYou can answer by replying to this email.`,
    ].join("\n\n"));
    expect(email.html).toContain("Alpha Kitchen");
    expect(email.html).toContain("We would like to invite you to an interview.<br>Date and time: Thursday at 3 PM");
    expect(email.html).toContain(`<a href="${ORIGIN}/"`);
    // Nothing of the dashboard, no other applicant and no link the writer did not see.
    expect(email.html).not.toMatch(/dashboard|token|Ben Carter/i);
    expect(email.html.match(/<a /g)).toHaveLength(1);
  });

  it("is kept on the application with who wrote it, and is in its history", async () => {
    const application = await read(owner, ids["Ana Reyes"]);
    expect(application.messages).toHaveLength(1);
    expect(application.messages[0]).toMatchObject({
      id: message.id, kind: "interview", to_email: "ana.reyes@example.test", status: "sent", sent_by_email: owner.email,
      body: "Dear Ana,\n\nWe would like to invite you to an interview.\nDate and time: Thursday at 3 PM\n\nKind regards,\nAlpha Kitchen",
    });
    expect(application.events.at(-1)).toMatchObject({ kind: "message_sent", note: "Interview for the Barista position", actor_email: owner.email });

    const [row] = await rows(ids["Ana Reyes"]);
    expect(row).toMatchObject({ restaurant_id: alpha, status: "sent", provider_message_id: "provider-message-1", sent_by: owner.id });
    // The provider's own id for the message is the backend's business, not the browser's.
    expect(JSON.stringify(application)).not.toContain("provider-message-1");
  });

  it("is recorded in the activity log without the applicant, the subject or the words", async () => {
    const [entry] = await audits();
    expect(entry).toMatchObject({
      restaurant_id: alpha, actor_email: owner.email, entity_type: "application", entity_id: ids["Ana Reyes"], result: "success",
      new_values: { kind: "interview", status: "sent" },
    });
    expect(JSON.stringify(entry)).not.toMatch(/ana\.reyes|Ana|Interview for|Thursday/);
    expect(JSON.stringify(h.logs)).not.toMatch(/ana\.reyes|Thursday/);
  });

  it("can be written by a manager too, in each of the kinds the dashboard offers", async () => {
    for (const kind of MESSAGE_KINDS) {
      const response = await write(manager, ids["Ben Carter"], { kind, subject: `About ${kind}` });
      expect(response.status, kind).toBe(200);
      expect(response.body.message).toMatchObject({ kind, status: "sent", sent_by_email: manager.email, to_email: "ben.carter@example.test" });
    }
    expect(h.sent.map((email) => email.to)).toEqual(Array(MESSAGE_KINDS.length).fill("ben.carter@example.test"));
    expect((await read(manager, ids["Ben Carter"])).messages.map((entry) => entry.kind)).toEqual([...MESSAGE_KINDS]);
  });
});

describe("who may write, and to whom", () => {
  const counts = async () => Number((await h.pg.query("select count(*) as n from public.job_application_messages")).rows[0].n);

  it("refuses anyone who is not an owner or a manager of the restaurant, and sends nothing", async () => {
    const before = await counts();
    expect((await write(null, ids["Ana Reyes"])).status).toBe(401);
    expect((await write({ token: "jwt-forged" }, ids["Ana Reyes"])).status).toBe(401);
    expect((await write(staff, ids["Ana Reyes"])).status).toBe(403);
    expect((await write(outsider, ids["Ana Reyes"])).status).toBe(403);
    expect(h.sent).toHaveLength(0);
    expect(await counts()).toBe(before);
  });

  it("answers as if another restaurant's application did not exist", async () => {
    const before = await counts();
    const theirs = await write(owner, ids["Zed Other"]);
    expect(theirs.status).toBe(404);
    expect(theirs.body.error).toMatchObject({ code: "not_found" });
    expect(JSON.stringify(theirs.body)).not.toMatch(/zed|Beta/i);
    expect((await write(owner, NOBODY)).status).toBe(404);
    // Naming the other restaurant does not help: the account is not a member of it.
    expect((await write(owner, ids["Zed Other"], {}, { "x-restaurant-id": beta })).status).toBe(403);
    expect(h.sent).toHaveLength(0);
    expect(await counts()).toBe(before);
    expect((await read(betaOwner, ids["Zed Other"])).messages).toEqual([]);
  });

  it("does not let a request choose the recipient, the sender or where answers go", async () => {
    for (const extra of [
      { to: "thief@evil.test" }, { to_email: "thief@evil.test" }, { email: "thief@evil.test" }, { cc: "thief@evil.test" }, { bcc: "thief@evil.test" },
      { from: "Boss <boss@evil.test>" }, { replyTo: "thief@evil.test" }, { reply_to: "thief@evil.test" }, { application_id: ids["Zed Other"] },
      { restaurant_id: beta }, { html: "<b>mine</b>" }, { attachment: { filename: "x.pdf", content: "AAAA" } },
    ]) {
      const response = await write(owner, ids["Ana Reyes"], extra);
      expect(response.status, JSON.stringify(extra)).toBe(422);
      expect(response.body.error.fields).toEqual({ [Object.keys(extra)[0]]: "is not a recognised field" });
    }
    expect(h.sent).toHaveLength(0);
  });

  it("cannot be used to try again a message of another restaurant, or one of another application", async () => {
    h.state.emailFails = true;
    const failed = (await write(betaOwner, ids["Zed Other"])).body.message;
    expect(failed.status).toBe("failed");
    h.state.emailFails = false;

    expect((await retry(owner, ids["Zed Other"], failed.id)).status).toBe(409);
    expect((await retry(owner, ids["Ana Reyes"], failed.id)).status).toBe(409);
    expect((await retry(staff, ids["Ana Reyes"], failed.id)).status).toBe(403);
    expect((await retry(null, ids["Zed Other"], failed.id)).status).toBe(401);
    expect(h.sent).toHaveLength(0);
    expect((await rows(ids["Zed Other"]))[0].status).toBe("failed");
  });

  it("is limited to sixty messages an hour for each person", async () => {
    await h.pg.query("delete from public.idempotency_keys");
    const id = await add(alpha, "Many Messages");
    for (let number = 1; number <= 60; number += 1) expect((await write(owner, id, { subject: `Message ${number}` })).status).toBe(200);
    const refused = await write(owner, id, { subject: "One too many" });
    expect(refused.status).toBe(429);
    expect(h.sent).toHaveLength(60);
    expect(await rows(id)).toHaveLength(60);
  });
});

describe("what goes into the email", () => {
  it("is text: nothing typed becomes markup, a link or a script", async () => {
    const body = 'Hello <b>Ana</b> & co.\n\n<script>alert("x")</script>\n<a href="https://evil.test/">Click</a> <img src=x onerror=alert(1)> \'quoted\'';
    const response = await write(owner, ids["Ana Reyes"], { subject: 'A <i>subject</i> & "more"', body });
    expect(response.status).toBe(200);
    const email = h.sent[0];
    expect(email.text).toContain(body.split("\n\n")[0]);
    expect(email.html).toContain("Hello &lt;b&gt;Ana&lt;/b&gt; &amp; co.");
    expect(email.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(email.html).toContain("&lt;a href=&quot;https://evil.test/&quot;&gt;Click&lt;/a&gt;");
    expect(email.html).toContain("&#39;quoted&#39;");
    expect(email.html).not.toMatch(/<script|<img|<b>|evil\.test\/"|onerror=alert\(1\)>/);
    // The one link in the email is the restaurant's own website.
    expect(email.html.match(/<a /g)).toHaveLength(1);
    expect(email.subject).toBe('A <i>subject</i> & "more"');
  });

  it("keeps a subject to one line, so that nothing typed can add a header", async () => {
    const response = await write(owner, ids["Ana Reyes"], { subject: "Hello\r\nBcc: thief@evil.test\nX-Injected: 1\tend" });
    expect(response.status).toBe(200);
    expect(h.sent[0].subject).toBe("Hello Bcc: thief@evil.test X-Injected: 1 end");
    expect(h.sent[0].subject).not.toMatch(/[\r\n\t]/);
    expect(h.sent[0].to).toBe("ana.reyes@example.test");
    expect(Object.keys(h.sent[0]).sort()).toEqual(["html", "replyTo", "subject", "text", "to"]);
    expect(response.body.message.subject).toBe("Hello Bcc: thief@evil.test X-Injected: 1 end");
  });

  it("takes the restaurant's name and website from the server, escaped, whatever they hold", () => {
    const email = applicantEmail('Tom & "Jerry\'s" <Grill>', "https://example.test/?a=1&b=<2>", { subject: " One\nline ", body: "First\r\n\r\n\r\nSecond\r\nline" });
    expect(email.subject).toBe("One line");
    expect(email.text).toBe('First\n\nSecond\nline\n\n-- \nTom & "Jerry\'s" <Grill>\nhttps://example.test/?a=1&b=<2>\nYou can answer by replying to this email.');
    expect(email.html).toContain("Tom &amp; &quot;Jerry&#39;s&quot; &lt;Grill&gt;");
    expect(email.html).toContain('href="https://example.test/?a=1&amp;b=&lt;2&gt;"');
    expect(email.html).not.toContain("<Grill>");
    // Without a website there is no link at all.
    expect(applicantEmail("Alpha", null, { subject: "s", body: "b" }).html).not.toContain("<a ");
  });

  it("refuses a message with no subject, no words, too many of them, or a kind it does not know", async () => {
    const cases = [
      [{ subject: "" }, { subject: "is required" }],
      [{ subject: "  \n " }, { subject: "is required" }],
      [{ subject: "s".repeat(151) }, { subject: "must be at most 150 characters" }],
      [{ body: "   " }, { body: "is required" }],
      [{ body: "b".repeat(5001) }, { body: "must be at most 5000 characters" }],
      [{ body: "bell\u{7}" }, { body: "contains characters that are not allowed" }],
      [{ kind: "newsletter" }, { kind: `must be one of: ${MESSAGE_KINDS.join(", ")}` }],
      [{ subject: 7 }, { subject: "must be text" }],
    ];
    for (const [change, fields] of cases) {
      const response = await write(owner, ids["Ana Reyes"], change);
      expect(response.status, JSON.stringify(change).slice(0, 60)).toBe(422);
      expect(response.body.error.fields).toEqual(fields);
    }
    expect((await h.api(owner, "POST", `/applications/${ids["Ana Reyes"]}/messages`, ["not", "an", "object"])).status).toBe(422);
    expect(h.sent).toHaveLength(0);
    // The longest message that is allowed goes.
    expect((await write(owner, ids["Ana Reyes"], { subject: "s".repeat(150), body: "b".repeat(5000) })).status).toBe(200);
  });
});

describe("a message that is sent once", () => {
  it("is not sent again when the same request arrives twice", async () => {
    const id = await add(alpha, "Twice Pressed");
    const headers = { "idempotency-key": "message-key-000001" };
    const first = await write(owner, id, { subject: "Only once" }, headers);
    const second = await write(owner, id, { subject: "Only once" }, headers);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.message.id).toBe(first.body.message.id);
    expect(h.sent).toHaveLength(1);
    expect(await rows(id)).toHaveLength(1);
    // The same key with other words is refused, not sent as a second message.
    expect((await write(owner, id, { subject: "Something else" }, headers)).status).toBe(422);
    expect(h.sent).toHaveLength(1);
  });

  it("needs a key, so that a request cannot be repeated by accident", async () => {
    const response = await write(owner, ids["Ana Reyes"], {}, { "idempotency-key": "" });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("idempotency_key_required");
    expect(h.sent).toHaveLength(0);
  });

  it("cannot be tried again once it has gone", async () => {
    const id = await add(alpha, "Gone Already");
    const sent = (await write(owner, id)).body.message;
    const again = await retry(owner, id, sent.id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("not_retryable");
    expect((await retry(owner, id, NOBODY)).status).toBe(409);
    expect(h.sent).toHaveLength(1);
  });
});

describe("a message that could not be sent", () => {
  let id, failed;

  it("is kept, says plainly that nothing reached the applicant, and is in the history as not sent", async () => {
    id = await add(alpha, "Fay Failed");
    h.state.emailFails = true;
    const response = await write(manager, id, { subject: "About your application" });
    expect(response.status).toBe(200);
    expect(response.body.result).toBe("failed");
    expect(response.body.notice).toBe("Your message was saved but could not be sent. Nothing reached the applicant. Try again from the list below.");
    failed = response.body.message;
    expect(failed).toMatchObject({ status: "failed", status_detail: "The email service did not accept the message.", attempts: 1, sent_at: null, delivered_at: null });
    expect(h.sent).toHaveLength(0);

    const application = await read(manager, id);
    expect(application.messages).toHaveLength(1);
    expect(application.events.at(-1)).toMatchObject({ kind: "message_failed", note: "About your application", actor_email: manager.email });
    expect((await audits()).at(-1)).toMatchObject({ entity_id: id, result: "failed", new_values: { kind: "reply", status: "failed" } });
    // The provider's own words are in the server log, for whoever looks into it. The
    // applicant's address and the message are not.
    const logged = h.logs.find((line) => line.event === "applicant_message_failed");
    expect(logged).toMatchObject({ level: "error", message_id: failed.id });
    expect(JSON.stringify(h.logs)).not.toMatch(/fay\.failed|About your application/);
  });

  it("is not asked about at the provider, which never had it", async () => {
    await read(manager, id);
    expect(h.asked).toEqual([]);
  });

  it("can be tried again, which sends the same words to the same applicant once", async () => {
    const response = await retry(owner, id, failed.id);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ result: "sent", notice: "Your message has been sent to fay.failed@example.test." });
    expect(response.body.message).toMatchObject({ id: failed.id, status: "sent", status_detail: null, attempts: 2, sent_by_email: manager.email });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ to: "fay.failed@example.test", subject: "About your application", replyTo: "hiring@alpha.test" });
    expect(await rows(id)).toHaveLength(1);
    expect((await audits()).at(-1)).toMatchObject({ entity_id: id, result: "success", actor_email: owner.email, new_values: { kind: "reply", status: "sent", retry: true } });

    expect((await retry(owner, id, failed.id)).status).toBe(409);
    expect(h.sent).toHaveLength(1);
  });

  it("stays failed when trying again fails too, and can be tried once more", async () => {
    const other = await add(alpha, "Fay Again");
    h.state.emailFails = true;
    const first = (await write(owner, other)).body.message;
    const second = await retry(owner, other, first.id);
    expect(second.body).toMatchObject({ result: "failed", message: { id: first.id, status: "failed", attempts: 2 } });
    h.state.emailFails = false;
    expect((await retry(owner, other, first.id)).body.message).toMatchObject({ status: "sent", attempts: 3 });
    expect(h.sent).toHaveLength(1);
  });

  it("says so, and sends nothing, while email is not set up", async () => {
    const other = await add(alpha, "No Email Yet");
    const email = h.deps.email;
    h.deps.email = null;
    try {
      const response = await write(owner, other);
      expect(response.status).toBe(200);
      expect(response.body.message).toMatchObject({ status: "failed", status_detail: "Email is not set up for this website yet." });
      expect((await read(owner, other)).messages).toHaveLength(1);
    } finally {
      h.deps.email = email;
    }
  });
});

describe("what became of a message", () => {
  let id, message, providerId;
  const fresh = () => h.pg.query("update public.job_application_messages set status_checked_at = null where application_id = $1", [id]);

  it("is 'sent', and no more than that, until the provider itself reports", async () => {
    id = await add(alpha, "Dee Livered");
    message = (await write(owner, id)).body.message;
    providerId = (await rows(id))[0].provider_message_id;
    expect(message).toMatchObject({ status: "sent", delivered_at: null });

    const application = await read(owner, id);
    expect(h.asked).toEqual([providerId]);
    expect(application.messages[0]).toMatchObject({ status: "sent", delivered_at: null });
    // The provider is not asked again within the minute.
    await read(owner, id);
    expect(h.asked).toEqual([providerId]);
  });

  it("becomes 'delivered' when the provider reports that the recipient's mail server took it", async () => {
    await fresh();
    h.deliveries.set(providerId, { status: "delivered", detail: null });
    const application = await read(manager, id);
    expect(application.messages[0]).toMatchObject({ id: message.id, status: "delivered", status_detail: null });
    expect(Date.parse(application.messages[0].delivered_at)).toBeGreaterThan(Date.now() - 60_000);
    // A message that has been answered for is not asked about again, and does not change.
    h.deliveries.set(providerId, { status: "bounced", detail: "later" });
    await fresh();
    expect((await read(owner, id)).messages[0].status).toBe("delivered");
    expect(h.asked).toEqual([providerId]);
    expect((await retry(owner, id, message.id)).status).toBe(409);
  });

  it("says when the recipient's mail server refused it, with the reason", async () => {
    const other = await add(alpha, "Bo Bounced");
    await write(owner, other);
    const [row] = await rows(other);
    h.deliveries.set(row.provider_message_id, { status: "bounced", detail: "The address does not exist or does not accept mail." });
    const application = await read(owner, other);
    expect(application.messages[0]).toMatchObject({ status: "bounced", status_detail: "The address does not exist or does not accept mail.", delivered_at: null });
  });

  it("stays 'sent' when the provider cannot be asked, and the page still opens", async () => {
    const other = await add(alpha, "Una Known");
    await write(owner, other);
    h.state.statusFails = true;
    const response = await h.api(owner, "GET", `/applications/${other}`);
    expect(response.status).toBe(200);
    expect(response.body.application.messages[0]).toMatchObject({ status: "sent", delivered_at: null });
    expect(h.logs.some((line) => line.event === "applicant_message_status_unavailable" && line.level === "warn")).toBe(true);
  });

  it("is never set by a request: the dashboard has no way to mark a message delivered", async () => {
    const other = await add(alpha, "Not Marked");
    const sent = (await write(owner, other)).body.message;
    for (const [method, path, body] of [
      ["PATCH", `/applications/${other}/messages/${sent.id}`, { status: "delivered" }],
      ["PUT", `/applications/${other}/messages/${sent.id}`, { status: "delivered" }],
      ["POST", `/applications/${other}/messages/${sent.id}/delivered`, {}],
      ["DELETE", `/applications/${other}/messages/${sent.id}`, undefined],
    ]) {
      const response = await h.api(owner, method, path, body);
      expect([404, 405], `${method} ${path}`).toContain(response.status);
    }
    expect((await rows(other))[0]).toMatchObject({ status: "sent", delivered_at: null });
  });
});

describe("telling the applicant about a new status", () => {
  const move = (user, id, body) => h.api(user, "PATCH", `/applications/${id}`, body);
  const statusOf = async (id) => (await h.pg.query("select status from public.job_applications where id = $1", [id])).rows[0].status;

  it("has the server's own email for every status but New, in the restaurant's name", () => {
    const applicant = { full_name: "  Maya   Thompson ", position: "Barista" };
    expect(Object.keys(statusEmails(applicant, "Alpha Kitchen"))).toEqual(["reviewing", "shortlisted", "interview", "hired", "rejected"]);
    for (const status of ["new", "maybe", "", "__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(statusEmail(status, applicant, "Alpha Kitchen"), status).toBeNull();
    }
    expect(statusEmail("interview", applicant, "Alpha Kitchen")).toEqual({
      subject: "Interview for the Barista position",
      body: "Dear Maya,\n\nThank you for your application for the Barista position at Alpha Kitchen. We would like to invite you to an interview.\n\nWe will contact you shortly to agree a day and time. If you prefer, reply to this email with the days and times that suit you.\n\nKind regards,\nAlpha Kitchen",
    });
    expect(statusEmail("hired", applicant, "Alpha Kitchen").subject).toBe("Welcome to Alpha Kitchen");
    expect(statusEmail("rejected", applicant, "Alpha Kitchen").body).toContain("we have decided not to move forward with your application at this time");
    expect(statusEmail("shortlisted", applicant, "Alpha Kitchen").body).toContain("you have been shortlisted");
    expect(statusEmail("reviewing", applicant, "Alpha Kitchen").body).toContain("We are now reviewing your application");
    for (const email of Object.values(statusEmails(applicant, "Alpha Kitchen"))) {
      expect(email.body.startsWith("Dear Maya,\n\n")).toBe(true);
      expect(email.body.endsWith("Kind regards,\nAlpha Kitchen")).toBe(true);
      expect(email.subject.length).toBeLessThanOrEqual(150);
      expect(email.body.length).toBeLessThanOrEqual(5000);
    }
  });

  it("is shown on the application's page, before anything is sent, to whoever may send it", async () => {
    const page = await read(owner, ids["Ben Carter"]);
    expect(page.status_emails.interview).toEqual(statusEmail("interview", { full_name: "Ben Carter", position: "Line Cook" }, "Alpha Kitchen"));
    expect((await read(manager, ids["Ben Carter"])).status_emails).toEqual(page.status_emails);
  });

  it("is sent when the status changes and the box is ticked, to the applicant, and kept with the other messages", async () => {
    const id = await add(alpha, "Iris Moved", "Host / Hostess");
    const response = await move(manager, id, { status: "interview", note: "Strong candidate, keep this between us.", notify_applicant: true });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      result: "saved", email: { result: "sent", to_email: "iris.moved@example.test" },
      message: "Status changed to Interview. The applicant has been emailed at iris.moved@example.test.",
      application: { status: "interview" },
    });
    expect(h.sent).toHaveLength(1);
    const expected = statusEmail("interview", { full_name: "Iris Moved", position: "Host / Hostess" }, "Alpha Kitchen");
    expect(h.sent[0]).toMatchObject({ to: "iris.moved@example.test", replyTo: "hiring@alpha.test", subject: expected.subject });
    expect(h.sent[0].text.startsWith(`${expected.body}\n\n-- \nAlpha Kitchen`)).toBe(true);
    // The note is the restaurant's own. It is not in the email.
    expect(JSON.stringify(h.sent[0])).not.toContain("Strong candidate");

    const { messages, events } = response.body.application;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: "status_update", status: "sent", subject: expected.subject, body: expected.body, sent_by_email: manager.email });
    expect(events.slice(-2).map((event) => event.kind)).toEqual(["status_changed", "message_sent"]);
    const logged = (await h.pg.query("select action, new_values, result from public.audit_logs where entity_id = $1 order by id", [id])).rows;
    expect(logged).toEqual([
      { action: "APPLICATION_STATUS_CHANGED", new_values: { status: "interview" }, result: "success" },
      { action: "APPLICATION_MESSAGE_SENT", new_values: { kind: "status_update", status: "sent", application_status: "interview" }, result: "success" },
    ]);
  });

  it("is not sent unless asked, when nothing changed, when the status is New, or twice for one change", async () => {
    const id = await add(alpha, "Quiet Change");
    expect((await move(owner, id, { status: "reviewing" })).body.email).toBeNull();
    expect((await move(owner, id, { status: "shortlisted", notify_applicant: false })).body.email).toBeNull();
    // The same status again, as a double press would send it: nothing changed, nothing sent.
    expect((await move(owner, id, { status: "shortlisted", notify_applicant: true })).body).toMatchObject({ email: null, message: "Nothing changed." });
    expect((await move(owner, id, { status: "new", notify_applicant: true })).body.email).toBeNull();
    expect(h.sent).toHaveLength(0);
    expect(await rows(id)).toEqual([]);
    for (const notify of ["yes", 1, null, "true"]) {
      expect((await move(owner, id, { status: "hired", notify_applicant: notify })).status, String(notify)).toBe(422);
    }
    expect(await statusOf(id)).toBe("new");
  });

  it("goes to the applicant whatever the request says, and to nobody for another restaurant's application", async () => {
    const id = await add(alpha, "Only Them");
    for (const extra of [{ to: "thief@evil.test" }, { email: "thief@evil.test" }, { subject: "Mine" }, { body: "Mine" }]) {
      expect((await move(owner, id, { status: "hired", notify_applicant: true, ...extra })).status).toBe(422);
    }
    expect((await move(owner, ids["Zed Other"], { status: "hired", notify_applicant: true })).status).toBe(404);
    expect((await move(staff, id, { status: "hired", notify_applicant: true })).status).toBe(403);
    expect(h.sent).toHaveLength(0);
    expect(await statusOf(ids["Zed Other"])).toBe("new");
  });

  it("does not undo the change when the email cannot be sent, and says so", async () => {
    const id = await add(alpha, "Down Provider");
    h.state.emailFails = true;
    const response = await move(owner, id, { status: "rejected", notify_applicant: true });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      email: { result: "failed", to_email: "down.provider@example.test" }, application: { status: "rejected" },
      message: 'Status changed to Rejected, but the email to the applicant could not be sent. It is kept under "Messages to the applicant", where you can try again.',
    });
    expect(await statusOf(id)).toBe("rejected");
    const [kept] = await rows(id);
    expect(kept).toMatchObject({ kind: "status_update", status: "failed" });
    // And it can be sent from there once the provider answers again.
    h.state.emailFails = false;
    expect((await retry(owner, id, kept.id)).body.message).toMatchObject({ status: "sent" });
    expect(h.sent[0].subject).toBe("Your application for the Barista position");
  });

  it("shares the hourly limit of messages written by hand, and refuses before changing anything", async () => {
    const id = await add(alpha, "Limit Reached");
    for (let number = 0; number < 60; number += 1) {
      await h.db.rpc("rate_limit_hit", { p_key: `dash:message:${owner.id}`, p_max: 60, p_window_seconds: 3600 });
    }
    const refused = await move(owner, id, { status: "interview", notify_applicant: true });
    expect(refused.status).toBe(429);
    expect(await statusOf(id)).toBe("new");
    expect(h.sent).toHaveLength(0);
    // Without the email the change goes through.
    expect((await move(owner, id, { status: "interview" })).status).toBe(200);
  });

  it("puts whatever the applicant's name holds into the email as text", async () => {
    const id = await add(alpha, "<img/src=x>Zoë Test");
    await h.pg.query("update public.job_applications set position = $2 where id = $1", [id, `<b>Chef</b> ${"x".repeat(200)}`]);
    const response = await move(owner, id, { status: "shortlisted", notify_applicant: true });
    expect(response.status).toBe(200);
    // A position too long for a subject is cut to the 150 characters a subject may have.
    expect(h.sent[0].subject.length).toBe(150);
    expect(h.sent[0].text).toContain("Dear <img/src=x>Zoë,");
    expect(h.sent[0].html).toContain("Dear &lt;img/src=x&gt;Zoë,");
    expect(h.sent[0].html).toContain("&lt;b&gt;Chef&lt;/b&gt;");
    expect(h.sent[0].html).not.toMatch(/<b>Chef|<img/);
  });
});

describe("messages and the rest of an application's life", () => {
  it("are not shown to someone who may not read applications", async () => {
    expect((await h.api(staff, "GET", `/applications/${ids["Ana Reyes"]}`)).status).toBe(403);
    expect((await h.api(betaOwner, "GET", `/applications/${ids["Ana Reyes"]}`)).status).toBe(404);
  });

  it("come back with the application after its status is changed", async () => {
    const response = await h.api(owner, "PATCH", `/applications/${ids["Ana Reyes"]}`, { status: "reviewing" });
    expect(response.status).toBe(200);
    expect(response.body.application.messages.length).toBeGreaterThan(0);
  });

  it("go when the application is deleted, and when it passes the retention period", async () => {
    const deleted = await add(alpha, "Del Eted");
    await write(owner, deleted);
    expect((await h.api(owner, "DELETE", `/applications/${deleted}`)).status).toBe(200);
    expect(await rows(deleted)).toEqual([]);

    const old = await add(alpha, "Old Timer", "Barista", 400);
    await write(owner, old);
    expect(await rows(old)).toHaveLength(1);
    await purgeExpiredApplications(h.deps);
    expect(await rows(old)).toEqual([]);
  });

  it("are closed to the browser's own database roles", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const privilege of ["select", "insert", "update", "delete"]) {
        const { rows: answer } = await h.pg.query("select has_table_privilege($1, 'public.job_application_messages', $2) as allowed", [role, privilege]);
        expect(answer[0].allowed, `${role} ${privilege}`).toBe(false);
      }
      const { rows: functions } = await h.pg.query(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname like 'dash_application_message%' and has_function_privilege($1, p.oid, 'execute')`, [role]);
      expect(functions).toEqual([]);
    }
    const { rows: table } = await h.pg.query("select relrowsecurity from pg_class where oid = 'public.job_application_messages'::regclass");
    expect(table[0].relrowsecurity).toBe(true);
    const { rows: policies } = await h.pg.query("select count(*) as n from pg_policies where tablename = 'job_application_messages'");
    expect(Number(policies[0].n)).toBe(0);
  });
});
