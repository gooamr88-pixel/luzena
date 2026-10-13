-- Writing to applicants from the dashboard, and the monthly report to the owner.
--
-- MESSAGES. An owner or manager answers an applicant from the application's page. Every
-- message is a row here before it is handed to the email provider, so there is always a
-- record of what was sent, to which address, by whom, and what became of it. The address
-- is the application's own, copied by the database when the row is made: nothing a request
-- carries can send a message anywhere else.
--
-- REPORTS. Once a month each restaurant's owner is sent a report. One row per restaurant
-- and month is what makes it happen once: the scheduler may call as often as it likes, and
-- a month that has been sent is never sent again.
--
-- As everywhere else: row level security with no policy, nothing for `anon` or
-- `authenticated`, and functions for the service role alone.

-- ---------------------------------------------------------------------------------------
-- The restaurant: where its report goes, and whose clock a "month" is on
-- ---------------------------------------------------------------------------------------

alter table public.restaurants
  -- Where the monthly report is sent. The recruitment address is used while this is empty.
  add column report_email text,
  -- An IANA zone name. A month starts at midnight on this clock, not at midnight UTC.
  add column timezone text not null default 'America/Los_Angeles';

-- ---------------------------------------------------------------------------------------
-- Messages to applicants
-- ---------------------------------------------------------------------------------------

create table public.job_application_messages (
  id                  uuid primary key default gen_random_uuid(),
  application_id      uuid not null references public.job_applications(id) on delete cascade,
  restaurant_id       uuid not null references public.restaurants(id) on delete cascade,
  kind                text not null check (kind in ('reply', 'acknowledgment', 'interview', 'more_information', 'status_update')),
  -- The applicant's address as it was when the message was written.
  to_email            text not null,
  subject             text not null check (char_length(subject) between 1 and 150),
  body                text not null check (char_length(body) between 1 and 5000),
  --   sending    made, not yet answered for by the provider
  --   sent       the provider accepted it
  --   delivered  the recipient's mail server accepted it (the provider's own report)
  --   bounced    the recipient's mail server refused it
  --   blocked    the provider would not send it
  --   failed     it never left: the provider refused it or could not be reached
  status              text not null default 'sending' check (status in ('sending', 'sent', 'delivered', 'bounced', 'blocked', 'failed')),
  status_detail       text check (status_detail is null or char_length(status_detail) <= 300),
  provider_message_id text,
  attempts            integer not null default 0,
  sent_by             uuid,
  sent_by_email       text,
  created_at          timestamptz not null default now(),
  sent_at             timestamptz,
  delivered_at        timestamptz,
  status_checked_at   timestamptz
);
create index job_application_messages_application_idx on public.job_application_messages (application_id, created_at);
create index job_application_messages_recent_idx on public.job_application_messages (restaurant_id, created_at desc);

alter table public.job_application_messages enable row level security;
revoke all on public.job_application_messages from anon, authenticated;
grant all on public.job_application_messages to service_role;

-- An application's history also says when a message was sent or could not be.
alter table public.job_application_events drop constraint job_application_events_kind_check;
alter table public.job_application_events add constraint job_application_events_kind_check
  check (kind in ('submitted', 'email_sent', 'email_failed', 'status_changed', 'note', 'cv_downloaded', 'message_sent', 'message_failed'));

create function public._application_message_json(m public.job_application_messages) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'id', m.id, 'kind', m.kind, 'to_email', m.to_email, 'subject', m.subject, 'body', m.body,
    'status', m.status, 'status_detail', m.status_detail, 'attempts', m.attempts,
    'sent_by_email', m.sent_by_email, 'created_at', m.created_at, 'sent_at', m.sent_at, 'delivered_at', m.delivered_at);
$$;

-- An application's messages, oldest first. Empty for another restaurant's application.
create function public.dash_application_messages(p_restaurant uuid, p_application uuid) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(public._application_message_json(m) order by m.created_at, m.id), '[]'::jsonb)
  from public.job_application_messages m
  where m.restaurant_id = p_restaurant and m.application_id = p_application;
$$;

-- Makes the record of a message before it is sent. The recipient is the application's own
-- address, read here. null when the application is not this restaurant's.
create function public.dash_application_message_create(
  p_restaurant uuid, p_application uuid, p_kind text, p_subject text, p_body text, p_user uuid, p_actor_email text
) returns jsonb language plpgsql as $$
declare
  v_application public.job_applications;
  v_message     public.job_application_messages;
