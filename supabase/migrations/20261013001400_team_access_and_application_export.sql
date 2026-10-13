-- Team access, and the export of job applications.
--
-- Until now a restaurant had one account, its owner's, linked by hand by the operator
-- (provision-restaurant.sql). The roles `manager` and `staff` were already in
-- restaurant_users and in the backend's permission map, but nothing could assign them.
-- From here an owner invites people from the dashboard, changes a member's role, and takes
-- access away again.
--
-- WHO HAS ACCESS IS STILL ONE TABLE. A row in restaurant_users is access; no row is none.
-- Every request reads it afresh (user_memberships), so taking a row away ends that person's
-- access at their very next request, whatever session they still hold. Nothing here adds a
-- second place that grants anything.
--
-- AN INVITATION GRANTS NOTHING. It is a record that an owner has offered a role to an email
-- address. It becomes a membership only when the person, signed in to Supabase Auth with
-- that address, accepts it (team_invitation_accept). There is no invitation token: what
-- proves who is accepting is the sign-in itself, which Supabase Auth checks. So there is
-- nothing in an invitation to leak, guess or replay, and a cancelled or expired one is
-- simply not accepted.
--
-- AN OWNER IS NEVER MADE, CHANGED OR REMOVED HERE. No function below writes the role
-- `owner` or touches a row that has it; the invitation table cannot even store it. Owners
-- stay the operator's to provision.
--
-- Like every other table, the new one has row level security with no policy and no
-- privilege for `anon` or `authenticated`, and every function is the service role's alone.

-- ---------------------------------------------------------------------------------------
-- What the team page shows about a member
-- ---------------------------------------------------------------------------------------

-- For display only. None of these columns takes part in deciding what anyone may do.
alter table public.restaurant_users
  -- The address the account signs in with, as last seen. Kept here because the backend's
  -- role reads this table and not Supabase Auth's own.
  add column email            text,
  add column invited_by_email text,
  add column last_seen_at     timestamptz,
  -- When the role was last changed.
  add column updated_at       timestamptz not null default now();

update public.restaurant_users set updated_at = created_at;
create index restaurant_users_email_idx on public.restaurant_users (restaurant_id, email);

-- The addresses of the accounts that exist already (the owner's). If the role applying
-- this migration may not read Supabase Auth's table, they are left empty and filled in the
-- next time each account opens the dashboard (team_member_seen): the migration does not
-- fail over a label.
do $$
begin
  update public.restaurant_users ru
  set email = lower(u.email)
  from auth.users u
  where u.id = ru.user_id and ru.email is null and u.email is not null;
exception when insufficient_privilege then
  raise notice 'restaurant_users.email left empty: this role cannot read auth.users. It is filled in when each account next opens the dashboard.';
end $$;

-- ---------------------------------------------------------------------------------------
-- Invitations
-- ---------------------------------------------------------------------------------------

create table public.team_invitations (
  id               uuid primary key default gen_random_uuid(),
  restaurant_id    uuid not null references public.restaurants(id) on delete cascade,
  -- Always lower case, so one person is one address.
  email            text not null check (email = lower(btrim(email)) and char_length(email) between 5 and 254),
  -- An owner is never made by invitation: the column cannot hold it.
  role             text not null check (role in ('manager', 'staff')),
  invited_by_email text,
  -- The Supabase Auth account made for this address when it was first invited, if this
  -- system made it. Used only to tell whether that account has ever been signed in to.
  account_id       uuid,
  email_status     text not null default 'pending' check (email_status in ('pending', 'sent', 'failed')),
  sent_at          timestamptz,
  send_count       integer not null default 0,
  expires_at       timestamptz not null,
  accepted_at      timestamptz,
  accepted_by      uuid,
  revoked_at       timestamptz,
  revoked_by_email text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- Accepted or cancelled, never both.
  check (accepted_at is null or revoked_at is null)
);
-- One open invitation per address per restaurant. This index, not the code, is what makes
-- two invitations to the same person impossible, also when two requests race.
create unique index team_invitations_open_idx on public.team_invitations (restaurant_id, email)
  where accepted_at is null and revoked_at is null;
-- "Is anything waiting for this address?", asked when an account with no restaurant signs in.
create index team_invitations_email_idx on public.team_invitations (email)
  where accepted_at is null and revoked_at is null;
create index team_invitations_recent_idx on public.team_invitations (restaurant_id, created_at desc);

alter table public.team_invitations enable row level security;
revoke all on public.team_invitations from anon, authenticated;
-- Said outright: default privileges belong to the role that creates the table.
grant all on public.team_invitations to service_role;

-- Where an invitation stands. Worked out from the row each time, so "expired" needs no
-- job to set it and can never be out of date.
create function public._invitation_status(i public.team_invitations) returns text
language sql stable as $$
  select case
    when i.accepted_at is not null then 'accepted'
    when i.revoked_at is not null then 'revoked'
    when i.expires_at <= now() then 'expired'
    else 'pending' end;
$$;

-- An invitation as the dashboard is given it. Never the account id.
create function public._invitation_json(i public.team_invitations) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', i.id, 'email', i.email, 'role', i.role, 'status', public._invitation_status(i),
    'invited_by_email', i.invited_by_email, 'email_status', i.email_status,
    'created_at', i.created_at, 'sent_at', i.sent_at, 'expires_at', i.expires_at,
    'revoked_at', i.revoked_at);
