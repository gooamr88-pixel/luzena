// Job applications from end to end, on the real handlers and real SQL (PGlite):
//
//   the form's request -> the database -> the dashboard API -> the notification email
//
// and the rules around it: who may read an application, how a CV leaves the private bucket,
// what the history records, and that nothing about an applicant reaches anyone else.
import { beforeAll, describe, expect, it } from "vitest";
import { handleJobApplication } from "../supabase/functions/_shared/public/application.ts";
import { purgeExpiredApplications } from "../supabase/functions/_shared/public/retention.ts";
import { createHarness, ORIGIN } from "./helpers/harness.js";

let h, alpha, beta, owner, manager, staff, outsider;
const pdf = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n");

let sequence = 0;
// Sends the form as a browser would, and waits for the work that follows the answer.
async function apply(overrides = {}, file = null, slug = "alpha") {
  sequence += 1;
  const fields = {
    restaurant: slug, full_name: `Applicant ${sequence}`, email: `applicant${sequence}@example.test`, phone: `+1 619 555 ${String(1000 + sequence)}`,
    position: "Barista", employment_type: "part_time", availability: ["weekday_days", "late_nights"], start_when: "immediately",
    experience_level: "1_2", experience: "Two years behind an espresso machine.", work_authorized: "yes",
    message: "I live nearby.", consent: "yes", started_at: String(Date.now() - 30_000), company_website: "", ...overrides,
  };
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) for (const entry of [].concat(value)) form.append(key, entry);
  if (file) form.append("cv", file);
  const response = await handleJobApplication(new Request("https://fn.test/job-application", {
    method: "POST", headers: { origin: ORIGIN, "x-forwarded-for": `192.0.2.${sequence}` }, body: form,
  }), h.deps);
  await h.settle();
  return { status: response.status, body: await response.json(), fields };
}
const idOf = async (email) =>
  (await h.pg.query("select id from public.job_applications where email = $1 order by created_at desc limit 1", [email])).rows[0].id;
const cvFile = (name = "resume.pdf") => new File([pdf], name, { type: "application/pdf" });

beforeAll(async () => {
  h = await createHarness();
  alpha = await h.createRestaurant("alpha");
  beta = await h.createRestaurant("beta");
  await h.pg.query("update public.restaurants set name = 'Alpha Kitchen', recruitment_email = 'hiring@alpha.test' where id = $1", [alpha]);
  await h.pg.query("update public.restaurants set recruitment_email = 'hiring@beta.test' where id = $1", [beta]);
  owner = await h.addUser(alpha, "owner");
  manager = await h.addUser(alpha, "manager");
  staff = await h.addUser(alpha, "staff");
  outsider = await h.addUser(beta, "owner");
});

