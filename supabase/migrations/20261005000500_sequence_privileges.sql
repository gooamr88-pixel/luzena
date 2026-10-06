-- Close the sequences, and close future tables and sequences by default.
--
-- Found on the first run against a real Supabase project (2026-10-05). Supabase's default
-- privileges give `anon` and `authenticated` every right on new tables AND sequences in
-- `public`. The schema migration revoked the tables but not the sequences, so the two
-- identity sequences (audit_logs, integration_logs) were readable and advanceable by the
-- public roles. Neither is reachable through the REST API and neither holds data, but the
-- rule in this database is that the public roles hold nothing.

revoke all on all sequences in schema public from anon, authenticated;

-- Anything a later migration creates starts closed, instead of relying on that migration
-- remembering to revoke. `service_role` keeps Supabase's defaults.
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
