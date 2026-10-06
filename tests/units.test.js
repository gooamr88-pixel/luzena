import { describe, expect, it } from "vitest";
import { buildAuthorizeUrl, parseTokenResponse } from "../supabase/functions/_shared/clover/auth.ts";
import { buildUrl, cloverFetch } from "../supabase/functions/_shared/clover/client.ts";
import { CloverError } from "../supabase/functions/_shared/clover/errors.ts";
import { buildSyncPayload, elementsOf, normalizeItem } from "../supabase/functions/_shared/clover/normalize.ts";
import { decryptSecret, encryptSecret, randomToken, timingSafeEqual } from "../supabase/functions/_shared/crypto.ts";
import { ConfigError, loadEnv } from "../supabase/functions/_shared/env.ts";
import { hasActiveContent, safeFilename, sniffDocument, sniffImage } from "../supabase/functions/_shared/files.ts";
import { createLogger, redact } from "../supabase/functions/_shared/log.ts";
import { parseBody, v } from "../supabase/functions/_shared/validate.ts";

const ok = (body) => new Response(JSON.stringify(body), { status: 200 });
const status = (code, headers = {}) => new Response("{}", { status: code, headers });

function client(responses) {
  const sleeps = [];
  let calls = 0;
  const deps = {
    fetch: async () => {
      const next = responses[calls++];
      if (next instanceof Error) throw next;
      return next;
    },
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0,
    log: createLogger({}, () => {}),
  };
  const run = (call) => cloverFetch(deps, "https://apisandbox.dev.clover.com", "token", call, "corr");
  return { run, sleeps, calls: () => calls };
}

const timeout = () => Object.assign(new Error("t"), { name: "TimeoutError" });

describe("Clover client retry policy", () => {
  it("retries a read through server errors with growing waits", async () => {
    const c = client([status(500), status(502), ok({ elements: [] })]);
    expect(await c.run({ method: "GET", path: "/x", retry: "read" })).toEqual({ elements: [] });
    expect(c.sleeps).toEqual([1000, 2000]);
  });

  it("gives up after three attempts", async () => {
    const c = client([status(500), status(500), status(500), ok({})]);
    await expect(c.run({ method: "GET", path: "/x", retry: "read" })).rejects.toMatchObject({ kind: "unavailable" });
    expect(c.calls()).toBe(3);
  });

  it("honours Retry-After on 429", async () => {
    const c = client([status(429, { "retry-after": "3" }), ok({})]);
    await c.run({ method: "GET", path: "/x", retry: "read" });
    expect(c.sleeps).toEqual([3000]);
  });

  it("never repeats a create after a server error or a timeout", async () => {
    for (const failure of [status(500), timeout()]) {
      const c = client([failure, ok({})]);
      await expect(c.run({ method: "POST", path: "/items", body: {}, retry: "create" }))
        .rejects.toMatchObject({ outcomeUnknown: true });
      expect(c.calls()).toBe(1);
    }
  });

  it("does repeat a create after 429, which Clover did not process", async () => {
    const c = client([status(429), ok({ id: "X" })]);
    expect(await c.run({ method: "POST", path: "/items", body: {}, retry: "create" })).toEqual({ id: "X" });
  });

  it("does not retry client errors and classifies them", async () => {
    for (const [code, kind] of [[400, "bad_request"], [401, "unauthorized"], [403, "forbidden"], [404, "not_found"]]) {
      const c = client([status(code), ok({})]);
      await expect(c.run({ method: "GET", path: "/x", retry: "read" })).rejects.toMatchObject({ kind, outcomeUnknown: false });
      expect(c.calls()).toBe(1);
    }
  });

  it("flags a failed write as unknown and a failed read as known", async () => {
    await expect(client([timeout(), timeout(), timeout()]).run({ method: "POST", path: "/x", body: {}, retry: "idempotent" }))
      .rejects.toMatchObject({ kind: "timeout", outcomeUnknown: true });
    await expect(client([timeout(), timeout(), timeout()]).run({ method: "GET", path: "/x", retry: "read" }))
      .rejects.toMatchObject({ kind: "timeout", outcomeUnknown: false });
  });

  it("rejects a non-JSON success body", async () => {
    const c = client([new Response("<html>", { status: 200 })]);
    await expect(c.run({ method: "GET", path: "/x", retry: "read" })).rejects.toBeInstanceOf(CloverError);
  });

  it("encodes query values, including repeated filters", () => {
    const url = buildUrl("https://api.clover.com", { path: "/v3/merchants/M/items", query: { expand: "categories,modifierGroups", filter: ["name=A&B", "modifiedTime>=5"] } });
    expect(url).toBe("https://api.clover.com/v3/merchants/M/items?expand=categories%2CmodifierGroups&filter=name%3DA%26B&filter=modifiedTime%3E%3D5");
  });
});

