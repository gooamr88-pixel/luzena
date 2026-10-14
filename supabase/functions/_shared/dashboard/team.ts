// Team and access: who may open this restaurant's dashboard, and as what.
//
// Three rules hold everything here together.
//
// 1. A row in restaurant_users is access, and it is the only thing that is. An invitation
//    grants nothing until its addressee, signed in, accepts it. Taking a row away ends that
//    person's access at their next request (session.ts reads the row on every one).
// 2. Nothing a browser sends decides a role or a restaurant. The restaurant is the caller's
//    own, from their membership. The roles a caller may give are a fixed list for their own
//    role (session.ts, `grantableRoles`): an owner gives any of the three, nobody else gives
//    any. The database checks again, under a lock, that the caller is still an owner, that
//    nobody changes their own access, and that the restaurant keeps at least one owner.
// 3. This system handles no password and no invitation token. It asks Supabase Auth to make
//    an account without a password; the person chooses one through Supabase Auth's own link
//    and signs in; that sign-in is the proof of who they are. So there is no secret here to
//    leak, guess or replay, and no route that an unsigned-in caller can use.
import { sha256Hex } from "../crypto.ts";
import { ApiError, isAllowedOrigin, json } from "../http.ts";
import { errorFields } from "../log.ts";
import type { AuthUser, Deps, Role, Session } from "../types.ts";
import { parseBody, v } from "../validate.ts";
import { audit, grantableRoles } from "./session.ts";
import { invitationEmail, ROLE_NAMES } from "./team-email.ts";

// How long an invitation stays open. Long enough for someone who reads email every few
// days; short enough that an offer nobody took does not stay open.
export const INVITATION_DAYS = 7;
const INVITATION_SECONDS = INVITATION_DAYS * 86_400;
// More open invitations than any restaurant's team needs. A stop for a runaway script.
const MAX_OPEN_INVITATIONS = 25;
// Invitation emails one address can be sent in a day, whoever asks and however: a person
// must not be able to be pestered through this form.
const MAX_EMAILS_PER_ADDRESS_PER_DAY = 5;

const ROLES = ["owner", "manager", "staff"] as const;
const emailAddress = v.string({ min: 5, max: 254, pattern: /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/ });

const inviteBody = v.object({ email: emailAddress, role: v.oneOf(ROLES) });
const roleBody = v.object({ role: v.oneOf(ROLES) });

const restaurantOf = (session: Session) => session.restaurant.restaurant_id;

interface Invitation {
  id: string;
  email: string;
  role: Role;
  status: string;
  expires_at: string;
}
interface InvitationRecord {
  refused?: string;
  invitation?: Invitation;
  account_id?: string | null;
}

// A role the caller may not give is refused before anything is looked up: the answer does
// not depend on who or what the request names.
function assertGrantable(session: Session, role: Role): void {
  if (!grantableRoles(session.restaurant.role).includes(role)) {
    throw new ApiError(403, "role_not_allowed", "Your role does not allow giving this role.");
  }
}

const INVITE_REFUSALS: Record<string, () => ApiError> = {
  role: () => new ApiError(403, "role_not_allowed", "This role cannot be given by invitation."),
  already_member: () => new ApiError(409, "already_member", "This person already has access to the dashboard."),
  already_invited: () => new ApiError(409, "already_invited", "This address already has an invitation waiting. Send it again from the list instead."),
  limit: () => new ApiError(409, "too_many_invitations", `There are already ${MAX_OPEN_INVITATIONS} invitations waiting. Cancel one that is no longer needed first.`),
};

function refuseInvitation(result: InvitationRecord): void {
  if (result.refused) throw (INVITE_REFUSALS[result.refused] ?? INVITE_REFUSALS.role)();
}

// Counts one email to this address, and refuses when it has had its share for the day. The
// address is counted as a salted hash, like every other address in the rate limiter.
async function emailBudget(deps: Deps, session: Session, email: string): Promise<void> {
  const key = await sha256Hex(`${deps.env.ipHashSalt}:invite:${restaurantOf(session)}:${email}`);
  const allowed = await deps.db.rpc<boolean>("rate_limit_hit", {
    p_key: `invite-to:${key}`, p_max: MAX_EMAILS_PER_ADDRESS_PER_DAY, p_window_seconds: 86_400,
  });
  if (!allowed) {
    throw new ApiError(429, "rate_limited", "This address has been sent several invitations today. Try again tomorrow.", { retryable: true });
  }
}

