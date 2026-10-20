-- Existing behavior charged every host through the Premium trial gate, so keep
-- existing profiles PREMIUM. Ticket accounting starts at migration time: old
-- unbounded sessions cannot reliably be assigned to a bounded ticket issuance.
alter table public.hosts
  add column profile_mode text not null default 'premium' check (profile_mode in ('free','premium')),
  add column call_id_max_uses integer not null default 1 check (call_id_max_uses in (1,2,3,5));
alter table public.call_ids drop constraint call_ids_status_check;
alter table public.call_ids
  add constraint call_ids_status_check check (status in ('active','revoked','exhausted','manually_retired')),
  add column issued_mode text not null default 'premium' check (issued_mode in ('free','premium')),
  add column max_uses integer not null default 1 check (max_uses in (1,2,3,5)),
  add column use_count integer not null default 0 check (use_count >= 0),
  add column exhausted_at timestamptz,
  add column replaced_by_call_id uuid references public.call_ids(id),
  add column generation_reason text not null default 'initial',
  add column updated_at timestamptz not null default now(),
  add constraint call_id_active_capacity check (status <> 'active' or use_count < max_uses);
-- Previously the browser retired older codes after insertion. Reconcile any
-- interrupted regeneration before enforcing exactly one current ticket.
with ranked as (select id, row_number() over(partition by host_id order by created_at desc,id desc) as n
  from public.call_ids where status = 'active')
update public.call_ids set status = 'manually_retired' where id in (select id from ranked where n > 1);
create unique index call_ids_one_active_host on public.call_ids(host_id) where status = 'active';
create trigger call_ids_updated_at before update on public.call_ids for each row execute function public.callastar_set_updated_at();
alter table public.call_sessions
  add column mode_at_start text check (mode_at_start in ('free','premium')),
  add column access_kind text check (access_kind in ('free','premium_bonus','paid')),
  add column ticket_reserved_until timestamptz,
  add column ticket_consumed_at timestamptz,
  add column ticket_use_number integer,
  add column end_reason text;
alter table public.call_sessions add column signaling_attempt_id text unique;
create index call_sessions_ticket_reservations on public.call_sessions(call_id_id,ticket_reserved_until)
  where ticket_consumed_at is null and ticket_reserved_until is not null;

-- Protect authoritative columns even from accidental direct Admin UI writes.
drop policy if exists "admins update call ids" on public.call_ids;
revoke update on public.call_ids from anon, authenticated;
revoke update on public.hosts from authenticated;
grant update(display_name,short_bio,slug,status,avatar_path,cover_path,
  remote_video_asset_id,remote_audio_asset_id,base_follower_count,base_like_count) on public.hosts to authenticated;

-- All ticket operations lock host -> ticket -> session -> customer/grant.
-- The candidate was generated/encrypted by the existing Edge encryption key.
create or replace function public.configure_call_ticket(
  p_host_id uuid, p_candidate jsonb, p_mode text default null,
  p_max_uses integer default null, p_regenerate boolean default false
) returns uuid language plpgsql security definer set search_path = public as $$
declare h public.hosts; t public.call_ids; n uuid; reason text;
begin
  select * into h from public.hosts where id = p_host_id for update;
  if not found then raise exception 'PROFILE_UNAVAILABLE'; end if;
  if p_mode is not null and p_mode not in ('free','premium') then raise exception 'INVALID_MODE'; end if;
  if p_max_uses is not null and p_max_uses not in (1,2,3,5) then raise exception 'INVALID_MAX_USES'; end if;
  select * into t from public.call_ids where host_id = h.id and status = 'active' for update;
  reason := case when p_mode is not null and p_mode <> h.profile_mode then 'mode_changed'
    when p_regenerate then 'manual' when t.id is null then 'initial'
    when t.use_count >= coalesce(p_max_uses,h.call_id_max_uses) then 'limit_reached' else null end;
  update public.hosts set profile_mode = coalesce(p_mode,profile_mode),
    call_id_max_uses = coalesce(p_max_uses,call_id_max_uses) where id = h.id returning * into h;
  if reason is null then
    update public.call_ids set max_uses = h.call_id_max_uses where id = t.id;
    return t.id;
  end if;
  if t.id is not null then
    update public.call_ids set status = case when reason = 'limit_reached' then 'exhausted' else 'manually_retired' end,
      max_uses = case when reason = 'limit_reached' then h.call_id_max_uses else max_uses end,
      exhausted_at = case when reason = 'limit_reached' then now() else exhausted_at end where id = t.id;
  end if;
  insert into public.call_ids(host_id,code_hash,code_ciphertext,code_last4,issued_mode,max_uses,generation_reason)
    values(h.id,p_candidate->>'code_hash',p_candidate->>'code_ciphertext',p_candidate->>'code_last4',
      h.profile_mode,h.call_id_max_uses,reason) returning id into n;
  update public.call_ids set replaced_by_call_id = n where id = t.id;
  raise log 'callastar % host=%', case when reason = 'mode_changed' then 'PROFILE_MODE_CHANGED'
    when reason = 'manual' then 'CALL_ID_MANUALLY_REGENERATED' else 'CALL_ID_AUTO_ROTATED' end, h.id;
  return n;
end; $$;

