// Email through a provider's HTTP API. The API key stays in the function environment.
//
// Two providers are supported behind one interface (EmailSender): Brevo, which the
// restaurant uses, and Resend, which came first. Which one is used is decided in runtime.ts
// by which key is set. Both are asked over HTTPS: an Edge Function is not allowed to open
// the ports SMTP uses.
//
// A provider that answers "accepted" has taken a message, not delivered it. `status` asks
// what happened next, and is what the dashboard shows as "delivered".
import type { DeliveryStatus, EmailMessage, EmailSender } from "./types.ts";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// "Luzena Restaurant & Cafe <careers@luzenarestaurant.com>" -> its two parts. An address on
// its own has no name.
export function parseSender(from: string): { name?: string; email: string } {
  const match = /^\s*(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(from);
  if (!match) return { email: from.trim() };
  const name = match[1].replace(/^"(.*)"$/, "$1").trim();
  return name ? { name, email: match[2] } : { email: match[2] };
}

const refused = async (response: Response): Promise<never> => {
  await response.body?.cancel().catch(() => {});
  throw new Error(`Email provider responded with status ${response.status}`);
};

export function createResendSender(apiKey: string, from: string, fetchFn: typeof fetch): EmailSender {
  const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
  return {
    async send(message: EmailMessage) {
      const response = await fetchFn("https://api.resend.com/emails", {
        method: "POST",
        headers,
        body: JSON.stringify({
          from,
          to: [message.to],
          reply_to: message.replyTo,
          subject: message.subject,
          text: message.text,
          html: message.html,
          attachments: message.attachment
            ? [{ filename: message.attachment.filename, content: toBase64(message.attachment.bytes) }]
            : undefined,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return refused(response);
      const body = await response.json().catch(() => null) as { id?: unknown } | null;
      return { id: typeof body?.id === "string" ? body.id : null };
    },
    async status(id: string): Promise<DeliveryStatus | null> {
      const response = await fetchFn(`https://api.resend.com/emails/${encodeURIComponent(id)}`, { headers, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return refused(response);
      const body = await response.json().catch(() => null) as { last_event?: unknown } | null;
      const event = typeof body?.last_event === "string" ? body.last_event : "";
      // Resend gives only the latest event. A message that was opened was delivered first.
      if (event === "delivered" || event === "opened" || event === "clicked") return { status: "delivered", detail: null };
      if (event === "bounced") return { status: "bounced", detail: "The recipient's mail server refused the message." };
      if (event === "complained" || event === "canceled") return { status: "blocked", detail: `The message was not delivered (${event}).` };
      return null;
    },
  };
}

// What Brevo calls each thing that can happen to a message, and what it means here. Events
// that settle nothing (requests, deferred, opened, clicks) are left out.
const BREVO_EVENTS: Record<string, DeliveryStatus> = {
  delivered: { status: "delivered", detail: null },
  hardBounces: { status: "bounced", detail: "The address does not exist or does not accept mail." },
  softBounces: { status: "bounced", detail: "The recipient's mail server refused the message for now (a full mailbox, for example)." },
  blocked: { status: "blocked", detail: "The provider did not send to this address: it is on its block list." },
  invalid: { status: "blocked", detail: "The address is not a valid email address." },
  spam: { status: "blocked", detail: "The recipient marked an earlier message as spam." },
  error: { status: "blocked", detail: "The provider could not send the message." },
};
// A message can have several events; the one that says most wins.
const BREVO_ORDER = ["hardBounces", "blocked", "invalid", "spam", "error", "delivered", "softBounces"];

export function createBrevoSender(apiKey: string, from: string, fetchFn: typeof fetch): EmailSender {
  const headers = { "api-key": apiKey, "content-type": "application/json", accept: "application/json" };
  return {
    async send(message: EmailMessage) {
      const response = await fetchFn("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers,
        body: JSON.stringify({
          sender: parseSender(from),
          to: [{ email: message.to }],
          replyTo: message.replyTo ? { email: message.replyTo } : undefined,
          subject: message.subject,
          textContent: message.text,
          htmlContent: message.html,
          attachment: message.attachment
            ? [{ name: message.attachment.filename, content: toBase64(message.attachment.bytes) }]
            : undefined,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return refused(response);
      const body = await response.json().catch(() => null) as { messageId?: unknown } | null;
      return { id: typeof body?.messageId === "string" ? body.messageId : null };
    },
    async status(id: string): Promise<DeliveryStatus | null> {
      const url = `https://api.brevo.com/v3/smtp/statistics/events?limit=50&messageId=${encodeURIComponent(id)}`;
      const response = await fetchFn(url, { headers, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return refused(response);
      const body = await response.json().catch(() => null) as { events?: { event?: unknown; reason?: unknown }[] } | null;
      const seen = (body?.events ?? []).filter((entry) => typeof entry?.event === "string");
      for (const name of BREVO_ORDER) {
        const found = seen.find((entry) => entry.event === name);
        if (found) {
          const reason = typeof found.reason === "string" && found.reason.trim() ? found.reason.trim().slice(0, 200) : null;
          return { status: BREVO_EVENTS[name].status, detail: reason ?? BREVO_EVENTS[name].detail };
        }
      }
      return null;
    },
  };
}
