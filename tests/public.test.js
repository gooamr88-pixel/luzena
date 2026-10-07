// Public endpoints: menu, Clover webhook, job application.
import { beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../supabase/functions/_shared/env.ts";
import { handleJobApplication } from "../supabase/functions/_shared/public/application.ts";
import { purgeExpiredApplications } from "../supabase/functions/_shared/public/retention.ts";
import { handlePublicMenu } from "../supabase/functions/_shared/public/menu.ts";
import { handleCloverWebhook } from "../supabase/functions/_shared/public/webhook.ts";
import { createHarness, ORIGIN } from "./helpers/harness.js";

const STORAGE = "https://project.supabase.co/storage/v1/object/public/menu-images";
let h, alpha, owner, soup, secretItem;

const read = async (response) => ({ status: response.status, headers: response.headers, body: JSON.parse(await response.text()) });
const menu = (slug = "alpha", init = {}) =>
  handlePublicMenu(new Request(`https://fn.test/public-menu?restaurant=${slug}`, { headers: { origin: ORIGIN }, ...init }), h.deps, STORAGE).then(read);

beforeAll(async () => {
  h = await createHarness();
  alpha = await h.createRestaurant("alpha");
  await h.pg.query("update public.restaurants set recruitment_email = 'jobs@example.test' where id = $1", [alpha]);
  owner = await h.addUser(alpha, "owner");
  const starters = h.clover.addCategory("Starters", 1);
  soup = h.clover.addItem("Soup", 700);
  secretItem = h.clover.addItem("Staff meal", 0, { hidden: true });
  h.clover.link(soup, starters);
  h.clover.link(secretItem, starters);
});

describe("public menu", () => {
  it("says the menu is unavailable before the first sync, without details", async () => {
    const response = await menu();
    expect(response.status).toBe(503);
    expect(response.body.error.message).toBe("Menu temporarily unavailable. Please try again shortly.");
  });

  it("gives the same answer for an unknown restaurant and a malformed slug", async () => {
    expect((await menu("nope")).status).toBe(404);
    expect((await menu("../../etc")).status).toBe(404);
  });

  it("serves the synced menu with cache headers and no private fields", async () => {
    await h.connect(alpha);
    await h.api(owner, "POST", "/clover/sync");

    // Importing publishes nothing: the menu is still unavailable to the public until the
    // owner shows at least one item.
    const imported = await menu();
    expect(imported.status).toBe(200);
    expect(imported.body.categories).toEqual([]);
    expect(JSON.stringify(imported.body)).not.toMatch(/Soup|Staff meal/);

    // The owner shows everything, including the item Clover marks hidden, which stays out.
    await h.api(owner, "POST", "/items/bulk", { ids: [soup, secretItem], action: "show" });
    await h.api(owner, "PATCH", `/items/${soup}`, { website: { description: "Fresh." } });

    const response = await menu();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("s-maxage=60");
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(response.body.categories).toHaveLength(1);
    expect(response.body.categories[0].items).toEqual([
      expect.objectContaining({ name: "Soup", price_cents: 700, available: true, description: "Fresh.", image_url: null }),
    ]);
    const text = JSON.stringify(response.body);
    expect(text).not.toContain("Staff meal");
    expect(text).not.toMatch(/restaurant_id|image_path|web_hidden|merchant|token/);
  });

  it("turns a stored photo path into a public URL", async () => {
    await h.db.rpc("web_update_item", { p_restaurant: alpha, p_item: soup, p_patch: { image_path: `${alpha}/${soup}/abc.webp` } });
    const response = await menu();
    expect(response.body.categories[0].items[0].image_url).toBe(`${STORAGE}/${alpha}/${soup}/abc.webp`);
  });

  it("keeps serving the last synced menu while Clover is down", async () => {
    await h.pg.query("update public.clover_connections set last_success_at = now() - interval '1 hour' where restaurant_id = $1", [alpha]);
    h.clover.fault({ method: "GET", path: /categories/, status: 503, times: 10 });
    const response = await menu();
    await h.settle();
    expect(response.status).toBe(200);
    expect(response.body.categories[0].items[0].name).toBe("Soup");
    const status = (await h.api(owner, "GET", "/clover")).body.connection;
    expect(status.last_error_code).toBe("clover_unavailable");
    h.clover.faults.length = 0;
  });

  it("refreshes from Clover in the background when the mirror is stale", async () => {
    h.clover.items.get(soup).price = 800;
    await h.pg.query("update public.clover_connections set last_success_at = now() - interval '1 hour' where restaurant_id = $1", [alpha]);
    expect((await menu()).body.categories[0].items[0].price_cents).toBe(700);
    await h.settle();
    expect((await menu()).body.categories[0].items[0].price_cents).toBe(800);
  });

  it("limits how fast one address can ask for the menu, with the same safe answer", async () => {
    const from = (ip) => menu("alpha", { headers: { origin: ORIGIN, "x-forwarded-for": ip } });
    const statuses = [];
    for (let i = 0; i < 122; i++) statuses.push((await from("198.51.100.7")).status);
    expect(statuses.slice(0, 120).every((status) => status === 200)).toBe(true);
    expect(statuses.slice(120)).toEqual([429, 429]);

    const limited = await from("198.51.100.7");
    expect(limited.headers.get("retry-after")).toBe("30");
    expect(limited.body.error.message).toBe("Menu temporarily unavailable. Please try again shortly.");
    // Another visitor is not affected, and the address itself is never stored.
    expect((await from("198.51.100.8")).status).toBe(200);
    const { rows } = await h.pg.query("select key from public.rate_limits where key like 'menu:%'");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((entry) => !entry.key.includes("198.51.100"))).toBe(true);
  });

  it("does not grant CORS to other origins and rejects other methods", async () => {
    const other = await menu("alpha", { headers: { origin: "https://evil.example" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    expect((await menu("alpha", { method: "POST" })).status).toBe(405);
  });
});

describe("Clover webhook", () => {
  const post = (body, headers = {}) =>
    handleCloverWebhook(new Request("https://fn.test/clover-webhook", {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    }), h.deps).then(read);
  const event = (objectId) => ({ appId: "APPID00000001", merchants: { [h.clover.merchantId]: [{ objectId, type: "UPDATE", ts: Date.now() }] } });

  it("rejects a notification without the shared secret", async () => {
    expect((await post(event(`I:${soup}`))).status).toBe(401);
    expect((await post(event(`I:${soup}`), { "x-clover-auth": "wrong" })).status).toBe(401);
  });

  it("acknowledges the one-time verification request", async () => {
    const response = await post({ verificationCode: "abc-123" });
    expect(response.status).toBe(200);
    expect(h.logs.some((l) => l.event === "clover_webhook_verification" && l.verification_value === "abc-123")).toBe(true);
  });

  // Clover sends the verification before it has given out the shared secret, so anyone can
  // send one. It changes nothing; this keeps it from being a way to fill the log.
  it("writes only a few verification requests an hour to the log, and answers them all alike", async () => {
    const statuses = [];
    for (let i = 0; i < 9; i++) statuses.push((await post({ verificationCode: `flood-${i}` })).status);
    expect(new Set(statuses)).toEqual(new Set([200]));
    const written = h.logs.filter((l) => l.event === "clover_webhook_verification").length;
    expect(written).toBe(5);
  });

  it("stops reading a body that is larger than a notification can be, whatever length it declares", async () => {
    const big = new Uint8Array(300 * 1024).fill(0x20);
    const chunks = [big.subarray(0, 100 * 1024), big.subarray(100 * 1024, 200 * 1024), big.subarray(200 * 1024)];
    let pulled = 0;
    const body = new ReadableStream({ pull(controller) { pulled < chunks.length ? controller.enqueue(chunks[pulled++]) : controller.close(); } });
    // No content-length at all: the size is only known by counting.
    const response = await handleCloverWebhook(new Request("https://fn.test/clover-webhook", {
      method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half",
    }), h.deps);
    expect(response.status).toBe(413);
  });

  it("re-syncs the menu when inventory changes in Clover", async () => {
    h.clover.items.get(soup).price = 950;
    const response = await post(event(`I:${soup}`), { "x-clover-auth": "webhook-shared-secret" });
    expect(response.status).toBe(200);
    await h.settle();
    expect((await menu()).body.categories[0].items[0].price_cents).toBe(950);
  });

  it("ignores events that are not about inventory", async () => {
    const before = h.clover.calls.length;
    await post(event("O:ORDER00000001"), { "x-clover-auth": "webhook-shared-secret" });
    await h.settle();
    expect(h.clover.calls.length).toBe(before);
  });
});

describe("job application", () => {
  const pdf = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n");
  // Every application comes from its own email address unless a test says otherwise, so
  // the per-address limit only shows up in the test that is about it.
  let applicant = 0;
  const valid = () => ({
    restaurant: "alpha", full_name: "Sam Rivera", email: `sam${++applicant}@example.test`, phone: "+1 555 010 0199",
    position: "Chefs & Cooks", employment_type: "full_time", availability: ["weekday_evenings", "weekend_days"],
    start_when: "two_weeks", experience_level: "3_5", experience: "Five years on the line at two restaurants.",
    work_authorized: "yes", message: "I would like to join the kitchen.", consent: "yes",
    started_at: String(Date.now() - 20_000), company_website: "",
  });
  let address = 0;
  const from = () => ({ origin: ORIGIN, "x-forwarded-for": `198.51.100.${++address}` });
  const submit = (fieldValues, file, headers = from()) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fieldValues)) {
      for (const entry of [].concat(value)) form.append(key, entry);
    }
    if (file) form.append("cv", file);
    return handleJobApplication(new Request("https://fn.test/job-application", { method: "POST", headers, body: form }), h.deps).then(read);
  };
  const count = async () => (await h.pg.query("select count(*)::int as n from public.job_applications")).rows[0].n;
  const latest = async () => (await h.pg.query("select * from public.job_applications order by created_at desc, id desc limit 1")).rows[0];
  const events = async (id) => (await h.pg.query("select kind from public.job_application_events where application_id = $1 order by id", [id])).rows.map((row) => row.kind);

  it("stores the application first, keeps the CV private, then notifies the recruiter", async () => {
    const response = await submit({ ...valid(), email: "Sam@Example.test" }, new File([pdf], "../../My CV (final).pdf", { type: "application/pdf" }));
    expect(response.status).toBe(200);
    // The applicant is answered once the application is stored; the email follows on its own.
    expect(await count()).toBe(1);

    const row = await latest();
    expect(row).toMatchObject({
      full_name: "Sam Rivera", email: "sam@example.test", position: "Chefs & Cooks", status: "new",
      employment_type: "full_time", availability: ["weekday_evenings", "weekend_days"], start_when: "two_weeks",
      experience_level: "3_5", experience: "Five years on the line at two restaurants.", work_authorized: true,
      message: "I would like to join the kitchen.", cv_original_name: "My-CV-final.pdf",
    });
    expect(row.cv_path).toMatch(new RegExp(`^${alpha}/[0-9a-f-]{36}\\.pdf$`));
    expect(row.ip_hash).not.toContain("198.51.100");
    expect(h.stored.has(`cvs/${row.cv_path}`)).toBe(true);

    await h.settle();
    expect(h.sent).toHaveLength(1);
    const email = h.sent[0];
    expect(email).toMatchObject({ to: "jobs@example.test", replyTo: "sam@example.test" });
    expect(email.subject).toBe("New Job Application — Sam Rivera — Chefs & Cooks");
    // A summary and a link to the dashboard. The CV and the applicant's own words stay
    // behind the sign-in.
    expect(email.attachment).toBeUndefined();
    expect(email.text).toContain(`${ORIGIN}/dashboard/#/applications/${row.id}`);
    expect(email.text).toContain("Weekday evenings, Weekend days");
    expect(email.text).not.toContain("I would like to join the kitchen.");
    expect(email.text).not.toContain("Five years on the line");
    expect(email.html).toContain(`href="${ORIGIN}/dashboard/#/applications/${row.id}"`);
    expect((await latest()).email_status).toBe("sent");
    expect(await events(row.id)).toEqual(["submitted", "email_sent"]);
    // The inbox address never reaches the applicant.
    expect(JSON.stringify(response.body)).not.toContain("jobs@example.test");
  });

  it("accepts an application without a CV, experience notes or an introduction", async () => {
    const response = await submit({ ...valid(), experience: "", message: "" });
    expect(response.status).toBe(200);
    expect(await latest()).toMatchObject({ cv_path: null, experience: null, message: null });
  });

  it("rejects submissions from other origins", async () => {
    expect((await submit(valid(), null, { origin: "https://evil.example" })).status).toBe(403);
    expect((await submit(valid(), null, {})).status).toBe(403);
  });

  it("returns a message for every field that is wrong, and stores nothing", async () => {
    const before = await count();
    const response = await submit({
      ...valid(), email: "not-an-email", phone: "abc", full_name: "x", consent: "",
      employment_type: "", availability: ["mondays"], start_when: "whenever", experience_level: "", work_authorized: "",
    });
    expect(response.status).toBe(422);
    expect(Object.keys(response.body.error.fields).sort()).toEqual([
      "availability", "consent", "email", "employment_type", "experience_level", "full_name", "phone", "start_when", "work_authorized",
    ]);
    expect(response.body.error.fields.availability).toBe("Choose at least one time you could work.");
    expect(response.body.error.fields.work_authorized).toMatch(/authorized to work/);
    expect((await submit({ ...valid(), availability: [] })).body.error.fields.availability).toBeDefined();
    expect((await submit({ ...valid(), message: "x".repeat(2001) })).body.error.fields.message).toMatch(/at most 2000/);
    expect(await count()).toBe(before);
  });

  it("rejects an executable renamed to .pdf, a wrong extension, and a macro document", async () => {
    const exe = new File([new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03])], "cv.pdf", { type: "application/pdf" });
    expect((await submit(valid(), exe)).body.error.fields.cv).toMatch(/PDF, DOC or DOCX/);

    const renamed = new File([pdf], "cv.docx", { type: "application/pdf" });
    expect((await submit(valid(), renamed)).status).toBe(422);

    const script = new File([new TextEncoder().encode("%PDF-1.7\n<< /S /JavaScript /JS (app.alert(1)) >>")], "cv.pdf");
    expect((await submit(valid(), script)).body.error.fields.cv).toMatch(/scripts or macros/);

    const html = new File([new TextEncoder().encode("<script>alert(1)</script>")], "cv.pdf");
    expect((await submit(valid(), html)).status).toBe(422);
  });

  it("silently drops bots: filled honeypot or an instant submit", async () => {
    await h.settle();
    const before = await count();
    const sentBefore = h.sent.length;
    const honeypot = await submit({ ...valid(), company_website: "http://spam.example" });
    const instant = await submit({ ...valid(), started_at: String(Date.now()) });
    expect(honeypot.status).toBe(200);
    expect(instant.status).toBe(200);
    await h.settle();
    expect(await count()).toBe(before);
    expect(h.sent.length).toBe(sentBefore);
  });

  it("keeps markup and line breaks in what the applicant typed out of the email", async () => {
    await submit({ ...valid(), full_name: "Eve\r\nBcc: victim@example.test", position: "<img src=x onerror=alert(1)>" });
    await h.settle();
    const email = h.sent.at(-1);
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.html).not.toContain("<img");
    expect(email.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("counts one submission once, however many times it is sent", async () => {
    await h.settle();
    const before = await count();
    const sentBefore = h.sent.length;
    const storedBefore = h.stored.size;
    const application = { ...valid(), submission_id: "0b6f6a51-6f0c-4d6c-9d7e-2f3b8a1c4e55" };
    const cvFile = () => new File([pdf], "cv.pdf", { type: "application/pdf" });

    expect((await submit(application, cvFile())).status).toBe(200);
    // The same form sent again: a second press of the button, or a retry after a lost answer.
    expect((await submit(application, cvFile())).status).toBe(200);
    expect((await submit(application, cvFile())).status).toBe(200);
    await h.settle();

    expect(await count()).toBe(before + 1);
    expect(h.sent.length).toBe(sentBefore + 1);
    expect(h.stored.size).toBe(storedBefore + 1);
    expect((await submit({ ...valid(), submission_id: "not-a-uuid" })).status).toBe(400);
  });

  it("still receives the application when the email cannot be sent, and records that it was not", async () => {
    h.state.emailFails = true;
    const response = await submit(valid());
    await h.settle();
    h.state.emailFails = false;
    // The application is in the database and the dashboard. The applicant has nothing to retry.
    expect(response.status).toBe(200);
    const row = await latest();
    expect(row.email_status).toBe("failed");
    expect(await events(row.id)).toEqual(["submitted", "email_failed"]);
    expect(h.logs.some((entry) => entry.event === "job_application_email_failed")).toBe(true);
  });

  it("still receives the application when no email provider or inbox is set up", async () => {
    const sender = h.deps.email;
    h.deps.email = null;
    const response = await submit(valid());
    await h.settle();
    h.deps.email = sender;
    expect(response.status).toBe(200);
    expect((await latest()).email_status).toBe("failed");
    expect(h.logs.some((entry) => entry.event === "job_application_email_not_configured")).toBe(true);
  });

  // One address is often many people (a mobile carrier, the restaurant's own wifi on a
  // hiring day), so the limit per address stops a script and not a queue of applicants.
  it("limits how many applications one connection can send, generously", async () => {
    const headers = { origin: ORIGIN, "x-forwarded-for": "203.0.113.99" };
    const statuses = [];
    for (let i = 0; i < 21; i++) statuses.push((await submit(valid(), null, headers)).status);
    expect(statuses.slice(0, 20).every((status) => status === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it("refuses a form larger than the limit by counting what arrives, not by what the sender says", async () => {
    const before = await count();
    const storedBefore = h.stored.size;
    const boundary = "----audit";
    const head = new TextEncoder().encode(`--${boundary}\r\ncontent-disposition: form-data; name="cv"; filename="cv.pdf"\r\ncontent-type: application/pdf\r\n\r\n%PDF-1.7\n`);
    const megabyte = new Uint8Array(1024 * 1024).fill(0x41);
    let sent = 0;
    // Seven megabytes, sent in pieces with no content-length: more than the 5 MB a CV may be.
    const body = new ReadableStream({
      pull(controller) {
        if (sent === 0) controller.enqueue(head);
        if (sent < 7) controller.enqueue(megabyte);
        else controller.close();
        sent += 1;
      },
    });
    const response = await handleJobApplication(new Request("https://fn.test/job-application", {
      method: "POST", headers: { ...from(), "content-type": `multipart/form-data; boundary=${boundary}` }, body, duplex: "half",
    }), h.deps).then(read);
    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe("payload_too_large");
    // Reading stopped soon after the limit, well before the end of what was being sent.
    expect(sent).toBeLessThanOrEqual(7);
    expect(await count()).toBe(before);
    expect(h.stored.size).toBe(storedBefore);
  });

  it("refuses a form that declares itself larger than the limit before reading any of it", async () => {
    const response = await handleJobApplication(new Request("https://fn.test/job-application", {
      method: "POST", headers: { ...from(), "content-type": "multipart/form-data; boundary=x", "content-length": String(50 * 1024 * 1024) }, body: "--x--",
    }), h.deps).then(read);
    expect(response.status).toBe(413);
  });

  it("limits how many applications one email address can send in a day", async () => {
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await submit({ ...valid(), email: "Keen@Example.test" })).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    // The address is counted as a hash, never stored as a key.
    const { rows } = await h.pg.query("select key from public.rate_limits where key like 'apply-email:%'");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => !row.key.includes("keen"))).toBe(true);
  });

  describe("the operator's switch", () => {
    const withSettings = async (settings, run) => {
      const original = h.deps.env.jobApplications;
      h.deps.env.jobApplications = settings;
      try {
        return await run();
      } finally {
        h.deps.env.jobApplications = original;
      }
    };

    it("is off unless explicitly switched on, and has no default retention period", () => {
      expect(loadEnv(() => undefined).jobApplications).toEqual({ enabled: false, retentionDays: null });
      expect(loadEnv((name) => ({ JOB_APPLICATIONS_ENABLED: "yes" })[name]).jobApplications.enabled).toBe(false);
      for (const value of ["", "0", "-5", "abc", "1.5", "99999"]) {
        expect(loadEnv((name) => ({ JOB_APPLICATION_RETENTION_DAYS: value })[name]).jobApplications.retentionDays, value).toBeNull();
      }
      expect(loadEnv((name) => ({ JOB_APPLICATIONS_ENABLED: "true", JOB_APPLICATION_RETENTION_DAYS: "90" })[name]).jobApplications)
        .toEqual({ enabled: true, retentionDays: 90 });
    });

    it("refuses applications while switched off, and stores nothing", async () => {
      const before = await count();
      const storedBefore = h.stored.size;
      const sentBefore = h.sent.length;
      const response = await withSettings({ enabled: false, retentionDays: 180 }, () =>
        submit(valid(), new File([pdf], "cv.pdf")));
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe("applications_closed");
      expect(await count()).toBe(before);
      expect(h.stored.size).toBe(storedBefore);
      expect(h.sent.length).toBe(sentBefore);
    });

    it("refuses applications when switched on without a retention period", async () => {
      const before = await count();
      const response = await withSettings({ enabled: true, retentionDays: null }, () =>
        submit(valid()));
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe("applications_closed");
      expect(await count()).toBe(before);
      expect(h.logs.some((entry) => entry.event === "job_applications_misconfigured")).toBe(true);
    });
  });

  describe("retention", () => {
    const addApplication = async (name, ageDays, cvPath) => {
      const { rows } = await h.pg.query(
        `insert into public.job_applications (restaurant_id, full_name, email, phone, position, cv_path, created_at)
         values ($1, $2, 'a@example.test', '5550100', 'Barista', $3, now() - make_interval(days => $4)) returning id`,
        [alpha, name, cvPath, ageDays]);
      if (cvPath) h.stored.set(`cvs/${cvPath}`, { bytes: new Uint8Array([1]), contentType: "application/pdf" });
      return rows[0].id;
    };
    const exists = async (id) => (await h.pg.query("select 1 from public.job_applications where id = $1", [id])).rows.length === 1;

    it("deletes applications older than the retention period, with their CV files, and keeps newer ones", async () => {
      const old = await addApplication("Old Applicant", 181, `${alpha}/old.pdf`);
      const oldWithoutCv = await addApplication("Old No CV", 400, null);
      const recent = await addApplication("Recent Applicant", 179, `${alpha}/recent.pdf`);

      const deleted = await purgeExpiredApplications(h.deps);

      expect(deleted).toBe(2);
      expect(await exists(old)).toBe(false);
      expect(await exists(oldWithoutCv)).toBe(false);
      expect(await exists(recent)).toBe(true);
      expect(h.stored.has(`cvs/${alpha}/old.pdf`)).toBe(false);
      expect(h.stored.has(`cvs/${alpha}/recent.pdf`)).toBe(true);
    });

    it("keeps the record if its CV file cannot be removed, so nothing is orphaned", async () => {
      const old = await addApplication("Stuck Applicant", 500, `${alpha}/stuck.pdf`);
      const realRemove = h.deps.files.remove;
      h.deps.files.remove = async () => { throw new Error("storage unavailable"); };
      const deleted = await purgeExpiredApplications(h.deps);
      h.deps.files.remove = realRemove;

      expect(deleted).toBe(0);
      expect(await exists(old)).toBe(true);
      expect(h.stored.has(`cvs/${alpha}/stuck.pdf`)).toBe(true);
      expect(h.logs.some((entry) => entry.event === "job_applications_purge_failed")).toBe(true);

      expect(await purgeExpiredApplications(h.deps)).toBe(1);
      expect(await exists(old)).toBe(false);
    });

    it("deletes nothing while no retention period is configured", async () => {
      const old = await addApplication("Undecided", 5000, null);
      const original = h.deps.env.jobApplications;
      h.deps.env.jobApplications = { enabled: true, retentionDays: null };
      expect(await purgeExpiredApplications(h.deps)).toBe(0);
      h.deps.env.jobApplications = original;
      expect(await exists(old)).toBe(true);
      await h.pg.query("delete from public.job_applications where id = $1", [old]);
    });

    // There is no scheduler. Before, expired applications were deleted only when a new one
    // arrived or an owner opened the dashboard; now any visitor to the website sets it off,
    // about once an hour.
    describe("the hourly chores, on the back of the public pages", () => {
      let hoursOn = 0;
      const anHourOn = async (run) => {
        const realNow = h.deps.now;
        // Each use moves the clock on again: this copy of the backend last looked hours
        // ago, and the database has not let anyone through this hour.
        hoursOn += 3;
        const ahead = hoursOn * 3600 * 1000;
        h.deps.now = () => realNow() + ahead;
        await h.pg.query("delete from public.rate_limits where key = 'upkeep'");
        try {
          return await run();
        } finally {
          h.deps.now = realNow;
        }
      };

      it("deletes expired applications when a visitor opens the menu, and only once in the hour", async () => {
        const old = await addApplication("Swept By A Visitor", 300, `${alpha}/visitor.pdf`);
        await anHourOn(async () => {
          expect((await menu()).status).toBe(200);
          await h.settle();
        });
        expect(await exists(old)).toBe(false);
        expect(h.stored.has(`cvs/${alpha}/visitor.pdf`)).toBe(false);

        // A second visitor in the same hour sets nothing off.
        const later = await addApplication("Not Yet", 300, null);
        await menu();
        await h.settle();
        expect(await exists(later)).toBe(true);
        await h.pg.query("delete from public.job_applications where id = $1", [later]);
      });

      it("clears rows that are only of use for a while, and keeps the recent ones and the audit log", async () => {
        await h.pg.exec(`
          insert into public.rate_limits (key, window_start, count) values
            ('menu:old-visitor', now() - interval '3 days', 4), ('menu:new-visitor', now() - interval '1 hour', 4);
          insert into public.idempotency_keys (restaurant_id, key, request_hash, status, created_at) values
            ('${alpha}', 'old-key-0001', 'h', 'completed', now() - interval '8 days'),
            ('${alpha}', 'new-key-0001', 'h', 'completed', now() - interval '1 day');
          insert into public.sync_runs (restaurant_id, trigger, status, started_at) values
            ('${alpha}', 'stale', 'succeeded', now() - interval '31 days'), ('${alpha}', 'stale', 'succeeded', now() - interval '2 days');
          insert into public.integration_logs (restaurant_id, level, event, created_at) values
            ('${alpha}', 'error', 'old_event', now() - interval '91 days'), ('${alpha}', 'error', 'new_event', now() - interval '5 days');
          insert into public.oauth_states (nonce_hash, restaurant_id, user_id, expires_at) values
            ('old-nonce', '${alpha}', gen_random_uuid(), now() - interval '2 days'), ('new-nonce', '${alpha}', gen_random_uuid(), now() + interval '5 minutes');`);
        const audits = (await h.pg.query("select count(*)::int as n from public.audit_logs")).rows[0].n;

        await anHourOn(async () => {
          await menu();
          await h.settle();
        });

        const left = async (sql) => (await h.pg.query(sql)).rows.map((row) => Object.values(row)[0]);
        expect(await left("select key from public.rate_limits where key like 'menu:%-visitor'")).toEqual(["menu:new-visitor"]);
        expect(await left("select key from public.idempotency_keys where key like '%-key-0001'")).toEqual(["new-key-0001"]);
        expect(await left("select event from public.integration_logs where event like '%_event'")).toEqual(["new_event"]);
        expect(await left("select nonce_hash from public.oauth_states where nonce_hash like '%-nonce'")).toEqual(["new-nonce"]);
        expect((await h.pg.query("select count(*)::int as n from public.sync_runs where started_at < now() - interval '30 days'")).rows[0].n).toBe(0);
        expect((await h.pg.query("select count(*)::int as n from public.sync_runs where started_at > now() - interval '3 days'")).rows[0].n).toBeGreaterThan(0);
        expect((await h.pg.query("select count(*)::int as n from public.audit_logs")).rows[0].n).toBe(audits);
        expect(h.logs.some((entry) => entry.event === "housekeeping_done" && entry.rate_limits >= 1)).toBe(true);
        expect(h.logs.some((entry) => entry.event === "upkeep_failed")).toBe(false);
      });

      it("is closed to the public roles, like every other function", async () => {
        for (const role of ["anon", "authenticated"]) {
          const result = await h.pg.query("select has_function_privilege($1, 'public.housekeeping()', 'execute') as open", [role]);
          expect(result.rows[0].open, role).toBe(false);
        }
      });
    });

    it("runs after a new application is accepted", async () => {
      const old = await addApplication("Swept On Submit", 300, null);
      const response = await submit(valid());
      expect(response.status).toBe(200);
      await h.settle();
      expect(await exists(old)).toBe(false);
    });
  });
});
