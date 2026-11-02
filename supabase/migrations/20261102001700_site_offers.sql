-- Special offers: the slides of the offers carousel on the home page, managed from the
-- dashboard.
--
-- Each offer is a slide: a photo, a small badge ("This week at Luzena"), a highlight
-- ("15% OFF"), a title, a few words, a button and a line of fine print. The owner puts them
-- in order, switches each on or off, and can give each a first and a last day; the website
-- shows only the offers that are switched on and within their dates, in the owner's order.
-- With none to show, the carousel is not on the page at all.
--
-- Offers are the website's own: nothing here goes to Clover, and nothing here changes a
-- price. A discount is honoured at the till, as it always was; this is how it is announced.
--
-- The photos live in the public `menu-images` bucket under <restaurant>/offers/, a folder of
-- their own, so no other clean-up (categories, site photos) ever looks at them.

create table public.site_offers (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  sort_order    integer not null default 0,
  -- Switched off, an offer is kept for next time but not shown.
  active        boolean not null default true,
  badge         text not null default '' check (char_length(badge) <= 40),
  highlight     text not null default '' check (char_length(highlight) <= 24),
  title         text not null check (char_length(title) between 1 and 80),
  description   text not null default '' check (char_length(description) <= 240),
  cta_label     text not null default '' check (char_length(cta_label) <= 30),
  -- A page of the website ("/menu/"), a full https address, or a phone number ("tel:...").
  -- Empty: the slide has no button.
  cta_url       text not null default '' check (char_length(cta_url) <= 500),
  fine_print    text not null default '' check (char_length(fine_print) <= 80),
  -- The first moment the offer is shown, and the moment it stops. Either may be open. The
  -- dashboard sets them to midnight at the restaurant, so a last day is shown all day long.
  starts_at     timestamptz,
  ends_at       timestamptz,
  -- The photo: a full-size file and a smaller one for phones, as the site's other photos.
  image_path    text,
  small_path    text,
  width         integer check (width between 1 and 10000),
  height        integer check (height between 1 and 10000),
  small_width   integer check (small_width between 1 and 10000),
  alt           text not null default '' check (char_length(alt) <= 200),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint site_offers_schedule_check check (starts_at is null or ends_at is null or ends_at > starts_at)
);

create index site_offers_order_idx on public.site_offers (restaurant_id, sort_order, created_at);

alter table public.site_offers enable row level security;
revoke all on public.site_offers from anon, authenticated;
grant all on public.site_offers to service_role;

-- ---------------------------------------------------------------------------------------
-- What the website shows
-- ---------------------------------------------------------------------------------------

-- One offer. The website is given what it shows; the dashboard also gets what it manages.
create function public.site_offer_json(o public.site_offers, p_with_id boolean) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'badge', o.badge, 'highlight', o.highlight, 'title', o.title, 'description', o.description,
    'cta_label', o.cta_label, 'cta_url', o.cta_url, 'fine_print', o.fine_print,
    'starts_at', o.starts_at, 'ends_at', o.ends_at,
    'image', case when o.image_path is null then null else jsonb_build_object(
      'path', o.image_path, 'small_path', o.small_path,
      'width', o.width, 'height', o.height, 'small_width', o.small_width, 'alt', o.alt) end)
    || case when p_with_id
         then jsonb_build_object('id', o.id, 'active', o.active, 'sort_order', o.sort_order,
                                 'created_at', o.created_at, 'updated_at', o.updated_at)
         else '{}'::jsonb end;
$$;

-- The offers in the owner's order. `p_all` false: only those the website shows right now,
-- switched on and within their dates. `p_all` true: every one, for the dashboard.
create function public.site_offers_for(p_restaurant uuid, p_all boolean) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(public.site_offer_json(o, p_all) order by o.sort_order, o.created_at, o.id), '[]'::jsonb)
  from public.site_offers o
  where o.restaurant_id = p_restaurant
    and (p_all or (o.active
                   and (o.starts_at is null or o.starts_at <= now())
                   and (o.ends_at is null or o.ends_at > now())));
$$;

-- ---------------------------------------------------------------------------------------
-- The dashboard
-- ---------------------------------------------------------------------------------------

-- Every offer, and the restaurant's time zone: the dashboard sets an offer's dates to
-- midnight there, wherever the person setting them happens to be.
create function public.dash_site_offers(p_restaurant uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object('offers', public.site_offers_for(p_restaurant, true), 'timezone', r.timezone)
  from public.restaurants r where r.id = p_restaurant;
$$;

-- Adds an offer at the end of the list. `p_fields` has been validated by the backend.
-- Returns {full: true} when there are already `p_max` offers.
create function public.dash_site_offer_create(p_restaurant uuid, p_fields jsonb, p_max integer) returns jsonb
language plpgsql as $$
declare
  v_next integer;
  v_id   uuid;
begin
  -- One at a time per restaurant, so two quick additions cannot both take the last place.
  perform 1 from public.restaurants where id = p_restaurant for update;
  if (select count(*) from public.site_offers where restaurant_id = p_restaurant) >= p_max then
    return jsonb_build_object('full', true);
  end if;
  if (p_fields->>'starts_at') is not null and (p_fields->>'ends_at') is not null
     and (p_fields->>'ends_at')::timestamptz <= (p_fields->>'starts_at')::timestamptz then
    return jsonb_build_object('refused', 'schedule');
  end if;
  select coalesce(max(sort_order), 0) + 1 into v_next from public.site_offers where restaurant_id = p_restaurant;
  insert into public.site_offers (
    restaurant_id, sort_order, active, badge, highlight, title, description,
    cta_label, cta_url, fine_print, starts_at, ends_at)
  values (
    p_restaurant, v_next, coalesce((p_fields->>'active')::boolean, true),
    coalesce(p_fields->>'badge', ''), coalesce(p_fields->>'highlight', ''), p_fields->>'title',
    coalesce(p_fields->>'description', ''), coalesce(p_fields->>'cta_label', ''),
    coalesce(p_fields->>'cta_url', ''), coalesce(p_fields->>'fine_print', ''),
    (p_fields->>'starts_at')::timestamptz, (p_fields->>'ends_at')::timestamptz)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'offers', public.site_offers_for(p_restaurant, true));
