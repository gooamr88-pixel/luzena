-- Schema for the restaurant platform.
--
-- Tenancy: every tenant-owned row carries restaurant_id.
-- Access: RLS is enabled on every table and NO policies are defined, so the anon and
-- authenticated roles can read and write nothing. All access goes through the SQL
-- functions in the next migration, which only the service role (Edge Functions) may call.
--
-- Menu tables are a MIRROR of Clover plus website-only data:
--   columns without a prefix  = owned by Clover, overwritten by sync
--   columns prefixed web_     = owned by this system, never touched by sync
--   archived_at               = owned by this system (website-only archive)

create table public.restaurants (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$'),
  name        text not null check (char_length(name) between 1 and 120),
  currency    text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  -- Where job applications are sent. Never returned to the public site.
  recruitment_email text,
  created_at  timestamptz not null default now()
);

create table public.restaurant_users (
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  role          text not null check (role in ('owner', 'manager', 'staff')),
  created_at    timestamptz not null default now(),
  primary key (restaurant_id, user_id)
);
create index restaurant_users_user_idx on public.restaurant_users (user_id);

-- One Clover merchant per restaurant. Tokens are AES-GCM ciphertext; the key lives only
-- in the Edge Function environment.
create table public.clover_connections (
  restaurant_id            uuid primary key references public.restaurants(id) on delete cascade,
  merchant_id              text not null,
  merchant_name            text,
  environment              text not null check (environment in ('sandbox', 'na', 'eu', 'la')),
  access_token_enc         text not null,
  refresh_token_enc        text not null,
  access_token_expires_at  timestamptz not null,
  refresh_token_expires_at timestamptz,
  refresh_lock_until       timestamptz,
  status                   text not null default 'active' check (status in ('active', 'needs_reauth')),
  connected_by             uuid,
  connected_at             timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  sync_lock_until          timestamptz,
  sync_requested_at        timestamptz,
  last_sync_started_at     timestamptz,
  last_sync_finished_at    timestamptz,
  last_success_at          timestamptz,
  last_error_code          text,
  last_error_at            timestamptz,
  unique (environment, merchant_id)
);

create table public.oauth_states (
  nonce_hash    text primary key,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  user_id       uuid not null,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now()
);

create table public.menu_categories (
  restaurant_id          uuid not null references public.restaurants(id) on delete cascade,
  clover_id              text not null,
  name                   text not null,
  sort_order             integer not null default 0,
  removed_from_clover_at timestamptz,
  synced_at              timestamptz not null default now(),
  web_hidden             boolean not null default false,
  archived_at            timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  primary key (restaurant_id, clover_id)
);
-- Category lists are always "for one restaurant, in display order".
create index menu_categories_order_idx on public.menu_categories (restaurant_id, sort_order, name);

create table public.menu_items (
  restaurant_id          uuid not null references public.restaurants(id) on delete cascade,
  clover_id              text not null,
  name                   text not null,
  price_cents            bigint,
  price_type             text not null default 'FIXED' check (price_type in ('FIXED', 'VARIABLE', 'PER_UNIT')),
  unit_name              text,
  hidden                 boolean not null default false,
  available              boolean not null default true,
  clover_modified_time   bigint,
  removed_from_clover_at timestamptz,
  synced_at              timestamptz not null default now(),
  web_description        text check (web_description is null or char_length(web_description) <= 600),
  web_image_path         text,
  web_featured           boolean not null default false,
  web_hidden             boolean not null default false,
  web_dietary            text[] not null default '{}',
  archived_at            timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  primary key (restaurant_id, clover_id)
);
-- Query patterns of the dashboard item table: default sort by name, sort by recent
-- change, sort by price. Each is scoped to one restaurant.
create index menu_items_name_idx    on public.menu_items (restaurant_id, lower(name));
create index menu_items_updated_idx on public.menu_items (restaurant_id, updated_at desc);
create index menu_items_price_idx   on public.menu_items (restaurant_id, price_cents);
-- Home page "featured" strip.
create index menu_items_featured_idx on public.menu_items (restaurant_id) where web_featured;

create table public.menu_item_categories (
  restaurant_id      uuid not null,
  category_clover_id text not null,
  item_clover_id     text not null,
  -- Website-only order of an item inside a category.
  position           integer not null default 0,
  primary key (restaurant_id, category_clover_id, item_clover_id),
  foreign key (restaurant_id, category_clover_id)
    references public.menu_categories (restaurant_id, clover_id) on delete cascade,
  foreign key (restaurant_id, item_clover_id)
    references public.menu_items (restaurant_id, clover_id) on delete cascade
);
create index menu_item_categories_item_idx on public.menu_item_categories (restaurant_id, item_clover_id);
create index menu_item_categories_pos_idx  on public.menu_item_categories (restaurant_id, category_clover_id, position);

