-- Takes back migration 20261102001700 (special offers).
--
-- NOT A MIGRATION, and not run by `supabase db push`. Tested with the others in
-- tests/rollback.test.js: it leaves the database exactly as migration 20261014001600 left
-- it. Deploy the previous functions first (they never ask for offers), then run this.
--
-- WHAT IT DOES TO DATA: every offer is deleted. Their photos stay in Storage under
-- <restaurant>/offers/; remove that folder by hand if they are not wanted. Take a copy
-- first if it matters:
--   select * from public.site_offers;

begin;

drop function public.dash_site_offer_reorder(uuid, uuid[]);
drop function public.dash_site_offer_remove(uuid, uuid);
drop function public.dash_site_offer_remove_image(uuid, uuid);
drop function public.dash_site_offer_set_image(uuid, uuid, text, text, integer, integer, integer, text);
drop function public.dash_site_offer_update(uuid, uuid, jsonb);
drop function public.dash_site_offer_create(uuid, jsonb, integer);
drop function public.dash_site_offers(uuid);
drop function public.site_offers_for(uuid, boolean);
drop function public.site_offer_json(public.site_offers, boolean);
drop table public.site_offers;

commit;