begin
  select * into v_application from public.job_applications where restaurant_id = p_restaurant and id = p_application;
  if not found then return null; end if;
  insert into public.job_application_messages (application_id, restaurant_id, kind, to_email, subject, body, sent_by, sent_by_email)
  values (p_application, p_restaurant, p_kind, v_application.email, p_subject, p_body, p_user, p_actor_email)
  returning * into v_message;
  return jsonb_build_object('message', public._application_message_json(v_message),
    'full_name', v_application.full_name, 'position', v_application."position");
end $$;

-- Records what the provider said to a message that was being sent, and puts it in the
-- application's history. Only a message that is being sent can be answered for.
create function public.dash_application_message_result(
  p_restaurant uuid, p_id uuid, p_sent boolean, p_provider_id text, p_detail text
) returns jsonb language plpgsql as $$
declare
  v_message public.job_application_messages;
begin
  update public.job_application_messages
  set status = case when p_sent then 'sent' else 'failed' end,
      status_detail = left(p_detail, 300), provider_message_id = coalesce(p_provider_id, provider_message_id),
      attempts = attempts + 1, sent_at = case when p_sent then now() else sent_at end
  where restaurant_id = p_restaurant and id = p_id and status = 'sending'
  returning * into v_message;
  if not found then return null; end if;
  insert into public.job_application_events (application_id, restaurant_id, kind, note, actor_email)
  values (v_message.application_id, p_restaurant, case when p_sent then 'message_sent' else 'message_failed' end,
          left(v_message.subject, 500), v_message.sent_by_email);
  return public._application_message_json(v_message);
end $$;

-- Takes a message that failed back into "sending", so that it can be tried again. null when
-- it is not this restaurant's or did not fail: a message that went is never sent twice.
create function public.dash_application_message_retry(p_restaurant uuid, p_application uuid, p_id uuid) returns jsonb
language plpgsql as $$
declare
  v_message public.job_application_messages;
begin
  update public.job_application_messages set status = 'sending', status_detail = null
  where restaurant_id = p_restaurant and application_id = p_application and id = p_id and status = 'failed'
  returning * into v_message;
  if not found then return null; end if;
  return jsonb_build_object('message', public._application_message_json(v_message),
    'full_name', (select full_name from public.job_applications where id = v_message.application_id),
    'position', (select "position" from public.job_applications where id = v_message.application_id));
end $$;

-- The messages of an application that the provider accepted and has not yet answered for:
-- the ones worth asking about. Asked at most once a minute each, and for a week.
create function public.dash_application_messages_unsettled(p_restaurant uuid, p_application uuid) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'provider_message_id', m.provider_message_id) order by m.created_at), '[]'::jsonb)
  from (
    select * from public.job_application_messages
    where restaurant_id = p_restaurant and application_id = p_application
      and status = 'sent' and provider_message_id is not null and sent_at > now() - interval '7 days'
      and (status_checked_at is null or status_checked_at < now() - interval '1 minute')
    order by created_at desc limit 5
  ) m;
$$;

-- Records what the provider reports became of a message it accepted. p_status null means
-- "nothing final yet": only the time of asking is noted.
create function public.dash_application_message_delivery(p_restaurant uuid, p_id uuid, p_status text, p_detail text) returns void
language sql as $$
  update public.job_application_messages
  set status = coalesce(p_status, status),
      status_detail = case when p_status is null then status_detail else left(p_detail, 300) end,
      delivered_at = case when p_status = 'delivered' then now() else delivered_at end,
      status_checked_at = now()
  where restaurant_id = p_restaurant and id = p_id and status = 'sent'
    and (p_status is null or p_status in ('delivered', 'bounced', 'blocked'));
$$;

-- ---------------------------------------------------------------------------------------
-- Monthly reports
-- ---------------------------------------------------------------------------------------

create table public.monthly_reports (
  restaurant_id       uuid not null references public.restaurants(id) on delete cascade,
  -- The first day of the month the report is about.
  period              date not null check (extract(day from period) = 1),
  status              text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  to_email            text,
  provider_message_id text,
  error               text check (error is null or char_length(error) <= 300),
  attempts            integer not null default 0,
  -- The figures the report was made from, kept so that what was sent can be looked up.
  summary             jsonb,
  claimed_at          timestamptz,
  sent_at             timestamptz,
  created_at          timestamptz not null default now(),
  primary key (restaurant_id, period)
);
alter table public.monthly_reports enable row level security;
revoke all on public.monthly_reports from anon, authenticated;
grant all on public.monthly_reports to service_role;

