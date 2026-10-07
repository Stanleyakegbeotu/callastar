-- Full-call recording is not part of the product. Keep the screenshot-based
-- call_evidence flow and remove only the empty, obsolete recording metadata.
-- Supabase requires bucket deletion through its Storage API; the production
-- call-recordings bucket was checked empty and removed through that API before
-- this migration was applied. Never delete from storage tables in SQL.
do $$
begin
  if exists (select 1 from public.call_recordings limit 1) then
    raise exception 'Refusing to remove call-recordings: recording metadata exists';
  end if;

  if exists (select 1 from public.call_recording_audit limit 1) then
    raise exception 'Refusing to remove call-recordings: audit metadata exists';
  end if;

  if exists (select 1 from storage.objects where bucket_id = 'call-recordings' limit 1) then
    raise exception 'Refusing to remove call-recordings: storage objects exist';
  end if;

end $$;

drop table if exists public.call_recording_audit;
drop table if exists public.call_recordings;
