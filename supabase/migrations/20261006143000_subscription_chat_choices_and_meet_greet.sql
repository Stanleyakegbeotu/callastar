-- Persist the subscription decision flow and add its included package benefit.

alter table public.support_conversations
  drop constraint if exists support_conversations_last_message_sender_check;
alter table public.support_conversations
  add constraint support_conversations_last_message_sender_check
  check (last_message_sender in ('customer', 'admin', 'assistant'));

alter table public.support_messages
  drop constraint if exists support_messages_sender_check;
alter table public.support_messages
  add constraint support_messages_sender_check
  check (sender in ('customer', 'admin', 'assistant'));

drop policy if exists "conversation members send messages" on public.support_messages;
create policy "conversation members send messages" on public.support_messages
  for insert to authenticated with check (
    (public.is_admin() and sender = 'admin') or
    (sender in ('customer', 'assistant') and exists (
      select 1 from public.support_conversations c
      where c.id = conversation_id and c.customer_email_normalized = lower(auth.jwt() ->> 'email')
    ))
  );

update public.subscription_plans
set features = features || '["Free meet-and-greet pass included with every package"]'::jsonb
where not features @> '["Free meet-and-greet pass included with every package"]'::jsonb;

create or replace function public.cancel_customer_subscription_request(p_request_id text)
returns public.subscription_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.subscription_requests;
  v_email text := lower(auth.jwt() ->> 'email');
begin
  if v_email is null then raise exception 'verified email sign-in required'; end if;
  select * into v_request from public.subscription_requests
    where id = p_request_id for update;
  if not found or v_request.customer_email_normalized <> v_email then
    raise exception 'subscription request not found';
  end if;
  if v_request.status = 'confirmed' then raise exception 'confirmed requests cannot be changed'; end if;
  if v_request.status <> 'cancelled' then
    update public.subscription_requests
      set status = 'cancelled', updated_at = now()
      where id = p_request_id returning * into v_request;
  end if;
  return v_request;
end;
$$;
revoke all on function public.cancel_customer_subscription_request(text) from public;
grant execute on function public.cancel_customer_subscription_request(text) to authenticated;
