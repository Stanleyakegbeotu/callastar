-- Production call access and support read state. Customer email remains an
-- unverified identity key; none of these functions authenticates an email.

alter table public.support_conversations
  add column if not exists customer_last_read_at timestamptz,
  add column if not exists admin_last_read_at timestamptz;

create or replace function public.callastar_stamp_support_message()
returns trigger language plpgsql set search_path = public as $$
begin
  new.created_at := statement_timestamp();
  return new;
end;
$$;
drop trigger if exists support_messages_server_timestamp on public.support_messages;
create trigger support_messages_server_timestamp
  before insert on public.support_messages
  for each row execute function public.callastar_stamp_support_message();

create or replace function public.mark_support_conversation_read(
  p_conversation_id text,
  p_reader text,
  p_last_read_message_id text
)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_created_at timestamptz;
begin
  if p_reader not in ('customer','admin') or p_last_read_message_id is null then return false; end if;
  if p_reader = 'admin' and not public.is_admin() then raise exception 'admin access required'; end if;
  if p_reader = 'customer' and coalesce(auth.role(), '') <> 'service_role' then raise exception 'scoped customer access required'; end if;

  select created_at into v_created_at from public.support_messages
    where id = p_last_read_message_id and conversation_id = p_conversation_id
      and ((p_reader = 'customer' and sender in ('admin','assistant')) or (p_reader = 'admin' and sender = 'customer'));
  if v_created_at is null then return false; end if;

  if p_reader = 'customer' then
    update public.support_conversations set
      customer_last_read_at = greatest(coalesce(customer_last_read_at, '-infinity'::timestamptz), v_created_at),
      unread_for_customer = 0
      where id = p_conversation_id;
  else
    update public.support_conversations set
      admin_last_read_at = greatest(coalesce(admin_last_read_at, '-infinity'::timestamptz), v_created_at),
      unread_for_admin = 0
      where id = p_conversation_id;
  end if;
  return found;
end;
$$;
revoke all on function public.mark_support_conversation_read(text,text,text) from public, anon, authenticated;
grant execute on function public.mark_support_conversation_read(text,text,text) to authenticated, service_role;

alter table public.call_sessions add column if not exists client_attempt_id text;
alter table public.call_sessions add column if not exists access_grant_id text references public.call_access_grants(id);
create unique index if not exists call_sessions_client_attempt_id_unique
  on public.call_sessions(client_attempt_id) where client_attempt_id is not null;

create table if not exists public.call_trial_eligibility (
  customer_email_normalized text primary key,
  state text not null default 'available' check (state in ('available','reserved','consumed')),
  reserved_session_id uuid references public.call_sessions(id) on delete set null,
  reserved_until timestamptz,
  consumed_session_id uuid references public.call_sessions(id) on delete set null,
  consumed_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((state = 'reserved') = (reserved_session_id is not null)),
  check ((state = 'consumed') = (consumed_session_id is not null))
);
alter table public.call_trial_eligibility enable row level security;
revoke all on public.call_trial_eligibility from public, anon, authenticated;
grant all on public.call_trial_eligibility to service_role;

