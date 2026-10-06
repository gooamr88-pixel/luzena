-- Storage buckets. No storage policies are created, so only the service role can write.
--
--   cvs          private. Job-application CVs. Read only through the service role.
--   menu-images  public read by URL (they are shown on the public menu). Written only by the
--                dashboard API after server-side validation.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('cvs', 'cvs', false, 5242880, array[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
  ('menu-images', 'menu-images', true, 1048576, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;
