// Ports the handlers depend on. Production adapters live in runtime.ts (Deno only);
// tests provide PGlite and in-memory implementations.

export interface Db {
  rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T>;
}

export interface FileStore {
  upload(bucket: string, path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  remove(bucket: string, paths: string[]): Promise<void>;
}

export interface AuthUser {
  id: string;
  email: string | null;
}

export interface AuthVerifier {
  getUser(jwt: string): Promise<AuthUser | null>;
}

export interface EmailMessage {
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  attachment?: { filename: string; contentType: string; bytes: Uint8Array };
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export type CloverEnvironment = "sandbox" | "na" | "eu" | "la";

export interface Env {
  allowedOrigins: string[];
  clover: {
    environment: CloverEnvironment;
    appId: string;
    appSecret: string;
    redirectUri: string;
    webhookAuth: string;
    requireState: boolean;
  } | null;
  tokenEncryptionKey: string | null;
  menuSyncTtlSeconds: number;
  ipHashSalt: string;
  emailFrom: string | null;
  jobApplications: {
    // The operator's switch. Off unless JOB_APPLICATIONS_ENABLED is exactly "true".
    enabled: boolean;
    // Days an application is kept before it and its CV are deleted. null until the
    // restaurant has decided; applications are refused while it is null.
    retentionDays: number | null;
  };
}

export interface Deps {
  db: Db;
  files: FileStore;
  auth: AuthVerifier;
  email: EmailSender | null;
  env: Env;
  log: Logger;
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  // Lets work continue after the response is sent (EdgeRuntime.waitUntil in production).
  waitUntil: (promise: Promise<unknown>) => void;
  random: () => number;
}

export type Role = "owner" | "manager" | "staff";

export interface Membership {
  restaurant_id: string;
  slug: string;
  name: string;
  currency: string;
  role: Role;
}

export interface Session {
  user: AuthUser;
  restaurant: Membership;
  requestId: string;
}