create table public.menu_modifier_groups (
  restaurant_id          uuid not null references public.restaurants(id) on delete cascade,
  clover_id              text not null,
  name                   text not null,
  min_required           integer,
  max_allowed            integer,
  show_by_default        boolean not null default true,
  sort_order             integer not null default 0,
  removed_from_clover_at timestamptz,
  synced_at              timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  primary key (restaurant_id, clover_id)
);

create table public.menu_modifiers (
  restaurant_id          uuid not null,
  clover_id              text not null,
  group_clover_id        text not null,
  name                   text not null,
  price_cents            bigint not null default 0,
  available              boolean not null default true,
  removed_from_clover_at timestamptz,
  synced_at              timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  primary key (restaurant_id, clover_id),
  foreign key (restaurant_id, group_clover_id)
    references public.menu_modifier_groups (restaurant_id, clover_id) on delete cascade
);
create index menu_modifiers_group_idx on public.menu_modifiers (restaurant_id, group_clover_id);

create table public.menu_item_modifier_groups (
  restaurant_id   uuid not null,
  item_clover_id  text not null,
  group_clover_id text not null,
  primary key (restaurant_id, item_clover_id, group_clover_id),
  foreign key (restaurant_id, item_clover_id)
    references public.menu_items (restaurant_id, clover_id) on delete cascade,
  foreign key (restaurant_id, group_clover_id)
    references public.menu_modifier_groups (restaurant_id, clover_id) on delete cascade
);
create index menu_item_modifier_groups_group_idx
  on public.menu_item_modifier_groups (restaurant_id, group_clover_id);

create table public.sync_runs (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  trigger       text not null check (trigger in ('manual', 'webhook', 'stale', 'connect')),
  status        text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  stats         jsonb,
  error_code    text,
  error_message text
);
create index sync_runs_recent_idx on public.sync_runs (restaurant_id, started_at desc);

create table public.audit_logs (
  id            bigint generated always as identity primary key,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  user_id       uuid,
  actor_email   text,
  action        text not null,
  entity_type   text not null,
  entity_id     text,
  old_values    jsonb,
  new_values    jsonb,
  result        text not null check (result in ('success', 'failed', 'partial', 'conflict')),
  sync_status   text,
  request_id    text,
  created_at    timestamptz not null default now()
);
-- The activity page pages backwards through one restaurant's log.
create index audit_logs_recent_idx on public.audit_logs (restaurant_id, id desc);

create table public.idempotency_keys (
  restaurant_id   uuid not null references public.restaurants(id) on delete cascade,
  key             text not null check (char_length(key) between 8 and 100),
  request_hash    text not null,
  status          text not null default 'in_progress' check (status in ('in_progress', 'completed', 'unknown')),
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz not null default now(),
  primary key (restaurant_id, key)
);

create table public.job_applications (
  id               uuid primary key default gen_random_uuid(),
  restaurant_id    uuid not null references public.restaurants(id) on delete cascade,
  full_name        text not null,
  email            text not null,
  phone            text not null,
  position         text not null,
  message          text,
  cv_path          text,
  cv_original_name text,
  cv_mime          text,
  cv_size          integer,
  email_status     text not null default 'pending' check (email_status in ('pending', 'sent', 'failed')),
  ip_hash          text,
  created_at       timestamptz not null default now()
);
create index job_applications_recent_idx on public.job_applications (restaurant_id, created_at desc);

create table public.rate_limits (
  key          text not null,
  window_start timestamptz not null,
  count        integer not null default 0,
  primary key (key, window_start)
);

create table public.integration_logs (
  id             bigint generated always as identity primary key,
  restaurant_id  uuid references public.restaurants(id) on delete cascade,
  level          text not null check (level in ('info', 'warn', 'error')),
  event          text not null,
  correlation_id text,
  details        jsonb,
  created_at     timestamptz not null default now()
);
create index integration_logs_recent_idx on public.integration_logs (restaurant_id, id desc);

-- Deny-by-default for every table.
alter table public.restaurants               enable row level security;
alter table public.restaurant_users          enable row level security;
alter table public.clover_connections        enable row level security;
alter table public.oauth_states              enable row level security;
alter table public.menu_categories           enable row level security;
alter table public.menu_items                enable row level security;
alter table public.menu_item_categories      enable row level security;
alter table public.menu_modifier_groups      enable row level security;
alter table public.menu_modifiers            enable row level security;
alter table public.menu_item_modifier_groups enable row level security;
alter table public.sync_runs                 enable row level security;
alter table public.audit_logs                enable row level security;
alter table public.idempotency_keys          enable row level security;
alter table public.job_applications          enable row level security;
alter table public.rate_limits               enable row level security;
alter table public.integration_logs          enable row level security;

revoke all on all tables in schema public from anon, authenticated;
