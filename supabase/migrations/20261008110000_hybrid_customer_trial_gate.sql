-- Backfill successful historical free calls into the authoritative eligibility ledger.
insert into public.call_trial_eligibility (
  customer_email_normalized, state, consumed_session_id, consumed_at, updated_at
)
select distinct on (lower(trim(s.visitor_email)))
  lower(trim(s.visitor_email)), 'consumed', s.id, s.connected_at, now()
from public.call_sessions s
where s.connected_at is not null and s.access_grant_id is null
  and lower(trim(s.visitor_email)) <> ''
order by lower(trim(s.visitor_email)), s.connected_at asc
on conflict (customer_email_normalized) do update
set state = 'consumed',
    consumed_session_id = excluded.consumed_session_id,
    consumed_at = excluded.consumed_at,
    reserved_session_id = null,
    reserved_until = null,
    updated_at = now()
where public.call_trial_eligibility.state <> 'consumed';

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
  v_previous_free_session uuid;
  v_previous_free_at timestamptz;
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

  select s.id, s.connected_at into v_previous_free_session, v_previous_free_at
  from public.call_sessions s
  where lower(trim(s.visitor_email)) = v_email and s.connected_at is not null
    and s.access_grant_id is null and s.id <> p_session_id
  order by s.connected_at asc limit 1;
  if v_previous_free_session is not null then
    update public.call_trial_eligibility set state = 'consumed', consumed_session_id = v_previous_free_session,
      consumed_at = v_previous_free_at, reserved_session_id = null, reserved_until = null, updated_at = now()
      where customer_email_normalized = v_email;
    return jsonb_build_object('allowed', false, 'code', 'FREE_TRIAL_EXHAUSTED');
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
