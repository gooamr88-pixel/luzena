-- Data-access layer. Edge Functions call ONLY these functions (through PostgREST rpc with
-- the service-role key). Every function that touches tenant data takes p_restaurant, which
-- the backend resolves from the authenticated user's membership, never from request input.
--
-- Functions are SECURITY INVOKER on purpose: if execute were ever granted to anon or
-- authenticated by mistake, RLS (no policies) would still return nothing.

-- ---------------------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------------------

create function public.user_memberships(p_user uuid) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'restaurant_id', r.id, 'slug', r.slug, 'name', r.name,
           'currency', r.currency, 'role', ru.role) order by r.name), '[]'::jsonb)
  from public.restaurant_users ru
  join public.restaurants r on r.id = ru.restaurant_id
  where ru.user_id = p_user;
$$;

create function public.restaurant_public(p_slug text) returns jsonb
language sql stable as $$
  select jsonb_build_object('id', id, 'name', name, 'currency', currency)
  from public.restaurants where slug = p_slug;
$$;

create function public.restaurant_recruitment_email(p_restaurant uuid) returns text
language sql stable as $$
  select recruitment_email from public.restaurants where id = p_restaurant;
$$;

-- ---------------------------------------------------------------------------------------
-- Rate limiting (fixed window)
-- ---------------------------------------------------------------------------------------

create function public.rate_limit_hit(p_key text, p_max integer, p_window_seconds integer)
returns boolean language plpgsql as $$
declare
  v_start timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_count integer;
begin
  insert into public.rate_limits as rl (key, window_start, count) values (p_key, v_start, 1)
  on conflict (key, window_start) do update set count = rl.count + 1
  returning rl.count into v_count;

  delete from public.rate_limits where key = p_key and window_start < v_start;
  return v_count <= p_max;
end $$;

-- ---------------------------------------------------------------------------------------
-- Logs and audit
-- ---------------------------------------------------------------------------------------

create function public.log_integration(
  p_restaurant uuid, p_level text, p_event text, p_correlation text, p_details jsonb
) returns void language sql as $$
  insert into public.integration_logs (restaurant_id, level, event, correlation_id, details)
  values (p_restaurant, p_level, p_event, p_correlation, p_details);
$$;

create function public.audit_write(
  p_restaurant uuid, p_user uuid, p_actor_email text, p_action text, p_entity_type text,
  p_entity_id text, p_old jsonb, p_new jsonb, p_result text, p_sync_status text, p_request_id text
) returns void language sql as $$
  insert into public.audit_logs (restaurant_id, user_id, actor_email, action, entity_type,
    entity_id, old_values, new_values, result, sync_status, request_id)
  values (p_restaurant, p_user, p_actor_email, p_action, p_entity_type,
    p_entity_id, p_old, p_new, p_result, p_sync_status, p_request_id);
$$;

create function public.audit_list(p_restaurant uuid, p_limit integer, p_before bigint)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(a) - 'restaurant_id' - 'user_id' order by a.id desc), '[]'::jsonb)
  from (
    select * from public.audit_logs
    where restaurant_id = p_restaurant and (p_before is null or id < p_before)
    order by id desc
    limit least(greatest(coalesce(p_limit, 30), 1), 100)
  ) a;
$$;

-- ---------------------------------------------------------------------------------------
-- Idempotency for retried create requests
-- ---------------------------------------------------------------------------------------

-- States returned:
--   new          first time this key is seen; caller proceeds
--   replay       finished before; caller returns the stored response
--   in_progress  another request with this key is still running
--   reconcile    an earlier attempt ended with an unknown outcome (or crashed); the caller
--                must check Clover before creating anything
--   mismatch     the key was reused with a different request body
create function public.idem_begin(p_restaurant uuid, p_key text, p_hash text) returns jsonb
language plpgsql as $$
declare v public.idempotency_keys;
begin
  insert into public.idempotency_keys (restaurant_id, key, request_hash)
  values (p_restaurant, p_key, p_hash)
  on conflict do nothing;
  if found then
    return jsonb_build_object('state', 'new');
  end if;

  select * into v from public.idempotency_keys
  where restaurant_id = p_restaurant and key = p_key for update;

  if v.request_hash <> p_hash then
    return jsonb_build_object('state', 'mismatch');
  elsif v.status = 'completed' then
    return jsonb_build_object('state', 'replay',
      'response_status', v.response_status, 'response_body', v.response_body);
  elsif v.status = 'in_progress' and v.created_at > now() - interval '2 minutes' then
    return jsonb_build_object('state', 'in_progress');
  end if;

  update public.idempotency_keys set status = 'in_progress', created_at = now()
  where restaurant_id = p_restaurant and key = p_key;
  return jsonb_build_object('state', 'reconcile', 'since', v.created_at);
end $$;

create function public.idem_finish(
  p_restaurant uuid, p_key text, p_status text, p_response_status integer, p_response_body jsonb
) returns void language sql as $$
  update public.idempotency_keys
  set status = p_status, response_status = p_response_status, response_body = p_response_body
  where restaurant_id = p_restaurant and key = p_key;
$$;

-- ---------------------------------------------------------------------------------------
-- Clover connection
-- ---------------------------------------------------------------------------------------

