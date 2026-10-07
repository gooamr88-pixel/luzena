-- A photo for each menu category, chosen by the owner in the dashboard.
--
-- The home page shows the menu's categories as photo tiles. Until now a tile borrowed the
-- photo of one of its dishes, or one of the photos the site was built with. That is still
-- what happens when the owner has chosen nothing. A photo chosen here comes first.
--
-- It is website-only data, like a dish's description: Clover has no field for it, the
-- column is prefixed web_, and synchronisation never writes to it.

alter table public.menu_categories add column web_image_path text;

-- The public menu, as before, with each category's own photo when it has one.
create or replace function public.public_menu(p_restaurant uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'synced_at', (select last_success_at from public.clover_connections
                  where restaurant_id = p_restaurant),
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

-- The dashboard's list of categories, as before, with two more things about each:
--   image_path       the photo the owner chose for it, if any
--   dish_image_path  the photo the website borrows when none is chosen: that of the first
--                    dish of the category, in the website's order, that has one and is shown
--   on_website_count how many of its dishes the website shows. A category with none is not
--                    on the home page, whatever photo it has.
create or replace function public.dash_list_categories(p_restaurant uuid) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.clover_id, 'name', c.name, 'sort_order', c.sort_order,
    'web_hidden', c.web_hidden, 'archived', c.archived_at is not null,
    'removed_from_clover', c.removed_from_clover_at is not null,
    'updated_at', c.updated_at,
    'image_path', c.web_image_path,
    'dish_image_path', (select i.web_image_path from public.menu_item_categories l
                        join public.menu_items i
                          on i.restaurant_id = l.restaurant_id and i.clover_id = l.item_clover_id
                        where l.restaurant_id = c.restaurant_id and l.category_clover_id = c.clover_id
                          and i.web_image_path is not null
                          and not i.hidden and not i.web_hidden and i.archived_at is null
                          and i.removed_from_clover_at is null
                        order by l.position, lower(i.name) limit 1),
    'on_website_count', (select count(*) from public.menu_item_categories l
                         join public.menu_items i
                           on i.restaurant_id = l.restaurant_id and i.clover_id = l.item_clover_id
                         where l.restaurant_id = c.restaurant_id and l.category_clover_id = c.clover_id
                           and not i.hidden and not i.web_hidden and i.archived_at is null
                           and i.removed_from_clover_at is null),
    'item_count', (select count(*) from public.menu_item_categories l
                   join public.menu_items i
                     on i.restaurant_id = l.restaurant_id and i.clover_id = l.item_clover_id
                   where l.restaurant_id = c.restaurant_id and l.category_clover_id = c.clover_id
                     and i.archived_at is null and i.removed_from_clover_at is null))
    order by c.sort_order, c.name), '[]'::jsonb)
  from public.menu_categories c
  where c.restaurant_id = p_restaurant;
$$;

-- Sets a category's photo, or clears it when p_path is null. Returns the path it had before
-- (for the backend to remove the file) and the categories as they now stand; null when the
-- category is not this restaurant's.
create function public.dash_category_set_image(p_restaurant uuid, p_category text, p_path text) returns jsonb
language plpgsql as $$
declare
  v_old text;
begin
  select web_image_path into v_old from public.menu_categories
  where restaurant_id = p_restaurant and clover_id = p_category for update;
  if not found then return null; end if;

  update public.menu_categories set web_image_path = p_path, updated_at = now()
  where restaurant_id = p_restaurant and clover_id = p_category;

  return jsonb_build_object('previous', v_old, 'categories', public.dash_list_categories(p_restaurant));
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
