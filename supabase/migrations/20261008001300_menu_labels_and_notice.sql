-- Menu labels (dietary and descriptive attributes of a dish) and the allergy notice.
--
-- Until now a dish could carry any of seven fixed dietary tags, held as text in
-- menu_items.web_dietary and spelled out in code. This replaces the fixed list with labels
-- each restaurant keeps for itself: a name, an icon from the website's own set, an optional
-- short description, whether it is in use, and its place in the order.
--
-- WHAT A LABEL SAYS IS THE RESTAURANT'S STATEMENT, ALWAYS. Nothing in this system puts a
-- label on a dish: not synchronisation, not the dish's name, not a default. A label is on a
-- dish because someone at the restaurant ticked it. The labels a new restaurant starts with
-- are a vocabulary only, assigned to nothing.
--
-- Like every other website-only choice, none of this is known to Clover, and
-- synchronisation neither reads nor writes these tables. A dish that Clover removes keeps
-- its labels on its (retained) row; a dish that is truly deleted takes them with it.
--
-- Three tables, each with restaurant_id, row level security on and no policy, and no
-- privilege for the website's own roles: as every other table here, they are reachable only
-- through the functions below, which the backend calls with the restaurant it has resolved
-- from the signed-in user's membership.

create table public.menu_labels (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 1 and 40),
  -- A key into the website's icon set (src/js/lib/label-icons.js). The backend checks it
  -- against the set; a key the page does not know is drawn as no icon, never as an error.
  icon          text not null check (icon ~ '^[a-z][a-z0-9-]{0,30}$'),
  description   text check (description is null or char_length(description) <= 160),
  active        boolean not null default true,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- Lets a dish's label be tied to the same restaurant by the database itself.
  unique (restaurant_id, id)
);
-- One label of a name per restaurant, whatever its capitals.
create unique index menu_labels_name_idx on public.menu_labels (restaurant_id, (lower(btrim(name))));
create index menu_labels_order_idx on public.menu_labels (restaurant_id, sort_order, name);

create table public.menu_item_labels (
  restaurant_id  uuid not null,
  item_clover_id text not null,
  label_id       uuid not null,
  primary key (restaurant_id, item_clover_id, label_id),
  foreign key (restaurant_id, item_clover_id)
    references public.menu_items (restaurant_id, clover_id) on delete cascade,
  -- The label must be this restaurant's own: another restaurant's id cannot be stored here.
  foreign key (restaurant_id, label_id)
    references public.menu_labels (restaurant_id, id) on delete cascade
);
create index menu_item_labels_label_idx on public.menu_item_labels (restaurant_id, label_id);

-- Settings of the public website that the owner changes in the dashboard. One row per
-- restaurant, made the first time it is needed.
create table public.site_settings (
  restaurant_id          uuid primary key references public.restaurants(id) on delete cascade,
  -- The allergy notice at the foot of the menu: off until the owner turns it on, and empty
  -- until the owner writes it. A list of {"lang": "en", "text": "..."}, in display order.
  allergy_notice_enabled boolean not null default false,
  allergy_notice         jsonb not null default '[]'::jsonb check (jsonb_typeof(allergy_notice) = 'array'),
  -- When this restaurant was given its starting labels, so that it is only ever done once
  -- and an owner who deletes them all is not given them back.
  labels_seeded_at       timestamptz,
  updated_at             timestamptz not null default now()
);

alter table public.menu_labels      enable row level security;
alter table public.menu_item_labels enable row level security;
alter table public.site_settings    enable row level security;
revoke all on public.menu_labels, public.menu_item_labels, public.site_settings from anon, authenticated;
-- Said outright: default privileges belong to the role that creates the table.
grant all on public.menu_labels, public.menu_item_labels, public.site_settings to service_role;

-- ---------------------------------------------------------------------------------------
-- Starting labels
-- ---------------------------------------------------------------------------------------

