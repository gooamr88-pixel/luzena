-- Retention of job applications.
--
-- How long applications are kept is a legal decision for the restaurant. It is NOT set
-- here: the number of days comes from the JOB_APPLICATION_RETENTION_DAYS secret of the Edge
-- Functions, and applications are not accepted at all until that secret is set.
--
-- Deleting is two steps on purpose. The backend first asks which applications have passed
-- the retention period, removes their CV files from Storage, and only then deletes the rows.
-- If removing a file fails, the row stays and is picked up again next time, so a CV is
-- never left in Storage without a row pointing to it.

create function public.job_applications_expired(p_days integer, p_limit integer) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'cv_path', a.cv_path)), '[]'::jsonb)
  from (
    select id, cv_path from public.job_applications
    where p_days >= 1 and created_at < now() - make_interval(days => p_days)
    order by created_at
    limit least(greatest(coalesce(p_limit, 100), 1), 500)
  ) a;
$$;

create function public.job_applications_delete(p_ids uuid[]) returns integer
language plpgsql as $$
declare v_count integer;
begin
  delete from public.job_applications where id = any(p_ids);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