$$;

-- The team page: who has access, and the invitations that have not been accepted. An
-- invitation that expired or was cancelled stays in view for 30 days, so the owner can see
-- that it is closed, and then drops out of the list.
create function public.team_list(p_restaurant uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ru.user_id, 'email', ru.email, 'role', ru.role, 'joined_at', ru.created_at,
        'invited_by_email', ru.invited_by_email, 'last_seen_at', ru.last_seen_at,
        'role_changed_at', case when ru.updated_at > ru.created_at then ru.updated_at end)
        order by case ru.role when 'owner' then 0 when 'manager' then 1 else 2 end, ru.created_at, ru.user_id)
      from public.restaurant_users ru where ru.restaurant_id = p_restaurant), '[]'::jsonb),
    'invitations', coalesce((
      select jsonb_agg(public._invitation_json(i) order by i.created_at desc, i.id)
      from public.team_invitations i
      where i.restaurant_id = p_restaurant and i.accepted_at is null
        and (i.revoked_at is null or i.revoked_at > now() - interval '30 days')
        and i.expires_at > now() - interval '30 days'), '[]'::jsonb));
$$;

-- Offers a role to an address. Refuses, changing nothing, when the address already has
-- access, already has an invitation waiting, or the restaurant has too many waiting:
--   {"refused": "role" | "already_member" | "already_invited" | "limit"}
-- An invitation to the same address that has expired is renewed rather than left beside a
-- new one. With p_dry_run nothing is written: the backend asks first, prepares the account,
-- and only then writes.
create function public.team_invitation_create(
  p_restaurant uuid, p_email text, p_role text, p_actor_email text,
  p_ttl_seconds integer, p_max_open integer, p_dry_run boolean
) returns jsonb language plpgsql as $$
declare
  v_email text := lower(btrim(p_email));
  v_open  public.team_invitations;
  v_found boolean;
  v_row   public.team_invitations;
begin
  if p_role is null or p_role not in ('manager', 'staff') then
    return jsonb_build_object('refused', 'role');
  end if;
  if exists (select 1 from public.restaurant_users where restaurant_id = p_restaurant and email = v_email) then
    return jsonb_build_object('refused', 'already_member');
  end if;

  select * into v_open from public.team_invitations
  where restaurant_id = p_restaurant and email = v_email and accepted_at is null and revoked_at is null
  for update;
  v_found := found;
  if v_found and v_open.expires_at > now() then
    return jsonb_build_object('refused', 'already_invited');
  end if;

  if not v_found and (
    select count(*) from public.team_invitations
    where restaurant_id = p_restaurant and accepted_at is null and revoked_at is null and expires_at > now()
  ) >= p_max_open then
    return jsonb_build_object('refused', 'limit');
  end if;
  if p_dry_run then
    return jsonb_build_object('ok', true);
  end if;

  -- Addresses of people who never joined are not kept for ever.
  delete from public.team_invitations
  where restaurant_id = p_restaurant and accepted_at is null
    and (revoked_at < now() - interval '90 days' or expires_at < now() - interval '90 days')
    and id is distinct from v_open.id;

  if v_found then
    update public.team_invitations
    set role = p_role, invited_by_email = p_actor_email, email_status = 'pending',
        expires_at = now() + make_interval(secs => p_ttl_seconds), updated_at = now()
    where id = v_open.id
    returning * into v_row;
  else
    insert into public.team_invitations (restaurant_id, email, role, invited_by_email, expires_at, account_id)
    values (p_restaurant, v_email, p_role, p_actor_email, now() + make_interval(secs => p_ttl_seconds),
            -- If this system made an account for the address before, it is the same account.
            (select t.account_id from public.team_invitations t
             where t.email = v_email and t.account_id is not null
             order by t.created_at desc limit 1))
    returning * into v_row;
  end if;
  return jsonb_build_object('invitation', public._invitation_json(v_row), 'account_id', v_row.account_id);