describe("an application, from the form to the dashboard and the inbox", () => {
  let id, sent;

  it("is stored, listed in the dashboard at once, and reported by email with a link to it", async () => {
    const response = await apply({ full_name: "Maya Thompson", email: "Maya.Thompson@Example.test" }, cvFile("Maya Thompson CV.pdf"));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, message: "Thank you. Your application has been received." });
    id = await idOf("maya.thompson@example.test");

    // 1. The dashboard list, with no waiting and no step in between.
    const list = await h.api(owner, "GET", "/applications");
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ total: 1, counts: { new: 1 }, positions: ["Barista"] });
    expect(list.body.applications[0]).toMatchObject({
      id, full_name: "Maya Thompson", position: "Barista", status: "new", has_cv: true,
      employment_type: "part_time", experience_level: "1_2", email_status: "sent",
    });
    expect((await h.api(owner, "GET", "/applications/summary")).body).toEqual({ new: 1, total: 1 });

    // 2. The email, to the inbox named in the database and nowhere else.
    expect(h.sent).toHaveLength(1);
    [sent] = h.sent;
    expect(sent.to).toBe("hiring@alpha.test");
    expect(sent.replyTo).toBe("maya.thompson@example.test");
    expect(sent.subject).toBe("New Job Application — Maya Thompson — Barista");
    expect(sent.text).toContain("NEW JOB APPLICATION for Alpha Kitchen");
    for (const detail of ["Maya Thompson", "Barista", "maya.thompson@example.test", "Part-time", "Weekday days, Late nights", "Immediately", "1 to 2 years", "Uploaded"]) {
      expect(sent.text, detail).toContain(detail);
    }
    expect(sent.html).toContain("New job application");
    expect(sent.attachment).toBeUndefined();

    // 3. The link in the email is this application in the dashboard.
    const link = sent.text.match(/https:\/\/\S+/)[0];
    expect(link).toBe(`${ORIGIN}/dashboard/#/applications/${id}`);
    expect(sent.html).toContain(`href="${link}"`);
  });

  it("shows every answer in the dashboard, and nothing that is of no use to a browser", async () => {
    const { status, body } = await h.api(owner, "GET", `/applications/${id}`);
    expect(status).toBe(200);
    expect(body.application).toMatchObject({
      id, full_name: "Maya Thompson", email: "maya.thompson@example.test", position: "Barista",
      employment_type: "part_time", availability: ["weekday_days", "late_nights"], start_when: "immediately",
      experience_level: "1_2", experience: "Two years behind an espresso machine.", work_authorized: true,
      message: "I live nearby.", status: "new", email_status: "sent", other_applications: 0,
      cv: { name: "Maya-Thompson-CV.pdf", mime: "application/pdf", size: pdf.length },
    });
    expect(body.application.events.map((event) => event.kind)).toEqual(["submitted", "email_sent"]);
    expect(Date.parse(body.application.created_at)).toBeGreaterThan(Date.now() - 60_000);
    // Where the file is stored, and the hash of the applicant's address, never leave the server.
    const everything = JSON.stringify([body, (await h.api(owner, "GET", "/applications")).body]);
    expect(everything).not.toMatch(/cv_path|ip_hash|submission_id|192\.0\.2\./);
    expect(everything).not.toContain(alpha);
    expect(everything).not.toContain("hiring@alpha.test");
  });

  it("hands the CV to a signed-in owner as a download, and records that it was taken", async () => {
    const response = await h.api(owner, "GET", `/applications/${id}/cv`);
    expect(response.status).toBe(200);
    expect([...response.bytes]).toEqual([...pdf]);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="Maya-Thompson-CV.pdf"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");

    const { body } = await h.api(owner, "GET", `/applications/${id}`);
    const download = body.application.events.at(-1);
    expect(download).toMatchObject({ kind: "cv_downloaded", actor_email: owner.email });
    const { rows } = await h.pg.query("select action, entity_id, actor_email from public.audit_logs where action = 'APPLICATION_CV_DOWNLOADED'");
    expect(rows).toEqual([{ action: "APPLICATION_CV_DOWNLOADED", entity_id: id, actor_email: owner.email }]);
  });

  it("moves through the stages, with who changed it, when, and their note", async () => {
    const before = Date.now() - 1000;
    const reviewing = await h.api(owner, "PATCH", `/applications/${id}`, { status: "reviewing" });
    expect(reviewing.status).toBe(200);
    expect(reviewing.body).toMatchObject({ result: "saved", message: "Status changed to Reviewing.", application: { status: "reviewing" } });
    expect(Date.parse(reviewing.body.application.status_changed_at)).toBeGreaterThan(before);

    const interview = await h.api(manager, "PATCH", `/applications/${id}`, { status: "interview", note: "  Thursday at 3 PM.  " });
    expect(interview.body.application.events.at(-1)).toMatchObject({
      kind: "status_changed", from_status: "reviewing", to_status: "interview", note: "Thursday at 3 PM.", actor_email: manager.email,
    });

    // The same stage again changes nothing; with a note it records the note alone.
    const count = interview.body.application.events.length;
    const same = await h.api(owner, "PATCH", `/applications/${id}`, { status: "interview" });
    expect(same.body.message).toBe("Nothing changed.");
    expect(same.body.application.events).toHaveLength(count);
    const noted = await h.api(owner, "PATCH", `/applications/${id}`, { status: "interview", note: "References checked." });
    expect(noted.body.message).toBe("Note added.");
    expect(noted.body.application.events.at(-1)).toMatchObject({ kind: "note", note: "References checked.", from_status: null });

    for (const status of ["shortlisted", "hired", "rejected", "new"]) {
      expect((await h.api(owner, "PATCH", `/applications/${id}`, { status })).body.application.status, status).toBe(status);
    }
    expect((await h.api(owner, "GET", "/applications/summary")).body).toEqual({ new: 1, total: 1 });
  });

  it("refuses a stage that does not exist, a note that is too long, and anything else in the request", async () => {
    for (const body of [{ status: "maybe" }, {}, { status: "hired", note: "x".repeat(501) }, { status: "hired", email: "other@example.test" }, { status: "hired", full_name: "Someone Else" }]) {
      expect((await h.api(owner, "PATCH", `/applications/${id}`, body)).status, JSON.stringify(body).slice(0, 60)).toBe(422);
    }
    expect((await h.api(owner, "GET", `/applications/${id}`)).body.application).toMatchObject({ status: "new", full_name: "Maya Thompson" });
  });

  it("writes the change to the activity log without saying whose application it is", async () => {
    await h.api(owner, "PATCH", `/applications/${id}`, { status: "reviewing", note: "A private note about Maya." });
    const activity = await h.api(owner, "GET", "/activity");
    const entry = activity.body.entries.find((candidate) => candidate.action === "APPLICATION_STATUS_CHANGED");
    expect(entry).toMatchObject({ entity_type: "application", entity_id: id, old_values: { status: "new" }, new_values: { status: "reviewing" } });
    expect(JSON.stringify(activity.body)).not.toMatch(/Maya|maya\.thompson|private note|619 555/);
  });
});