end $$;

-- Changes the fields named in `p_fields`; the others stay as they are. A key that is present
-- with the value null clears a date. Returns null for an unknown offer, and
-- {refused: 'schedule'} when the last day would come before the first.
create function public.dash_site_offer_update(p_restaurant uuid, p_id uuid, p_fields jsonb) returns jsonb
language plpgsql as $$
declare
  v_row    public.site_offers;
  v_starts timestamptz;
  v_ends   timestamptz;
begin
  select * into v_row from public.site_offers where restaurant_id = p_restaurant and id = p_id for update;
  if not found then return null; end if;
  v_starts := case when p_fields ? 'starts_at' then (p_fields->>'starts_at')::timestamptz else v_row.starts_at end;
  v_ends   := case when p_fields ? 'ends_at' then (p_fields->>'ends_at')::timestamptz else v_row.ends_at end;
  if v_starts is not null and v_ends is not null and v_ends <= v_starts then
    return jsonb_build_object('refused', 'schedule');
  end if;
  update public.site_offers set
    active      = case when p_fields ? 'active' then (p_fields->>'active')::boolean else active end,
    badge       = case when p_fields ? 'badge' then p_fields->>'badge' else badge end,
    highlight   = case when p_fields ? 'highlight' then p_fields->>'highlight' else highlight end,
    title       = case when p_fields ? 'title' then p_fields->>'title' else title end,
    description = case when p_fields ? 'description' then p_fields->>'description' else description end,
    cta_label   = case when p_fields ? 'cta_label' then p_fields->>'cta_label' else cta_label end,
    cta_url     = case when p_fields ? 'cta_url' then p_fields->>'cta_url' else cta_url end,
    fine_print  = case when p_fields ? 'fine_print' then p_fields->>'fine_print' else fine_print end,
    alt         = case when p_fields ? 'alt' then p_fields->>'alt' else alt end,
    starts_at   = v_starts,
    ends_at     = v_ends,
    updated_at  = now()
  where id = p_id;
  return jsonb_build_object('offers', public.site_offers_for(p_restaurant, true));
end $$;

-- Gives an offer a photo, in place of the one it had. Returns the offers as they now stand
-- and the files of the replaced photo, for the backend to remove if nothing else uses them.
create function public.dash_site_offer_set_image(
  p_restaurant uuid, p_id uuid, p_image_path text, p_small_path text,
  p_width integer, p_height integer, p_small_width integer, p_alt text
) returns jsonb language plpgsql as $$
declare
  v_unused text[];
begin
  select array_remove(array[image_path, small_path], null) into v_unused
  from public.site_offers where restaurant_id = p_restaurant and id = p_id for update;
  if not found then return null; end if;
  update public.site_offers set
    image_path = p_image_path, small_path = p_small_path, width = p_width, height = p_height,
    small_width = p_small_width, alt = coalesce(p_alt, alt), updated_at = now()
  where id = p_id;
  return jsonb_build_object('offers', public.site_offers_for(p_restaurant, true), 'unused', to_jsonb(coalesce(v_unused, '{}')));
end $$;

-- Takes an offer's photo away; the slide shows the restaurant's green panel instead.
create function public.dash_site_offer_remove_image(p_restaurant uuid, p_id uuid) returns jsonb
language plpgsql as $$
declare
  v_unused text[];
begin
  select array_remove(array[image_path, small_path], null) into v_unused
  from public.site_offers where restaurant_id = p_restaurant and id = p_id for update;
  if not found then return null; end if;
  update public.site_offers set image_path = null, small_path = null, width = null, height = null,
    small_width = null, updated_at = now()
  where id = p_id;
  return jsonb_build_object('offers', public.site_offers_for(p_restaurant, true), 'unused', to_jsonb(coalesce(v_unused, '{}')));
end $$;

create function public.dash_site_offer_remove(p_restaurant uuid, p_id uuid) returns jsonb
language plpgsql as $$
declare
  v_unused text[];
  v_title  text;
begin
  delete from public.site_offers where restaurant_id = p_restaurant and id = p_id
  returning array_remove(array[image_path, small_path], null), title into v_unused, v_title;
  if not found then return null; end if;
  return jsonb_build_object(
    'offers', public.site_offers_for(p_restaurant, true), 'unused', to_jsonb(v_unused), 'title', v_title);
end $$;

-- Puts the offers in the given order. Every offer must be named exactly once.
create function public.dash_site_offer_reorder(p_restaurant uuid, p_ids uuid[]) returns jsonb
language plpgsql as $$
declare
  v_current uuid[];
begin
  select coalesce(array_agg(id), '{}') into v_current
  from public.site_offers where restaurant_id = p_restaurant;
  if cardinality(p_ids) <> cardinality(v_current) or not (p_ids <@ v_current and v_current <@ p_ids)
     or cardinality(p_ids) <> (select count(distinct x) from unnest(p_ids) x) then
    return null;
  end if;
  update public.site_offers o set sort_order = n.position, updated_at = now()
  from unnest(p_ids) with ordinality as n(id, position)
  where o.restaurant_id = p_restaurant and o.id = n.id;
  return public.site_offers_for(p_restaurant, true);
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
