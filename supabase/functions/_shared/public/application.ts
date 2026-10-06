// POST /job-application  (multipart/form-data)
//
// Validates the application, stores the CV in a private bucket and the application in the
// database, and answers the applicant. Only then, after the answer, does it email the
// restaurant that an application has arrived.
//
// The database is the record. The owner reads applications in the dashboard; the email is a
// notification with a link to it. So a failed email never fails an application: it is
// recorded on the application, where the dashboard shows it.
import { sha256Hex } from "../crypto.ts";
import { DOCUMENT_TYPES, hasActiveContent, safeFilename, sniffDocument } from "../files.ts";
import { ApiError, clientIp, corsHeaders, errorBody, isAllowedOrigin, json, newRequestId, preflight } from "../http.ts";
import { errorFields } from "../log.ts";
import type { Deps } from "../types.ts";
import { uuid, ValidationError, v, type Validator } from "../validate.ts";
import { applicationEmail } from "./application-email.ts";
import { AVAILABILITY, EMPLOYMENT_TYPES, EXPERIENCE_LEVELS, START_WHEN } from "./application-fields.ts";
import { purgeExpiredApplications } from "./retention.ts";

export const CV_BUCKET = "cvs";
const MAX_CV_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_CV_BYTES + 64 * 1024;
const MIN_FILL_MS = 3000;
const SLUG = /^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$/;

const text: Record<string, Validator<string>> = {
  full_name: v.string({ min: 2, max: 100 }),
  email: v.string({ min: 5, max: 254, pattern: /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/ }),
  phone: v.string({ min: 7, max: 25, pattern: /^\+?[0-9 ()\-.]{7,25}$/ }),
  position: v.string({ min: 2, max: 100 }),
  experience: v.string({ max: 2000 }),
  message: v.string({ max: 2000 }),
};

const TEXT_LABELS: Record<string, string> = {
  full_name: "Full name", email: "Email", phone: "Phone", position: "Position",
  experience: "Relevant experience", message: "Introduction",
};

// A question answered by picking one choice. Any answer that is not one of the choices,
// including none, gets the same plain request to choose.
const choices: Record<string, { validate: Validator<string>; message: string }> = {
  employment_type: { validate: v.oneOf(EMPLOYMENT_TYPES), message: "Choose full-time, part-time or either." },
  start_when: { validate: v.oneOf(START_WHEN), message: "Choose when you could start." },
  experience_level: { validate: v.oneOf(EXPERIENCE_LEVELS), message: "Choose how much experience you have." },
  work_authorized: { validate: v.oneOf(["yes", "no"]), message: "Answer whether you are authorized to work in the United States." },
};

// Text is line-based and goes into an email: collapse anything that could be read as a
// header or break the layout.
const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();

