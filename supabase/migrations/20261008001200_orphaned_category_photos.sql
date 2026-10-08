-- Photos left behind by categories that Clover no longer has.
--
-- A category deleted in Clover is not deleted here: its row is kept and marked
-- (removed_from_clover_at), so that the owner's choices come back with it if it returns.
-- Its photo, chosen in the dashboard, stayed in Storage for ever.
--
-- Nothing is deleted because a category disappeared. A photo becomes a candidate only when
-- ALL of this is true:
--   * its category has been gone from Clover for longer than the grace period the backend
--     gives (30 days), counted from the moment it went;
--   * the file is in that category's own folder, <restaurant>/categories/<category>/, so a
--     path that points anywhere else is never touched;
--   * nothing else points at the same file: no other category, no dish, none of the
--     website's own photos (hero, story, gallery).
-- A category that comes back within the grace period stops being a candidate at once,
-- because synchronisation clears removed_from_clover_at.
--
-- The backend removes the files first and only then calls category_photos_forget, which
-- checks every condition again. If removing a file fails, the row is untouched and the
-- next hourly pass tries again. Both functions can be run any number of times.

create function public.category_photos_orphaned(p_grace_days integer, p_limit integer) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'restaurant_id', c.restaurant_id, 'category_id', c.clover_id, 'path', c.web_image_path)), '[]'::jsonb)
  from (
    select c.restaurant_id, c.clover_id, c.web_image_path
    from public.menu_categories c
    where p_grace_days >= 1
      and c.web_image_path is not null
      and c.removed_from_clover_at is not null
      and c.removed_from_clover_at < now() - make_interval(days => p_grace_days)
      and left(c.web_image_path, length(c.restaurant_id::text || '/categories/' || c.clover_id || '/'))
          = c.restaurant_id::text || '/categories/' || c.clover_id || '/'
      and not exists (select 1 from public.menu_categories o
                      where o.web_image_path = c.web_image_path
                        and (o.restaurant_id, o.clover_id) <> (c.restaurant_id, c.clover_id))
      and not exists (select 1 from public.menu_items i where i.web_image_path = c.web_image_path)
      and not exists (select 1 from public.site_photos s
                      where s.image_path = c.web_image_path or s.small_path = c.web_image_path)
    order by c.removed_from_clover_at
    limit least(greatest(coalesce(p_limit, 100), 1), 500)
  ) c;
$$;

-- Forgets the photos whose files have just been removed. Each is given as
-- {restaurant_id, category_id, path}; a row is cleared only if it still names that very
-- path and its category is still gone past the grace period. Returns how many were cleared.
create function public.category_photos_forget(p_photos jsonb, p_grace_days integer) returns integer
language plpgsql as $$
declare
  v_count integer;
begin
  update public.menu_categories c
  set web_image_path = null, updated_at = now()
  from jsonb_array_elements(coalesce(p_photos, '[]'::jsonb)) p
  where c.restaurant_id = (p->>'restaurant_id')::uuid
    and c.clover_id = p->>'category_id'
    and c.web_image_path = p->>'path'
    and p_grace_days >= 1
    and c.removed_from_clover_at is not null
    and c.removed_from_clover_at < now() - make_interval(days => p_grace_days);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