-- Gives a restaurant its starting vocabulary, once. Assigns nothing to any dish.
create function public.menu_labels_seed(p_restaurant uuid) returns void
language plpgsql as $$
begin
  insert into public.site_settings (restaurant_id) values (p_restaurant) on conflict do nothing;
  update public.site_settings set labels_seeded_at = now()
  where restaurant_id = p_restaurant and labels_seeded_at is null;
  if not found then return; end if;

  insert into public.menu_labels (restaurant_id, name, icon, sort_order)
  select p_restaurant, s.name, s.icon, s.position
  from (values
    ('Spicy', 'flame', 1), ('Vegetarian', 'leaf', 2), ('Vegan', 'sprout', 3),
    ('Contains Nuts', 'nut', 4), ('Contains Dairy', 'milk', 5), ('Contains Gluten', 'wheat', 6),
    ('Popular', 'star', 7), ('New', 'sparkle', 8), ('Chef''s Choice', 'chef-hat', 9)
  ) as s(name, icon, position)
  on conflict (restaurant_id, (lower(btrim(name)))) do nothing;
end $$;

-- Restaurants that exist already get theirs now, and the dietary tags their dishes carry
-- are carried over: each tag in use becomes a label, on exactly the dishes that had it.
-- This moves the owner's own choices; it decides nothing. web_dietary itself is left as it
-- is, so the website that is live while this is applied goes on showing what it showed.
do $$
declare
  r record;
  v_label uuid;
begin
  for r in select id from public.restaurants loop
    perform public.menu_labels_seed(r.id);
  end loop;

  for r in
    select distinct i.restaurant_id, d.tag
    from public.menu_items i cross join lateral unnest(i.web_dietary) as d(tag)
  loop
    insert into public.menu_labels (restaurant_id, name, icon, sort_order)
    select r.restaurant_id, m.name, m.icon, 100
    from (select
            case r.tag when 'vegetarian' then 'Vegetarian' when 'vegan' then 'Vegan' when 'spicy' then 'Spicy'
              when 'gluten-free' then 'Gluten-Free' when 'dairy-free' then 'Dairy-Free' when 'nut-free' then 'Nut-Free'
              when 'halal' then 'Halal' else initcap(replace(r.tag, '-', ' ')) end as name,
            case r.tag when 'vegetarian' then 'leaf' when 'vegan' then 'sprout' when 'spicy' then 'flame'
              when 'gluten-free' then 'wheat' when 'dairy-free' then 'milk' when 'nut-free' then 'nut'
              else 'seal' end as icon) m
    on conflict (restaurant_id, (lower(btrim(name)))) do nothing;

    select l.id into v_label from public.menu_labels l
    where l.restaurant_id = r.restaurant_id and lower(btrim(l.name)) = lower(
      case r.tag when 'gluten-free' then 'Gluten-Free' when 'dairy-free' then 'Dairy-Free' when 'nut-free' then 'Nut-Free'
        else initcap(replace(r.tag, '-', ' ')) end);

    if v_label is not null then
      insert into public.menu_item_labels (restaurant_id, item_clover_id, label_id)
      select i.restaurant_id, i.clover_id, v_label from public.menu_items i
      where i.restaurant_id = r.restaurant_id and r.tag = any(i.web_dietary)
      on conflict do nothing;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------
-- Labels: the dashboard
-- ---------------------------------------------------------------------------------------

-- A restaurant's labels in order, each with how many dishes carry it. Gives a restaurant
-- that has never had any its starting ones first.
create function public.dash_labels_list(p_restaurant uuid) returns jsonb
language plpgsql as $$
begin
  perform public.menu_labels_seed(p_restaurant);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', l.id, 'name', l.name, 'icon', l.icon, 'description', l.description,
      'active', l.active, 'sort_order', l.sort_order, 'updated_at', l.updated_at,
      'item_count', (select count(*) from public.menu_item_labels il
                     where il.restaurant_id = l.restaurant_id and il.label_id = l.id))
      order by l.sort_order, lower(l.name), l.id)
    from public.menu_labels l where l.restaurant_id = p_restaurant), '[]'::jsonb);
end $$;

-- Adds a label at the end. {"full": true} at the limit, {"duplicate": true} when the
-- restaurant already has one of that name.
create function public.dash_label_create(p_restaurant uuid, p_name text, p_icon text, p_description text, p_max integer)
returns jsonb language plpgsql as $$
declare
  v_id uuid;
