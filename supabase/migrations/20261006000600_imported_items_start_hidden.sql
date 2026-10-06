-- Items that arrive from Clover are not shown on the website until the owner shows them.
--
-- Website visibility belongs to this system, not to Clover. Until now a new row in
-- menu_items started with web_hidden = false, so connecting a merchant published its whole
-- inventory at once: every register-only item, test item and service charge included. From
-- here on a new item starts hidden, and the owner chooses what is public (Items > select >
-- Show, or the switch on each row).
--
-- Only the starting value changes. menu_apply_sync still never writes web_hidden, so:
--   - an item the owner has shown stays shown through every later sync;
--   - an item the owner has hidden stays hidden;
--   - rows that already exist are not touched by this migration.
-- An item created from the dashboard is shown or hidden as its form says: the handler sets
-- web_hidden explicitly after the create (supabase/functions/_shared/dashboard/items.ts).
--
-- Categories keep starting visible: a category only appears on the website when it holds at
-- least one item that is shown.

alter table public.menu_items alter column web_hidden set default true;