describe("Clover OAuth helpers", () => {
  const clover = { environment: "na", appId: "APP", appSecret: "SECRET", redirectUri: "https://site.test/dashboard/", webhookAuth: "", requireState: true };

  it("builds the authorize URL for the right region without the secret", () => {
    const url = new URL(buildAuthorizeUrl(clover, "nonce-1"));
    expect(url.origin + url.pathname).toBe("https://www.clover.com/oauth/v2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "APP", redirect_uri: "https://site.test/dashboard/", response_type: "code", state: "nonce-1",
    });
  });

  it("reads expirations given in seconds or milliseconds", () => {
    const seconds = parseTokenResponse({ access_token: "a", refresh_token: "r", access_token_expiration: 1_800_000_000, refresh_token_expiration: 1_900_000_000 });
    expect(seconds.accessExpiresAt).toBe(1_800_000_000_000);
    const millis = parseTokenResponse({ access_token: "a", refresh_token: "r", access_token_expiration: 1_800_000_000_000 });
    expect(millis.accessExpiresAt).toBe(1_800_000_000_000);
    expect(millis.refreshExpiresAt).toBeNull();
  });

  it("rejects a token response that lacks a field", () => {
    expect(() => parseTokenResponse({ access_token: "a" })).toThrow(CloverError);
    expect(() => parseTokenResponse(null)).toThrow(CloverError);
  });
});

describe("normalising Clover data", () => {
  it("unwraps element lists in every documented shape", () => {
    expect(elementsOf({ elements: [1] })).toEqual([1]);
    expect(elementsOf([2])).toEqual([2]);
    expect(elementsOf(undefined)).toEqual([]);
    expect(elementsOf({ elements: "x" })).toEqual([]);
  });

  it("maps an item and defaults missing flags safely", () => {
    const item = normalizeItem({
      id: "ABCDEFGHJKLMN", name: "  Burger ", price: 1250, priceType: "PER_UNIT", unitName: "lb",
      categories: { elements: [{ id: "CATEGORY00001" }, { id: "bad" }] },
    }, { categories: true, modifierGroups: true });
    expect(item).toEqual({
      id: "ABCDEFGHJKLMN", name: "Burger", price_cents: 1250, price_type: "PER_UNIT", unit_name: "lb",
      hidden: false, available: true, modified_time: null,
      category_ids: ["CATEGORY00001"], modifier_group_ids: [],
    });
  });

  it("leaves links alone when the associations were not expanded", () => {
    const item = normalizeItem({ id: "ABCDEFGHJKLMN", name: "Burger", price: 1 }, { categories: false, modifierGroups: false });
    expect(item).not.toHaveProperty("category_ids");
    expect(item).not.toHaveProperty("modifier_group_ids");
  });

  it("drops malformed and deleted entries and counts only the malformed ones", () => {
    const { payload, skipped } = buildSyncPayload({
      categories: [{ id: "CATEGORY00001", name: "A", sortOrder: 2 }, { id: "short", name: "B" }],
      items: [
        { id: "ITEM000000001", name: "Ok", price: 100 },
        { id: "ITEM000000002", name: "", price: 100 },
        { id: "ITEM000000003", name: "Gone", price: 100, deleted: true },
        { id: "ITEM000000004", name: "Odd price", price: "12.5" },
        "garbage",
      ],
      modifierGroups: [{ id: "GROUP00000001", name: "G", modifiers: { elements: [{ id: "MODIFIER00001", name: "M", price: 50 }, { name: "no id" }] } }],
    });
    expect(payload.categories.map((c) => c.id)).toEqual(["CATEGORY00001"]);
    expect(payload.items.map((i) => i.id)).toEqual(["ITEM000000001", "ITEM000000004"]);
    expect(payload.items[1].price_cents).toBeNull();
    expect(payload.modifier_groups[0].modifiers).toEqual([{ id: "MODIFIER00001", name: "M", price_cents: 50, available: true }]);
    expect(skipped).toBe(3);
  });
});

describe("secrets", () => {
  const key = Buffer.alloc(32, 1).toString("base64");

  it("round-trips and never produces the same ciphertext twice", async () => {
    const a = await encryptSecret("token-value", key);
    const b = await encryptSecret("token-value", key);
    expect(a).not.toBe(b);
    expect(a).not.toContain("token-value");
    expect(await decryptSecret(a, key)).toBe("token-value");
  });

  it("fails on a tampered ciphertext or the wrong key", async () => {
    const sealed = await encryptSecret("token-value", key);
    const tampered = sealed.slice(0, -2) + (sealed.endsWith("AA") ? "BB" : "AA");
    await expect(decryptSecret(tampered, key)).rejects.toThrow();
    await expect(decryptSecret(sealed, Buffer.alloc(32, 2).toString("base64"))).rejects.toThrow();
  });

  it("refuses a key of the wrong length", async () => {
    await expect(encryptSecret("x", Buffer.alloc(16).toString("base64"))).rejects.toThrow(/32 bytes/);
  });

  it("compares strings safely and generates unguessable tokens", async () => {
    expect(await timingSafeEqual("abc", "abc")).toBe(true);
    expect(await timingSafeEqual("abc", "abd")).toBe(false);
    expect(await timingSafeEqual("", "abc")).toBe(false);
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(randomToken());
  });
});

