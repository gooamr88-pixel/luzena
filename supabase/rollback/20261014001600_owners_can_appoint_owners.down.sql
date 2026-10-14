-- Takes back migration 20261014001600 (owners can appoint owners).
--
-- NOT A MIGRATION, and not run by `supabase db push`. Tested with the others in
-- tests/rollback.test.js: it leaves the database exactly as migration 20261014001500 left
-- it. Deploy the previous functions first (they never offer "owner"), then run this.
--
-- WHAT IT DOES TO DATA: every invitation that offers the role owner is deleted, accepted or
-- not (the earlier table cannot hold one). The people who became owners through the
-- dashboard REMAIN OWNERS: no membership is changed. Take a copy first if it matters:
--   select * from public.team_invitations where role = 'owner';

begin;

delete from public.team_invitations where role = 'owner';
alter table public.team_invitations drop constraint team_invitations_role_check;
alter table public.team_invitations add constraint team_invitations_role_check
  check (role in ('manager', 'staff'));

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

-- Changes a member's role between manager and staff.
--   {"refused": "role" | "self" | "not_found" | "owner"}
-- Nobody changes their own role, nobody is made an owner, and an owner's row is never
-- written. A user id from another restaurant is "not found", the same as one that is no one's.
create or replace function public.team_member_set_role(p_restaurant uuid, p_user uuid, p_role text, p_actor uuid) returns jsonb
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
create or replace function public.team_member_remove(p_restaurant uuid, p_user uuid, p_actor uuid) returns jsonb
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

drop function public._is_owner(uuid, uuid);

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;

do $$
begin
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    delete from supabase_migrations.schema_migrations where version = '20261014001600';
  end if;
end $$;

commit;
