// The two email providers behind one interface: what is sent to each, where the API key
// goes, what counts as accepted, and how each provider's own report of what happened to a
// message is read. No request leaves the machine: `fetch` is a stand-in that records what
// it was asked and answers what the test tells it to.
import { describe, expect, it } from "vitest";
import { createBrevoSender, createResendSender, parseSender } from "../supabase/functions/_shared/email.ts";

const KEY = "provider-api-key-for-tests";
const FROM = "Luzena Restaurant & Cafe <careers@luzenarestaurant.com>";
const MESSAGE = { to: "applicant@example.test", replyTo: "hiring@example.test", subject: "Hello", text: "Plain words", html: "<p>Plain words</p>" };

// Answers each request with the next of `answers`: [status, body].
function recorder(...answers) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null });
    const [status, body] = answers[Math.min(calls.length, answers.length) - 1];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return { calls, fetchFn };
}

describe("the sender's name and address", () => {
  it("are read from one line, as mail programs write it", () => {
    expect(parseSender(FROM)).toEqual({ name: "Luzena Restaurant & Cafe", email: "careers@luzenarestaurant.com" });
    expect(parseSender('"Luzena, Restaurant" <a@b.test>')).toEqual({ name: "Luzena, Restaurant", email: "a@b.test" });
    expect(parseSender("  careers@luzenarestaurant.com ")).toEqual({ email: "careers@luzenarestaurant.com" });
    expect(parseSender("<careers@luzenarestaurant.com>")).toEqual({ email: "careers@luzenarestaurant.com" });
  });
});