create function public.oauth_state_create(
  p_restaurant uuid, p_user uuid, p_nonce_hash text, p_ttl_seconds integer
) returns void language plpgsql as $$
begin
  delete from public.oauth_states where expires_at < now();
  insert into public.oauth_states (nonce_hash, restaurant_id, user_id, expires_at)
  values (p_nonce_hash, p_restaurant, p_user, now() + make_interval(secs => p_ttl_seconds));
end $$;

-- Single use: the row is deleted as it is matched.
create function public.oauth_state_consume(p_restaurant uuid, p_user uuid, p_nonce_hash text)
returns boolean language plpgsql as $$
begin
  delete from public.oauth_states
  where nonce_hash = p_nonce_hash and restaurant_id = p_restaurant
    and user_id = p_user and expires_at > now();
  return found;
end $$;

create function public.clover_connection_save(
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
    last_error_code = null, last_error_at = null;

  return jsonb_build_object('ok', true, 'merchant_changed',
    v_previous is not null and v_previous <> p_merchant_id);
exception when unique_violation then
  -- This Clover merchant is already connected to a different restaurant.
  return jsonb_build_object('ok', false, 'reason', 'merchant_in_use');
end $$;

create function public.clover_set_merchant_name(p_restaurant uuid, p_name text) returns void
language sql as $$
  update public.clover_connections set merchant_name = p_name where restaurant_id = p_restaurant;
$$;

-- Server-side only: includes ciphertext. Never returned to a client.
create function public.clover_connection_secret(p_restaurant uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'merchant_id', merchant_id, 'environment', environment, 'status', status,
    'access_token_enc', access_token_enc, 'refresh_token_enc', refresh_token_enc,
    'access_token_expires_at', access_token_expires_at,
    'refresh_token_expires_at', refresh_token_expires_at)
  from public.clover_connections where restaurant_id = p_restaurant;
$$;

-- Safe for the dashboard: no token material.
create function public.clover_connection_status(p_restaurant uuid) returns jsonb
language sql stable as $$
  select coalesce((
    select jsonb_build_object(
      'connected', true, 'status', status, 'merchant_id', merchant_id,
      'merchant_name', merchant_name, 'environment', environment,
      'connected_at', connected_at,
      'syncing', sync_lock_until is not null and sync_lock_until > now(),
      'last_sync_started_at', last_sync_started_at,
      'last_sync_finished_at', last_sync_finished_at,
      'last_success_at', last_success_at,
      'last_error_code', last_error_code, 'last_error_at', last_error_at)
    from public.clover_connections where restaurant_id = p_restaurant
  ), jsonb_build_object('connected', false, 'status', 'not_connected'));
$$;

-- Refresh tokens are single use. Only the caller that wins this claim may refresh.
create function public.clover_refresh_claim(p_restaurant uuid, p_lock_seconds integer)
returns boolean language plpgsql as $$
begin
  update public.clover_connections
  set refresh_lock_until = now() + make_interval(secs => p_lock_seconds)
  where restaurant_id = p_restaurant
    and (refresh_lock_until is null or refresh_lock_until < now());
  return found;
end $$;

create function public.clover_tokens_rotate(
  p_restaurant uuid, p_access_enc text, p_refresh_enc text,
  p_access_exp timestamptz, p_refresh_exp timestamptz
) returns void language sql as $$
  update public.clover_connections
  set access_token_enc = p_access_enc, refresh_token_enc = p_refresh_enc,
      access_token_expires_at = p_access_exp, refresh_token_expires_at = p_refresh_exp,
      refresh_lock_until = null, status = 'active', updated_at = now()
  where restaurant_id = p_restaurant;
$$;

create function public.clover_refresh_release(p_restaurant uuid) returns void
language sql as $$
  update public.clover_connections set refresh_lock_until = null where restaurant_id = p_restaurant;
$$;

create function public.clover_mark_needs_reauth(p_restaurant uuid, p_error_code text)
returns void language sql as $$
  update public.clover_connections
  set status = 'needs_reauth', refresh_lock_until = null,
      last_error_code = p_error_code, last_error_at = now(), updated_at = now()
  where restaurant_id = p_restaurant;
$$;

-- Removes the tokens. The mirrored menu and all website data are kept.
create function public.clover_disconnect(p_restaurant uuid) returns boolean
language plpgsql as $$
begin
  delete from public.clover_connections where restaurant_id = p_restaurant;
  return found;
end $$;

create function public.restaurants_by_merchant(p_merchant_id text) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(restaurant_id), '[]'::jsonb)
  from public.clover_connections where merchant_id = p_merchant_id and status = 'active';
$$;

-- ---------------------------------------------------------------------------------------
-- Sync bookkeeping
-- ---------------------------------------------------------------------------------------

create function public.sync_request(p_restaurant uuid) returns void
language sql as $$
  update public.clover_connections set sync_requested_at = now() where restaurant_id = p_restaurant;
$$;

create function public.sync_due(p_restaurant uuid, p_ttl_seconds integer) returns boolean
language sql stable as $$
  select exists (
    select 1 from public.clover_connections
    where restaurant_id = p_restaurant and status = 'active'
      and (sync_lock_until is null or sync_lock_until < now())
      and (sync_requested_at is not null
           or last_success_at is null
           or last_success_at < now() - make_interval(secs => p_ttl_seconds)));
$$;