export async function handleJobApplication(request: Request, deps: Deps): Promise<Response> {
  const requestId = newRequestId();
  const cors = corsHeaders(request, deps.env, "POST, OPTIONS");
  if (request.method === "OPTIONS") return preflight(request, deps.env, "POST, OPTIONS");
  const respond = (status: number, body: unknown) => json(status, body, cors);
  const accepted = () => respond(200, { ok: true, message: "Thank you. Your application has been received." });

  try {
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed.");
    // Browsers always send Origin on a cross-origin POST. Anything else is not our form.
    const origin = request.headers.get("origin");
    if (!isAllowedOrigin(origin, deps.env)) {
      throw new ApiError(403, "forbidden_origin", "This form can only be submitted from the restaurant website.");
    }
    // Applications are personal data. They are accepted only when the operator has switched
    // them on AND set how long they are kept. Checked before anything is read or stored.
    const { enabled, retentionDays } = deps.env.jobApplications;
    if (!enabled || retentionDays === null) {
      if (enabled) deps.log.error("job_applications_misconfigured", { request_id: requestId, reason: "retention_days_not_set" });
      throw new ApiError(503, "applications_closed", "Online applications are not open yet. Please check back soon.");
    }
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
      throw new ApiError(415, "unsupported_media_type", "Submit the form as multipart/form-data.");
    }
    if (Number(request.headers.get("content-length") ?? "0") > MAX_REQUEST_BYTES) {
      throw new ApiError(413, "payload_too_large", "The CV is too large. The maximum size is 5 MB.");
    }

    const ipHash = await sha256Hex(`${deps.env.ipHashSalt}:${clientIp(request)}`);
    const allowed = await deps.db.rpc<boolean>("rate_limit_hit", {
      p_key: `apply:${ipHash}`, p_max: 5, p_window_seconds: 3600,
    });
    if (!allowed) {
      throw new ApiError(429, "rate_limited", "Too many applications from this connection. Please try again later.");
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new ApiError(400, "invalid_form", "The form could not be read.");
    }
    const field = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };

    // Bots fill every field and submit instantly. Both traps answer exactly like a
    // success, so a bot learns nothing.
    const startedAt = Number(field("started_at"));
    if (field("company_website") !== "" || !Number.isFinite(startedAt) || deps.now() - startedAt < MIN_FILL_MS) {
      deps.log.info("job_application_dropped", { request_id: requestId, reason: "bot_trap" });
      return accepted();
    }

    const slug = field("restaurant");
    const restaurant = SLUG.test(slug)
      ? await deps.db.rpc<{ id: string; name: string } | null>("restaurant_public", { p_slug: slug })
      : null;
    if (!restaurant) throw new ApiError(400, "invalid_form", "The form could not be read.");

    // The form makes this id once per page load. Sending it again (a double press, a retry
    // after a lost answer) is the same application, and is answered as received.
    let submissionId: string | null = null;
    if (field("submission_id") !== "") {
      try {
        submissionId = uuid(field("submission_id"), "submission_id").toLowerCase();
      } catch {
        throw new ApiError(400, "invalid_form", "The form could not be read.");
      }
      const already = await deps.db.rpc<boolean>("job_application_exists", {
        p_restaurant: restaurant.id, p_submission: submissionId,
      });
      if (already) {
        deps.log.info("job_application_repeat", { request_id: requestId });
        return accepted();
      }
    }

    const errors: Record<string, string> = {};
    const values: Record<string, string> = {};
    for (const [name, validator] of Object.entries(text)) {
      try {
        values[name] = validator(field(name), name);
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        errors[name] = `${TEXT_LABELS[name]} ${error.message}.`;
      }
    }
    for (const [name, choice] of Object.entries(choices)) {
      try {
        values[name] = choice.validate(field(name), name);
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        errors[name] = choice.message;
      }
    }
    const availability = [...new Set(form.getAll("availability").filter((entry): entry is string => typeof entry === "string"))];
    if (availability.length === 0 || availability.some((entry) => !(AVAILABILITY as readonly string[]).includes(entry))) {
      errors.availability = "Choose at least one time you could work.";
    }
    if (field("consent") !== "yes") errors.consent = "Please confirm that we may contact you about this application.";

    const upload = form.get("cv");
    let cv: { bytes: Uint8Array; filename: string; mime: string; path: string } | null = null;
    if (upload instanceof File && upload.size > 0) {
      if (upload.size > MAX_CV_BYTES) {
        errors.cv = "The CV is too large. The maximum size is 5 MB.";
      } else {
        const bytes = new Uint8Array(await upload.arrayBuffer());
        const kind = sniffDocument(bytes);
        const extension = upload.name.toLowerCase().split(".").pop() ?? "";
        if (!kind || DOCUMENT_TYPES[kind].extension !== extension) {
          // Covers executables, renamed files, and a mismatch between name and content.
          errors.cv = "Upload your CV as a PDF, DOC or DOCX file.";
        } else if (hasActiveContent(bytes, kind)) {
          errors.cv = "This file contains scripts or macros and cannot be accepted. Export it as a plain PDF.";
        } else {
          cv = {
            bytes,
            filename: safeFilename(upload.name, DOCUMENT_TYPES[kind].extension),
            mime: DOCUMENT_TYPES[kind].mime,
            path: `${restaurant.id}/${crypto.randomUUID()}.${DOCUMENT_TYPES[kind].extension}`,
          };
        }
      }
    }
    if (Object.keys(errors).length > 0) {
      throw new ApiError(422, "validation_failed", "Please check the highlighted fields.", { fields: errors });
    }

    // One address cannot fill the list: three applications a day is more than anyone
    // applying in earnest needs. The address is hashed, as the connection is.
    const email = values.email.toLowerCase();
    const emailAllowed = await deps.db.rpc<boolean>("rate_limit_hit", {
      p_key: `apply-email:${await sha256Hex(`${deps.env.ipHashSalt}:${restaurant.id}:${email}`)}`, p_max: 3, p_window_seconds: 86400,
    });
    if (!emailAllowed) {
      throw new ApiError(429, "rate_limited", "We have already received several applications from this email address today. Please try again tomorrow.");
    }

    const fullName = oneLine(values.full_name);
    const position = oneLine(values.position);
    if (cv) await deps.files.upload(CV_BUCKET, cv.path, cv.bytes, cv.mime);
    let saved: { id: string; created: boolean };
    try {
      saved = await deps.db.rpc<{ id: string; created: boolean }>("job_application_submit", {
        p_restaurant: restaurant.id,
        p_submission: submissionId,
        p_data: {
          full_name: fullName, email, phone: values.phone, position,
          employment_type: values.employment_type, availability, start_when: values.start_when,
          experience_level: values.experience_level, experience: values.experience || null,
          work_authorized: values.work_authorized === "yes", message: values.message || null,
          cv_path: cv?.path ?? null, cv_original_name: cv?.filename ?? null,
          cv_mime: cv?.mime ?? null, cv_size: cv?.bytes.length ?? null,
        },
        p_ip_hash: ipHash,
      });
    } catch (error) {
      // Nothing points at the file that was just stored, so it must not stay.
      if (cv) await deps.files.remove(CV_BUCKET, [cv.path]).catch(() => {});
      throw error;
    }
    if (!saved.created) {
      // The same submission arrived twice at once and the other request stored it.
      if (cv) await deps.files.remove(CV_BUCKET, [cv.path]).catch(() => {});
      deps.log.info("job_application_repeat", { request_id: requestId, application_id: saved.id });
      return accepted();
    }
    deps.log.info("job_application_received", { request_id: requestId, application_id: saved.id, has_cv: cv !== null });

    // After the answer: tell the restaurant, then remove applications past the retention
    // period. The applicant does not wait for either, and neither can undo the application.
    deps.waitUntil(notifyRestaurant(deps, requestId, restaurant, {
      id: saved.id, fullName, email, phone: values.phone, position,
      employmentType: values.employment_type, availability, startWhen: values.start_when,
      experienceLevel: values.experience_level, workAuthorized: values.work_authorized === "yes",
      hasCv: cv !== null, hasMessage: values.message !== "",
    }, `${(origin as string).replace(/\/$/, "")}/dashboard/#/applications/${saved.id}`)
      .then(() => purgeExpiredApplications(deps)));
    return accepted();
  } catch (error) {
    if (error instanceof ApiError) return respond(error.status, errorBody(error, requestId));
    deps.log.error("job_application_failed", { request_id: requestId, ...errorFields(error) });
    return respond(500, errorBody(
      new ApiError(500, "internal_error", "We could not submit your application right now. Please try again later."),
      requestId,
    ));
  }
}

