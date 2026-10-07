-- Photos of the website that the owner can change from the dashboard: the home page's
-- hero photo, the "our story" photo, and the gallery.
--
-- Until now these were files in the repository, named in content/site.json and built into
-- the site, so changing one meant a developer and a deployment. They still are the
-- starting point: the site is built with them and shows them when nothing else is set.
-- A row here replaces one. The pages ask the public-site function which photos to show.
--
-- The files live in the public `menu-images` bucket, under <restaurant>/site/. They are
-- public by nature: they are the photos on the public website.

create table public.site_photos (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  -- Where the photo goes. `hero` and `story` hold one photo each; `gallery` holds many.
  slot          text not null check (slot in ('hero', 'story', 'gallery')),
  sort_order    integer not null default 0,
  -- The full-size file, and a smaller one for phones. Paths inside the bucket.
  image_path    text not null,
  small_path    text,
  width         integer check (width between 1 and 10000),
  height        integer check (height between 1 and 10000),
  small_width   integer check (small_width between 1 and 10000),
  -- What the photo shows, for people who cannot see it.
  alt           text not null default '' check (char_length(alt) <= 200),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index site_photos_single_idx on public.site_photos (restaurant_id, slot)
  where slot in ('hero', 'story');
create index site_photos_order_idx on public.site_photos (restaurant_id, slot, sort_order, created_at);

alter table public.site_photos enable row level security;
revoke all on public.site_photos from anon, authenticated;
-- Said outright: default privileges belong to the role that creates the table.
grant all on public.site_photos to service_role;

-- ---------------------------------------------------------------------------------------
-- What the website shows
-- ---------------------------------------------------------------------------------------

create function public.site_photo_json(p public.site_photos, p_with_id boolean) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'path', p.image_path, 'small_path', p.small_path,
    'width', p.width, 'height', p.height, 'small_width', p.small_width, 'alt', p.alt)
    || case when p_with_id then jsonb_build_object('id', p.id, 'updated_at', p.updated_at) else '{}'::jsonb end;
$$;

-- The photos the owner has set, by slot. A slot with nothing set is null (or an empty
-- list for the gallery), and the page keeps the photo it was built with.
create function public.site_photos_for(p_restaurant uuid, p_with_id boolean) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'hero', (select public.site_photo_json(p, p_with_id) from public.site_photos p
             where p.restaurant_id = p_restaurant and p.slot = 'hero'),
    'story', (select public.site_photo_json(p, p_with_id) from public.site_photos p
              where p.restaurant_id = p_restaurant and p.slot = 'story'),
    'gallery', coalesce((select jsonb_agg(public.site_photo_json(p, p_with_id) order by p.sort_order, p.created_at, p.id)
                         from public.site_photos p
                         where p.restaurant_id = p_restaurant and p.slot = 'gallery'), '[]'::jsonb));
$$;

-- ---------------------------------------------------------------------------------------
-- The dashboard
-- ---------------------------------------------------------------------------------------

-- Sets the photo of a single-photo slot, or adds one to the gallery. Returns the photos as
-- they now stand and the files that are no longer used, for the backend to remove.
create function public.dash_site_photo_add(
  p_restaurant uuid, p_slot text, p_image_path text, p_small_path text,
  p_width integer, p_height integer, p_small_width integer, p_alt text
) returns jsonb language plpgsql as $$
declare
  v_unused text[] := '{}';
  v_next   integer;
begin
  if p_slot in ('hero', 'story') then
    select array_remove(array[image_path, small_path], null) into v_unused
    from public.site_photos where restaurant_id = p_restaurant and slot = p_slot;
    delete from public.site_photos where restaurant_id = p_restaurant and slot = p_slot;
    insert into public.site_photos (restaurant_id, slot, image_path, small_path, width, height, small_width, alt)
    values (p_restaurant, p_slot, p_image_path, p_small_path, p_width, p_height, p_small_width, coalesce(p_alt, ''));
  else
    if (select count(*) from public.site_photos where restaurant_id = p_restaurant and slot = 'gallery') >= 24 then
      return jsonb_build_object('full', true);
    end if;
    select coalesce(max(sort_order), 0) + 1 into v_next
    from public.site_photos where restaurant_id = p_restaurant and slot = 'gallery';
    insert into public.site_photos (restaurant_id, slot, sort_order, image_path, small_path, width, height, small_width, alt)
    values (p_restaurant, 'gallery', v_next, p_image_path, p_small_path, p_width, p_height, p_small_width, coalesce(p_alt, ''));
  end if;
  return jsonb_build_object('photos', public.site_photos_for(p_restaurant, true), 'unused', to_jsonb(coalesce(v_unused, '{}')));
end $$;

create function public.dash_site_photo_describe(p_restaurant uuid, p_id uuid, p_alt text) returns jsonb
language plpgsql as $$
begin
  update public.site_photos set alt = coalesce(p_alt, ''), updated_at = now()
  where restaurant_id = p_restaurant and id = p_id;
  if not found then return null; end if;
  return public.site_photos_for(p_restaurant, true);
end $$;

-- Removes a photo. For `hero` and `story` the page goes back to the photo it was built with.
create function public.dash_site_photo_remove(p_restaurant uuid, p_id uuid) returns jsonb
language plpgsql as $$
declare
  v_unused text[];
  v_slot   text;
begin
  delete from public.site_photos where restaurant_id = p_restaurant and id = p_id
  returning array_remove(array[image_path, small_path], null), slot into v_unused, v_slot;
  if not found then return null; end if;
  return jsonb_build_object(
    'photos', public.site_photos_for(p_restaurant, true), 'unused', to_jsonb(v_unused), 'slot', v_slot);
end $$;

-- Puts the gallery in the given order. Every gallery photo must be named exactly once.
create function public.dash_site_gallery_reorder(p_restaurant uuid, p_ids uuid[]) returns jsonb
language plpgsql as $$
declare
  v_current uuid[];
begin
  select coalesce(array_agg(id), '{}') into v_current
  from public.site_photos where restaurant_id = p_restaurant and slot = 'gallery';
  if cardinality(p_ids) <> cardinality(v_current) or not (p_ids <@ v_current and v_current <@ p_ids)
     or cardinality(p_ids) <> (select count(distinct x) from unnest(p_ids) x) then
    return null;
  end if;
  update public.site_photos p set sort_order = o.position, updated_at = now()
  from unnest(p_ids) with ordinality as o(id, position)
  where p.restaurant_id = p_restaurant and p.id = o.id;
  return public.site_photos_for(p_restaurant, true);
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
