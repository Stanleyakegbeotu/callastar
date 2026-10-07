-- Commit uploaded metadata and the playable host source together. RLS stays on.
create or replace function public.attach_host_assets(p_host_id uuid, p_asset_ids text[])
returns void language plpgsql security invoker set search_path = public as $$
declare asset public.host_assets; host_exists uuid;
begin
  if not public.is_admin() then raise exception 'unauthorized'; end if;
  select id into host_exists from public.hosts where id = p_host_id for update;
  if host_exists is null then raise exception 'host_not_found'; end if;
  if (select count(*) from public.host_assets where id = any(p_asset_ids) and host_id = p_host_id) <> cardinality(p_asset_ids)
    then raise exception 'invalid_assets'; end if;
  if exists (select 1 from public.host_assets where id = any(p_asset_ids) group by kind having count(*) > 1)
    then raise exception 'duplicate_asset_kind'; end if;
  for asset in select * from public.host_assets where id = any(p_asset_ids) and host_id = p_host_id loop
    if asset.kind in ('remote_video','remote_audio') then
      update public.host_media set is_active = false where host_id = p_host_id and kind = asset.kind;
      insert into public.host_media(host_id,kind,storage_path,mime_type,file_size_bytes,duration_seconds,has_audio,is_active)
      values(p_host_id,asset.kind,asset.storage_path,asset.mime_type,asset.file_size_bytes,asset.duration_seconds,asset.has_audio,true);
    end if;
    update public.hosts set
      avatar_path = case when asset.kind = 'avatar' then asset.storage_path else avatar_path end,
      cover_path = case when asset.kind = 'cover' then asset.storage_path else cover_path end,
      remote_video_asset_id = case when asset.kind = 'remote_video' then asset.id else remote_video_asset_id end,
      remote_audio_asset_id = case when asset.kind = 'remote_audio' then asset.id else remote_audio_asset_id end,
      updated_at = now()
    where id = p_host_id;
  end loop;
end $$;
revoke all on function public.attach_host_assets(uuid,text[]) from public, anon;
grant execute on function public.attach_host_assets(uuid,text[]) to authenticated;
