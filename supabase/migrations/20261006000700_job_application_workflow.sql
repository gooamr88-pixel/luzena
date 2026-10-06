-- Job applications become something the owner works through in the dashboard.
--
-- Until now an application was stored and emailed, and the email was the record. From here
-- the database is the record: the dashboard lists applications, shows each one in full,
-- moves it through a status, and keeps a history of what happened to it. The email is only
-- a notification that one has arrived.
--
-- Nothing here opens the table to the browser. Like every other table it has row level
-- security with no policies and no privileges for `anon` or `authenticated`; the Edge
-- Functions reach it through the functions below with the service role, after they have
-- checked who is asking.

-- ---------------------------------------------------------------------------------------
-- What an applicant is asked, and where the application stands
-- ---------------------------------------------------------------------------------------

alter table public.job_applications
  -- Made by the form once per page load. A second request with the same id (a double
  -- press, a retry after a lost answer) is the same application, not another one.
  add column submission_id     uuid,
  add column employment_type   text check (employment_type in ('full_time', 'part_time', 'either')),
  add column availability      text[] not null default '{}'
    check (availability <@ array['weekday_days', 'weekday_evenings', 'weekend_days', 'weekend_evenings', 'late_nights']),
  add column start_when        text check (start_when in ('immediately', 'two_weeks', 'one_month', 'later')),
  add column experience_level  text check (experience_level in ('none', 'under_1', '1_2', '3_5', 'over_5')),
  add column experience        text,
  add column work_authorized   boolean,
  add column status            text not null default 'new'
    check (status in ('new', 'reviewing', 'shortlisted', 'interview', 'hired', 'rejected')),
  add column status_changed_at timestamptz;

create unique index job_applications_submission_idx
  on public.job_applications (restaurant_id, submission_id) where submission_id is not null;
create index job_applications_status_idx on public.job_applications (restaurant_id, status, created_at desc);
create index job_applications_email_idx on public.job_applications (restaurant_id, email);

-- One row per thing that happened to an application, oldest first: it arrived, the
-- notification email went out or did not, its status changed, someone downloaded the CV.
-- Deleted with the application, so the retention period covers the history too.
create table public.job_application_events (
  id             bigint generated always as identity primary key,
  application_id uuid not null references public.job_applications(id) on delete cascade,
  restaurant_id  uuid not null references public.restaurants(id) on delete cascade,
  kind           text not null check (kind in ('submitted', 'email_sent', 'email_failed', 'status_changed', 'note', 'cv_downloaded')),
  from_status    text,
  to_status      text,
  note           text check (note is null or char_length(note) <= 500),
  actor_email    text,
  created_at     timestamptz not null default now()
);
create index job_application_events_application_idx on public.job_application_events (application_id, id);

alter table public.job_application_events enable row level security;
revoke all on public.job_application_events from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- ---------------------------------------------------------------------------------------
-- Receiving an application
-- ---------------------------------------------------------------------------------------

-- Replaced by job_application_submit, which takes the new answers and the submission id.
drop function public.job_application_create(uuid, text, text, text, text, text, text, text, text, integer, text);

create function public.job_application_exists(p_restaurant uuid, p_submission uuid) returns boolean
language sql stable as $$
  select exists (select 1 from public.job_applications
                 where restaurant_id = p_restaurant and submission_id = p_submission);
$$;

-- Stores an application and records that it arrived. Returns its id and whether this call
-- created it: false means an application with the same submission id was already there.
create function public.job_application_submit(
  p_restaurant uuid, p_submission uuid, p_data jsonb, p_ip_hash text
) returns jsonb language plpgsql as $$
declare
  v_id uuid;
begin
  insert into public.job_applications (restaurant_id, submission_id, full_name, email, phone, position,
    employment_type, availability, start_when, experience_level, experience, work_authorized, message,
    cv_path, cv_original_name, cv_mime, cv_size, ip_hash)
  values (p_restaurant, p_submission,
    p_data->>'full_name', p_data->>'email', p_data->>'phone', p_data->>'position',
    p_data->>'employment_type',
    array(select jsonb_array_elements_text(coalesce(p_data->'availability', '[]'::jsonb))),
    p_data->>'start_when', p_data->>'experience_level', p_data->>'experience',
    (p_data->>'work_authorized')::boolean, p_data->>'message',
    p_data->>'cv_path', p_data->>'cv_original_name', p_data->>'cv_mime', (p_data->>'cv_size')::integer,
    p_ip_hash)
  on conflict (restaurant_id, submission_id) where submission_id is not null do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.job_applications
    where restaurant_id = p_restaurant and submission_id = p_submission;
    return jsonb_build_object('id', v_id, 'created', false);
  end if;

  insert into public.job_application_events (application_id, restaurant_id, kind, to_status)
  values (v_id, p_restaurant, 'submitted', 'new');
  return jsonb_build_object('id', v_id, 'created', true);
