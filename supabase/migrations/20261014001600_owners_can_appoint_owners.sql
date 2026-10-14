-- Owners can appoint owners (the client's request, 2026-10-14).
--
-- Until now an owner was made only by the operator, and the dashboard could neither make an
-- owner nor touch one. From now on an owner can:
--   - invite someone as an owner,
--   - make a manager or a member of staff an owner,
--   - make another owner a manager or staff, or remove another owner's access.
-- What still holds, and is checked here, in the database, whoever calls:
--   - nobody changes or removes their own access (so nobody locks themselves out by mistake),
--   - a restaurant always keeps at least one owner,
--   - the person making the change must still be an owner of that restaurant at that moment.
-- Every team change of a restaurant takes that restaurant's row lock first, so two owners
-- acting at the same instant are taken one after the other and cannot, between them, leave
-- the restaurant with no owner.
--
-- Additive in effect: no row is changed. The way back is
-- supabase/rollback/20261014001600_owners_can_appoint_owners.down.sql.

alter table public.team_invitations drop constraint team_invitations_role_check;
alter table public.team_invitations add constraint team_invitations_role_check
  check (role in ('owner', 'manager', 'staff'));

-- Whether a user is an owner of a restaurant. For the checks below.
create function public._is_owner(p_restaurant uuid, p_user uuid) returns boolean
language sql stable as $$
  select exists (select 1 from public.restaurant_users
                 where restaurant_id = p_restaurant and user_id = p_user and role = 'owner');
$$;

-- As before, with "owner" among the roles an invitation can offer. (Who may offer which
-- role is decided by the backend: only an owner reaches this function at all.)
create or replace function public.team_invitation_create(
  p_restaurant uuid, p_email text, p_role text, p_actor_email text,
  p_ttl_seconds integer, p_max_open integer, p_dry_run boolean
) returns jsonb language plpgsql as $$
declare
  v_email text := lower(btrim(p_email));
  v_open  public.team_invitations;
  v_found boolean;
  v_row   public.team_invitations;
begin
  if p_role is null or p_role not in ('owner', 'manager', 'staff') then
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

-- Changes a member's role: owner, manager or staff.
--   {"refused": "role" | "self" | "not_found" | "not_owner" | "last_owner"}
-- Nobody changes their own role; the person changing it must be an owner; an owner can be
-- made something else only while another owner remains. A user id from another restaurant
-- is "not found", the same as one that is no one's.
create or replace function public.team_member_set_role(p_restaurant uuid, p_user uuid, p_role text, p_actor uuid) returns jsonb
language plpgsql as $$
declare
  v_old   text;
  v_email text;
begin
  if p_role is null or p_role not in ('owner', 'manager', 'staff') then
    return jsonb_build_object('refused', 'role');
  end if;
  if p_user = p_actor then return jsonb_build_object('refused', 'self'); end if;

  -- One team change at a time for this restaurant.
  perform 1 from public.restaurants where id = p_restaurant for update;
  if not public._is_owner(p_restaurant, p_actor) then return jsonb_build_object('refused', 'not_owner'); end if;

  select role, email into v_old, v_email from public.restaurant_users
  where restaurant_id = p_restaurant and user_id = p_user for update;
  if not found then return jsonb_build_object('refused', 'not_found'); end if;

  if v_old = 'owner' and p_role <> 'owner' and not exists (
    select 1 from public.restaurant_users
    where restaurant_id = p_restaurant and role = 'owner' and user_id <> p_user
  ) then
    return jsonb_build_object('refused', 'last_owner');
  end if;

  if v_old is distinct from p_role then
    update public.restaurant_users set role = p_role, updated_at = now()
    where restaurant_id = p_restaurant and user_id = p_user;
  end if;
  return jsonb_build_object('old', v_old, 'new', p_role, 'email', v_email);
end $$;

-- Takes a member's access away. Only the membership row goes: the restaurant, everything
-- in it, the person's Supabase Auth account and what they did (the audit log) all stay.
--   {"refused": "self" | "not_found" | "not_owner" | "last_owner"}
create or replace function public.team_member_remove(p_restaurant uuid, p_user uuid, p_actor uuid) returns jsonb
language plpgsql as $$
declare
  v_role  text;
  v_email text;
begin
  if p_user = p_actor then return jsonb_build_object('refused', 'self'); end if;

  perform 1 from public.restaurants where id = p_restaurant for update;
  if not public._is_owner(p_restaurant, p_actor) then return jsonb_build_object('refused', 'not_owner'); end if;

  select role, email into v_role, v_email from public.restaurant_users
  where restaurant_id = p_restaurant and user_id = p_user for update;
  if not found then return jsonb_build_object('refused', 'not_found'); end if;

  if v_role = 'owner' and not exists (
    select 1 from public.restaurant_users
    where restaurant_id = p_restaurant and role = 'owner' and user_id <> p_user
  ) then
    return jsonb_build_object('refused', 'last_owner');
  end if;

  delete from public.restaurant_users where restaurant_id = p_restaurant and user_id = p_user;
  return jsonb_build_object('role', v_role, 'email', v_email);
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
