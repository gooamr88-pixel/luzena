import type { CloverEnvironment, Env } from "./types.ts";

const CLOVER_ENVIRONMENTS: CloverEnvironment[] = ["sandbox", "na", "eu", "la"];

export class ConfigError extends Error {}

// Reads configuration from environment variables. Clover and email are optional so the
// public site and dashboard still load before those are set up; the features that need
// them report "not configured" instead of crashing.
export function loadEnv(get: (name: string) => string | undefined): Env {
  const value = (name: string) => {
    const raw = get(name);
    return raw === undefined || raw.trim() === "" ? undefined : raw.trim();
  };

  const allowedOrigins = (value("ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);

  // Which Clover a merchant-token connection talks to. There is no default here on
  // purpose: a production token must never be sent to the sandbox by omission, or the
  // other way round.
  const explicitEnvironment = value("CLOVER_ENV") as CloverEnvironment | undefined;
  if (explicitEnvironment !== undefined && !CLOVER_ENVIRONMENTS.includes(explicitEnvironment)) {
    throw new ConfigError("CLOVER_ENV must be one of sandbox, na, eu, la");
  }

  let clover: Env["clover"] = null;
  const appId = value("CLOVER_APP_ID");
  const appSecret = value("CLOVER_APP_SECRET");
  if (appId && appSecret) {
    const environment = explicitEnvironment ?? "sandbox";
    const redirectUri = value("CLOVER_REDIRECT_URI");
    if (!redirectUri) {
      throw new ConfigError("CLOVER_REDIRECT_URI is required when Clover is configured");
    }
    clover = {
      environment,
      appId,
      appSecret,
      redirectUri,
      webhookAuth: value("CLOVER_WEBHOOK_AUTH") ?? "",
      requireState: (value("CLOVER_REQUIRE_STATE") ?? "true") !== "false",
    };
  }

  const ttl = Number(value("MENU_SYNC_TTL_SECONDS") ?? "300");

  // No default on purpose: how long to keep applicants' personal data is the restaurant's
  // decision, and guessing one here would be making that decision for them.
  const retention = Number(value("JOB_APPLICATION_RETENTION_DAYS") ?? "");
  const retentionDays = Number.isInteger(retention) && retention >= 1 && retention <= 3650 ? retention : null;

  return {
    jobApplications: {
      enabled: value("JOB_APPLICATIONS_ENABLED") === "true",
      retentionDays,
    },
    allowedOrigins,
    clover,
    cloverEnvironment: explicitEnvironment ?? null,
    tokenEncryptionKey: value("TOKEN_ENCRYPTION_KEY") ?? null,
    menuSyncTtlSeconds: Number.isFinite(ttl) && ttl >= 30 ? Math.floor(ttl) : 300,
    ipHashSalt: value("IP_HASH_SALT") ?? "",
    emailFrom: value("EMAIL_FROM") ?? null,
  };
}