exception when unique_violation then
  -- Two requests for the same address at once: the other one made it.
  return jsonb_build_object('refused', 'already_invited');
end $$;

-- Remembers which account was made for an invited address.
create function public.team_invitation_set_account(p_restaurant uuid, p_id uuid, p_account uuid) returns void
language sql as $$
  update public.team_invitations set account_id = p_account
  where restaurant_id = p_restaurant and id = p_id;
$$;

-- Whether the invitation email went out.
create function public.team_invitation_set_email_status(p_restaurant uuid, p_id uuid, p_status text) returns void
language sql as $$
  update public.team_invitations
  set email_status = p_status,
      sent_at = case when p_status = 'sent' then now() else sent_at end,
      send_count = send_count + case when p_status = 'sent' then 1 else 0 end
  where restaurant_id = p_restaurant and id = p_id;
$$;

-- An invitation that can still be sent again or cancelled: not accepted, not cancelled
-- (one that has only run out counts). null otherwise, and for another restaurant's.
create function public.team_invitation_open(p_restaurant uuid, p_id uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object('invitation', public._invitation_json(i), 'account_id', i.account_id)
  from public.team_invitations i
  where i.restaurant_id = p_restaurant and i.id = p_id and i.accepted_at is null and i.revoked_at is null;
$$;

-- Sends an invitation again: it gets a fresh expiry, so one that had run out is open again.
-- null when it is not this restaurant's, or was already accepted or cancelled.
create function public.team_invitation_renew(p_restaurant uuid, p_id uuid, p_ttl_seconds integer) returns jsonb
language plpgsql as $$
declare
  v_row public.team_invitations;
begin
  update public.team_invitations
  set expires_at = now() + make_interval(secs => p_ttl_seconds), email_status = 'pending', updated_at = now()
  where restaurant_id = p_restaurant and id = p_id and accepted_at is null and revoked_at is null
  returning * into v_row;
  if not found then return null; end if;
  return jsonb_build_object('invitation', public._invitation_json(v_row), 'account_id', v_row.account_id);
end $$;

-- Cancels an invitation that has not been accepted. From this moment it cannot be.
-- null when it is not this restaurant's, or is not open.
create function public.team_invitation_revoke(p_restaurant uuid, p_id uuid, p_actor_email text) returns jsonb
language plpgsql as $$
declare
  v_row public.team_invitations;
begin
  update public.team_invitations
  set revoked_at = now(), revoked_by_email = p_actor_email, updated_at = now()
  where restaurant_id = p_restaurant and id = p_id and accepted_at is null and revoked_at is null
  returning * into v_row;
  if not found then return null; end if;
  return public._invitation_json(v_row);
end $$;

-- The invitations waiting for an address, for the person who has just signed in with it.
-- The backend passes the address Supabase Auth vouches for, never one from the request.
create function public.account_invitations(p_email text) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', i.id, 'restaurant', r.name, 'role', i.role,
    'invited_by_email', i.invited_by_email, 'expires_at', i.expires_at)
    order by i.created_at desc, i.id), '[]'::jsonb)
  from public.team_invitations i
  join public.restaurants r on r.id = i.restaurant_id
  where i.email = lower(btrim(p_email))
    and i.accepted_at is null and i.revoked_at is null and i.expires_at > now();
$$;

-- Accepts an invitation: the one moment a membership is made from one.
--   p_user, p_email  the account Supabase Auth has just verified, and its address
-- The invitation must be addressed to exactly that address, open, and not expired. An id
-- that exists but is addressed to someone else is answered like one that does not exist.
--   {"refused": "not_found" | "revoked" | "used" | "expired" | "other_restaurant"}
-- The role given is the invitation's. Someone who is already a member keeps the role they
-- have: an invitation never changes an existing membership, least of all an owner's.
create function public.team_invitation_accept(p_id uuid, p_user uuid, p_email text) returns jsonb
language plpgsql as $$
declare
  v_inv  public.team_invitations;
  v_role text;
