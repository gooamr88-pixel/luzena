// Two-step sign-in (an authenticator app), as Supabase Auth provides it. This system does
// not implement it: the secret, the codes and their checking are all Supabase's. What is
// here only READS two facts Supabase states about a session, so that the API can refuse a
// session that has skipped the second step.
//
//   aal1  signed in with the password alone
//   aal2  signed in with the password and a code from the authenticator app
//
// Nothing about a factor (its secret, its id, the codes) is stored, logged or returned by
// this system.

export type AssuranceLevel = "aal1" | "aal2";

// The level a session was signed in at, read from the session token's `aal` claim.
//
// The token is NOT verified here and must not be trusted from this function alone: the
// caller has already had Supabase Auth verify it (auth.getUser), which is the only reason
// its contents can be believed. Anything unreadable is the lowest level.
export function sessionLevel(jwt: string): AssuranceLevel {
  try {
    const payload = jwt.split(".")[1] ?? "";
    const text = atob(payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "="));
    return (JSON.parse(text) as { aal?: unknown }).aal === "aal2" ? "aal2" : "aal1";
  } catch {
    return "aal1";
  }
}

// Whether the account has turned two-step sign-in on: it has a factor that it has proved it
// holds. A factor that was begun and never confirmed does not count.
export function hasVerifiedFactor(factors: unknown): boolean {
  return Array.isArray(factors) && factors.some((factor) => (factor as { status?: unknown } | null)?.status === "verified");
}
