// Production wiring. This is the only file that touches Deno globals and the Supabase
// client; everything else is plain TypeScript that also runs under Node for tests.
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { createResendSender } from "./email.ts";
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
        return { id: data.user.id, email: data.user.email ?? null };
      },
    },
    email: resendKey && env.emailFrom ? createResendSender(resendKey, env.emailFrom, fetch) : null,
  };

  return { deps, storagePublicBase: `${supabaseUrl}/storage/v1/object/public/menu-images` };
}