begin
  select * into v_inv from public.team_invitations
  where id = p_id and email = lower(btrim(p_email))
  for update;
  if not found then return jsonb_build_object('refused', 'not_found'); end if;
  if v_inv.revoked_at is not null then return jsonb_build_object('refused', 'revoked'); end if;

  if v_inv.accepted_at is not null then
    -- Pressed twice: the same answer. But an accepted invitation is spent: if the access it
    -- gave has since been taken away, it does not give it back.
    select role into v_role from public.restaurant_users
    where restaurant_id = v_inv.restaurant_id and user_id = p_user;
    if v_inv.accepted_by = p_user and v_role is not null then
      return jsonb_build_object('ok', true, 'restaurant_id', v_inv.restaurant_id, 'role', v_role, 'already', true);
    end if;
    return jsonb_build_object('refused', 'used');
  end if;
  if v_inv.expires_at <= now() then return jsonb_build_object('refused', 'expired'); end if;

  -- The dashboard opens one restaurant per account, so an account that already belongs to
  -- another is not given a second.
  if exists (select 1 from public.restaurant_users
             where user_id = p_user and restaurant_id <> v_inv.restaurant_id) then
    return jsonb_build_object('refused', 'other_restaurant');
  end if;

  insert into public.restaurant_users (restaurant_id, user_id, role, email, invited_by_email)
  values (v_inv.restaurant_id, p_user, v_inv.role, v_inv.email, v_inv.invited_by_email)
  on conflict (restaurant_id, user_id) do nothing;
  select role into v_role from public.restaurant_users
  where restaurant_id = v_inv.restaurant_id and user_id = p_user;

  update public.team_invitations
  set accepted_at = now(), accepted_by = p_user, updated_at = now()
  where id = v_inv.id;
  return jsonb_build_object('ok', true, 'restaurant_id', v_inv.restaurant_id, 'role', v_role, 'already', false);
end $$;

-- ---------------------------------------------------------------------------------------
-- Members
-- ---------------------------------------------------------------------------------------

-- Changes a member's role between manager and staff.
--   {"refused": "role" | "self" | "not_found" | "owner"}
-- Nobody changes their own role, nobody is made an owner, and an owner's row is never
-- written. A user id from another restaurant is "not found", the same as one that is no one's.
create function public.team_member_set_role(p_restaurant uuid, p_user uuid, p_role text, p_actor uuid) returns jsonb
language plpgsql as $$
declare
  v_old   text;
  v_email text;
begin
  if p_role is null or p_role not in ('manager', 'staff') then
    return jsonb_build_object('refused', 'role');
  end if;
  if p_user = p_actor then return jsonb_build_object('refused', 'self'); end if;

  select role, email into v_old, v_email from public.restaurant_users
  where restaurant_id = p_restaurant and user_id = p_user for update;
  if not found then return jsonb_build_object('refused', 'not_found'); end if;
  if v_old = 'owner' then return jsonb_build_object('refused', 'owner'); end if;

  if v_old is distinct from p_role then
    update public.restaurant_users set role = p_role, updated_at = now()
    where restaurant_id = p_restaurant and user_id = p_user;
  end if;
  return jsonb_build_object('old', v_old, 'new', p_role, 'email', v_email);
end $$;

-- Takes a member's access away. Only the membership row goes: the restaurant, everything
-- in it, the person's Supabase Auth account and what they did (the audit log) all stay.
--   {"refused": "self" | "not_found" | "owner"}
create function public.team_member_remove(p_restaurant uuid, p_user uuid, p_actor uuid) returns jsonb
language plpgsql as $$
declare
  v_role  text;
  v_email text;
begin
  if p_user = p_actor then return jsonb_build_object('refused', 'self'); end if;

  select role, email into v_role, v_email from public.restaurant_users
  where restaurant_id = p_restaurant and user_id = p_user for update;
  if not found then return jsonb_build_object('refused', 'not_found'); end if;
  if v_role = 'owner' then return jsonb_build_object('refused', 'owner'); end if;

  delete from public.restaurant_users where restaurant_id = p_restaurant and user_id = p_user;
  return jsonb_build_object('role', v_role, 'email', v_email);
end $$;

-- Notes that a member has opened the dashboard, and keeps their address current. Written at
-- most once in five minutes per member.
create function public.team_member_seen(p_restaurant uuid, p_user uuid, p_email text) returns void
language sql as $$
  update public.restaurant_users
  set email = coalesce(lower(btrim(p_email)), email), last_seen_at = now()
  where restaurant_id = p_restaurant and user_id = p_user
    and (last_seen_at is null or last_seen_at < now() - interval '5 minutes'
         or (p_email is not null and email is distinct from lower(btrim(p_email))));
$$;

-- ---------------------------------------------------------------------------------------
-- Job applications: one definition of "the applications that match", and the export
-- ---------------------------------------------------------------------------------------

