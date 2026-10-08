-- One "unauthorized" answer from Clover is not proof that the token is dead.
--
-- A connection made with a merchant's own API token cannot be refreshed, so until now the
-- first time Clover answered 401 the connection was marked as needing a new token, and the
-- menu stopped updating until the owner entered one. Clover does sometimes answer 401 for
-- a token that is perfectly good (a blip on their side, a deployment). That one answer
-- should cost one failed attempt, not the connection.
--
-- So rejections are counted. The connection is marked `needs_reauth` only when Clover has
-- gone on rejecting the token: a number of attempts in a row, spread over a length of time.
-- Both are given by the backend (clover/auth.ts). One accepted request clears the count.
--
-- Nothing here stores or returns a token.

alter table public.clover_connections
  -- Attempts in a row that Clover answered "unauthorized", after a second try of the same request.
  add column auth_failures      integer not null default 0 check (auth_failures >= 0),
  -- When the current run of rejections began, and when the latest one was.
  add column auth_failing_since timestamptz,
  add column auth_failed_at     timestamptz;

-- Records one rejected attempt. Returns how many there have been in a row and whether the
-- connection has now been marked as needing a new token; null when there is no connection.
create function public.clover_auth_failed(p_restaurant uuid, p_threshold integer, p_min_seconds integer)
returns jsonb language plpgsql as $$
declare
  v public.clover_connections;
begin
  update public.clover_connections
  set auth_failures = auth_failures + 1,
      auth_failing_since = coalesce(auth_failing_since, now()),
      auth_failed_at = now(),
      last_error_code = 'unauthorized', last_error_at = now(),
      refresh_lock_until = null, updated_at = now()
  where restaurant_id = p_restaurant
  returning * into v;
  if not found then return null; end if;

  -- Enough attempts, and over a long enough time: Clover means it.
  if v.status = 'active' and v.auth_failures >= greatest(p_threshold, 1)
     and v.auth_failing_since <= now() - make_interval(secs => greatest(p_min_seconds, 0)) then
    update public.clover_connections
    set status = 'needs_reauth', last_error_code = 'token_rejected'
    where restaurant_id = p_restaurant;
    return jsonb_build_object('failures', v.auth_failures, 'needs_reauth', true);
  end if;
  return jsonb_build_object('failures', v.auth_failures, 'needs_reauth', v.status = 'needs_reauth');
end $$;

-- Clover accepted a request: whatever run of rejections there was is over.
create function public.clover_auth_ok(p_restaurant uuid) returns void
language sql as $$
  update public.clover_connections
  set auth_failures = 0, auth_failing_since = null, auth_failed_at = null
  where restaurant_id = p_restaurant and auth_failures > 0;
$$;

-- The backend needs to know whether a run of rejections is in progress, so that it clears
-- the count only when there is one to clear. Still no token leaves the database in clear.
create or replace function public.clover_connection_secret(p_restaurant uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'merchant_id', merchant_id, 'environment', environment, 'status', status,
    'access_token_enc', access_token_enc, 'refresh_token_enc', refresh_token_enc,
    'access_token_expires_at', access_token_expires_at,
    'refresh_token_expires_at', refresh_token_expires_at,
    'auth_failures', auth_failures)
  from public.clover_connections where restaurant_id = p_restaurant;
$$;

-- A new token, or a new authorisation, starts with a clean count. Otherwise as before.
create or replace function public.clover_connection_save(
  p_restaurant uuid, p_user uuid, p_merchant_id text, p_merchant_name text, p_environment text,
  p_access_enc text, p_refresh_enc text, p_access_exp timestamptz, p_refresh_exp timestamptz
) returns jsonb language plpgsql as $$
declare v_previous text;
begin
  select merchant_id into v_previous from public.clover_connections where restaurant_id = p_restaurant;

  insert into public.clover_connections as c (restaurant_id, merchant_id, merchant_name, environment,
    access_token_enc, refresh_token_enc, access_token_expires_at, refresh_token_expires_at,
    status, connected_by, connected_at, updated_at)
  values (p_restaurant, p_merchant_id, p_merchant_name, p_environment,
    p_access_enc, p_refresh_enc, p_access_exp, p_refresh_exp, 'active', p_user, now(), now())
  on conflict (restaurant_id) do update set
    merchant_id = excluded.merchant_id, merchant_name = excluded.merchant_name,
    environment = excluded.environment, access_token_enc = excluded.access_token_enc,
    refresh_token_enc = excluded.refresh_token_enc,
    access_token_expires_at = excluded.access_token_expires_at,
    refresh_token_expires_at = excluded.refresh_token_expires_at,
    status = 'active', connected_by = excluded.connected_by, connected_at = now(),
    updated_at = now(), refresh_lock_until = null, sync_lock_until = null,
    last_error_code = null, last_error_at = null,
    auth_failures = 0, auth_failing_since = null, auth_failed_at = null;

  return jsonb_build_object('ok', true, 'merchant_changed',
    v_previous is not null and v_previous <> p_merchant_id);
exception when unique_violation then
  -- This Clover merchant is already connected to a different restaurant.
  return jsonb_build_object('ok', false, 'reason', 'merchant_in_use');
end $$;

-- A refreshed OAuth token does NOT clear the count: only a request that Clover accepts does.
-- Otherwise a token that is refreshed and rejected, over and over, would never add up.

-- Whether the public website should start a synchronisation. As before, with one addition:
-- after Clover has rejected the token, visitors do not set off another attempt for two
-- minutes. Without this every page view would ask Clover again while it is saying no.
-- An owner pressing "Sync now" is not held back by it.
create or replace function public.sync_due(p_restaurant uuid, p_ttl_seconds integer) returns boolean
language sql stable as $$
  select exists (
    select 1 from public.clover_connections
    where restaurant_id = p_restaurant and status = 'active'
      and (sync_lock_until is null or sync_lock_until < now())
      and (auth_failed_at is null or auth_failed_at < now() - interval '2 minutes')
      and (sync_requested_at is not null
           or last_success_at is null
           or last_success_at < now() - make_interval(secs => p_ttl_seconds)));
$$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
