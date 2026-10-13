-- The daily schedule: once a day the database calls the `scheduled-tasks` function, which
-- sends the monthly report when one is owed and does the regular clean-up.
--
-- NOT A MIGRATION. It is run once on each project, by hand, after the function has been
-- deployed and its CRON_SECRET set, because it holds two things that differ per project and
-- do not belong in Git: the address of that project's functions, and the secret.
--
-- BEFORE RUNNING, replace the two placeholders below:
--   __PROJECT_REF__   the project's reference (TEST or PRODUCTION: never the other one's)
--   __CRON_SECRET__   the same value the function was given as its CRON_SECRET secret
-- Run it in the project's SQL editor, or with
--   supabase db query --linked --project-ref <ref> -f <a copy with the values filled in>
-- and delete the filled-in copy afterwards. Do not commit one.
--
-- It can be run again at any time: the secret and the address are replaced and the job is
-- rescheduled, never duplicated. To change the secret, set the new CRON_SECRET on the
-- function first, then run this again with the same value.
--
-- Both values are kept in Supabase Vault, encrypted at rest. The job itself holds neither:
-- it reads them from the Vault each time it runs, so they are in no job definition, no
-- `cron.job` row and no log.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- A fact to know, not something this file can change: when pg_net is created, Supabase
-- itself grants its functions (SQL that makes HTTP requests) to `anon` and `authenticated`,
-- and the role that runs this file cannot take a grant of Supabase's back. Those roles
-- cannot use it all the same: they reach the database only through the API, and the API
-- serves the `public` schema alone (a request for the `net`, `cron` or `vault` schema is
-- refused, which was checked on TEST). See SECURITY.md section 4d.

do $$
declare
  v_url    constant text := 'https://__PROJECT_REF__.supabase.co/functions/v1/scheduled-tasks';
  v_secret constant text := '__CRON_SECRET__';
  v_id     uuid;
begin
  if v_url like '%\_\_%' or v_secret like '%\_\_%' then
    raise exception 'Replace __PROJECT_REF__ and __CRON_SECRET__ before running this file.';
  end if;
  if char_length(v_secret) < 32 then
    raise exception 'The secret must be at least 32 characters, as the function requires.';
  end if;

  select id into v_id from vault.secrets where name = 'scheduled_tasks_url';
  if v_id is null then
    perform vault.create_secret(v_url, 'scheduled_tasks_url', 'Address of the scheduled-tasks function');
  else
    perform vault.update_secret(v_id, v_url);
  end if;

  select id into v_id from vault.secrets where name = 'scheduled_tasks_secret';
  if v_id is null then
    perform vault.create_secret(v_secret, 'scheduled_tasks_secret', 'Shared secret the scheduled-tasks function expects');
  else
    perform vault.update_secret(v_id, v_secret);
  end if;
end $$;

-- Every day at 13:15 UTC: a quarter past six in the morning in San Diego in summer, a
-- quarter past five in winter. The function works out for itself, on each restaurant's own
-- clock, which month is owed; calling it daily is what makes a report that could not be
-- sent on the first of the month go out on the second.
select cron.schedule(
  'luzena-daily-tasks',
  '15 13 * * *',
  $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'scheduled_tasks_url'),
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'scheduled_tasks_secret')),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000);
  $job$
);

-- ---------------------------------------------------------------------------------------
-- Looking at it afterwards (read-only)
-- ---------------------------------------------------------------------------------------
-- The job, and that it is active:
--   select jobid, jobname, schedule, active from cron.job where jobname = 'luzena-daily-tasks';
-- Its last runs (did the database make the call):
--   select start_time, status, return_message from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'luzena-daily-tasks')
--   order by start_time desc limit 10;
-- What the function answered (kept by pg_net for a few hours): 200 and counts, or the reason.
--   select created, status_code, content from net._http_response order by created desc limit 5;
-- What has been sent, month by month:
--   select r.slug, m.period, m.status, m.to_email, m.sent_at, m.attempts, m.error
--   from public.monthly_reports m join public.restaurants r on r.id = m.restaurant_id order by m.period desc;
--
-- To stop it:   select cron.unschedule('luzena-daily-tasks');
