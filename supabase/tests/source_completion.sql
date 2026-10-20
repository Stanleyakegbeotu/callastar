-- Every fixture is rolled back; no Edge notifications or storage writes.
begin;
do $verification$
declare h uuid; asset text; code text; candidate jsonb; result jsonb; sid uuid; configured integer; n integer; count_now integer;
begin
  if has_function_privilege('anon','public.renew_ticket_session(uuid)','EXECUTE') then raise exception 'renewal exposed'; end if;
  foreach configured in array array[1,2,3,5] loop
    insert into public.hosts(display_name) values('Source Completion Transaction Test') returning id into h;
    asset := 'rollback-source-'||gen_random_uuid()::text;
    insert into public.host_assets(id,host_id,kind,storage_path,file_name,mime_type,file_size_bytes,duration_seconds,width,height)
      values(asset,h,'remote_video',asset||'.mp4','validation.mp4','video/mp4',1000,30,640,360);
    update public.hosts set remote_video_asset_id=asset where id=h;
    code := 'rollback-hash-'||gen_random_uuid()::text;
    candidate := jsonb_build_object('code_hash',code,'code_ciphertext','transaction-only-fixture','code_last4','TEST');
    perform public.configure_call_ticket(h,candidate,'free',configured);
    update public.hosts set status='inactive' where id=h;
    result := public.begin_ticket_session(code,'video',jsonb_build_object('fullName','Transaction Caller','email','rollback@example.test','phone','123456789'),'rollback-attempt-'||gen_random_uuid()::text,'token');
    if result->>'code' <> 'PROFILE_UNAVAILABLE' then raise exception 'inactive availability guard'; end if;
    update public.hosts set status='active' where id=h;
    -- Early active failure releases capacity without rotating or consuming.
    result := public.begin_ticket_session(code,'video',jsonb_build_object('fullName','Transaction Caller','email','rollback@example.test','phone','123456789'),'rollback-attempt-'||gen_random_uuid()::text,'token');
    sid := (result->>'sessionId')::uuid;
    if not public.transition_call_session(sid,'active') then raise exception 'activation failed'; end if;
    if not public.transition_call_session(sid,'failed',null,null,'source_unavailable') then raise exception 'release failed'; end if;
    select use_count into count_now from public.call_ids where code_hash=code;
    if count_now <> 0 then raise exception 'failed use consumed'; end if;
    for n in 1..configured loop
      result := public.begin_ticket_session(code,'video',jsonb_build_object('fullName','Transaction Caller','email','rollback@example.test','phone','123456789'),'rollback-attempt-'||gen_random_uuid()::text,'token');
      if result->>'kind' <> 'free' or result->>'deliveryKind' <> 'source_video' then raise exception 'free source not authorized'; end if;
      sid := (result->>'sessionId')::uuid;
      if not public.transition_call_session(sid,'active') then raise exception 'activation failed'; end if;
      select use_count into count_now from public.call_ids where code_hash=code;
      if count_now <> n-1 then raise exception 'consumed before ended'; end if;
      if not public.renew_ticket_session(sid) then raise exception 'renewal failed'; end if;
      if n=configured then
        result := public.begin_ticket_session(code,'video',jsonb_build_object('fullName','Second Caller','email','second-rollback@example.test','phone','123456789'),'rollback-attempt-'||gen_random_uuid()::text,'token');
        if result->>'code' <> 'CALL_ID_TEMPORARILY_RESERVED' then raise exception 'active final slot not held'; end if;
      end if;
      candidate := jsonb_build_object('code_hash','rollback-next-'||gen_random_uuid()::text,'code_ciphertext','transaction-only-fixture','code_last4','NEXT');
      if not public.transition_call_session(sid,'ended',null,null,'SOURCE_VIDEO_ENDED',candidate) then raise exception 'completion failed'; end if;
      if not public.transition_call_session(sid,'ended',null,null,'SOURCE_VIDEO_ENDED',candidate) then raise exception 'completion retry failed'; end if;
      select use_count into count_now from public.call_ids where code_hash=code;
      if count_now <> n then raise exception 'completion count mismatch'; end if;
    end loop;
    result := public.begin_ticket_session(code,'video',jsonb_build_object('fullName','Transaction Caller','email','rollback@example.test','phone','123456789'),'rollback-attempt-'||gen_random_uuid()::text,'token');
    if result->>'code' <> 'CALL_ID_EXHAUSTED' then raise exception 'old ID usable'; end if;
    select count(*) into count_now from public.call_ids where host_id=h and status='active' and use_count=0 and max_uses=configured and issued_mode='free';
    if count_now <> 1 then raise exception 'replacement ticket missing'; end if;
  end loop;
end;
$verification$;
rollback;
select 'PASS: hosted 1/2/3/5 source completions, activation holds, release, idempotency, rotation, old-ID rejection; all fixtures rolled back' as verification;