-- Returns the new run id, or null when a sync is already running or there is no usable
-- connection.
create function public.sync_claim(p_restaurant uuid, p_trigger text, p_lock_seconds integer)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  update public.clover_connections
  set sync_lock_until = now() + make_interval(secs => p_lock_seconds),
      last_sync_started_at = now(), sync_requested_at = null
  where restaurant_id = p_restaurant and status = 'active'
    and (sync_lock_until is null or sync_lock_until < now());
  if not found then
    return null;
  end if;
  insert into public.sync_runs (restaurant_id, trigger) values (p_restaurant, p_trigger)
  returning id into v_id;
  return v_id;
end $$;

create function public.sync_finish(
  p_run uuid, p_status text, p_stats jsonb, p_error_code text, p_error_message text
) returns void language plpgsql as $$
declare v_restaurant uuid;
begin
  update public.sync_runs
  set status = p_status, finished_at = now(), stats = p_stats,
      error_code = p_error_code, error_message = left(p_error_message, 500)
  where id = p_run
  returning restaurant_id into v_restaurant;

  update public.clover_connections
  set sync_lock_until = null,
      last_sync_finished_at = now(),
      last_success_at = case when p_status = 'succeeded' then now() else last_success_at end,
      last_error_code = case when p_status = 'succeeded' then null else p_error_code end,
      last_error_at   = case when p_status = 'succeeded' then null else now() end
  where restaurant_id = v_restaurant;
end $$;

-- ---------------------------------------------------------------------------------------
-- Applying Clover data to the mirror
-- ---------------------------------------------------------------------------------------

-- p_payload (all keys optional):
--   categories:      [{id, name, sort_order, item_ids?}]
--   items:           [{id, name, price_cents, price_type, unit_name, hidden, available,
--                      modified_time, category_ids?, modifier_group_ids?}]
--   modifier_groups: [{id, name, min_required, max_allowed, show_by_default, sort_order,
--                      modifiers: [{id, name, price_cents, available}]}]
--   removed_item_ids: [id]
-- p_full = true means the payload is the merchant's complete inventory, so anything in the
-- mirror that is absent from it is marked removed_from_clover_at. Rows are never deleted:
-- website data and audit history stay attached.
-- Only Clover-owned columns are written. web_* columns and archived_at are never touched.
create function public.menu_apply_sync(p_restaurant uuid, p_payload jsonb, p_full boolean)
returns jsonb language plpgsql as $$
declare
  v_now timestamptz := now();
  v_categories integer := 0;
  v_items integer := 0;
  v_groups integer := 0;
  v_modifiers integer := 0;
  v_removed integer := 0;
  n integer;
