// POST /job-application  (multipart/form-data)
// Validates the application, stores it privately, stores the CV in a private bucket, and
// emails the restaurant's recruitment inbox.
import { sha256Hex } from "../crypto.ts";
import { DOCUMENT_TYPES, hasActiveContent, safeFilename, sniffDocument } from "../files.ts";
import { ApiError, clientIp, corsHeaders, errorBody, isAllowedOrigin, json, newRequestId, preflight } from "../http.ts";
import { errorFields } from "../log.ts";
import type { Deps } from "../types.ts";
import { ValidationError, v } from "../validate.ts";
import { purgeExpiredApplications } from "./retention.ts";

export const CV_BUCKET = "cvs";
const MAX_CV_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_CV_BYTES + 64 * 1024;
const MIN_FILL_MS = 3000;
const SLUG = /^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$/;

const fields = {
  full_name: v.string({ min: 2, max: 100 }),
  email: v.string({ min: 5, max: 254, pattern: /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/ }),
  phone: v.string({ min: 7, max: 25, pattern: /^\+?[0-9 ()\-.]{7,25}$/ }),
  position: v.string({ min: 2, max: 100 }),
  message: v.string({ max: 3000 }),
};

const LABELS: Record<string, string> = {
  full_name: "Full name", email: "Email", phone: "Phone", position: "Position", message: "Message",
};

// Text is line-based and goes into a plain-text email: collapse anything that could be
// read as a header or break the layout.
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
    if (!isAllowedOrigin(request.headers.get("origin"), deps.env)) {
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
    const text = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };

    // Bots fill every field and submit instantly. Both traps answer exactly like a
    // success, so a bot learns nothing.
    const startedAt = Number(text("started_at"));
    if (text("company_website") !== "" || !Number.isFinite(startedAt) || deps.now() - startedAt < MIN_FILL_MS) {
      deps.log.info("job_application_dropped", { request_id: requestId, reason: "bot_trap" });
      return accepted();
    }

    const slug = text("restaurant");
    const restaurant = SLUG.test(slug)
      ? await deps.db.rpc<{ id: string; name: string } | null>("restaurant_public", { p_slug: slug })
      : null;
    if (!restaurant) throw new ApiError(400, "invalid_form", "The form could not be read.");

    const errors: Record<string, string> = {};
    const values: Record<string, string> = {};
    for (const [name, validator] of Object.entries(fields)) {
      try {
        values[name] = validator(text(name), name);
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        errors[name] = `${LABELS[name]} ${error.message}.`;
      }
    }
    if (text("consent") !== "yes") errors.consent = "Please confirm that we may contact you about this application.";

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

    if (cv) await deps.files.upload(CV_BUCKET, cv.path, cv.bytes, cv.mime);
    const applicationId = await deps.db.rpc<string>("job_application_create", {
      p_restaurant: restaurant.id,
      p_full_name: oneLine(values.full_name),
      p_email: values.email.toLowerCase(),
      p_phone: values.phone,
      p_position: oneLine(values.position),
      p_message: values.message || null,
      p_cv_path: cv?.path ?? null,
      p_cv_original_name: cv?.filename ?? null,
      p_cv_mime: cv?.mime ?? null,
      p_cv_size: cv?.bytes.length ?? null,
      p_ip_hash: ipHash,
    });

    const recipient = await deps.db.rpc<string | null>("restaurant_recruitment_email", { p_restaurant: restaurant.id });
    const markEmail = (status: string) =>
      deps.db.rpc("job_application_set_email_status", { p_id: applicationId, p_status: status }).catch(() => {});

    if (!deps.email || !recipient) {
      await markEmail("failed");
      deps.log.error("job_application_email_not_configured", { request_id: requestId, application_id: applicationId });
      throw new ApiError(503, "delivery_unavailable", "We could not send your application right now. Please try again later.");
    }
    try {
      await deps.email.send({
        to: recipient,
        replyTo: values.email.toLowerCase(),
        subject: `Job application: ${oneLine(values.position)} - ${oneLine(values.full_name)}`,
        text: [
          `New job application for ${restaurant.name}`,
          "",
          `Name:     ${oneLine(values.full_name)}`,
          `Email:    ${values.email.toLowerCase()}`,
          `Phone:    ${values.phone}`,
          `Position: ${oneLine(values.position)}`,
          `CV:       ${cv ? `attached (${cv.filename})` : "not provided"}`,
          "",
          "Message:",
          values.message || "(none)",
          "",
          `Reference: ${applicationId}`,
        ].join("\n"),
        attachment: cv ? { filename: cv.filename, contentType: cv.mime, bytes: cv.bytes } : undefined,
      });
    } catch (error) {
      // The application is stored, so it is not lost; the applicant is told to retry
      // because the restaurant has not been notified.
      await markEmail("failed");
      deps.log.error("job_application_email_failed", { request_id: requestId, application_id: applicationId, ...errorFields(error) });
      throw new ApiError(502, "delivery_failed", "We could not send your application right now. Please try again later.");
    }
    await markEmail("sent");
    deps.log.info("job_application_received", { request_id: requestId, application_id: applicationId, has_cv: cv !== null });
    // Housekeeping after the response: remove applications past the retention period.
    deps.waitUntil(purgeExpiredApplications(deps));
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
