-- Run once per restaurant, in the Supabase SQL editor, AFTER the migrations are applied
-- and AFTER the owner's user exists in Authentication > Users.
--
-- There is no self-service sign-up: the operator creates the user (Authentication >
-- Users > Add user, or "Invite"), then links it to the restaurant here. The owner sets
-- their own password with "Forgot your password?" on the dashboard sign-in page.
--
-- Check the four values below before running. v_owner is the email the owner signs in
-- with; the client confirmed on 2026-10-06 that it is the same as the recruitment address.

do $$
declare
  v_slug       text := 'luzena';                      -- must equal restaurantSlug in content/site.json
  v_name       text := 'Luzena Restaurant & Cafe';    -- shown in the dashboard and in application emails
  v_recruiting text := 'fadi.auchi@gmail.com';        -- inbox that receives job applications (confirmed by the client 2026-10-05)
  v_owner      text := 'fadi.auchi@gmail.com';        -- email of the owner's Supabase Auth user (supplied by the client 2026-10-06)
  v_restaurant uuid;
  v_user       uuid;
begin
  select id into v_user from auth.users where email = v_owner;
  if v_user is null then
    raise exception 'No Supabase Auth user with email %. Create the user first.', v_owner;
  end if;

  insert into public.restaurants (slug, name, recruitment_email)
  values (v_slug, v_name, v_recruiting)
  on conflict (slug) do update set name = excluded.name, recruitment_email = excluded.recruitment_email
  returning id into v_restaurant;

  insert into public.restaurant_users (restaurant_id, user_id, role)
  values (v_restaurant, v_user, 'owner')
  on conflict (restaurant_id, user_id) do update set role = 'owner';

  raise notice 'Restaurant % (%) is linked to owner %.', v_name, v_restaurant, v_owner;
end $$;