begin
  if p_payload ? 'categories' then
    insert into public.menu_categories as t (restaurant_id, clover_id, name, sort_order, synced_at)
    select p_restaurant, c->>'id', c->>'name', coalesce((c->>'sort_order')::integer, 0), v_now
    from jsonb_array_elements(p_payload->'categories') c
    on conflict (restaurant_id, clover_id) do update set
      name = excluded.name, sort_order = excluded.sort_order, synced_at = v_now,
      removed_from_clover_at = null,
      updated_at = case
        when (t.name, t.sort_order) is distinct from (excluded.name, excluded.sort_order)
          or t.removed_from_clover_at is not null then v_now else t.updated_at end;
    get diagnostics v_categories = row_count;

    if p_full then
      update public.menu_categories t
      set removed_from_clover_at = v_now, updated_at = v_now
      where t.restaurant_id = p_restaurant and t.removed_from_clover_at is null
        and not exists (select 1 from jsonb_array_elements(p_payload->'categories') c
                        where c->>'id' = t.clover_id);
      get diagnostics n = row_count;
      v_removed := v_removed + n;
    end if;
  end if;

  if p_payload ? 'modifier_groups' then
    insert into public.menu_modifier_groups as t (restaurant_id, clover_id, name, min_required,
      max_allowed, show_by_default, sort_order, synced_at)
    select p_restaurant, g->>'id', g->>'name', (g->>'min_required')::integer,
      (g->>'max_allowed')::integer, coalesce((g->>'show_by_default')::boolean, true),
      coalesce((g->>'sort_order')::integer, 0), v_now
    from jsonb_array_elements(p_payload->'modifier_groups') g
    on conflict (restaurant_id, clover_id) do update set
      name = excluded.name, min_required = excluded.min_required,
      max_allowed = excluded.max_allowed, show_by_default = excluded.show_by_default,
      sort_order = excluded.sort_order, synced_at = v_now, removed_from_clover_at = null,
      updated_at = v_now;
    get diagnostics v_groups = row_count;

    insert into public.menu_modifiers as t (restaurant_id, clover_id, group_clover_id, name,
      price_cents, available, synced_at)
    select p_restaurant, m->>'id', g->>'id', m->>'name',
      coalesce((m->>'price_cents')::bigint, 0), coalesce((m->>'available')::boolean, true), v_now
    from jsonb_array_elements(p_payload->'modifier_groups') g,
         jsonb_array_elements(coalesce(g->'modifiers', '[]'::jsonb)) m
    on conflict (restaurant_id, clover_id) do update set
      group_clover_id = excluded.group_clover_id, name = excluded.name,
      price_cents = excluded.price_cents, available = excluded.available,
      synced_at = v_now, removed_from_clover_at = null, updated_at = v_now;
    get diagnostics v_modifiers = row_count;

    -- Within every group present in the payload, a modifier that is missing was removed.
    update public.menu_modifiers t
    set removed_from_clover_at = v_now, updated_at = v_now
    where t.restaurant_id = p_restaurant and t.removed_from_clover_at is null
      and exists (select 1 from jsonb_array_elements(p_payload->'modifier_groups') g
                  where g->>'id' = t.group_clover_id and g ? 'modifiers')
      and not exists (select 1 from jsonb_array_elements(p_payload->'modifier_groups') g,
                           jsonb_array_elements(coalesce(g->'modifiers', '[]'::jsonb)) m
                      where m->>'id' = t.clover_id);

    if p_full then
      update public.menu_modifier_groups t
      set removed_from_clover_at = v_now, updated_at = v_now
      where t.restaurant_id = p_restaurant and t.removed_from_clover_at is null
        and not exists (select 1 from jsonb_array_elements(p_payload->'modifier_groups') g
                        where g->>'id' = t.clover_id);
    end if;
  end if;

  if p_payload ? 'items' then
    insert into public.menu_items as t (restaurant_id, clover_id, name, price_cents, price_type,
      unit_name, hidden, available, clover_modified_time, synced_at)
    select p_restaurant, i->>'id', i->>'name', (i->>'price_cents')::bigint,
      coalesce(i->>'price_type', 'FIXED'), nullif(i->>'unit_name', ''),
      coalesce((i->>'hidden')::boolean, false), coalesce((i->>'available')::boolean, true),
      (i->>'modified_time')::bigint, v_now
    from jsonb_array_elements(p_payload->'items') i
    on conflict (restaurant_id, clover_id) do update set
      name = excluded.name, price_cents = excluded.price_cents,
      price_type = excluded.price_type, unit_name = excluded.unit_name,
      hidden = excluded.hidden, available = excluded.available,
      clover_modified_time = excluded.clover_modified_time, synced_at = v_now,
      removed_from_clover_at = null,
      updated_at = case
        when (t.name, t.price_cents, t.price_type, t.unit_name, t.hidden, t.available)
             is distinct from
             (excluded.name, excluded.price_cents, excluded.price_type, excluded.unit_name,
              excluded.hidden, excluded.available)
          or t.removed_from_clover_at is not null then v_now else t.updated_at end;
    get diagnostics v_items = row_count;

    if p_full then
      update public.menu_items t
      set removed_from_clover_at = v_now, updated_at = v_now
      where t.restaurant_id = p_restaurant and t.removed_from_clover_at is null
        and not exists (select 1 from jsonb_array_elements(p_payload->'items') i
                        where i->>'id' = t.clover_id);
      get diagnostics n = row_count;
      v_removed := v_removed + n;
    end if;

    -- Item <-> category links, for the items whose payload states its categories.
    with desired as (
      select i->>'id' as item_id, cid as category_id
      from jsonb_array_elements(p_payload->'items') i,
           jsonb_array_elements_text(i->'category_ids') cid
      where i ? 'category_ids'
        and exists (select 1 from public.menu_categories mc
                    where mc.restaurant_id = p_restaurant and mc.clover_id = cid)
    ),
    stale as (
      delete from public.menu_item_categories l
      where l.restaurant_id = p_restaurant
        and l.item_clover_id in (select i->>'id' from jsonb_array_elements(p_payload->'items') i
                                 where i ? 'category_ids')
        and not exists (select 1 from desired d
                        where d.item_id = l.item_clover_id and d.category_id = l.category_clover_id)
    ),
    tail as (
      select category_clover_id, max(position) as max_position
      from public.menu_item_categories where restaurant_id = p_restaurant
      group by category_clover_id
    ),
    hint as (
      -- Clover returns a category's items as an ordered list; use it to place NEW links.
      select c->>'id' as category_id, t.item_id, t.ord
      from jsonb_array_elements(coalesce(p_payload->'categories', '[]'::jsonb)) c,
           jsonb_array_elements_text(coalesce(c->'item_ids', '[]'::jsonb)) with ordinality t(item_id, ord)
    )
    insert into public.menu_item_categories (restaurant_id, category_clover_id, item_clover_id, position)
    select p_restaurant, d.category_id, d.item_id,
           coalesce(tail.max_position, 0)
             + row_number() over (partition by d.category_id order by hint.ord nulls last, lower(mi.name))
    from desired d
    join public.menu_items mi on mi.restaurant_id = p_restaurant and mi.clover_id = d.item_id
    left join tail on tail.category_clover_id = d.category_id
    left join hint on hint.category_id = d.category_id and hint.item_id = d.item_id
    on conflict do nothing;

    -- Item <-> modifier group links.
    with desired as (
      select i->>'id' as item_id, gid as group_id
      from jsonb_array_elements(p_payload->'items') i,
           jsonb_array_elements_text(i->'modifier_group_ids') gid
      where i ? 'modifier_group_ids'
        and exists (select 1 from public.menu_modifier_groups mg
                    where mg.restaurant_id = p_restaurant and mg.clover_id = gid)
    ),
    stale as (
      delete from public.menu_item_modifier_groups l
      where l.restaurant_id = p_restaurant
        and l.item_clover_id in (select i->>'id' from jsonb_array_elements(p_payload->'items') i
                                 where i ? 'modifier_group_ids')
        and not exists (select 1 from desired d
                        where d.item_id = l.item_clover_id and d.group_id = l.group_clover_id)
    )
    insert into public.menu_item_modifier_groups (restaurant_id, item_clover_id, group_clover_id)
    select p_restaurant, d.item_id, d.group_id from desired d
    on conflict do nothing;
  end if;

  if p_payload ? 'removed_item_ids' then
    update public.menu_items t
    set removed_from_clover_at = v_now, updated_at = v_now
    where t.restaurant_id = p_restaurant and t.removed_from_clover_at is null
      and t.clover_id in (select jsonb_array_elements_text(p_payload->'removed_item_ids'));
    get diagnostics n = row_count;
    v_removed := v_removed + n;
  end if;

  return jsonb_build_object('categories', v_categories, 'items', v_items,
    'modifier_groups', v_groups, 'modifiers', v_modifiers, 'removed', v_removed);