create or replace function public.reserve_call_trial(
  p_customer_email text,
  p_session_id uuid
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(trim(coalesce(p_customer_email, '')));
  v_trial public.call_trial_eligibility;
  v_grant_id text;
  v_plan_id text;
  v_plan_name text;
  v_duration integer;
begin
  if v_email = '' or length(v_email) > 254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    return jsonb_build_object('allowed', false, 'code', 'INVALID_CUSTOMER_IDENTITY');
  end if;

  insert into public.call_trial_eligibility(customer_email_normalized, state)
    values (v_email, 'available') on conflict (customer_email_normalized) do nothing;
  select * into v_trial from public.call_trial_eligibility where customer_email_normalized = v_email for update;
  if not exists (select 1 from public.call_sessions s where s.id = p_session_id
      and lower(trim(s.visitor_email)) = v_email and s.status = 'connecting') then
    return jsonb_build_object('allowed', false, 'code', 'INVALID_CALL_SESSION');
  end if;
  if v_trial.state = 'reserved' and v_trial.reserved_until > now() and v_trial.reserved_session_id <> p_session_id then
    return jsonb_build_object('allowed', false, 'code', 'FREE_TRIAL_IN_PROGRESS');
  end if;

  select g.id, g.plan_id, p.display_name, p.session_duration_minutes
    into v_grant_id, v_plan_id, v_plan_name, v_duration
    from public.call_access_grants g join public.subscription_plans p on p.id = g.plan_id and p.is_active
    where g.customer_email_normalized = v_email and g.status = 'active' and g.consumed_by_session_id is null
    order by g.granted_at limit 1 for update of g skip locked;
  if v_grant_id is not null then
    update public.call_access_grants set consumed_by_session_id = p_session_id::text, consumed_at = now() where id = v_grant_id;
    update public.call_sessions set access_grant_id = v_grant_id where id = p_session_id;
    if v_trial.state = 'available' then
      update public.call_trial_eligibility set state = 'reserved', reserved_session_id = p_session_id,
        reserved_until = now() + interval '10 minutes', updated_at = now()
        where customer_email_normalized = v_email;
    end if;
    return jsonb_build_object('allowed', true, 'kind', 'paid', 'grantId', v_grant_id,
      'planId', v_plan_id, 'planName', v_plan_name, 'sessionDurationMinutes', v_duration);
  end if;

  if v_trial.state = 'consumed' then return jsonb_build_object('allowed', false, 'code', 'FREE_TRIAL_EXHAUSTED'); end if;

  update public.call_trial_eligibility set state = 'reserved', reserved_session_id = p_session_id,
    reserved_until = now() + interval '10 minutes', consumed_session_id = null, consumed_at = null, updated_at = now()
    where customer_email_normalized = v_email;
  return jsonb_build_object('allowed', true, 'kind', 'free_trial');
end;
$$;
revoke all on function public.reserve_call_trial(text,uuid) from public, anon, authenticated;
grant execute on function public.reserve_call_trial(text,uuid) to service_role;

create or replace function public.transition_call_session(
  p_session_id uuid,
  p_status text,
  p_ended_at timestamptz default null,
  p_duration_seconds integer default null,
  p_failure_code text default null
)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_session public.call_sessions;
  v_allowed boolean := false;
begin
  select * into v_session from public.call_sessions where id = p_session_id for update;
  if not found then return false; end if;
  if v_session.status = p_status then return true; end if;

  v_allowed := case v_session.status
    when 'connecting' then p_status in ('ringing','active','ended','cancelled','failed','declined','no_answer')
    when 'ringing' then p_status in ('active','ended','cancelled','failed','declined','no_answer')
    when 'active' then p_status in ('ended','failed')
    else false end;
  if not v_allowed then return false; end if;
  if p_status not in ('connecting','ringing','active','ended','cancelled','failed','declined','no_answer') then return false; end if;

  update public.call_sessions set status = p_status,
    connected_at = case when p_status = 'active' then coalesce(connected_at, now()) else connected_at end,
    ended_at = case when p_status in ('ended','cancelled','failed','declined','no_answer') then coalesce(p_ended_at, now()) else ended_at end,
    duration_seconds = case when p_status in ('ended','cancelled','failed','declined','no_answer') then p_duration_seconds else duration_seconds end,
    failure_code = case when p_failure_code is not null then left(p_failure_code, 80) else failure_code end
    where id = p_session_id returning * into v_session;

  if p_status = 'active' and v_session.access_grant_id is null then
    update public.call_trial_eligibility set state = 'consumed', consumed_session_id = p_session_id,
      consumed_at = now(), reserved_session_id = null, reserved_until = null, updated_at = now()
      where customer_email_normalized = lower(trim(v_session.visitor_email))
        and state = 'reserved' and reserved_session_id = p_session_id;
    if v_session.access_grant_id is null and not found then
      if not exists (select 1 from public.call_trial_eligibility where customer_email_normalized = lower(trim(v_session.visitor_email))
          and state = 'consumed' and consumed_session_id = p_session_id) then
        raise exception 'call trial reservation unavailable';
      end if;
    end if;
  elsif p_status = 'active' and v_session.access_grant_id is not null then
    update public.call_trial_eligibility set state = 'available', reserved_session_id = null,
      reserved_until = null, updated_at = now()
      where customer_email_normalized = lower(trim(v_session.visitor_email))
        and state = 'reserved' and reserved_session_id = p_session_id;
  elsif p_status in ('ended','cancelled','failed','declined','no_answer') and v_session.connected_at is null then
    update public.call_trial_eligibility set state = 'available', reserved_session_id = null,
      reserved_until = null, updated_at = now()
      where customer_email_normalized = lower(trim(v_session.visitor_email))
        and state = 'reserved' and reserved_session_id = p_session_id;
    update public.call_access_grants set consumed_by_session_id = null, consumed_at = null
      where consumed_by_session_id = p_session_id::text and id = v_session.access_grant_id;
  end if;
  return true;
end;
$$;
revoke all on function public.transition_call_session(uuid,text,timestamptz,integer,text) from public, anon, authenticated;
grant execute on function public.transition_call_session(uuid,text,timestamptz,integer,text) to service_role;
