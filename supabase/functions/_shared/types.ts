// Ports the handlers depend on. Production adapters live in runtime.ts (Deno only);
// tests provide PGlite and in-memory implementations.

export interface Db {
  rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T>;
}

export interface FileStore {
  upload(bucket: string, path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  remove(bucket: string, paths: string[]): Promise<void>;
  // The file's bytes, or null when there is no such file.
  download(bucket: string, path: string): Promise<Uint8Array | null>;
}

export interface AuthUser {
  id: string;
  email: string | null;
  // Two-step sign-in, as Supabase Auth reports it (see auth-level.ts). `twoStep` is whether
  // the account has it turned on; `level` is how this session signed in. Both are absent
  // for an account that has never been asked: that is the same as off, and aal1.
  twoStep?: boolean;
  level?: "aal1" | "aal2";
  // Whether Supabase Auth has confirmed that the account holds its email address. Only an
  // address that has been confirmed can accept an invitation sent to it.
  emailVerified?: boolean;
}

export interface AuthVerifier {
  getUser(jwt: string): Promise<AuthUser | null>;
}

// Supabase Auth's accounts, as far as inviting someone needs them. This system never sets,
// reads or handles a password: an account is made without one, and its holder chooses one
// through Supabase Auth's own reset link.
export interface AccountDirectory {
  // Makes sure an account exists for this address, so that the person can be sent a link to
  // set a password. `created` is false when the address already had an account, which is
  // left exactly as it was. `id` is known only for an account made by this call.
  ensure(email: string): Promise<{ created: boolean; id: string | null }>;
  // Whether the account has ever been signed in to. When that cannot be told, the answer
  // is yes: the cautious one, because a set-password link is only made for an account
  // nobody has used.
  hasSignedIn(id: string): Promise<boolean>;
  // A single-use link, made by Supabase Auth, that lets the holder of this address choose
  // their password. null when one could not be made. It goes into the invitation email and
  // nowhere else: not into a response, a log or the database.
  passwordLink(email: string, redirectTo: string): Promise<string | null>;
}

export interface EmailMessage {
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  // The same message laid out for mail programs that show HTML. `text` is always sent too.
  html?: string;
  attachment?: { filename: string; contentType: string; bytes: Uint8Array };
}

// What became of a message after the provider took it, as the provider reports it.
//   delivered  the recipient's mail server accepted it
//   bounced    the recipient's mail server refused it
//   blocked    the provider would not send it (a blocked or invalid address, a complaint)
export interface DeliveryStatus {
  status: "delivered" | "bounced" | "blocked";
  detail: string | null;
}

export interface EmailSender {
  // Hands a message to the provider. `id` is the provider's own name for it, when it gives
  // one. A provider that accepts a message has not delivered it: see `status`.
  send(message: EmailMessage): Promise<{ id: string | null }>;
  // What the provider now knows about a message it accepted, or null while it knows
  // nothing final. Absent for a provider that cannot be asked.
  status?(id: string): Promise<DeliveryStatus | null>;
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
  // CLOVER_ENV as the operator set it, or null when it is not set. Connecting with a
  // merchant's own API token needs this and the encryption key, but no Clover app.
  cloverEnvironment: CloverEnvironment | null;
  tokenEncryptionKey: string | null;
  menuSyncTtlSeconds: number;
  ipHashSalt: string;
  emailFrom: string | null;
  // The shared secret the database's scheduler presents to the scheduled-tasks function.
  // null until it is set, and the function refuses every call while it is.
  cronSecret: string | null;
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
  accounts: AccountDirectory;
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
