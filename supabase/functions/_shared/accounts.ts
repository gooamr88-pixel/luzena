// What Supabase Auth says when asked to make an account for an address that has one.
//
// Inviting someone starts by making sure an account exists for their address
// (runtime.ts, `accounts.ensure`). "It already exists" is then a good answer, not a
// failure, and has to be told apart from a real one. Supabase has worded it differently
// over the years, so every form it has taken is recognised here, and anything else is
// treated as a failure: an invitation is not sent on the strength of a guess.

export interface AuthFailure {
  code?: unknown;
  status?: unknown;
  message?: unknown;
}

const EXISTS_CODES = ["email_exists", "user_already_exists"];
const EXISTS_MESSAGE = /already (been )?registered|already exists/i;

export function isExistingAccount(error: AuthFailure | null | undefined): boolean {
  if (!error) return false;
  if (typeof error.code === "string" && EXISTS_CODES.includes(error.code)) return true;
  return typeof error.message === "string" && EXISTS_MESSAGE.test(error.message);
}