end $$;

-- ---------------------------------------------------------------------------------------
-- JSON shapes
-- ---------------------------------------------------------------------------------------

create function public._item_json(i public.menu_items) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', i.clover_id, 'name', i.name, 'price_cents', i.price_cents,
    'price_type', i.price_type, 'unit_name', i.unit_name,
    'hidden', i.hidden, 'available', i.available, 'modified_time', i.clover_modified_time,
    'removed_from_clover', i.removed_from_clover_at is not null,
    'description', i.web_description, 'image_path', i.web_image_path,
    'featured', i.web_featured, 'web_hidden', i.web_hidden, 'dietary', to_jsonb(i.web_dietary),
    'archived', i.archived_at is not null,
    'on_website', (not i.hidden and not i.web_hidden and i.archived_at is null
                   and i.removed_from_clover_at is null),
    'synced_at', i.synced_at, 'updated_at', i.updated_at,
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.clover_id, 'name', c.name) order by c.sort_order, c.name)
      from public.menu_item_categories l
      join public.menu_categories c
        on c.restaurant_id = l.restaurant_id and c.clover_id = l.category_clover_id
      where l.restaurant_id = i.restaurant_id and l.item_clover_id = i.clover_id), '[]'::jsonb),
    'modifier_groups', coalesce((
      select jsonb_agg(jsonb_build_object('id', g.clover_id, 'name', g.name) order by g.sort_order, g.name)
      from public.menu_item_modifier_groups l
      join public.menu_modifier_groups g
        on g.restaurant_id = l.restaurant_id and g.clover_id = l.group_clover_id
      where l.restaurant_id = i.restaurant_id and l.item_clover_id = i.clover_id
        and g.removed_from_clover_at is null), '[]'::jsonb));
$$;

create function public._web_fields(i public.menu_items) returns jsonb
language sql immutable as $$
  select jsonb_build_object('description', i.web_description, 'image_path', i.web_image_path,
    'featured', i.web_featured, 'web_hidden', i.web_hidden, 'dietary', to_jsonb(i.web_dietary),
    'archived', i.archived_at is not null);
$$;

create function public._public_item_json(i public.menu_items) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', i.clover_id, 'name', i.name, 'description', i.web_description,
    'price_cents', i.price_cents, 'price_type', i.price_type, 'unit_name', i.unit_name,
    'available', i.available, 'image_path', i.web_image_path, 'featured', i.web_featured,
    'dietary', to_jsonb(i.web_dietary),
    'modifier_groups', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', g.clover_id, 'name', g.name,
        'min_required', g.min_required, 'max_allowed', g.max_allowed,
        'modifiers', coalesce((
          select jsonb_agg(jsonb_build_object('id', m.clover_id, 'name', m.name,
                   'price_cents', m.price_cents, 'available', m.available)
                   order by lower(m.name))
          from public.menu_modifiers m
          where m.restaurant_id = g.restaurant_id and m.group_clover_id = g.clover_id
            and m.removed_from_clover_at is null), '[]'::jsonb))
        order by g.sort_order, g.name)
      from public.menu_item_modifier_groups l
      join public.menu_modifier_groups g
        on g.restaurant_id = l.restaurant_id and g.clover_id = l.group_clover_id
      where l.restaurant_id = i.restaurant_id and l.item_clover_id = i.clover_id
        and g.removed_from_clover_at is null and g.show_by_default), '[]'::jsonb));
$$;

-- ---------------------------------------------------------------------------------------
-- Public website
-- ---------------------------------------------------------------------------------------

-- What a customer may see. An item is public when Clover does not hide it and the owner has
-- not hidden or archived it and it still exists in Clover. A hidden category hides its
-- items. Unavailable items are returned with available = false so the site can say so.
create function public.public_menu(p_restaurant uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'synced_at', (select last_success_at from public.clover_connections
                  where restaurant_id = p_restaurant),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.clover_id, 'name', c.name, 'items', items.j)
                       order by c.sort_order, c.name)
      from public.menu_categories c
      cross join lateral (
        select jsonb_agg(public._public_item_json(i) order by l.position, lower(i.name)) as j
        from public.menu_item_categories l
        join public.menu_items i
          on i.restaurant_id = l.restaurant_id and i.clover_id = l.item_clover_id
        where l.restaurant_id = c.restaurant_id and l.category_clover_id = c.clover_id
          and not i.hidden and not i.web_hidden and i.archived_at is null
          and i.removed_from_clover_at is null
      ) items
      where c.restaurant_id = p_restaurant and not c.web_hidden and c.archived_at is null
        and c.removed_from_clover_at is null and items.j is not null), '[]'::jsonb),
    'uncategorized', coalesce((
      select jsonb_agg(public._public_item_json(i) order by lower(i.name))
      from public.menu_items i
      where i.restaurant_id = p_restaurant
        and not i.hidden and not i.web_hidden and i.archived_at is null
        and i.removed_from_clover_at is null
        and not exists (select 1 from public.menu_item_categories l
                        where l.restaurant_id = i.restaurant_id
                          and l.item_clover_id = i.clover_id)), '[]'::jsonb));
