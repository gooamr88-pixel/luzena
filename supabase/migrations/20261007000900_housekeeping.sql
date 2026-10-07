-- Housekeeping: rows that are only of use for a while, removed once they are not.
--
-- Four tables grew for ever. None of them holds anything a person reads after the time
-- given here, and one of them, rate_limits, gains a row for every address that ever visits:
--
--   rate_limits       a counter for one address in one window. The longest window is a day,
--                     so a counter two days old can never be counted against again. Until
--                     now a counter was removed only when the same address came back.
--   idempotency_keys  the outcome of one create request, kept so that a retry does not
--                     create twice. A retry comes within minutes.
--   sync_runs         one row per synchronisation with Clover: several hundred a day on a
--                     site with visitors. The dashboard shows the recent ones.
--   integration_logs  errors talking to Clover, for looking into a problem.
--
-- The audit log is not touched: it is the record of who changed what, and it is kept.
--
-- The backend calls this about once an hour (see _shared/public/retention.ts). There is no
-- scheduler in this system; a busy hour and a quiet one both end with the same tables.

create index rate_limits_window_idx on public.rate_limits (window_start);

create function public.housekeeping() returns jsonb language plpgsql as $$
declare
  v_rate_limits integer;
  v_idempotency integer;
  v_sync_runs   integer;
  v_logs        integer;
  v_states      integer;
begin
  delete from public.rate_limits where window_start < now() - interval '2 days';
  get diagnostics v_rate_limits = row_count;

  delete from public.idempotency_keys where created_at < now() - interval '7 days';
  get diagnostics v_idempotency = row_count;

  -- A run that is still marked as running after a month never finished; it goes too.
  delete from public.sync_runs where started_at < now() - interval '30 days';
  get diagnostics v_sync_runs = row_count;

  delete from public.integration_logs where created_at < now() - interval '90 days';
  get diagnostics v_logs = row_count;

  -- Connection attempts that were never completed. They were only removed when the next
  -- attempt began.
  delete from public.oauth_states where expires_at < now() - interval '1 day';
  get diagnostics v_states = row_count;

  return jsonb_build_object(
    'rate_limits', v_rate_limits, 'idempotency_keys', v_idempotency, 'sync_runs', v_sync_runs,
    'integration_logs', v_logs, 'oauth_states', v_states);
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
