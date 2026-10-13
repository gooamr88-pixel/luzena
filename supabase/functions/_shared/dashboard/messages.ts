// Writing to an applicant from the dashboard.
//
// An owner or manager writes a subject and a message on an application's page; this sends
// it to the applicant under the restaurant's name and keeps the record. What cannot be
// chosen by the request, on purpose:
//   - the recipient. It is the address on the application, read by the database when the
//     record is made. A message can only ever go to the applicant it is about.
//   - the sender. It is the restaurant's configured identity (EMAIL_FROM). A reply the
//     applicant writes goes to the restaurant's recruitment inbox.
//   - the layout. What the staff member types is text. It is put into the email as text,
//     never as markup, and a subject is one line: nothing typed can add a header or a link
//     of its own making.
// Every message is recorded before it is sent, with who wrote it, and afterwards with what
// the provider said. "Sent" means the provider accepted it; "delivered" is only ever shown
// when the provider itself reports that the recipient's mail server took it.
import { ApiError, isAllowedOrigin, json } from "../http.ts";
import { errorFields } from "../log.ts";
import type { Deps, EmailMessage, Session } from "../types.ts";
import { parseBody, v } from "../validate.ts";
import { audit, idempotent } from "./session.ts";
import { type Applicant, statusEmail } from "./status-emails.ts";

export { statusEmail, statusEmails } from "./status-emails.ts";

export const MESSAGE_KINDS = ["reply", "acknowledgment", "interview", "more_information", "status_update"] as const;

const messageBody = v.object({
  kind: v.oneOf(MESSAGE_KINDS),
  subject: v.string({ min: 1, max: 150 }),
  body: v.string({ min: 1, max: 5000 }),
});

interface StoredMessage {
  id: string;
  to_email: string;
  subject: string;
  body: string;
  kind: string;
}
interface MessageRecord {
  message: StoredMessage;
  full_name: string;
  position: string;
}