$$;

-- ---------------------------------------------------------------------------------------
-- Dashboard reads
-- ---------------------------------------------------------------------------------------

create function public.dash_overview(p_restaurant uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'counts', (
      select jsonb_build_object(
        'items', count(*) filter (where archived_at is null),
        'on_website', count(*) filter (where archived_at is null and not hidden and not web_hidden),
        'hidden', count(*) filter (where archived_at is null and (hidden or web_hidden)),
        'unavailable', count(*) filter (where archived_at is null and not available),
        'archived', count(*) filter (where archived_at is not null),
        'featured', count(*) filter (where archived_at is null and web_featured))
      from public.menu_items
      where restaurant_id = p_restaurant and removed_from_clover_at is null),
    'categories', (
      select count(*) from public.menu_categories
      where restaurant_id = p_restaurant and removed_from_clover_at is null and archived_at is null),
    'recent_items', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.clover_id, 'name', r.name, 'updated_at', r.updated_at)
                       order by r.updated_at desc)
      from (select clover_id, name, updated_at from public.menu_items
            where restaurant_id = p_restaurant and removed_from_clover_at is null
            order by updated_at desc limit 6) r), '[]'::jsonb),
    'connection', public.clover_connection_status(p_restaurant),
    'sync_errors', coalesce((
      select jsonb_agg(jsonb_build_object('started_at', s.started_at, 'trigger', s.trigger,
               'error_code', s.error_code, 'error_message', s.error_message)
               order by s.started_at desc)
      from (select * from public.sync_runs
            where restaurant_id = p_restaurant and status = 'failed'
              and started_at > now() - interval '7 days'
            order by started_at desc limit 5) s), '[]'::jsonb),
    'recent_activity', public.audit_list(p_restaurant, 8, null));
$$;

-- p_filters: search, category (clover id or 'none'), availability (available|unavailable),
-- visibility (visible|hidden), status (active|archived|removed|all), featured (true|false),
-- sort (name|price|updated|category|custom), dir (asc|desc), limit (1..100), offset.
create function public.dash_list_items(p_restaurant uuid, p_filters jsonb) returns jsonb
language plpgsql stable as $$
declare
  v_search       text := nullif(btrim(p_filters->>'search'), '');
  v_category     text := nullif(p_filters->>'category', '');
  v_availability text := nullif(p_filters->>'availability', '');
  v_visibility   text := nullif(p_filters->>'visibility', '');
  v_status       text := coalesce(nullif(p_filters->>'status', ''), 'active');
  v_featured     text := nullif(p_filters->>'featured', '');
  v_sort         text := coalesce(nullif(p_filters->>'sort', ''), 'name');
  v_dir          text := coalesce(nullif(p_filters->>'dir', ''), 'asc');
  v_limit        integer := least(greatest(coalesce((p_filters->>'limit')::integer, 25), 1), 100);
  v_offset       integer := greatest(coalesce((p_filters->>'offset')::integer, 0), 0);
  v_like         text;
  v_total        bigint;
  v_items        jsonb;
