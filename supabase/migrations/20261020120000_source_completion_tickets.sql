-- Correct source-video accounting without rewriting previously applied history.
-- Availability (hosts.status), monetization (profile_mode) and delivery are independent.
-- Existing sessions retain their original accounting; new video reservations snapshot
-- the selected source and hold capacity until its natural completion.
alter table public.call_sessions
  add column delivery_kind text not null default 'live' check (delivery_kind in ('live','source_video')),
  add column source_asset_id text,
  add column source_duration_seconds double precision;

create or replace function public.begin_ticket_session(
  p_code_hash text,p_call_type text,p_caller jsonb,p_attempt_id text,p_token_hash text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare h public.hosts; t public.call_ids; s public.call_sessions; b public.call_trial_eligibility;
  g public.call_access_grants; pending integer; kind text; source public.host_assets; email text := lower(trim(p_caller->>'email'));
begin
  select * into t from public.call_ids where code_hash = p_code_hash;
  if not found then return jsonb_build_object('code','CALL_ID_NOT_FOUND'); end if;
  select * into h from public.hosts where id = t.host_id for update;
  select * into t from public.call_ids where id = t.id for update;
  -- A retry is bound to the same ticket AND customer. Never rotate another
  -- customer's session token merely because an attempt identifier was copied.
  select * into s from public.call_sessions where client_attempt_id = p_attempt_id for update;
  if found then
    if s.call_id_id <> t.id or lower(trim(s.visitor_email)) <> email or s.call_type <> p_call_type then
      return jsonb_build_object('code','INVALID_CALL_SESSION'); end if;
    if s.status <> 'connecting' or s.ticket_reserved_until <= now() then
      return jsonb_build_object('code','CALL_ID_RESERVATION_CONFLICT'); end if;
    update public.call_sessions set session_token_hash = p_token_hash where id = s.id;
    return jsonb_build_object('sessionId',s.id,'kind',s.access_kind,'mode',s.mode_at_start,'grantId',s.access_grant_id,'deliveryKind',s.delivery_kind);
  end if;
  if t.status = 'exhausted' or (t.expires_at is not null and t.expires_at <= now()) then
    return jsonb_build_object('code','CALL_ID_EXHAUSTED','mode',t.issued_mode); end if;
  if t.status <> 'active' then return jsonb_build_object('code','CALL_ID_RETIRED','mode',t.issued_mode); end if;
  if h.status <> 'active' then return jsonb_build_object('code','PROFILE_UNAVAILABLE'); end if;
  if p_call_type = 'video' then
    select * into source from public.host_assets a where a.id = h.remote_video_asset_id
      and a.host_id = h.id and a.kind = 'remote_video' and a.duration_seconds > 0 and a.width > 0 and a.height > 0;
    if not found then return jsonb_build_object('code','SOURCE_MEDIA_UNAVAILABLE'); end if;
  end if;
  select count(*) into pending from public.call_sessions where call_id_id = t.id
    and ticket_consumed_at is null and ticket_reserved_until > now() and status in ('connecting','ringing','active','reconnecting');
  if t.use_count + pending >= t.max_uses then
    return jsonb_build_object('code','CALL_ID_TEMPORARILY_RESERVED','mode',t.issued_mode); end if;
  kind := 'free';
  if t.issued_mode = 'premium' then
    insert into public.call_trial_eligibility(customer_email_normalized,state) values(email,'available') on conflict do nothing;
    select * into b from public.call_trial_eligibility where customer_email_normalized = email for update;
    if b.state = 'reserved' and b.reserved_until > now() then
      return jsonb_build_object('code','FREE_TRIAL_IN_PROGRESS'); end if;
    if b.state <> 'consumed' then kind := 'premium_bonus';
    else
      -- Release abandoned paid reservations for this customer before looking up
      -- entitlement. Expired leases cannot subsequently activate.
      update public.call_access_grants ag set consumed_by_session_id = null, consumed_at = null
        from public.call_sessions cs where ag.consumed_by_session_id = cs.id::text
          and ag.customer_email_normalized = email and cs.ticket_consumed_at is null and cs.ticket_reserved_until <= now();
      select ag.* into g
        from public.call_access_grants ag join public.subscription_plans p on p.id = ag.plan_id and p.is_active
        where ag.customer_email_normalized = email and ag.status = 'active' and ag.consumed_by_session_id is null
        order by ag.granted_at limit 1 for update of ag;
      if g.id is null then
        raise log 'callastar PREMIUM_ACCESS_REQUIRED';
        return jsonb_build_object('code','PREMIUM_SUBSCRIPTION_REQUIRED'); end if;
      kind := 'paid';
    end if;
  end if;
  insert into public.call_sessions(host_id,call_id_id,call_id_snapshot,profile_name_snapshot,call_type,
    visitor_name,visitor_email,visitor_phone,session_token_hash,client_attempt_id,mode_at_start,access_kind,ticket_reserved_until,access_grant_id,delivery_kind,source_asset_id,source_duration_seconds)
    values(h.id,t.id,'masked-'||t.code_last4,h.display_name,p_call_type,trim(p_caller->>'fullName'),email,
      trim(p_caller->>'phone'),p_token_hash,p_attempt_id,t.issued_mode,kind,now()+interval '3 minutes',
      case when kind = 'paid' then g.id else null end,
      case when p_call_type = 'video' then 'source_video' else 'live' end,source.id,source.duration_seconds) returning * into s;
  if kind = 'premium_bonus' then
    update public.call_trial_eligibility set state = 'reserved',reserved_session_id = s.id,
      reserved_until = s.ticket_reserved_until,updated_at = now() where customer_email_normalized = email;
  elsif kind = 'paid' then
    update public.call_access_grants set consumed_by_session_id = s.id::text,consumed_at = now() where id = g.id;
  end if;
  insert into public.call_events(session_id,event_type,metadata) values(s.id,'CALL_ID_RESERVED',jsonb_build_object('mode',t.issued_mode));
  return jsonb_build_object('sessionId',s.id,'kind',kind,'mode',t.issued_mode,'grantId',s.access_grant_id,'deliveryKind',s.delivery_kind);
end; $$;

create or replace function public.transition_call_session(
  p_session_id uuid,p_status text,p_ended_at timestamptz default null,
  p_duration_seconds integer default null,p_failure_code text default null,
  p_candidate jsonb default null
) returns boolean language plpgsql security definer set search_path = public as $$
declare s public.call_sessions; t public.call_ids; h public.hosts; n uuid; terminal boolean; completing boolean;
begin
  select * into s from public.call_sessions where id = p_session_id;
  if not found then return false; end if;
  select * into h from public.hosts where id = s.host_id for update;
  select * into t from public.call_ids where id = s.call_id_id for update;
  select * into s from public.call_sessions where id = p_session_id for update;
  if s.status = p_status then return true; end if;
  if not (case s.status when 'connecting' then p_status in ('ringing','active','ended','cancelled','failed','declined','no_answer')
    when 'ringing' then p_status in ('active','ended','cancelled','failed','declined','no_answer')
    when 'active' then p_status in ('ended','failed') else false end) then return false; end if;
  terminal := p_status in ('ended','cancelled','failed','declined','no_answer');
  completing := s.delivery_kind = 'source_video' and p_status = 'ended' and p_failure_code = 'SOURCE_VIDEO_ENDED';
  if completing and s.status <> 'active' then return false; end if;
  if p_status = 'active' and s.delivery_kind = 'source_video' then
    if s.ticket_reserved_until is null or s.ticket_reserved_until <= now() then return false; end if;
    if s.access_kind = 'premium_bonus' and not exists(select 1 from public.call_trial_eligibility
      where reserved_session_id=s.id and state='reserved' and reserved_until > now()) then return false; end if;
    update public.call_sessions set ticket_reserved_until = now()+interval '3 minutes' where id=s.id;
    update public.call_trial_eligibility set reserved_until=now()+interval '3 minutes',updated_at=now()
      where reserved_session_id=s.id and state='reserved';
  elsif ((p_status = 'active' and s.delivery_kind = 'live') or completing) and s.mode_at_start is not null then
    if s.ticket_reserved_until is null or s.ticket_reserved_until <= now() then return false; end if;
    -- Existing reservations survive configuration changes. Retired tickets can
    -- finish their authorized in-flight attempts, but cannot reserve anew.
    if s.access_kind = 'premium_bonus' then
      update public.call_trial_eligibility set state = 'consumed',consumed_session_id = s.id,consumed_at = now(),
        reserved_session_id = null,reserved_until = null,updated_at = now()
        where customer_email_normalized = lower(trim(s.visitor_email)) and state = 'reserved'
          and reserved_session_id = s.id and reserved_until > now();
      if not found then return false; end if;
      raise log 'callastar PREMIUM_BONUS_USED session=%',s.id;
    end if;
    update public.call_ids set use_count = use_count + 1,
      status = case when status = 'active' and use_count + 1 >= max_uses then 'exhausted' else status end,
      exhausted_at = case when use_count + 1 >= max_uses then coalesce(exhausted_at,now()) else exhausted_at end,
      last_used_at = now() where id = t.id returning * into t;
    update public.call_sessions set ticket_consumed_at = now(),ticket_reserved_until = null,ticket_use_number = t.use_count where id = s.id;
    insert into public.call_events(session_id,event_type) values(s.id,'CALL_ID_USE_CONSUMED');
    if completing then insert into public.call_events(session_id,event_type) values(s.id,'SOURCE_VIDEO_ENDED'); end if;
    if t.status = 'exhausted' and t.replaced_by_call_id is null then
      if p_candidate is null then raise exception 'rotation candidate required'; end if;
      n := public.configure_call_ticket(h.id,p_candidate);
      update public.call_ids set generation_reason = 'exhausted' where id = n;
      update public.call_ids set replaced_by_call_id = n where id = t.id;
      insert into public.call_events(session_id,event_type) values(s.id,'CALL_ID_EXHAUSTED'),(s.id,'CALL_ID_AUTO_ROTATED');
    end if;
  elsif terminal and s.ticket_consumed_at is null then
    update public.call_trial_eligibility set state = 'available',reserved_session_id = null,reserved_until = null,updated_at = now()
      where reserved_session_id = s.id and state = 'reserved';
    update public.call_access_grants set consumed_by_session_id = null,consumed_at = null
      where consumed_by_session_id = s.id::text;
    update public.call_sessions set ticket_reserved_until = null where id = s.id;
    insert into public.call_events(session_id,event_type) values(s.id,'CALL_ID_RESERVATION_RELEASED');
  end if;
  update public.call_sessions set status = p_status,
    connected_at = case when p_status = 'active' then coalesce(connected_at,now()) else connected_at end,
    ended_at = case when terminal then now() else ended_at end,
    duration_seconds = case when terminal and connected_at is not null then greatest(0,extract(epoch from now()-connected_at)::integer) else duration_seconds end,
    end_reason = case when terminal then coalesce(p_failure_code,'USER_ENDED') else end_reason end,
    failure_code = case when p_status = 'failed' then p_failure_code else failure_code end where id = s.id;
  return true;
end; $$;

-- Leases keep long source calls reserved, while abandoned tabs eventually release
-- capacity. Never revive an expired lease or a completed/failed attempt.
create function public.renew_ticket_session(p_session_id uuid)
returns boolean language plpgsql security definer set search_path=public as $$
declare s public.call_sessions;
begin
  select * into s from public.call_sessions where id=p_session_id;
  if not found then return false; end if;
  perform 1 from public.hosts where id=s.host_id for update;
  perform 1 from public.call_ids where id=s.call_id_id for update;
  select * into s from public.call_sessions where id=p_session_id for update;
  if s.delivery_kind <> 'source_video' or s.status not in ('connecting','ringing','active')
    or s.ticket_consumed_at is not null or s.ticket_reserved_until is null or s.ticket_reserved_until <= now() then return false; end if;
  if s.access_kind = 'premium_bonus' and not exists(select 1 from public.call_trial_eligibility
    where reserved_session_id=s.id and state='reserved' and reserved_until > now()) then return false; end if;
  update public.call_sessions set ticket_reserved_until=now()+interval '3 minutes' where id=s.id;
  update public.call_trial_eligibility set reserved_until=now()+interval '3 minutes',updated_at=now()
    where reserved_session_id=s.id and state='reserved';
  return true;
end; $$;
revoke all on function public.renew_ticket_session(uuid) from public,anon,authenticated;
grant execute on function public.renew_ticket_session(uuid) to service_role;