// Where the dashboard is, for the link in the email: the page the request came from when
// that is one of this backend's own allowed origins, and the first allowed origin
// otherwise. Never an address taken on trust from the request.
function dashboardAddress(request: Request, deps: Deps): string | null {
  const origin = request.headers.get("origin");
  const base = isAllowedOrigin(origin, deps.env) ? (origin as string) : deps.env.allowedOrigins[0];
  return base ? `${base.replace(/\/$/, "")}/dashboard/` : null;
}

// Sends the invitation email and records on the invitation whether that worked. Never
// throws: the invitation exists either way, and the dashboard shows which it was.
async function deliver(
  deps: Deps, session: Session, request: Request, invitation: Invitation, accountId: string | null,
): Promise<boolean> {
  const mark = (status: "sent" | "failed") =>
    deps.db.rpc("team_invitation_set_email_status", { p_restaurant: restaurantOf(session), p_id: invitation.id, p_status: status })
      .catch((error) => deps.log.error("team_invitation_status_failed", { request_id: session.requestId, ...errorFields(error) }));
  try {
    const dashboard = dashboardAddress(request, deps);
    if (!deps.email || !dashboard) {
      deps.log.error("team_invitation_email_not_configured", { request_id: session.requestId, invitation_id: invitation.id });
      await mark("failed");
      return false;
    }
    // A link to choose a password is made only for an account this system created and
    // nobody has signed in to. An account that is in use is never sent one unasked.
    const unused = accountId !== null && !(await deps.accounts.hasSignedIn(accountId).catch(() => true));
    const passwordLink = unused ? await deps.accounts.passwordLink(invitation.email, dashboard).catch(() => null) : null;

    await deps.email.send({
      to: invitation.email,
      ...invitationEmail({
        restaurantName: session.restaurant.name,
        role: invitation.role,
        inviterEmail: session.user.email,
        welcomeUrl: `${dashboard}#/welcome?email=${encodeURIComponent(invitation.email)}`,
        passwordLink,
        hasAccount: !unused,
        expiresAt: invitation.expires_at,
      }),
    });
    await mark("sent");
    return true;
  } catch (error) {
    deps.log.error("team_invitation_email_failed", { request_id: session.requestId, invitation_id: invitation.id, ...errorFields(error) });
    await mark("failed");
    return false;
  }
}

const NOT_SENT = "The invitation is saved, but the email could not be sent. Send it again, or tell the person to open the dashboard and choose \"Forgot your password?\" with this address.";

async function team(deps: Deps, session: Session) {
  const list = await deps.db.rpc<{ members: unknown[]; invitations: unknown[] }>("team_list", { p_restaurant: restaurantOf(session) });
  return {
    ...list,
    // Who is asking, so the page can mark their own row; and the roles they may give.
    you: session.user.id,
    roles: grantableRoles(session.restaurant.role),
    limits: { invitation_days: INVITATION_DAYS },
  };
}

export async function listTeam(deps: Deps, session: Session): Promise<Response> {
  return json(200, await team(deps, session));
}