describe("logging", () => {
  it("redacts credentials at any depth", () => {
    expect(redact({ access_token: "a", nested: { client_secret: "s", ok: 1 }, list: [{ Authorization: "Bearer x" }], code: "c", error_code: "kept" }))
      .toEqual({ access_token: "[redacted]", nested: { client_secret: "[redacted]", ok: 1 }, list: [{ Authorization: "[redacted]" }], code: "[redacted]", error_code: "kept" });
  });
});

describe("configuration", () => {
  it("treats Clover as unconfigured until both app id and secret are set", () => {
    expect(loadEnv(() => undefined).clover).toBeNull();
    expect(loadEnv((n) => ({ CLOVER_APP_ID: "x" })[n]).clover).toBeNull();
  });

  it("requires a redirect URI and a valid environment", () => {
    expect(() => loadEnv((n) => ({ CLOVER_APP_ID: "x", CLOVER_APP_SECRET: "y" })[n])).toThrow(ConfigError);
    expect(() => loadEnv((n) => ({ CLOVER_APP_ID: "x", CLOVER_APP_SECRET: "y", CLOVER_REDIRECT_URI: "https://a", CLOVER_ENV: "prod" })[n])).toThrow(ConfigError);
  });

  it("requires state by default and normalises origins", () => {
    const env = loadEnv((n) => ({ CLOVER_APP_ID: "x", CLOVER_APP_SECRET: "y", CLOVER_REDIRECT_URI: "https://a", ALLOWED_ORIGINS: "https://a.test/, https://b.test" })[n]);
    expect(env.clover.requireState).toBe(true);
    expect(env.clover.environment).toBe("sandbox");
    expect(env.allowedOrigins).toEqual(["https://a.test", "https://b.test"]);
  });
});

describe("file inspection", () => {
  const bytes = (text) => new TextEncoder().encode(text);

  it("identifies documents by content", () => {
    expect(sniffDocument(bytes("%PDF-1.4 ..."))).toBe("pdf");
    expect(sniffDocument(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe("doc");
    expect(sniffDocument(new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...bytes("word/document.xml")]))).toBe("docx");
    expect(sniffDocument(new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...bytes("evil.exe")]))).toBeNull();
    expect(sniffDocument(new Uint8Array([0x4d, 0x5a]))).toBeNull();
    expect(sniffDocument(bytes("#!/bin/sh"))).toBeNull();
  });

  it("flags scripts and macros", () => {
    expect(hasActiveContent(bytes("%PDF-1.4 /JavaScript"), "pdf")).toBe(true);
    expect(hasActiveContent(bytes("%PDF-1.4 /Launch"), "pdf")).toBe(true);
    expect(hasActiveContent(bytes("%PDF-1.4 plain"), "pdf")).toBe(false);
    expect(hasActiveContent(bytes("PK word/vbaProject.bin"), "docx")).toBe(true);
  });

  it("identifies images by content", () => {
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("png");
    expect(sniffImage(bytes("<svg onload=alert(1)>"))).toBeNull();
  });

  it("makes filenames safe", () => {
    expect(safeFilename("../../etc/passwd", "pdf")).toBe("passwd.pdf");
    expect(safeFilename("C:\\Users\\x\\résumé final.docx", "docx")).toBe("resume-final.docx");
    expect(safeFilename("\r\nBcc: a@b.c", "pdf")).toBe("Bcc-ab.pdf");
    expect(safeFilename("...", "pdf")).toBe("file.pdf");
  });
});

describe("request validation", () => {
  const schema = v.object({ name: v.string({ min: 1, max: 5 }), count: v.optional(v.int({ min: 0, max: 9 })) });

  it("accepts valid input and trims text", () => {
    expect(parseBody(schema, { name: " ab " })).toEqual({ name: "ab" });
  });

  it("rejects unknown keys, wrong types and control characters", () => {
    for (const body of [{ name: "ab", extra: 1 }, { name: 5 }, { name: "a\u0000b" }, { name: "ab", count: 1.5 }, { name: "ab", count: "1" }, null, []]) {
      expect(() => parseBody(schema, body), JSON.stringify(body)).toThrow();
    }
  });

  it("reports the failing field", () => {
    try {
      parseBody(schema, { name: "toolong" });
    } catch (error) {
      expect(error.status).toBe(422);
      expect(error.extra.fields).toEqual({ name: "must be at most 5 characters" });
    }
  });
});