// Emails the restaurant's recruitment inbox and records on the application whether that
// worked. The inbox address is read from the database here, server-side, and goes nowhere
// else. This never throws: the application is already stored.
async function notifyRestaurant(
  deps: Deps,
  requestId: string,
  restaurant: { id: string; name: string },
  application: Parameters<typeof applicationEmail>[1],
  dashboardUrl: string,
): Promise<void> {
  const mark = (status: "sent" | "failed") =>
    deps.db.rpc("job_application_set_email_status", { p_id: application.id, p_status: status })
      .catch((error) => deps.log.error("job_application_email_status_failed", { request_id: requestId, ...errorFields(error) }));
  try {
    const recipient = await deps.db.rpc<string | null>("restaurant_recruitment_email", { p_restaurant: restaurant.id });
    if (!deps.email || !recipient) {
      deps.log.error("job_application_email_not_configured", { request_id: requestId, application_id: application.id });
      return void (await mark("failed"));
    }
    await deps.email.send({
      to: recipient,
      replyTo: application.email,
      ...applicationEmail(restaurant.name, application, dashboardUrl),
    });
    await mark("sent");
  } catch (error) {
    deps.log.error("job_application_email_failed", { request_id: requestId, application_id: application.id, ...errorFields(error) });
    await mark("failed");
  }
}