begin
  if v_search is not null then
    v_like := '%' || replace(replace(replace(lower(v_search), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  with filtered as (
    select i.clover_id, i.name, i.price_cents, i.updated_at,
      (select min(lower(c.name))
       from public.menu_item_categories l
       join public.menu_categories c
         on c.restaurant_id = l.restaurant_id and c.clover_id = l.category_clover_id
       where l.restaurant_id = i.restaurant_id and l.item_clover_id = i.clover_id) as first_category,
      (select l.position from public.menu_item_categories l
       where l.restaurant_id = i.restaurant_id and l.item_clover_id = i.clover_id
         and l.category_clover_id = v_category) as category_position
    from public.menu_items i
    where i.restaurant_id = p_restaurant
      and case v_status
            when 'active'   then i.archived_at is null and i.removed_from_clover_at is null
            when 'archived' then i.archived_at is not null and i.removed_from_clover_at is null
            when 'removed'  then i.removed_from_clover_at is not null
            else true end
      and (v_like is null
           or lower(i.name) like v_like escape '\'
           or exists (select 1 from public.menu_item_categories l
                      join public.menu_categories c
                        on c.restaurant_id = l.restaurant_id and c.clover_id = l.category_clover_id
                      where l.restaurant_id = i.restaurant_id and l.item_clover_id = i.clover_id
                        and lower(c.name) like v_like escape '\'))
      and (v_category is null
           or (v_category = 'none' and not exists (
                 select 1 from public.menu_item_categories l
                 where l.restaurant_id = i.restaurant_id and l.item_clover_id = i.clover_id))
           or exists (select 1 from public.menu_item_categories l
                      where l.restaurant_id = i.restaurant_id and l.item_clover_id = i.clover_id
                        and l.category_clover_id = v_category))
      and (v_availability is null or (v_availability = 'available') = i.available)
      and (v_visibility is null or (v_visibility = 'visible') = (not i.hidden and not i.web_hidden))
      and (v_featured is null or (v_featured = 'true') = i.web_featured)
  ),
  ranked as (
    select f.clover_id, row_number() over (order by
      case when v_sort = 'price' and v_dir = 'asc' then f.price_cents end asc nulls last,
      case when v_sort = 'price' and v_dir = 'desc' then f.price_cents end desc nulls last,
      case when v_sort = 'updated' and v_dir = 'asc' then f.updated_at end asc,
      case when v_sort = 'updated' and v_dir = 'desc' then f.updated_at end desc,
      case when v_sort = 'category' and v_dir = 'asc' then f.first_category end asc nulls last,
      case when v_sort = 'category' and v_dir = 'desc' then f.first_category end desc nulls last,
      case when v_sort = 'custom' then f.category_position end asc nulls last,
      case when v_sort = 'name' and v_dir = 'desc' then lower(f.name) end desc,
      lower(f.name) asc, f.clover_id asc) as rn
    from filtered f
  ),
  page as (
    select * from ranked where rn > v_offset and rn <= v_offset + v_limit
  )
  select (select count(*) from ranked),
         coalesce((select jsonb_agg(public._item_json(i) order by p.rn)
                   from page p
                   join public.menu_items i
                     on i.restaurant_id = p_restaurant and i.clover_id = p.clover_id), '[]'::jsonb)
  into v_total, v_items;

  return jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_offset, 'items', v_items);
end $$;

create function public.dash_get_item(p_restaurant uuid, p_item text) returns jsonb
language sql stable as $$
  select public._item_json(i) from public.menu_items i
  where i.restaurant_id = p_restaurant and i.clover_id = p_item;
$$;

create function public.dash_list_categories(p_restaurant uuid) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.clover_id, 'name', c.name, 'sort_order', c.sort_order,
    'web_hidden', c.web_hidden, 'archived', c.archived_at is not null,
    'removed_from_clover', c.removed_from_clover_at is not null,
    'updated_at', c.updated_at,
    'item_count', (select count(*) from public.menu_item_categories l
                   join public.menu_items i
                     on i.restaurant_id = l.restaurant_id and i.clover_id = l.item_clover_id
                   where l.restaurant_id = c.restaurant_id and l.category_clover_id = c.clover_id
                     and i.archived_at is null and i.removed_from_clover_at is null))
    order by c.sort_order, c.name), '[]'::jsonb)
  from public.menu_categories c
  where c.restaurant_id = p_restaurant;
$$;

create function public.dash_list_modifier_groups(p_restaurant uuid) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', g.clover_id, 'name', g.name, 'min_required', g.min_required,
    'max_allowed', g.max_allowed, 'show_by_default', g.show_by_default,
    'item_count', (select count(*) from public.menu_item_modifier_groups l
                   where l.restaurant_id = g.restaurant_id and l.group_clover_id = g.clover_id),
    'modifiers', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.clover_id, 'name', m.name,
               'price_cents', m.price_cents, 'available', m.available) order by lower(m.name))
      from public.menu_modifiers m
      where m.restaurant_id = g.restaurant_id and m.group_clover_id = g.clover_id
        and m.removed_from_clover_at is null), '[]'::jsonb))
    order by g.sort_order, g.name), '[]'::jsonb)
  from public.menu_modifier_groups g
  where g.restaurant_id = p_restaurant and g.removed_from_clover_at is null;
$$;

-- Which of the given ids belong to this restaurant. Used to reject foreign ids before any
-- Clover call is made.
create function public.menu_known_ids(p_restaurant uuid, p_kind text, p_ids text[]) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(id), '[]'::jsonb) from (
    select clover_id as id from public.menu_items
      where p_kind = 'item' and restaurant_id = p_restaurant and clover_id = any(p_ids)
        and removed_from_clover_at is null
    union all
    select clover_id from public.menu_categories
      where p_kind = 'category' and restaurant_id = p_restaurant and clover_id = any(p_ids)
        and removed_from_clover_at is null
    union all
    select clover_id from public.menu_modifier_groups
      where p_kind = 'modifier_group' and restaurant_id = p_restaurant and clover_id = any(p_ids)
        and removed_from_clover_at is null
    union all
    select clover_id from public.menu_modifiers
      where p_kind = 'modifier' and restaurant_id = p_restaurant and clover_id = any(p_ids)
        and removed_from_clover_at is null
  ) k;
$$;

-- ---------------------------------------------------------------------------------------
-- Dashboard writes of website-owned data (these never go to Clover)
-- ---------------------------------------------------------------------------------------

-- p_patch keys: description, image_path, featured, web_hidden, dietary, archived.
-- Returns null when the item does not belong to the restaurant.
create function public.web_update_item(p_restaurant uuid, p_item text, p_patch jsonb)
returns jsonb language plpgsql as $$
declare
  v_old public.menu_items;
  v_new public.menu_items;