describe("Brevo", () => {
  it("is handed a message with the restaurant as sender, and answers with the message's id", async () => {
    const { calls, fetchFn } = recorder([201, { messageId: "<2026.abc@smtp-relay.mailin.fr>" }]);
    const result = await createBrevoSender(KEY, FROM, fetchFn).send(MESSAGE);
    expect(result).toEqual({ id: "<2026.abc@smtp-relay.mailin.fr>" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "https://api.brevo.com/v3/smtp/email", method: "POST" });
    expect(calls[0].headers).toMatchObject({ "api-key": KEY, "content-type": "application/json" });
    expect(calls[0].body).toEqual({
      sender: { name: "Luzena Restaurant & Cafe", email: "careers@luzenarestaurant.com" },
      to: [{ email: "applicant@example.test" }], replyTo: { email: "hiring@example.test" },
      subject: "Hello", textContent: "Plain words", htmlContent: "<p>Plain words</p>",
    });
    // The key travels in its header and nowhere else.
    expect(calls[0].url).not.toContain(KEY);
    expect(JSON.stringify(calls[0].body)).not.toContain(KEY);
  });

  it("sends an attachment as the file's own bytes, and leaves out what a message does not have", async () => {
    const { calls, fetchFn } = recorder([201, { messageId: "id-1" }]);
    const bytes = new Uint8Array(70_000).map((_, index) => index % 251);
    await createBrevoSender(KEY, FROM, fetchFn).send({ to: "owner@example.test", subject: "S", text: "T", html: "<p>T</p>", attachment: { filename: "cv.pdf", bytes } });
    expect(calls[0].body.replyTo).toBeUndefined();
    expect(calls[0].body.attachment).toHaveLength(1);
    expect(calls[0].body.attachment[0].name).toBe("cv.pdf");
    expect(new Uint8Array(Buffer.from(calls[0].body.attachment[0].content, "base64"))).toEqual(bytes);
  });

  it("does not count a refusal as sent, and does not repeat the provider's answer or the key", async () => {
    for (const status of [400, 401, 403, 429, 500]) {
      const { fetchFn } = recorder([status, { code: "unauthorized", message: `Key not found ${KEY}` }]);
      const failure = await createBrevoSender(KEY, FROM, fetchFn).send(MESSAGE).catch((error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toBe(`Email provider responded with status ${status}`);
      expect(failure.message).not.toContain(KEY);
    }
    // Accepted, but with an answer that cannot be read: sent, with no id to ask about later.
    const { fetchFn } = recorder([201, "not json"]);
    expect(await createBrevoSender(KEY, FROM, fetchFn).send(MESSAGE)).toEqual({ id: null });
  });

  const status = async (events) => {
    const { calls, fetchFn } = recorder([200, events === undefined ? {} : { events }]);
    const found = await createBrevoSender(KEY, FROM, fetchFn).status("<id@brevo>");
    return { found, call: calls[0] };
  };

  it("asks what became of one message, by its id", async () => {
    const { found, call } = await status([{ event: "requests" }, { event: "delivered" }]);
    expect(found).toEqual({ status: "delivered", detail: null });
    expect(call.method).toBe("GET");
    expect(call.url).toBe("https://api.brevo.com/v3/smtp/statistics/events?limit=50&messageId=%3Cid%40brevo%3E");
    expect(call.headers).toMatchObject({ "api-key": KEY });
  });

  it("says 'delivered' only when the provider reports a delivery", async () => {
    // Accepted, queued, deferred, even opened: none of these is the provider saying that
    // the recipient's mail server took the message.
    for (const events of [undefined, [], [{ event: "requests" }], [{ event: "requests" }, { event: "deferred" }], [{ event: "opened" }, { event: "clicks" }], [{ event: 7 }, null, {}]]) {
      expect((await status(events)).found, JSON.stringify(events)).toBeNull();
    }
    expect((await status([{ event: "requests" }, { event: "deferred" }, { event: "delivered" }, { event: "opened" }])).found).toEqual({ status: "delivered", detail: null });
  });

  it("reports a message that did not arrive, with the provider's reason when it gives one", async () => {
    expect((await status([{ event: "requests" }, { event: "hardBounces", reason: " 550 5.1.1 user unknown " }])).found).toEqual({ status: "bounced", detail: "550 5.1.1 user unknown" });
    expect((await status([{ event: "softBounces" }])).found).toEqual({ status: "bounced", detail: "The recipient's mail server refused the message for now (a full mailbox, for example)." });
    expect((await status([{ event: "blocked" }])).found.status).toBe("blocked");
    expect((await status([{ event: "invalid" }])).found.status).toBe("blocked");
    expect((await status([{ event: "spam" }])).found.status).toBe("blocked");
    expect((await status([{ event: "error", reason: "x".repeat(500) }])).found).toEqual({ status: "blocked", detail: "x".repeat(200) });
    // A refusal that is final outweighs a delivery report beside it; a delivery outweighs
    // an earlier refusal that was only for the moment.
    expect((await status([{ event: "delivered" }, { event: "hardBounces" }])).found.status).toBe("bounced");
    expect((await status([{ event: "softBounces" }, { event: "delivered" }])).found.status).toBe("delivered");
  });

  it("throws when the provider cannot be asked, so that nothing is concluded from silence", async () => {
    const { fetchFn } = recorder([401, { message: "Key not found" }]);
    await expect(createBrevoSender(KEY, FROM, fetchFn).status("id")).rejects.toThrow("Email provider responded with status 401");
  });
});

describe("Resend", () => {
  it("is handed the same message in its own shape, and answers with the message's id", async () => {
    const { calls, fetchFn } = recorder([200, { id: "re_123" }]);
    expect(await createResendSender(KEY, FROM, fetchFn).send(MESSAGE)).toEqual({ id: "re_123" });
    expect(calls[0]).toMatchObject({ url: "https://api.resend.com/emails", method: "POST" });
    expect(calls[0].headers).toMatchObject({ authorization: `Bearer ${KEY}` });
    expect(calls[0].body).toEqual({ from: FROM, to: ["applicant@example.test"], reply_to: "hiring@example.test", subject: "Hello", text: "Plain words", html: "<p>Plain words</p>" });
  });

  it("does not count a refusal as sent", async () => {
    const { fetchFn } = recorder([422, { message: "domain not verified" }]);
    await expect(createResendSender(KEY, FROM, fetchFn).send(MESSAGE)).rejects.toThrow("Email provider responded with status 422");
  });

  it("says 'delivered' only when the provider's last word on the message is a delivery", async () => {
    const ask = async (lastEvent) => {
      const { calls, fetchFn } = recorder([200, lastEvent === undefined ? {} : { last_event: lastEvent }]);
      const found = await createResendSender(KEY, FROM, fetchFn).status("re_1/2");
      expect(calls[0].url).toBe("https://api.resend.com/emails/re_1%2F2");
      return found;
    };
    expect(await ask("delivered")).toEqual({ status: "delivered", detail: null });
    // Resend reports only the latest event: one that was opened had been delivered.
    expect(await ask("opened")).toEqual({ status: "delivered", detail: null });
    expect(await ask("clicked")).toEqual({ status: "delivered", detail: null });
    expect((await ask("bounced")).status).toBe("bounced");
    expect((await ask("complained")).status).toBe("blocked");
    for (const event of [undefined, "sent", "queued", "delivery_delayed", "scheduled", 5]) expect(await ask(event), String(event)).toBeNull();
  });
});