const restaurantOf = (session: Session) => session.restaurant.restaurant_id;
const notFound = () => new ApiError(404, "not_found", "This application does not exist.");
const oneLine = (value: string) => value.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// The email an applicant receives: the staff member's own words under the restaurant's
// name, with where to find the restaurant and how to answer.
export function applicantEmail(
  restaurantName: string, websiteUrl: string | null, message: { subject: string; body: string },
): Pick<EmailMessage, "subject" | "text" | "html"> {
  const paragraphs = message.body.replace(/\r\n?/g, "\n").split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const foot = [restaurantName, websiteUrl, "You can answer by replying to this email."].filter(Boolean).join("\n");
  // "-- " on a line of its own is how plain-text mail marks where a signature begins.
  const text = [...paragraphs, `-- \n${foot}`].join("\n\n");

  const html = [
    '<!doctype html><html lang="en"><body style="margin:0;padding:0;background:#f6f4f0;font-family:Arial,Helvetica,sans-serif;color:#2b211e;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f4f0;padding:24px 12px;"><tr><td align="center">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e6dfd3;border-radius:12px;overflow:hidden;">',
    '<tr><td style="background:#18120f;padding:22px 28px;">',
    `<p style="margin:0;font-size:20px;color:#ffffff;font-family:Georgia,'Times New Roman',serif;">${escapeHtml(restaurantName)}</p>`,
    "</td></tr>",
    '<tr><td style="padding:26px 28px 10px;">',
    ...paragraphs.map((part) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;">${escapeHtml(part).replace(/\n/g, "<br>")}</p>`),
    "</td></tr>",
    '<tr><td style="padding:16px 28px 24px;border-top:1px solid #e6dfd3;">',
    `<p style="margin:0;font-size:13px;line-height:1.5;color:#6e645c;"><strong style="color:#2b211e;">${escapeHtml(restaurantName)}</strong>`,
    websiteUrl ? `<br><a href="${escapeHtml(websiteUrl)}" style="color:#835f20;">${escapeHtml(websiteUrl.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</a>` : "",
    "<br>You can answer by replying to this email.</p>",
    "</td></tr>",
    "</table></td></tr></table></body></html>",
  ].join("");
  return { subject: oneLine(message.subject), text, html };
}

// The restaurant's website, for the foot of the email: the page the request came from when
// that is one of this backend's own origins, the first of them otherwise.
function websiteOf(request: Request, deps: Deps): string | null {
  const origin = request.headers.get("origin");
  const base = isAllowedOrigin(origin, deps.env) ? (origin as string) : deps.env.allowedOrigins[0];
  return base ? `${base.replace(/\/$/, "")}/` : null;
}

// Hands one recorded message to the provider and records the answer. Never throws: the
// record exists either way, and says which it was.
async function deliver(deps: Deps, session: Session, request: Request, record: MessageRecord): Promise<StoredMessage & { status: string }> {
  const restaurant = restaurantOf(session);
  let sent = false;
  let providerId: string | null = null;
  let detail: string | null = null;
  try {
    if (!deps.email) {
      detail = "Email is not set up for this website yet.";
      deps.log.error("applicant_message_email_not_configured", { request_id: session.requestId, message_id: record.message.id });
    } else {
      const replyTo = await deps.db.rpc<string | null>("restaurant_recruitment_email", { p_restaurant: restaurant });
      const result = await deps.email.send({
        to: record.message.to_email,
        replyTo: replyTo ?? undefined,
        ...applicantEmail(session.restaurant.name, websiteOf(request, deps), record.message),
      });
      sent = true;
      providerId = result?.id ?? null;
    }
  } catch (error) {
    detail = "The email service did not accept the message.";
    deps.log.error("applicant_message_failed", { request_id: session.requestId, message_id: record.message.id, ...errorFields(error) });
  }
  const stored = await deps.db.rpc<(StoredMessage & { status: string }) | null>("dash_application_message_result", {
    p_restaurant: restaurant, p_id: record.message.id, p_sent: sent, p_provider_id: providerId, p_detail: detail,
  });
  return stored ?? { ...record.message, status: sent ? "sent" : "failed" };
}

const outcome = async (deps: Deps, session: Session, applicationId: string, message: StoredMessage & { status: string }) => ({
  result: message.status === "sent" ? "sent" : "failed",
  message,
  messages: await deps.db.rpc("dash_application_messages", { p_restaurant: restaurantOf(session), p_application: applicationId }),
  notice: message.status === "sent"
    ? `Your message has been sent to ${message.to_email}.`
    : "Your message was saved but could not be sent. Nothing reached the applicant. Try again from the list below.",
});

// Records one message and hands it to the provider. The recipient is the application's own
// address, read by the database; null when the application is not this restaurant's.
async function recordAndSend(
  deps: Deps, session: Session, request: Request, applicationId: string, kind: string, subject: string, body: string,
): Promise<(StoredMessage & { status: string }) | null> {
  const record = await deps.db.rpc<MessageRecord | null>("dash_application_message_create", {
    p_restaurant: restaurantOf(session), p_application: applicationId, p_kind: kind, p_subject: subject,
    p_body: body, p_user: session.user.id, p_actor_email: session.user.email,
  });
  return record ? deliver(deps, session, request, record) : null;
}

// Tells the applicant that their application has moved to `status`. Called after the status
// has been saved; never throws for a failed email: the change stands, and the message is
// kept, marked "not sent", to be tried again from the application's page.
export async function notifyStatusChange(
  deps: Deps, session: Session, request: Request, applicationId: string, status: string, application: Applicant,
): Promise<{ result: "sent" | "failed"; to_email: string } | null> {
  const email = statusEmail(status, application, session.restaurant.name);
  if (!email) return null;
  // A subject is at most 150 characters, whatever the position and restaurant are called.
  const message = await recordAndSend(deps, session, request, applicationId, "status_update", oneLine(email.subject).slice(0, 150), email.body);
  if (!message) return null;
  await audit(deps, session, {
    action: "APPLICATION_MESSAGE_SENT", entityType: "application", entityId: applicationId,
    newValues: { kind: "status_update", status: message.status, application_status: status },
    result: message.status === "sent" ? "success" : "failed",
  });
  return { result: message.status === "sent" ? "sent" : "failed", to_email: message.to_email };
}

export function sendApplicantMessage(deps: Deps, session: Session, request: Request, applicationId: string, body: unknown): Promise<Response> {
  const parsed = parseBody(messageBody, body);
  const subject = oneLine(parsed.subject);
  if (subject === "") {
    throw new ApiError(422, "validation_failed", "Some fields need attention.", { fields: { subject: "is required" } });
  }
  // The key the page made for this message: pressing Send twice, or a retry after a lost
  // answer, is the same message and is sent once.
  return idempotent(deps, session, request, `applicant-message:${applicationId}`, { ...parsed, subject }, async () => {
    const message = await recordAndSend(deps, session, request, applicationId, parsed.kind, subject, parsed.body);
    if (!message) throw notFound();
    // The audit log says that a message was written and whether it went. Not to whom and
    // not what it said: the activity page is open to people who may not read applications.
    await audit(deps, session, {
      action: "APPLICATION_MESSAGE_SENT", entityType: "application", entityId: applicationId,
      newValues: { kind: parsed.kind, status: message.status }, result: message.status === "sent" ? "success" : "failed",
    });
    return { status: 200, body: await outcome(deps, session, applicationId, message) };
  });
}

export async function retryApplicantMessage(deps: Deps, session: Session, request: Request, applicationId: string, messageId: string): Promise<Response> {
  const record = await deps.db.rpc<MessageRecord | null>("dash_application_message_retry", {
    p_restaurant: restaurantOf(session), p_application: applicationId, p_id: messageId,
  });
  // Also the answer for a message that went: one that was sent is never sent again.
  if (!record) throw new ApiError(409, "not_retryable", "This message cannot be sent again: it is not one that failed.");
  const message = await deliver(deps, session, request, record);
  await audit(deps, session, {
    action: "APPLICATION_MESSAGE_SENT", entityType: "application", entityId: applicationId,
    newValues: { kind: message.kind, status: message.status, retry: true }, result: message.status === "sent" ? "success" : "failed",
  });
  return json(200, await outcome(deps, session, applicationId, message));
}

// An application's messages, after asking the provider what became of the ones it has
// accepted and not yet answered for. A provider that cannot be asked, or does not answer,
// changes nothing: the message stays "sent", which is all that is known.
export async function applicationMessages(deps: Deps, session: Session, applicationId: string): Promise<unknown[]> {
  const restaurant = restaurantOf(session);
  const email = deps.email;
  if (email?.status) {
    const unsettled = await deps.db.rpc<{ id: string; provider_message_id: string }[]>("dash_application_messages_unsettled", {
      p_restaurant: restaurant, p_application: applicationId,
    });
    await Promise.all(unsettled.map(async (entry) => {
      try {
        const found = await (email.status as NonNullable<typeof email.status>)(entry.provider_message_id);
        await deps.db.rpc("dash_application_message_delivery", {
          p_restaurant: restaurant, p_id: entry.id, p_status: found?.status ?? null, p_detail: found?.detail ?? null,
        });
      } catch (error) {
        deps.log.warn("applicant_message_status_unavailable", { request_id: session.requestId, message_id: entry.id, ...errorFields(error) });
      }
    }));
  }
  return deps.db.rpc<unknown[]>("dash_application_messages", { p_restaurant: restaurant, p_application: applicationId });
}
