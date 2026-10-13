-- Takes back migration 20261013001400 (team access, export of applications).
--
-- NOT A MIGRATION, and not run by `supabase db push`. It is the way back, kept beside the
-- way forward and tested with it (tests/rollback.test.js). Migration 20261014001500 must be
-- taken back first (its own file in this folder): it was applied after this one.
--
-- ORDER MATTERS. Deploy the previous functions first (the commit before this work), then
-- run this file: the newer backend calls functions that this removes.
--
-- WHAT IS LOST, for good: every invitation, and THE ACCESS OF EVERYONE WHO JOINED THROUGH
-- ONE. Before this migration a restaurant had its owner and nobody else, and the dashboard
-- had no way to remove anyone; so the people who were invited are taken off again, here,
-- rather than left with access nobody can end. No owner is touched: a row whose role is
-- `owner` is never deleted by this file, and neither is any Supabase Auth account, any
-- application, any CV or any menu data.
-- Take a copy first:   select * from public.restaurant_users;   select * from public.team_invitations;

begin;

-- Everyone who came in by invitation. Never an owner.
delete from public.restaurant_users where role <> 'owner' and invited_by_email is not null;

drop function public.dash_applications_export(uuid, text, text, text, timestamptz, timestamptz, uuid[], integer, boolean);

-- The list as it was before it shared its matching with the export (migration
-- 20261006000700, unchanged). It gives the same answer as the one it replaces.
create or replace function public.dash_applications_list(
  p_restaurant uuid, p_search text, p_status text, p_position text,
  p_from timestamptz, p_to timestamptz, p_limit integer, p_offset integer
) returns jsonb language plpgsql stable as $$
declare
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  -- % and _ in what the owner typed are looked for as they are, not as wildcards.
  v_like   text := case when v_search is null then null
                   else '%' || replace(replace(replace(lower(v_search), '\', '\\'), '%', '\%'), '_', '\_') || '%' end;
  v_limit  integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_result jsonb;
begin
  with matching as (
    select a.* from public.job_applications a
    where a.restaurant_id = p_restaurant
      and (p_status is null or a.status = p_status)
      and (p_position is null or a."position" = p_position)
      and (p_from is null or a.created_at >= p_from)
      and (p_to is null or a.created_at < p_to)
      and (v_like is null
           or lower(a.full_name) like v_like escape '\'
           or lower(a.email) like v_like escape '\'
           or lower(a."position") like v_like escape '\'
           or a.phone like v_like escape '\')
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

drop function public._applications_matching(uuid, text, text, text, timestamptz, timestamptz);
drop function public._like_pattern(text);

drop function public.team_member_seen(uuid, uuid, text);
drop function public.team_member_remove(uuid, uuid, uuid);
drop function public.team_member_set_role(uuid, uuid, text, uuid);
drop function public.team_invitation_accept(uuid, uuid, text);
drop function public.account_invitations(text);
drop function public.team_invitation_revoke(uuid, uuid, text);
drop function public.team_invitation_renew(uuid, uuid, integer);
drop function public.team_invitation_open(uuid, uuid);
drop function public.team_invitation_set_email_status(uuid, uuid, text);
drop function public.team_invitation_set_account(uuid, uuid, uuid);
drop function public.team_invitation_create(uuid, text, text, text, integer, integer, boolean);
drop function public.team_list(uuid);
drop function public._invitation_json(public.team_invitations);
drop function public._invitation_status(public.team_invitations);
drop table public.team_invitations;

drop index public.restaurant_users_email_idx;
alter table public.restaurant_users
  drop column email, drop column invited_by_email, drop column last_seen_at, drop column updated_at;

-- As every migration ends: nothing for the public roles, everything for the backend's.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;

do $$
begin
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    delete from supabase_migrations.schema_migrations where version = '20261013001400';
  end if;
end $$;

commit;
