export type CloverErrorKind =
  | "not_configured"
  | "not_connected"
  | "needs_reauth"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "bad_request"
  | "rate_limited"
  | "unavailable"
  | "timeout"
  | "network"
  | "invalid_response";

export class CloverError extends Error {
  kind: CloverErrorKind;
  status?: number;
  // True when a write may or may not have been applied by Clover (timeout, dropped
  // connection, 5xx). The caller must re-read from Clover before telling the owner
  // anything about the result.
  outcomeUnknown: boolean;

  constructor(kind: CloverErrorKind, message: string, options: { status?: number; outcomeUnknown?: boolean } = {}) {
    super(message);
    this.name = "CloverError";
    this.kind = kind;
    this.status = options.status;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
  }
}

// Owner-facing wording for each failure. Clover's own response text is never forwarded.
export const CLOVER_MESSAGES: Record<CloverErrorKind, string> = {
  not_configured: "Clover is not set up for this website yet.",
  not_connected: "Clover is not connected. Connect Clover to manage the menu.",
  needs_reauth: "The Clover connection has expired. Reconnect Clover to continue.",
  unauthorized: "Clover did not accept the connection just now. Nothing was changed. Try again in a few minutes; if it keeps happening, enter a new Clover token.",
  forbidden: "Clover refused this action. The app may be missing the inventory permission.",
  not_found: "Clover could not find this record. It may have been deleted in Clover.",
  bad_request: "Clover did not accept this change.",
  rate_limited: "Clover is receiving too many requests. Wait a moment and try again.",
  unavailable: "Clover is not responding right now. Try again shortly.",
  timeout: "Clover took too long to respond. Try again shortly.",
  network: "Clover could not be reached. Try again shortly.",
  invalid_response: "Clover returned data this system could not read.",
};

export const RETRYABLE_KINDS: CloverErrorKind[] = ["rate_limited", "unavailable", "timeout", "network"];