-- What the owner typed, as a pattern in which % and _ are looked for as themselves.
-- null when nothing was typed.
create function public._like_pattern(p_search text) returns text
language sql immutable as $$
  select case when nullif(btrim(coalesce(p_search, '')), '') is null then null
    else '%' || replace(replace(replace(lower(btrim(p_search)), '\', '\\'), '%', '\%'), '_', '\_') || '%' end;
$$;

-- The applications of one restaurant that match the dashboard's filters. The list and the
-- export both read from here, so they can never disagree about what a filter means.
-- p_from is inclusive and p_to exclusive; both are instants.
create function public._applications_matching(
  p_restaurant uuid, p_search text, p_status text, p_position text, p_from timestamptz, p_to timestamptz
) returns setof public.job_applications language sql stable as $$
  select a.* from public.job_applications a
  where a.restaurant_id = p_restaurant
    and (p_status is null or a.status = p_status)
    and (p_position is null or a."position" = p_position)
    and (p_from is null or a.created_at >= p_from)
    and (p_to is null or a.created_at < p_to)
    and (public._like_pattern(p_search) is null
         or lower(a.full_name) like public._like_pattern(p_search) escape '\'
         or lower(a.email) like public._like_pattern(p_search) escape '\'
         or lower(a."position") like public._like_pattern(p_search) escape '\'
         or a.phone like public._like_pattern(p_search) escape '\');
$$;

-- The list, exactly as before (migration 20261006000700), now reading its matches from the
-- shared definition above. Same arguments, same answer.
create or replace function public.dash_applications_list(
  p_restaurant uuid, p_search text, p_status text, p_position text,
  p_from timestamptz, p_to timestamptz, p_limit integer, p_offset integer
) returns jsonb language plpgsql stable as $$
declare
  v_limit  integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_result jsonb;
begin
  with matching as (
    select * from public._applications_matching(p_restaurant, p_search, p_status, p_position, p_from, p_to)
  ),
  page as (
    select * from matching order by created_at desc, id limit v_limit offset v_offset
  )
  select jsonb_build_object(
    'total', (select count(*) from matching),
    'limit', v_limit,
    'offset', v_offset,
    'applications', coalesce((select jsonb_agg(jsonb_build_object(
        'id', p.id, 'full_name', p.full_name, 'position', p."position", 'status', p.status,
        'employment_type', p.employment_type, 'experience_level', p.experience_level,
        'has_cv', p.cv_path is not null, 'email_status', p.email_status, 'created_at', p.created_at)
        order by p.created_at desc, p.id) from page p), '[]'::jsonb),
    -- Across every application, whatever the filters: the numbers on the status buttons.
    'counts', coalesce((select jsonb_object_agg(s.status, s.n) from (
        select status, count(*) as n from public.job_applications
        where restaurant_id = p_restaurant group by status) s), '{}'::jsonb),
    'positions', coalesce((select jsonb_agg(d.title order by d.title) from (
        select distinct "position" as title from public.job_applications
        where restaurant_id = p_restaurant) d), '[]'::jsonb))
  into v_result;
  return v_result;
end $$;

-- The applications to export, newest first: those matching the filters and, when p_ids is
-- given, only those among the ids named. Every id is looked for inside this restaurant, so
-- an id from another restaurant matches nothing and says nothing.
--
-- It is one statement, so the count and the rows are of the same moment: an application
-- arriving or being deleted meanwhile cannot make them disagree, and there are no pages to
-- drift apart.
--
-- With p_count_only, or when there are more than p_limit, no rows are returned: only how many.
--
-- AN EXPORT IS THE LIST, IN A FILE: the main facts of each application and no more (the
-- client's decision, 2026-10-13). So it carries what the list carries: who applied, for
-- what, how much experience, when, whether there is a CV, and where it stands. The details
-- are not in it and are not read for it: email, phone, availability, the applicant's own
-- words, the CV's place in storage, internal notes and history. Those stay in the
-- dashboard, read one application at a time.
create function public.dash_applications_export(
  p_restaurant uuid, p_search text, p_status text, p_position text,
  p_from timestamptz, p_to timestamptz, p_ids uuid[], p_limit integer, p_count_only boolean
) returns jsonb language sql stable as $$
  with matching as (
    select a.* from public._applications_matching(p_restaurant, p_search, p_status, p_position, p_from, p_to) a
    where p_ids is null or a.id = any(p_ids)
  ),
  counted as (select count(*) as n from matching)
  select jsonb_build_object(
    'count', (select n from counted),
    'applications', case
      when p_count_only or (select n from counted) > p_limit then null
      else coalesce((select jsonb_agg(jsonb_build_object(
          'full_name', m.full_name, 'position', m."position", 'status', m.status,
          'employment_type', m.employment_type, 'experience_level', m.experience_level,
          'has_cv', m.cv_path is not null, 'created_at', m.created_at)
          order by m.created_at desc, m.id) from matching m), '[]'::jsonb) end);
$$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
