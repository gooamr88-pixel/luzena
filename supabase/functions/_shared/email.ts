// Email through Resend's HTTP API. The API key stays in the function environment.
import type { EmailMessage, EmailSender } from "./types.ts";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function createResendSender(apiKey: string, from: string, fetchFn: typeof fetch): EmailSender {
  return {
    async send(message: EmailMessage) {
      const response = await fetchFn("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
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
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`Email provider responded with status ${response.status}`);
      }
    },
  };
}