begin
  select * into v_old from public.menu_items
  where restaurant_id = p_restaurant and clover_id = p_item for update;
  if not found then
    return null;
  end if;

  update public.menu_items set
    web_description = case when p_patch ? 'description'
      then nullif(btrim(p_patch->>'description'), '') else web_description end,
    web_image_path = case when p_patch ? 'image_path'
      then p_patch->>'image_path' else web_image_path end,
    web_featured = case when p_patch ? 'featured'
      then (p_patch->>'featured')::boolean else web_featured end,
    web_hidden = case when p_patch ? 'web_hidden'
      then (p_patch->>'web_hidden')::boolean else web_hidden end,
    web_dietary = case when p_patch ? 'dietary'
      then array(select jsonb_array_elements_text(p_patch->'dietary')) else web_dietary end,
    archived_at = case when p_patch ? 'archived'
      then case when (p_patch->>'archived')::boolean then coalesce(archived_at, now()) end
      else archived_at end,
    updated_at = now()
  where restaurant_id = p_restaurant and clover_id = p_item
  returning * into v_new;

  return jsonb_build_object('old', public._web_fields(v_old), 'new', public._web_fields(v_new),
    'item', public._item_json(v_new));
end $$;

-- p_patch keys: web_hidden, archived, featured. Returns the ids that were changed.
create function public.web_bulk_update_items(p_restaurant uuid, p_items text[], p_patch jsonb)
returns jsonb language plpgsql as $$
declare v_ids jsonb;
begin
  with changed as (
    update public.menu_items set
      web_hidden = case when p_patch ? 'web_hidden'
        then (p_patch->>'web_hidden')::boolean else web_hidden end,
      web_featured = case when p_patch ? 'featured'
        then (p_patch->>'featured')::boolean else web_featured end,
      archived_at = case when p_patch ? 'archived'
        then case when (p_patch->>'archived')::boolean then coalesce(archived_at, now()) end
        else archived_at end,
      updated_at = now()
    where restaurant_id = p_restaurant and clover_id = any(p_items)
    returning clover_id
  )
  select coalesce(jsonb_agg(clover_id), '[]'::jsonb) into v_ids from changed;
  return v_ids;
end $$;

-- p_patch keys: web_hidden, archived.
create function public.web_update_category(p_restaurant uuid, p_category text, p_patch jsonb)
returns jsonb language plpgsql as $$
declare
  v_old public.menu_categories;
  v_new public.menu_categories;
begin
  select * into v_old from public.menu_categories
  where restaurant_id = p_restaurant and clover_id = p_category for update;
  if not found then
    return null;
  end if;

  update public.menu_categories set
    web_hidden = case when p_patch ? 'web_hidden'
      then (p_patch->>'web_hidden')::boolean else web_hidden end,
    archived_at = case when p_patch ? 'archived'
      then case when (p_patch->>'archived')::boolean then coalesce(archived_at, now()) end
      else archived_at end,
    updated_at = now()
  where restaurant_id = p_restaurant and clover_id = p_category
  returning * into v_new;

  return jsonb_build_object(
    'old', jsonb_build_object('web_hidden', v_old.web_hidden, 'archived', v_old.archived_at is not null),
    'new', jsonb_build_object('web_hidden', v_new.web_hidden, 'archived', v_new.archived_at is not null));
end $$;

-- Sets the website order of items inside one category. Ids that are not linked to the
-- category are ignored; linked items that were not listed keep their relative order after
-- the listed ones.
create function public.web_reorder_category_items(p_restaurant uuid, p_category text, p_items text[])
returns integer language plpgsql as $$
declare v_count integer;
begin
  with listed as (
    select t.item_id, t.ord from unnest(p_items) with ordinality t(item_id, ord)
  ),
  ranked as (
    select l.item_clover_id,
           row_number() over (order by listed.ord nulls last, l.position, l.item_clover_id) as rn
    from public.menu_item_categories l
    left join listed on listed.item_id = l.item_clover_id
    where l.restaurant_id = p_restaurant and l.category_clover_id = p_category
  )
  update public.menu_item_categories l
  set position = ranked.rn
  from ranked
  where l.restaurant_id = p_restaurant and l.category_clover_id = p_category
    and l.item_clover_id = ranked.item_clover_id;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ---------------------------------------------------------------------------------------
-- Job applications
-- ---------------------------------------------------------------------------------------

create function public.job_application_create(
  p_restaurant uuid, p_full_name text, p_email text, p_phone text, p_position text,
  p_message text, p_cv_path text, p_cv_original_name text, p_cv_mime text, p_cv_size integer,
  p_ip_hash text
) returns uuid language sql as $$
  insert into public.job_applications (restaurant_id, full_name, email, phone, position, message,
    cv_path, cv_original_name, cv_mime, cv_size, ip_hash)
  values (p_restaurant, p_full_name, p_email, p_phone, p_position, p_message,
    p_cv_path, p_cv_original_name, p_cv_mime, p_cv_size, p_ip_hash)
  returning id;
$$;

create function public.job_application_set_email_status(p_id uuid, p_status text) returns void
language sql as $$
  update public.job_applications set email_status = p_status where id = p_id;
$$;

-- ---------------------------------------------------------------------------------------
-- Privileges: only the service role may execute anything here.
-- ---------------------------------------------------------------------------------------

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