create or replace function public.begin_ticket_session(
  p_code_hash text,p_call_type text,p_caller jsonb,p_attempt_id text,p_token_hash text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare h public.hosts; t public.call_ids; s public.call_sessions; b public.call_trial_eligibility;
  g public.call_access_grants; pending integer; kind text; email text := lower(trim(p_caller->>'email'));
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
    return jsonb_build_object('sessionId',s.id,'kind',s.access_kind,'mode',s.mode_at_start,'grantId',s.access_grant_id);
  end if;
  if t.status = 'exhausted' or (t.expires_at is not null and t.expires_at <= now()) then
    return jsonb_build_object('code','CALL_ID_EXHAUSTED','mode',t.issued_mode); end if;
  if t.status <> 'active' then return jsonb_build_object('code','CALL_ID_RETIRED','mode',t.issued_mode); end if;
  if h.status <> 'active' then return jsonb_build_object('code','PROFILE_UNAVAILABLE'); end if;
  if p_call_type = 'video' and not exists(select 1 from public.host_assets a where a.id = h.remote_video_asset_id
      and a.host_id = h.id and a.kind = 'remote_video' and a.duration_seconds > 0 and a.width > 0 and a.height > 0) then
    return jsonb_build_object('code','SOURCE_MEDIA_UNAVAILABLE'); end if;
  select count(*) into pending from public.call_sessions where call_id_id = t.id
    and ticket_consumed_at is null and ticket_reserved_until > now() and status in ('connecting','ringing');
  if t.use_count + pending >= t.max_uses then
    return jsonb_build_object('code','CALL_ID_RESERVATION_CONFLICT','mode',t.issued_mode); end if;
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
          and ag.customer_email_normalized = email and cs.connected_at is null and cs.ticket_reserved_until <= now();
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
    visitor_name,visitor_email,visitor_phone,session_token_hash,client_attempt_id,mode_at_start,access_kind,ticket_reserved_until,access_grant_id)
    values(h.id,t.id,'masked-'||t.code_last4,h.display_name,p_call_type,trim(p_caller->>'fullName'),email,
      trim(p_caller->>'phone'),p_token_hash,p_attempt_id,t.issued_mode,kind,now()+interval '3 minutes',
      case when kind = 'paid' then g.id else null end) returning * into s;
  if kind = 'premium_bonus' then
    update public.call_trial_eligibility set state = 'reserved',reserved_session_id = s.id,
      reserved_until = s.ticket_reserved_until,updated_at = now() where customer_email_normalized = email;
  elsif kind = 'paid' then
    update public.call_access_grants set consumed_by_session_id = s.id::text,consumed_at = now() where id = g.id;
  end if;
  insert into public.call_events(session_id,event_type,metadata) values(s.id,'CALL_ID_RESERVED',jsonb_build_object('mode',t.issued_mode));
  return jsonb_build_object('sessionId',s.id,'kind',kind,'mode',t.issued_mode,'grantId',s.access_grant_id);
end; $$;

-- Replace the authoritative transition; all existing callers use this seam.
create or replace function public.transition_call_session(
  p_session_id uuid,p_status text,p_ended_at timestamptz default null,
  p_duration_seconds integer default null,p_failure_code text default null,
  p_candidate jsonb default null
) returns boolean language plpgsql security definer set search_path = public as $$
declare s public.call_sessions; t public.call_ids; h public.hosts; n uuid; terminal boolean;
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
  if p_status = 'active' and s.mode_at_start is not null then
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
    if t.status = 'exhausted' and t.replaced_by_call_id is null then
      if p_candidate is null then raise exception 'rotation candidate required'; end if;
      n := public.configure_call_ticket(h.id,p_candidate);
      update public.call_ids set generation_reason = 'exhausted' where id = n;
      update public.call_ids set replaced_by_call_id = n where id = t.id;
      insert into public.call_events(session_id,event_type) values(s.id,'CALL_ID_EXHAUSTED'),(s.id,'CALL_ID_AUTO_ROTATED');
    end if;
  elsif terminal and s.connected_at is null then
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
-- Remove old overload so a five-argument call cannot bypass ticket consumption.
drop function public.transition_call_session(uuid,text,timestamptz,integer,text);
revoke all on function public.configure_call_ticket(uuid,jsonb,text,integer,boolean) from public,anon,authenticated;
revoke all on function public.begin_ticket_session(text,text,jsonb,text,text) from public,anon,authenticated;
revoke all on function public.transition_call_session(uuid,text,timestamptz,integer,text,jsonb) from public,anon,authenticated;
grant execute on function public.configure_call_ticket(uuid,jsonb,text,integer,boolean),
  public.begin_ticket_session(text,text,jsonb,text,text),
  public.transition_call_session(uuid,text,timestamptz,integer,text,jsonb) to service_role;
-- Obsolete trial reservation is no longer an independent callable gate.
revoke execute on function public.reserve_call_trial(text,uuid) from service_role;

-- Bind one reservation to one signaling attempt, independently of browser UI.
create function public.bind_ticket_signaling(p_session_id uuid,p_code_hash text,p_attempt_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.call_sessions;
begin
  select * into s from public.call_sessions where id = p_session_id for update;
  if not found or s.mode_at_start is null or s.status not in ('connecting','ringing')
      or s.ticket_reserved_until is null or s.ticket_reserved_until <= clock_timestamp()
      or not exists(select 1 from public.call_ids t join public.hosts h on h.id=t.host_id
        where t.id=s.call_id_id and t.code_hash=p_code_hash and h.status='active') then
    return null;
  end if;
  if p_attempt_id !~ '^att_[a-zA-Z0-9_-]{8,80}$' then return null; end if;
  update public.call_sessions set signaling_attempt_id=coalesce(signaling_attempt_id,p_attempt_id)
    where id=s.id returning * into s;
  return jsonb_build_object('authorized',true,'callAttemptId',s.signaling_attempt_id,'reservedUntil',s.ticket_reserved_until);
end; $$;
revoke all on function public.bind_ticket_signaling(uuid,text,text) from public,anon,authenticated;
grant execute on function public.bind_ticket_signaling(uuid,text,text) to service_role;