begin
  perform public.menu_labels_seed(p_restaurant);
  if (select count(*) from public.menu_labels where restaurant_id = p_restaurant) >= p_max then
    return jsonb_build_object('full', true);
  end if;
  insert into public.menu_labels (restaurant_id, name, icon, description, sort_order)
  values (p_restaurant, btrim(p_name), p_icon, nullif(btrim(coalesce(p_description, '')), ''),
          (select coalesce(max(sort_order), 0) + 1 from public.menu_labels where restaurant_id = p_restaurant))
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'labels', public.dash_labels_list(p_restaurant));
exception when unique_violation then
  return jsonb_build_object('duplicate', true);
end $$;

-- Changes any of a label's name, icon, description and whether it is in use. null when
-- the label is not this restaurant's.
create function public.dash_label_update(p_restaurant uuid, p_id uuid, p_patch jsonb) returns jsonb
language plpgsql as $$
begin
  update public.menu_labels set
    name = case when p_patch ? 'name' then btrim(p_patch->>'name') else name end,
    icon = case when p_patch ? 'icon' then p_patch->>'icon' else icon end,
    description = case when p_patch ? 'description'
      then nullif(btrim(coalesce(p_patch->>'description', '')), '') else description end,
    active = case when p_patch ? 'active' then (p_patch->>'active')::boolean else active end,
    updated_at = now()
  where restaurant_id = p_restaurant and id = p_id;
  if not found then return null; end if;
  return jsonb_build_object('labels', public.dash_labels_list(p_restaurant));
exception when unique_violation then
  return jsonb_build_object('duplicate', true);
end $$;

-- Deletes a label and takes it off every dish. null when it is not this restaurant's.
create function public.dash_label_delete(p_restaurant uuid, p_id uuid) returns jsonb
language plpgsql as $$
declare
  v_dishes integer;
begin
  select count(*) into v_dishes from public.menu_item_labels where restaurant_id = p_restaurant and label_id = p_id;
  delete from public.menu_labels where restaurant_id = p_restaurant and id = p_id;
  if not found then return null; end if;
  return jsonb_build_object('labels', public.dash_labels_list(p_restaurant), 'dishes', v_dishes);
end $$;

-- Puts the labels in the given order. Every label must be named exactly once; null otherwise.
create function public.dash_labels_reorder(p_restaurant uuid, p_ids uuid[]) returns jsonb
language plpgsql as $$
declare
  v_current uuid[];
begin
  select coalesce(array_agg(id), '{}') into v_current from public.menu_labels where restaurant_id = p_restaurant;
  if cardinality(p_ids) <> cardinality(v_current) or not (p_ids <@ v_current and v_current <@ p_ids)
     or cardinality(p_ids) <> (select count(distinct x) from unnest(p_ids) x) then
    return null;
  end if;
  update public.menu_labels l set sort_order = o.position, updated_at = now()
  from unnest(p_ids) with ordinality as o(id, position)
  where l.restaurant_id = p_restaurant and l.id = o.id;
  return jsonb_build_object('labels', public.dash_labels_list(p_restaurant));
end $$;

-- Sets exactly which labels a dish carries. false when the dish or any of the labels is not
-- this restaurant's, in which case nothing is changed.
create function public.web_set_item_labels(p_restaurant uuid, p_item text, p_label_ids uuid[]) returns boolean
language plpgsql as $$
declare
  v_ids uuid[] := coalesce(p_label_ids, '{}');
begin
  if not exists (select 1 from public.menu_items where restaurant_id = p_restaurant and clover_id = p_item) then
    return false;
  end if;
  if (select count(*) from public.menu_labels where restaurant_id = p_restaurant and id = any(v_ids))
     <> (select count(distinct x) from unnest(v_ids) x) then
    return false;
  end if;
  delete from public.menu_item_labels
  where restaurant_id = p_restaurant and item_clover_id = p_item and not (label_id = any(v_ids));
  insert into public.menu_item_labels (restaurant_id, item_clover_id, label_id)
  select p_restaurant, p_item, x from (select distinct x from unnest(v_ids) x) ids
  on conflict do nothing;
  update public.menu_items set updated_at = now() where restaurant_id = p_restaurant and clover_id = p_item;
  return true;
