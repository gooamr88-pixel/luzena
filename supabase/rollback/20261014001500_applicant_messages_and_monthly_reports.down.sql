-- Takes back migration 20261014001500 (messages to applicants, monthly reports).
--
-- NOT A MIGRATION, and not run by `supabase db push`. It is the way back, kept beside the
-- way forward and tested with it (tests/rollback.test.js): it leaves the database exactly
-- as it was before that migration, and the migration can then be applied again.
--
-- ORDER MATTERS. The backend that needs these objects must be gone first:
--   1. Stop the schedule:            select cron.unschedule('luzena-daily-tasks');
--   2. Deploy the previous functions (check out the commit before this work, then
--      `supabase functions deploy ... --project-ref <ref> --use-api`). The function
--      `scheduled-tasks` did not exist before: delete it, or leave it (without the tables
--      it answers with an error and does nothing).
--   3. Run this file.
--
-- WHAT IS LOST, for good: every message written to an applicant from the dashboard and its
-- delivery record; the record of which monthly reports were sent; each restaurant's report
-- address and time zone. Job applications, CVs, the team and everything else are untouched.
-- Take a copy first if any of it matters:
--   select * from public.job_application_messages;   select * from public.monthly_reports;

begin;

drop function public.monthly_reports_list(uuid);
drop function public.monthly_report_data(uuid, timestamptz, timestamptz, timestamptz);
drop function public.monthly_report_finish(uuid, date, boolean, text, text, text, jsonb);
drop function public.monthly_report_claim(uuid, date);
drop function public.monthly_report_restaurants();
drop table public.monthly_reports;

drop function public.dash_application_message_delivery(uuid, uuid, text, text);
drop function public.dash_application_messages_unsettled(uuid, uuid);
drop function public.dash_application_message_retry(uuid, uuid, uuid);
drop function public.dash_application_message_result(uuid, uuid, boolean, text, text);
drop function public.dash_application_message_create(uuid, uuid, text, text, text, uuid, text);
drop function public.dash_application_messages(uuid, uuid);
drop function public._application_message_json(public.job_application_messages);
drop table public.job_application_messages;

-- The history's two new kinds of entry are not ones the earlier constraint allows.
delete from public.job_application_events where kind in ('message_sent', 'message_failed');
alter table public.job_application_events drop constraint job_application_events_kind_check;
alter table public.job_application_events add constraint job_application_events_kind_check
  check (kind in ('submitted', 'email_sent', 'email_failed', 'status_changed', 'note', 'cv_downloaded'));

alter table public.restaurants drop column report_email, drop column timezone;

-- So that `supabase db push` offers the migration again. (No such table outside Supabase.)
do $$
begin
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    delete from supabase_migrations.schema_migrations where version = '20261014001500';
  end if;
end $$;

commit;