-- Every restaurant, with where its report goes and the clock its months are on. Which
-- month is owed, and the instants it starts and ends at on that clock, are worked out by
-- the backend (scheduled/monthly-report.ts); whether it may be sent is `monthly_report_claim`.
create function public.monthly_report_restaurants() returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'restaurant_id', r.id, 'name', r.name, 'slug', r.slug, 'timezone', r.timezone,
    'to_email', coalesce(nullif(btrim(r.report_email), ''), nullif(btrim(r.recruitment_email), ''))) order by r.name), '[]'::jsonb)
  from public.restaurants r;
$$;

-- Takes one restaurant's month to send. false when it has been sent, or when another call
-- took it less than fifteen minutes ago: two calls at once send one report.
create function public.monthly_report_claim(p_restaurant uuid, p_period date) returns boolean
language plpgsql as $$
begin
  insert into public.monthly_reports as m (restaurant_id, period, claimed_at, attempts)
  values (p_restaurant, p_period, now(), 1)
  on conflict (restaurant_id, period) do update set claimed_at = now(), attempts = m.attempts + 1
  where m.status <> 'sent' and (m.claimed_at is null or m.claimed_at < now() - interval '15 minutes');
  return found;
end $$;

create function public.monthly_report_finish(
  p_restaurant uuid, p_period date, p_sent boolean, p_to text, p_provider_id text, p_error text, p_summary jsonb
) returns void language sql as $$
  update public.monthly_reports
  set status = case when p_sent then 'sent' else 'failed' end, to_email = p_to, provider_message_id = p_provider_id,
      error = left(p_error, 300), summary = p_summary, sent_at = case when p_sent then now() else null end,
      -- A report that could not be sent is free to be tried again at the next call.
      claimed_at = case when p_sent then claimed_at else null end
  where restaurant_id = p_restaurant and period = p_period and status <> 'sent';
$$;