export async function inviteMember(deps: Deps, session: Session, request: Request, body: unknown): Promise<Response> {
  const parsed = parseBody(inviteBody, body);
  const email = parsed.email.toLowerCase();
  assertGrantable(session, parsed.role);
  if (email === (session.user.email ?? "").toLowerCase()) {
    throw new ApiError(409, "already_member", "That is your own address. You already have access.");
  }

  const args = {
    p_restaurant: restaurantOf(session), p_email: email, p_role: parsed.role, p_actor_email: session.user.email,
    p_ttl_seconds: INVITATION_SECONDS, p_max_open: MAX_OPEN_INVITATIONS,
  };
  // Asked first and written last, so that a refusal makes no account and sends no email.
  refuseInvitation(await deps.db.rpc<InvitationRecord>("team_invitation_create", { ...args, p_dry_run: true }));
  await emailBudget(deps, session, email);

  let account: { created: boolean; id: string | null };
  try {
    account = await deps.accounts.ensure(email);
  } catch (error) {
    deps.log.error("team_account_failed", { request_id: session.requestId, ...errorFields(error) });
    throw new ApiError(502, "account_unavailable", "The invitation could not be prepared, so nothing was sent. Try again.", { retryable: true });
  }

  const created = await deps.db.rpc<InvitationRecord>("team_invitation_create", { ...args, p_dry_run: false });
  refuseInvitation(created);
  const invitation = created.invitation as Invitation;
  if (account.id) {
    await deps.db.rpc("team_invitation_set_account", { p_restaurant: restaurantOf(session), p_id: invitation.id, p_account: account.id });
  }

  const sent = await deliver(deps, session, request, invitation, account.id ?? created.account_id ?? null);
  await audit(deps, session, {
    action: "MEMBER_INVITED", entityType: "team_invitation", entityId: invitation.id,
    newValues: { email, role: invitation.role, email_sent: sent }, result: "success",
  });
  return json(200, {
    result: "invited", email_sent: sent, team: await team(deps, session),
    message: sent ? `An invitation has been sent to ${email}.` : NOT_SENT,
  });
}

const closed = () => new ApiError(404, "not_found", "This invitation is no longer open.");

export async function resendInvitation(deps: Deps, session: Session, request: Request, id: string): Promise<Response> {
  const open = await deps.db.rpc<InvitationRecord | null>("team_invitation_open", { p_restaurant: restaurantOf(session), p_id: id });
  if (!open?.invitation) throw closed();
  await emailBudget(deps, session, open.invitation.email);

  // Sending again gives the invitation a fresh week, so one that had run out is open again.
  const renewed = await deps.db.rpc<InvitationRecord | null>("team_invitation_renew", {
    p_restaurant: restaurantOf(session), p_id: id, p_ttl_seconds: INVITATION_SECONDS,
  });
  if (!renewed?.invitation) throw closed();

  const sent = await deliver(deps, session, request, renewed.invitation, renewed.account_id ?? null);
  await audit(deps, session, {
    action: "INVITATION_RESENT", entityType: "team_invitation", entityId: id,
    newValues: { email: renewed.invitation.email, role: renewed.invitation.role, email_sent: sent }, result: "success",
  });
  return json(200, {
    result: "sent", email_sent: sent, team: await team(deps, session),
    message: sent ? `The invitation has been sent to ${renewed.invitation.email} again.` : NOT_SENT,
  });
}

export async function cancelInvitation(deps: Deps, session: Session, id: string): Promise<Response> {
  const invitation = await deps.db.rpc<Invitation | null>("team_invitation_revoke", {
    p_restaurant: restaurantOf(session), p_id: id, p_actor_email: session.user.email,
  });
  if (!invitation) throw closed();
  await audit(deps, session, {
    action: "INVITATION_CANCELLED", entityType: "team_invitation", entityId: id,
    oldValues: { email: invitation.email, role: invitation.role }, result: "success",
  });
  return json(200, {
    result: "cancelled", team: await team(deps, session),
    message: `The invitation to ${invitation.email} has been cancelled. It can no longer be accepted.`,
  });
}

// The answers for a member who cannot be changed. A user id from another restaurant gets
// the same "not found" as one that belongs to nobody: there is nothing to learn from it.
const MEMBER_REFUSALS: Record<string, () => ApiError> = {
  role: () => new ApiError(403, "role_not_allowed", "This role cannot be given."),
  self: () => new ApiError(403, "self_change", "You cannot change or remove your own access. Ask another owner."),
  last_owner: () => new ApiError(409, "last_owner", "The restaurant must keep at least one owner. Make someone else an owner first."),
  // The caller stopped being an owner after this request was checked (another owner changed it).
  not_owner: () => new ApiError(403, "forbidden", "Your role does not allow this action."),
  not_found: () => new ApiError(404, "not_found", "This person is not a member of this restaurant."),
};

interface MemberChange {
  refused?: string;
  old?: Role;
  new?: Role;
  role?: Role;
  email?: string | null;
}

