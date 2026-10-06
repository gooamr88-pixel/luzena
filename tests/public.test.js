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
  const valid = () => ({
    restaurant: "alpha", full_name: "Sam Rivera", email: "Sam@Example.test", phone: "+1 555 010 0199",
    position: "Chefs & Cooks", message: "I have five years of line experience.", consent: "yes",
    started_at: String(Date.now() - 20_000), company_website: "",
  });
  const submit = (fieldValues, file, headers = { origin: ORIGIN, "x-forwarded-for": "203.0.113.9" }) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fieldValues)) form.append(key, value);
    if (file) form.append("cv", file);
    return handleJobApplication(new Request("https://fn.test/job-application", { method: "POST", headers, body: form }), h.deps).then(read);
  };
  const count = async () => (await h.pg.query("select count(*)::int as n from public.job_applications")).rows[0].n;

  it("stores the application, keeps the CV private, and emails the recruiter", async () => {
    const response = await submit(valid(), new File([pdf], "../../My CV (final).pdf", { type: "application/pdf" }));
    expect(response.status).toBe(200);

    const { rows } = await h.pg.query("select * from public.job_applications");
    expect(rows[0]).toMatchObject({ full_name: "Sam Rivera", email: "sam@example.test", email_status: "sent", cv_original_name: "My-CV-final.pdf" });
    expect(rows[0].cv_path).toMatch(new RegExp(`^${alpha}/[0-9a-f-]{36}\\.pdf$`));
    expect(rows[0].ip_hash).not.toContain("203.0.113.9");
    expect(h.stored.has(`cvs/${rows[0].cv_path}`)).toBe(true);

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ to: "jobs@example.test", replyTo: "sam@example.test" });
    expect(h.sent[0].subject).toBe("Job application: Chefs & Cooks - Sam Rivera");
    expect(h.sent[0].attachment.filename).toBe("My-CV-final.pdf");
    expect(JSON.stringify(response.body)).not.toContain("jobs@example.test");
  });

  it("accepts an application without a CV", async () => {
    const response = await submit(valid(), null, { origin: ORIGIN, "x-forwarded-for": "203.0.113.10" });
    expect(response.status).toBe(200);
  });

  it("rejects submissions from other origins", async () => {
    expect((await submit(valid(), null, { origin: "https://evil.example" })).status).toBe(403);
    expect((await submit(valid(), null, {})).status).toBe(403);
  });

  it("returns field errors for invalid input and stores nothing", async () => {
    const before = await count();
    const response = await submit({ ...valid(), email: "not-an-email", phone: "abc", full_name: "x", consent: "" }, null,
      { origin: ORIGIN, "x-forwarded-for": "203.0.113.11" });
    expect(response.status).toBe(422);
    expect(Object.keys(response.body.error.fields).sort()).toEqual(["consent", "email", "full_name", "phone"]);
    expect(await count()).toBe(before);
  });

  it("rejects an executable renamed to .pdf, a wrong extension, and a macro document", async () => {
    const headers = (n) => ({ origin: ORIGIN, "x-forwarded-for": `203.0.113.${n}` });
    const exe = new File([new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03])], "cv.pdf", { type: "application/pdf" });
    expect((await submit(valid(), exe, headers(20))).body.error.fields.cv).toMatch(/PDF, DOC or DOCX/);

    const renamed = new File([pdf], "cv.docx", { type: "application/pdf" });
    expect((await submit(valid(), renamed, headers(21))).status).toBe(422);

    const script = new File([new TextEncoder().encode("%PDF-1.7\n<< /S /JavaScript /JS (app.alert(1)) >>")], "cv.pdf");
    expect((await submit(valid(), script, headers(22))).body.error.fields.cv).toMatch(/scripts or macros/);

    const html = new File([new TextEncoder().encode("<script>alert(1)</script>")], "cv.pdf");
    expect((await submit(valid(), html, headers(23))).status).toBe(422);
  });

  it("silently drops bots: filled honeypot or an instant submit", async () => {
    const before = await count();
    const sentBefore = h.sent.length;
    const honeypot = await submit({ ...valid(), company_website: "http://spam.example" }, null, { origin: ORIGIN, "x-forwarded-for": "203.0.113.30" });
    const instant = await submit({ ...valid(), started_at: String(Date.now()) }, null, { origin: ORIGIN, "x-forwarded-for": "203.0.113.31" });
    expect(honeypot.status).toBe(200);
    expect(instant.status).toBe(200);
    expect(await count()).toBe(before);
    expect(h.sent.length).toBe(sentBefore);
  });

  it("strips line breaks from fields that reach the email subject", async () => {
    await submit({ ...valid(), full_name: "Eve\r\nBcc: victim@example.test" }, null, { origin: ORIGIN, "x-forwarded-for": "203.0.113.40" });
    expect(h.sent.at(-1).subject).not.toMatch(/[\r\n]/);
  });

  it("tells the applicant to retry when the email cannot be sent, and records the failure", async () => {
    h.state.emailFails = true;
    const response = await submit(valid(), null, { origin: ORIGIN, "x-forwarded-for": "203.0.113.50" });
    h.state.emailFails = false;
    expect(response.status).toBe(502);
    expect(response.body.error.message).not.toMatch(/provider|resend|stack/i);
    const { rows } = await h.pg.query("select email_status from public.job_applications order by created_at desc limit 1");
    expect(rows[0].email_status).toBe("failed");
  });

  it("limits how many applications one connection can send", async () => {
    const headers = { origin: ORIGIN, "x-forwarded-for": "203.0.113.99" };
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await submit(valid(), null, headers)).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
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
        submit(valid(), new File([pdf], "cv.pdf"), { origin: ORIGIN, "x-forwarded-for": "203.0.113.60" }));
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe("applications_closed");
      expect(await count()).toBe(before);
      expect(h.stored.size).toBe(storedBefore);
      expect(h.sent.length).toBe(sentBefore);
    });

    it("refuses applications when switched on without a retention period", async () => {
      const before = await count();
      const response = await withSettings({ enabled: true, retentionDays: null }, () =>
        submit(valid(), null, { origin: ORIGIN, "x-forwarded-for": "203.0.113.61" }));
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

    it("runs after a new application is accepted", async () => {
      const old = await addApplication("Swept On Submit", 300, null);
      const response = await submit(valid(), null, { origin: ORIGIN, "x-forwarded-for": "203.0.113.70" });
      expect(response.status).toBe(200);
      await h.settle();
      expect(await exists(old)).toBe(false);
    });
  });
});
