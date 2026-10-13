// Production wiring. This is the only file that touches Deno globals and the Supabase
// client; everything else is plain TypeScript that also runs under Node for tests.
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { isExistingAccount } from "./accounts.ts";
import { hasVerifiedFactor, sessionLevel } from "./auth-level.ts";
import { createBrevoSender, createResendSender } from "./email.ts";
import { loadEnv } from "./env.ts";
import { createLogger } from "./log.ts";
import type { Deps } from "./types.ts";

declare const Deno: { env: { get(name: string): string | undefined } };
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

export function createDeps(): { deps: Deps; storagePublicBase: string } {
  const get = (name: string) => Deno.env.get(name);
  const supabaseUrl = get("SUPABASE_URL");
  const serviceRoleKey = get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");

  const env = loadEnv(get);
  const log = createLogger();
  // Service-role client. It bypasses RLS, which is why it exists only here, server-side.
  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const resendKey = get("RESEND_API_KEY");
  // Brevo is the restaurant's provider. Resend is still understood, for a project that has
  // only that key.
  const brevoKey = get("BREVO_API_KEY");

  const deps: Deps = {
    env,
    log,
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random: () => Math.random(),
    waitUntil: (promise) => {
      const guarded = promise.catch((error) => log.error("background_task_failed", { error_message: String(error) }));
      if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(guarded);
    },
    db: {
      async rpc<T>(fn: string, args: Record<string, unknown> = {}) {
        const { data, error } = await client.rpc(fn, args);
        if (error) throw new Error(`Database call ${fn} failed: ${error.message}`);
        return data as T;
      },
    },
    files: {
      async upload(bucket, path, bytes, contentType) {
        const { error } = await client.storage.from(bucket).upload(path, bytes, {
          contentType, upsert: true, cacheControl: "31536000",
        });
        if (error) throw new Error(`Storage upload failed: ${error.message}`);
      },
      async remove(bucket, paths) {
        const { error } = await client.storage.from(bucket).remove(paths);
        if (error) throw new Error(`Storage remove failed: ${error.message}`);
      },
      async download(bucket, path) {
        const { data, error } = await client.storage.from(bucket).download(path);
        // A missing file and a failed read arrive here the same way, so the caller's message
        // covers both.
        if (error || !data) return null;
        return new Uint8Array(await data.arrayBuffer());
      },
    },
    auth: {
      // Verifies the JWT with Supabase Auth and returns the user it belongs to.
      async getUser(jwt) {
        const { data, error } = await client.auth.getUser(jwt);
        if (error || !data.user) return null;
        // Supabase Auth has just verified this token, so what it says about itself can be
        // read. Whether the account has two-step sign-in on comes from Supabase's own
        // record of the account, not from the token.
        return {
          id: data.user.id, email: data.user.email ?? null,
          twoStep: hasVerifiedFactor(data.user.factors), level: sessionLevel(jwt),
          emailVerified: Boolean(data.user.email_confirmed_at),
        };
      },
    },
    // Supabase Auth's admin API, for inviting someone. It is reached with the service role,
    // which is why it is here and nowhere a browser can call it. No password is ever passed:
    // the account is made without one.
    accounts: {
      async ensure(email) {
        const { data, error } = await client.auth.admin.createUser({ email, email_confirm: true });
        if (!error && data.user) return { created: true, id: data.user.id };
        if (isExistingAccount(error)) return { created: false, id: null };
        // The provider's own wording may name the address, so only its code is passed on.
        throw new Error(`Supabase Auth could not make the account (${error?.code ?? error?.status ?? "no answer"})`);
      },
      async hasSignedIn(id) {
        const { data, error } = await client.auth.admin.getUserById(id);
        if (error || !data.user) return true;
        return Boolean(data.user.last_sign_in_at);
      },
      async passwordLink(email, redirectTo) {
        const { data, error } = await client.auth.admin.generateLink({ type: "recovery", email, options: { redirectTo } });
        if (error) return null;
        return data.properties?.action_link ?? null;
      },
    },
    email: !env.emailFrom ? null
      : brevoKey ? createBrevoSender(brevoKey, env.emailFrom, fetch)
      : resendKey ? createResendSender(resendKey, env.emailFrom, fetch)
      : null,
  };

  return { deps, storagePublicBase: `${supabaseUrl}/storage/v1/object/public/menu-images` };
}