function refuseMember(result: MemberChange): void {
  if (result.refused) throw (MEMBER_REFUSALS[result.refused] ?? MEMBER_REFUSALS.not_found)();
}

export async function changeMemberRole(deps: Deps, session: Session, userId: string, body: unknown): Promise<Response> {
  const { role } = parseBody(roleBody, body);
  assertGrantable(session, role);
  const result = await deps.db.rpc<MemberChange>("team_member_set_role", {
    p_restaurant: restaurantOf(session), p_user: userId, p_role: role, p_actor: session.user.id,
  });
  refuseMember(result);

  const changed = result.old !== result.new;
  if (changed) {
    await audit(deps, session, {
      action: "MEMBER_ROLE_CHANGED", entityType: "team_member", entityId: userId,
      oldValues: { role: result.old, email: result.email ?? null }, newValues: { role: result.new }, result: "success",
    });
  }
  const who = result.email ?? "This member";
  return json(200, {
    result: "saved", team: await team(deps, session),
    message: changed ? `${who} is now ${ROLE_NAMES[role] ?? role}.` : "Nothing changed.",
  });
}

export async function removeMember(deps: Deps, session: Session, userId: string): Promise<Response> {
  const result = await deps.db.rpc<MemberChange>("team_member_remove", {
    p_restaurant: restaurantOf(session), p_user: userId, p_actor: session.user.id,
  });
  refuseMember(result);
  await audit(deps, session, {
    action: "MEMBER_REMOVED", entityType: "team_member", entityId: userId,
    oldValues: { role: result.role, email: result.email ?? null }, result: "success",
  });
  return json(200, {
    result: "removed", team: await team(deps, session),
    message: `${result.email ?? "This member"} no longer has access to the dashboard.`,
  });
}

// ---------------------------------------------------------------------------------------
// The invited person's side. These two are the only routes an account that belongs to no
// restaurant may call. They are still behind a sign-in: the account is the one Supabase
// Auth has verified, and its address is the one Supabase Auth has confirmed. An address
// that has not been confirmed is offered nothing and can accept nothing.
// ---------------------------------------------------------------------------------------

const confirmedAddress = (user: AuthUser): string | null =>
  (user.email && user.emailVerified === true ? user.email.toLowerCase() : null);

export async function myInvitations(deps: Deps, user: AuthUser): Promise<Response> {
  const email = confirmedAddress(user);
  return json(200, { invitations: email ? await deps.db.rpc("account_invitations", { p_email: email }) : [] });
}

const ACCEPT_REFUSALS: Record<string, () => ApiError> = {
  not_found: () => new ApiError(404, "not_found", "This invitation does not exist."),
  revoked: () => new ApiError(410, "invitation_revoked", "This invitation was cancelled. Ask for a new one."),
  expired: () => new ApiError(410, "invitation_expired", "This invitation has expired. Ask for it to be sent again."),
  used: () => new ApiError(409, "invitation_used", "This invitation has already been used."),
  other_restaurant: () => new ApiError(409, "account_in_use", "This account already belongs to another restaurant's dashboard. Ask to be invited at a different email address."),
};

export async function acceptInvitation(deps: Deps, user: AuthUser, id: string, requestId: string): Promise<Response> {
  const email = confirmedAddress(user);
  // Asked for by id, but found only if it is addressed to this account's own address.
  if (!email) throw ACCEPT_REFUSALS.not_found();
  const result = await deps.db.rpc<{ refused?: string; restaurant_id?: string; role?: Role; already?: boolean }>(
    "team_invitation_accept", { p_id: id, p_user: user.id, p_email: email });
  if (result.refused) throw (ACCEPT_REFUSALS[result.refused] ?? ACCEPT_REFUSALS.not_found)();

  if (!result.already) {
    await audit(deps, { user, restaurant: { restaurant_id: result.restaurant_id as string }, requestId }, {
      action: "INVITATION_ACCEPTED", entityType: "team_member", entityId: user.id,
      newValues: { role: result.role, email }, result: "success",
    });
  }
  return json(200, { result: "accepted", role: result.role, message: "You now have access to the dashboard." });
}