end $$;

-- Whether the notification email went out. Recorded on the application and in its history.
create or replace function public.job_application_set_email_status(p_id uuid, p_status text) returns void
language plpgsql as $$
declare
  v_restaurant uuid;
begin
  update public.job_applications set email_status = p_status where id = p_id
  returning restaurant_id into v_restaurant;
  if v_restaurant is not null and p_status in ('sent', 'failed') then
    insert into public.job_application_events (application_id, restaurant_id, kind)
    values (p_id, v_restaurant, 'email_' || p_status);
  end if;
end $$;

-- ---------------------------------------------------------------------------------------
-- The dashboard
-- ---------------------------------------------------------------------------------------

-- One page of applications, newest first, with the totals the filters need. The list
-- carries no contact details and no free text: those are read one application at a time.
-- p_from is inclusive and p_to exclusive; both are instants, so the caller decides the
-- time zone a "day" is in.
create function public.dash_applications_list(
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

create function public.dash_applications_summary(p_restaurant uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'new', count(*) filter (where status = 'new'),
    'total', count(*))
  from public.job_applications where restaurant_id = p_restaurant;
$$;

-- Everything about one application, with its history. Never the CV's storage path and
-- never the address hash: neither is of any use to a browser.
create function public.dash_application_get(p_restaurant uuid, p_id uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', a.id, 'full_name', a.full_name, 'email', a.email, 'phone', a.phone,
    'position', a."position", 'employment_type', a.employment_type,
    'availability', to_jsonb(a.availability), 'start_when', a.start_when,
    'experience_level', a.experience_level, 'experience', a.experience,
    'work_authorized', a.work_authorized, 'message', a.message,
    'status', a.status, 'status_changed_at', a.status_changed_at,
    'email_status', a.email_status, 'created_at', a.created_at,
    'cv', case when a.cv_path is null then null
          else jsonb_build_object('name', a.cv_original_name, 'mime', a.cv_mime, 'size', a.cv_size) end,
    'other_applications', (select count(*) from public.job_applications o
                           where o.restaurant_id = a.restaurant_id and o.email = a.email and o.id <> a.id),
    'events', coalesce((select jsonb_agg(jsonb_build_object(
        'id', e.id, 'kind', e.kind, 'from_status', e.from_status, 'to_status', e.to_status,
        'note', e.note, 'actor_email', e.actor_email, 'created_at', e.created_at) order by e.id)
      from public.job_application_events e where e.application_id = a.id), '[]'::jsonb))
  from public.job_applications a
  where a.restaurant_id = p_restaurant and a.id = p_id;
$$;

-- Where the CV is stored. For the backend only, which streams the file to a signed-in owner.
create function public.dash_application_cv(p_restaurant uuid, p_id uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object('path', cv_path, 'name', cv_original_name, 'mime', cv_mime)
  from public.job_applications
  where restaurant_id = p_restaurant and id = p_id and cv_path is not null;
$$;

-- Moves an application to another status, with an optional note, and records who did it.
-- The same status with a note records the note alone. Returns the application as it now
-- stands, or null when it is not this restaurant's.
create function public.dash_application_set_status(
  p_restaurant uuid, p_id uuid, p_status text, p_note text, p_actor_email text
) returns jsonb language plpgsql as $$
declare
  v_old  text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select status into v_old from public.job_applications
  where restaurant_id = p_restaurant and id = p_id for update;
  if not found then return null; end if;

  if v_old is distinct from p_status then
    update public.job_applications set status = p_status, status_changed_at = now() where id = p_id;
    insert into public.job_application_events (application_id, restaurant_id, kind, from_status, to_status, note, actor_email)
    values (p_id, p_restaurant, 'status_changed', v_old, p_status, v_note, p_actor_email);
  elsif v_note is not null then
    insert into public.job_application_events (application_id, restaurant_id, kind, note, actor_email)
    values (p_id, p_restaurant, 'note', v_note, p_actor_email);
  end if;
  return public.dash_application_get(p_restaurant, p_id);
end $$;

-- Records that someone took a copy of the CV.
create function public.dash_application_log_download(p_restaurant uuid, p_id uuid, p_actor_email text) returns void
language sql as $$
  insert into public.job_application_events (application_id, restaurant_id, kind, actor_email)
  select a.id, a.restaurant_id, 'cv_downloaded', p_actor_email
  from public.job_applications a where a.restaurant_id = p_restaurant and a.id = p_id;
$$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