end $$;

-- ---------------------------------------------------------------------------------------
-- Labels on a dish: what the dashboard and the website are given
-- ---------------------------------------------------------------------------------------

-- The dashboard's item, as before, with the ids of the labels it carries (in label order).
create or replace function public._item_json(i public.menu_items) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', i.clover_id, 'name', i.name, 'price_cents', i.price_cents,
    'price_type', i.price_type, 'unit_name', i.unit_name,
    'hidden', i.hidden, 'available', i.available, 'modified_time', i.clover_modified_time,
    'removed_from_clover', i.removed_from_clover_at is not null,
    'description', i.web_description, 'image_path', i.web_image_path,
    'featured', i.web_featured, 'web_hidden', i.web_hidden, 'dietary', to_jsonb(i.web_dietary),
    'label_ids', coalesce((
      select jsonb_agg(l.id order by l.sort_order, lower(l.name), l.id)
      from public.menu_item_labels il
      join public.menu_labels l on l.restaurant_id = il.restaurant_id and l.id = il.label_id
      where il.restaurant_id = i.restaurant_id and il.item_clover_id = i.clover_id), '[]'::jsonb),
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

-- The public item, as before, with its labels: name, icon and description of each label
-- that is in use, in the restaurant's order. A label that has been switched off is not
-- shown, and comes back on every dish that had it when it is switched on again.
create or replace function public._public_item_json(i public.menu_items) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', i.clover_id, 'name', i.name, 'description', i.web_description,
    'price_cents', i.price_cents, 'price_type', i.price_type, 'unit_name', i.unit_name,
    'available', i.available, 'image_path', i.web_image_path, 'featured', i.web_featured,
    'dietary', to_jsonb(i.web_dietary),
    'labels', coalesce((
      select jsonb_agg(jsonb_build_object('name', l.name, 'icon', l.icon, 'description', l.description)
                       order by l.sort_order, lower(l.name), l.id)
      from public.menu_item_labels il
      join public.menu_labels l on l.restaurant_id = il.restaurant_id and l.id = il.label_id
      where il.restaurant_id = i.restaurant_id and il.item_clover_id = i.clover_id and l.active), '[]'::jsonb),
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
-- The allergy notice
-- ---------------------------------------------------------------------------------------

create function public.site_notice_get(p_restaurant uuid) returns jsonb
language sql stable as $$
  select coalesce((
    select jsonb_build_object('enabled', allergy_notice_enabled, 'entries', allergy_notice, 'updated_at', updated_at)
    from public.site_settings where restaurant_id = p_restaurant),
    jsonb_build_object('enabled', false, 'entries', '[]'::jsonb, 'updated_at', null));
$$;

create function public.site_notice_set(p_restaurant uuid, p_enabled boolean, p_entries jsonb) returns jsonb
language plpgsql as $$
begin
  insert into public.site_settings (restaurant_id, allergy_notice_enabled, allergy_notice)
  values (p_restaurant, p_enabled, coalesce(p_entries, '[]'::jsonb))
  on conflict (restaurant_id) do update set
    allergy_notice_enabled = excluded.allergy_notice_enabled,
    allergy_notice = excluded.allergy_notice, updated_at = now();
  return public.site_notice_get(p_restaurant);
end $$;

-- The public menu, as before, with the allergy notice when the owner has turned it on and
-- written it: a list of {lang, text}. Absent (null) otherwise.
create or replace function public.public_menu(p_restaurant uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'synced_at', (select last_success_at from public.clover_connections
                  where restaurant_id = p_restaurant),
    'notice', (select case when s.allergy_notice_enabled and jsonb_array_length(s.allergy_notice) > 0
                           then s.allergy_notice end
               from public.site_settings s where s.restaurant_id = p_restaurant),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object(
                         'id', c.clover_id, 'name', c.name, 'image_path', c.web_image_path, 'items', items.j)
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

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