describe("who may read an application", () => {
  let id;

  beforeAll(async () => {
    await apply({ full_name: "Daniel Ortiz", email: "daniel@example.test" }, cvFile());
    id = await idOf("daniel@example.test");
  });

  const routes = () => [
    ["GET", "/applications"], ["GET", "/applications/summary"], ["GET", `/applications/${id}`],
    ["GET", `/applications/${id}/cv`], ["PATCH", `/applications/${id}`, { status: "hired" }],
  ];

  it("nobody without a session, and nobody with a made-up one", async () => {
    for (const [method, path, body] of routes()) {
      expect((await h.api(null, method, path, body)).status, `${method} ${path}`).toBe(401);
      expect((await h.api({ token: "jwt-forged" }, method, path, body)).status, `${method} ${path}`).toBe(401);
    }
  });

  it("not staff: applications are for the people who hire", async () => {
    for (const [method, path, body] of routes()) {
      const response = await h.api(staff, method, path, body);
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(JSON.stringify(response.body)).not.toMatch(/Daniel|daniel@/);
    }
    expect((await h.api(staff, "GET", "/me")).body.permissions).toEqual(["menu.read"]);
  });

  it("owners and managers", async () => {
    for (const user of [owner, manager]) {
      expect((await h.api(user, "GET", `/applications/${id}`)).body.application.full_name).toBe("Daniel Ortiz");
      expect((await h.api(user, "GET", "/me")).body.permissions).toEqual(expect.arrayContaining(["applications.read", "applications.manage"]));
    }
  });

  it("never another restaurant's owner: the application is simply not there", async () => {
    expect((await h.api(outsider, "GET", "/applications")).body).toMatchObject({ total: 0, applications: [], counts: {}, positions: [] });
    expect((await h.api(outsider, "GET", "/applications/summary")).body).toEqual({ new: 0, total: 0 });
    expect((await h.api(outsider, "GET", `/applications/${id}`)).status).toBe(404);
    expect((await h.api(outsider, "GET", `/applications/${id}/cv`)).status).toBe(404);
    expect((await h.api(outsider, "PATCH", `/applications/${id}`, { status: "rejected" })).status).toBe(404);
    // Asking for the other restaurant by name does not help.
    expect((await h.api(outsider, "GET", `/applications/${id}`, undefined, { "x-restaurant-id": alpha })).status).toBe(403);
    expect((await h.api(owner, "GET", `/applications/${id}`)).body.application.status).toBe("new");
  });

  it("not the public: the table and the bucket have no way in but the dashboard API", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const table of ["job_applications", "job_application_events"]) {
        const { rows } = await h.pg.query("select has_table_privilege($1, $2, 'select, insert, update, delete') as open", [role, `public.${table}`]);
        expect(rows[0].open, `${role} on ${table}`).toBe(false);
      }
      for (const fn of ["dash_applications_list(uuid, text, text, text, timestamptz, timestamptz, integer, integer)", "dash_application_get(uuid, uuid)", "dash_application_cv(uuid, uuid)", "job_application_submit(uuid, uuid, jsonb, text)"]) {
        const { rows } = await h.pg.query("select has_function_privilege($1, $2, 'execute') as open", [role, `public.${fn}`]);
        expect(rows[0].open, `${role} on ${fn}`).toBe(false);
      }
    }
    const { rows } = await h.pg.query("select relrowsecurity from pg_class where relname in ('job_applications', 'job_application_events')");
    expect(rows.map((row) => row.relrowsecurity)).toEqual([true, true]);
  });

  it("says so plainly when there is no CV, or the file can no longer be read", async () => {
    await apply({ full_name: "No Resume", email: "noresume@example.test" });
    const without = await idOf("noresume@example.test");
    expect((await h.api(owner, "GET", `/applications/${without}`)).body.application.cv).toBeNull();
    expect((await h.api(owner, "GET", `/applications/${without}/cv`)).body.error.message).toBe("This application has no CV.");

    const path = (await h.pg.query("select cv_path from public.job_applications where id = $1", [id])).rows[0].cv_path;
    const file = h.stored.get(`cvs/${path}`);
    h.stored.delete(`cvs/${path}`);
    const missing = await h.api(owner, "GET", `/applications/${id}/cv`);
    h.stored.set(`cvs/${path}`, file);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("cv_unavailable");
    expect(JSON.stringify(missing.body)).not.toContain(path);
  });

  it("answers an id that is not one, and one that does not exist, without detail", async () => {
    expect((await h.api(owner, "GET", "/applications/not-an-id")).status).toBe(404);
    expect((await h.api(owner, "GET", "/applications/00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await h.api(owner, "GET", "/applications/' or 1=1 --")).status).toBe(404);
  });
});

describe("finding applications", () => {
  let gamma, boss;
  const add = (fullName, email, position, status, daysAgo, phone = "+1 619 555 0000") =>
    h.pg.query(
      `insert into public.job_applications (restaurant_id, full_name, email, phone, position, status, created_at)
       values ($1, $2, $3, $4, $5, $6, now() - make_interval(days => $7))`,
      [gamma, fullName, email, phone, position, status, daysAgo]);
  const list = async (query = "") => (await h.api(boss, "GET", `/applications${query}`)).body;
  const names = async (query) => (await list(query)).applications.map((application) => application.full_name);

  beforeAll(async () => {
    gamma = await h.createRestaurant("gamma");
    boss = await h.addUser(gamma, "owner");
    await add("Ana Reyes", "ana@example.test", "Barista", "new", 0, "+1 619 555 0101");
    await add("Ben Carter", "ben.carter@example.test", "Line Cook", "reviewing", 2);
    await add("Cora 100% Diaz", "cora_diaz@example.test", "Barista", "interview", 5);
    await add("Dev Patel", "dev@example.test", "Head Chef", "hired", 20);
    await add("Eli Novak", "eli@example.test", "Line Cook", "rejected", 40);
  });

  it("lists newest first with the numbers the status buttons show", async () => {
    const body = await list();
    expect(body.total).toBe(5);
    expect(body.applications.map((application) => application.full_name)).toEqual(["Ana Reyes", "Ben Carter", "Cora 100% Diaz", "Dev Patel", "Eli Novak"]);
    expect(body.counts).toEqual({ new: 1, reviewing: 1, interview: 1, hired: 1, rejected: 1 });
    expect(body.positions).toEqual(["Barista", "Head Chef", "Line Cook"]);
    // The list is for finding an application: no contact details, no free text.
    expect(Object.keys(body.applications[0]).sort()).toEqual([
      "created_at", "email_status", "employment_type", "experience_level", "full_name", "has_cv", "id", "position", "status",
    ]);
  });

  it("searches name, email, phone and position, treating % and _ as themselves", async () => {
    expect(await names("?search=carter")).toEqual(["Ben Carter"]);
    expect(await names("?search=ANA%40example")).toEqual(["Ana Reyes"]);
    expect(await names("?search=555+0101")).toEqual(["Ana Reyes"]);
    expect(await names("?search=line+cook")).toEqual(["Ben Carter", "Eli Novak"]);
    expect(await names("?search=100%25")).toEqual(["Cora 100% Diaz"]);
    expect(await names("?search=cora_diaz")).toEqual(["Cora 100% Diaz"]);
    expect(await names("?search=%25")).toEqual(["Cora 100% Diaz"]);
    expect(await names("?search=_")).toEqual(["Cora 100% Diaz"]);
    expect(await names("?search=nobody")).toEqual([]);
  });

  it("filters by status, by position and by the day it arrived, together or apart", async () => {
    expect(await names("?status=interview")).toEqual(["Cora 100% Diaz"]);
    expect(await names("?position=Line+Cook")).toEqual(["Ben Carter", "Eli Novak"]);
    expect(await names("?position=Line+Cook&status=rejected")).toEqual(["Eli Novak"]);

    const daysAgo = (days) => encodeURIComponent(new Date(Date.now() - days * 86_400_000).toISOString());
    expect(await names(`?from=${daysAgo(3)}`)).toEqual(["Ana Reyes", "Ben Carter"]);
    expect(await names(`?to=${daysAgo(10)}`)).toEqual(["Dev Patel", "Eli Novak"]);
    expect(await names(`?from=${daysAgo(30)}&to=${daysAgo(1)}`)).toEqual(["Ben Carter", "Cora 100% Diaz", "Dev Patel"]);
    // The counts are of everything, so the buttons do not change as filters are applied.
    expect((await list("?status=hired")).counts).toEqual({ new: 1, reviewing: 1, interview: 1, hired: 1, rejected: 1 });
  });

  it("pages through the list and reports the total", async () => {
    const first = await list("?limit=2");
    expect(first).toMatchObject({ total: 5, limit: 2, offset: 0 });
    expect(first.applications.map((application) => application.full_name)).toEqual(["Ana Reyes", "Ben Carter"]);
    expect(await names("?limit=2&offset=4")).toEqual(["Eli Novak"]);
    expect((await list("?limit=100")).limit).toBe(100);
  });

  it("refuses filters that are not what they claim to be", async () => {
    for (const query of ["?status=archived", "?from=yesterday", "?to=2026-10-06", "?limit=1000", "?limit=-1", "?offset=x", "?from=2026-13-45T00:00:00Z"]) {
      expect((await h.api(boss, "GET", `/applications${query}`)).status, query).toBe(422);
    }
  });

  it("points out someone who has applied before", async () => {
    await add("Ana Reyes", "ana@example.test", "Line Cook", "new", 0);
    const first = (await list("?search=ana%40example")).applications;
    expect(first).toHaveLength(2);
    expect((await h.api(boss, "GET", `/applications/${first[0].id}`)).body.application.other_applications).toBe(1);
  });
});

describe("the end of an application's life", () => {
  it("is deleted with its CV and its history when the retention period has passed, and is then gone from the dashboard", async () => {
    await apply({ full_name: "Long Ago", email: "longago@example.test" }, cvFile());
    const id = await idOf("longago@example.test");
    await h.api(owner, "PATCH", `/applications/${id}`, { status: "rejected", note: "Position filled." });
    const path = (await h.pg.query("select cv_path from public.job_applications where id = $1", [id])).rows[0].cv_path;
    expect(h.stored.has(`cvs/${path}`)).toBe(true);

    await h.pg.query("update public.job_applications set created_at = now() - interval '181 days' where id = $1", [id]);
    expect(await purgeExpiredApplications(h.deps)).toBeGreaterThanOrEqual(1);

    expect((await h.api(owner, "GET", `/applications/${id}`)).status).toBe(404);
    expect((await h.api(owner, "GET", `/applications/${id}/cv`)).status).toBe(404);
    expect(h.stored.has(`cvs/${path}`)).toBe(false);
    expect((await h.pg.query("select count(*)::int as n from public.job_application_events where application_id = $1", [id])).rows[0].n).toBe(0);
  });
});