-- The figures of one restaurant between two instants, and of the month before for
-- comparison. Only what this system records: it has no visitor counts and sees no orders.
create function public.monthly_report_data(p_restaurant uuid, p_from timestamptz, p_to timestamptz, p_previous_from timestamptz)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'applications', jsonb_build_object(
      'received', (select count(*) from public.job_applications where restaurant_id = p_restaurant and created_at >= p_from and created_at < p_to),
      'received_previous', (select count(*) from public.job_applications where restaurant_id = p_restaurant and created_at >= p_previous_from and created_at < p_from),
      'with_cv', (select count(*) from public.job_applications where restaurant_id = p_restaurant and created_at >= p_from and created_at < p_to and cv_path is not null),
      'by_position', coalesce((select jsonb_agg(jsonb_build_object('position', s.title, 'count', s.n) order by s.n desc, s.title) from (
          select "position" as title, count(*) as n from public.job_applications
          where restaurant_id = p_restaurant and created_at >= p_from and created_at < p_to group by "position") s), '[]'::jsonb),
      'by_status', coalesce((select jsonb_object_agg(s.status, s.n) from (
          select status, count(*) as n from public.job_applications
          where restaurant_id = p_restaurant and created_at >= p_from and created_at < p_to group by status) s), '{}'::jsonb),
      'open_now', (select count(*) from public.job_applications where restaurant_id = p_restaurant and status in ('new', 'reviewing', 'shortlisted', 'interview')),
      'new_waiting_over_14_days', (select count(*) from public.job_applications where restaurant_id = p_restaurant and status = 'new' and created_at < p_to - interval '14 days'),
      'status_changes', (select count(*) from public.job_application_events where restaurant_id = p_restaurant and kind = 'status_changed' and created_at >= p_from and created_at < p_to),
      'notifications_failed', (select count(*) from public.job_application_events where restaurant_id = p_restaurant and kind = 'email_failed' and created_at >= p_from and created_at < p_to)),
    'messages', jsonb_build_object(
      'written', (select count(*) from public.job_application_messages where restaurant_id = p_restaurant and created_at >= p_from and created_at < p_to),
      'delivered', (select count(*) from public.job_application_messages where restaurant_id = p_restaurant and created_at >= p_from and created_at < p_to and status = 'delivered'),
      'not_delivered', (select count(*) from public.job_application_messages where restaurant_id = p_restaurant and created_at >= p_from and created_at < p_to and status in ('failed', 'bounced', 'blocked'))),
    'clover', (select jsonb_build_object(
        'connected', c.restaurant_id is not null, 'status', c.status, 'merchant_name', c.merchant_name,
        'last_success_at', c.last_success_at, 'last_error_code', c.last_error_code)
      from (select 1) one left join public.clover_connections c on c.restaurant_id = p_restaurant),
    -- Synchronisation history is kept for thirty days, so the first days of a long month
    -- may already be gone by the time its report is made. `history_from` says from when.
    'sync', jsonb_build_object(
      'succeeded', (select count(*) from public.sync_runs where restaurant_id = p_restaurant and status = 'succeeded' and started_at >= p_from and started_at < p_to),
      'failed', (select count(*) from public.sync_runs where restaurant_id = p_restaurant and status = 'failed' and started_at >= p_from and started_at < p_to),
      'history_from', (select min(started_at) from public.sync_runs where restaurant_id = p_restaurant),
      'errors', coalesce((select jsonb_agg(jsonb_build_object('code', s.error_code, 'count', s.n) order by s.n desc) from (
          select coalesce(error_code, 'unknown') as error_code, count(*) as n from public.sync_runs
          where restaurant_id = p_restaurant and status = 'failed' and started_at >= p_from and started_at < p_to group by 1) s), '[]'::jsonb)),
    'menu', (select jsonb_build_object(
        'items', count(*) filter (where archived_at is null),
        'on_website', count(*) filter (where archived_at is null and not hidden and not web_hidden),
        'out_of_stock', count(*) filter (where archived_at is null and not available),
        'without_description', count(*) filter (where archived_at is null and not hidden and not web_hidden and web_description is null),
        'without_photo', count(*) filter (where archived_at is null and not hidden and not web_hidden and web_image_path is null))
      from public.menu_items where restaurant_id = p_restaurant and removed_from_clover_at is null),
    'activity', jsonb_build_object(
      'changes', (select count(*) from public.audit_logs where restaurant_id = p_restaurant and created_at >= p_from and created_at < p_to),
      'not_completed', (select count(*) from public.audit_logs where restaurant_id = p_restaurant and created_at >= p_from and created_at < p_to and result <> 'success'),
      'by_action', coalesce((select jsonb_agg(jsonb_build_object('action', s.action, 'count', s.n) order by s.n desc, s.action) from (
          select action, count(*) as n from public.audit_logs
          where restaurant_id = p_restaurant and created_at >= p_from and created_at < p_to group by action order by n desc limit 12) s), '[]'::jsonb)),
    'errors', jsonb_build_object(
      'logged', (select count(*) from public.integration_logs where restaurant_id = p_restaurant and level = 'error' and created_at >= p_from and created_at < p_to),
      'by_event', coalesce((select jsonb_agg(jsonb_build_object('event', s.event, 'count', s.n) order by s.n desc) from (
          select event, count(*) as n from public.integration_logs
          where restaurant_id = p_restaurant and level = 'error' and created_at >= p_from and created_at < p_to group by event order by n desc limit 8) s), '[]'::jsonb)),
    'team', jsonb_build_object(
      'members', (select count(*) from public.restaurant_users where restaurant_id = p_restaurant),
      'joined', (select count(*) from public.restaurant_users where restaurant_id = p_restaurant and created_at >= p_from and created_at < p_to),
      'removed', (select count(*) from public.audit_logs where restaurant_id = p_restaurant and action = 'MEMBER_REMOVED' and created_at >= p_from and created_at < p_to),
      'invitations_waiting', (select count(*) from public.team_invitations where restaurant_id = p_restaurant and accepted_at is null and revoked_at is null and expires_at > now())));
$$;

-- The reports made for a restaurant, newest first, for whoever looks into one later.
create function public.monthly_reports_list(p_restaurant uuid) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('period', m.period, 'status', m.status, 'to_email', m.to_email,
    'sent_at', m.sent_at, 'attempts', m.attempts, 'error', m.error) order by m.period desc), '[]'::jsonb)
  from (select * from public.monthly_reports where restaurant_id = p_restaurant order by period desc limit 24) m;
$$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
