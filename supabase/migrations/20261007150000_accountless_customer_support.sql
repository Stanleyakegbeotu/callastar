-- Public customer support is accountless. Email identifies a thread; it is not
-- proof of ownership. Anonymous access remains behind the scoped Edge Function.
alter table public.support_conversations
  alter column customer_email drop not null,
  alter column customer_email_normalized drop not null,
  add column if not exists customer_phone text not null default '',
  add column if not exists guest_session_id uuid;

create index if not exists support_conversations_guest_session_idx
  on public.support_conversations(guest_session_id, last_message_at desc)
  where guest_session_id is not null;

-- Customer table policies remain authenticated/admin only. The Edge Function
-- uses service_role and checks a customer identity plus conversation scope.

alter table public.call_evidence drop constraint if exists call_evidence_evidence_status_check;
alter table public.call_evidence add constraint call_evidence_evidence_status_check
  check (evidence_status in ('pending','captured','uploading','ready','failed','upload_failed'));

create or replace function public.select_support_payment_method_accountless(
  p_conversation_id text, p_customer_email text, p_guest_session_id uuid,
  p_plan_id text, p_checkout_intent_id text, p_method text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conversation public.support_conversations;
  v_draft jsonb;
  v_label text;
  v_email text := lower(trim(coalesce(p_customer_email, '')));
begin
  v_label := case p_method
    when 'bank_transfer' then 'Bank Transfer' when 'cash_app' then 'Cash App'
    when 'cryptocurrency' then 'Cryptocurrency' when 'gift_cards' then 'Gift Cards'
    when 'paypal' then 'PayPal' else null end;
  if v_label is null then raise exception 'invalid payment method'; end if;
  select * into v_conversation from public.support_conversations
    where id = p_conversation_id and (
      (v_email <> '' and customer_email_normalized = v_email) or
      (v_email = '' and guest_session_id = p_guest_session_id)
    ) for update;
  if not found then raise exception 'conversation is unavailable'; end if;
  v_draft := coalesce(v_conversation.checkout_draft, '{}'::jsonb);
  if v_draft ->> 'planId' is distinct from p_plan_id
    or coalesce(v_draft ->> 'checkoutIntentId', p_conversation_id || ':' || p_plan_id) is distinct from p_checkout_intent_id then return false; end if;
  if v_draft ->> 'selectedPaymentMethod' is not null then return v_draft ->> 'selectedPaymentMethod' = p_method; end if;
  if v_draft ->> 'paymentDecision' is distinct from 'yes'
    or v_draft ->> 'subscriptionFollowupStatus' is distinct from 'awaiting_payment_method' then return false; end if;
  if exists(select 1 from public.support_messages where conversation_id = p_conversation_id and sender = 'admin') then return false; end if;
  insert into public.support_messages(id, conversation_id, sender, body, action_type, action_value, created_at)
    values ('event:' || p_conversation_id || ':payment-method:' || p_checkout_intent_id || ':' || p_method,
      p_conversation_id, 'customer', v_label, 'select_payment_method', p_method, now()) on conflict (id) do nothing;
  update public.support_conversations set checkout_draft = v_draft || jsonb_build_object(
      'checkoutIntentId', p_checkout_intent_id, 'selectedPaymentMethod', p_method, 'subscriptionFollowupStatus', 'payment_method_selected'),
    last_message_preview = v_label, last_message_at = now(), last_message_sender = 'customer',
    unread_for_admin = unread_for_admin + 1, status = 'open', updated_at = now()
    where id = p_conversation_id;
  return true;
end;
$$;
revoke all on function public.select_support_payment_method_accountless(text,text,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.select_support_payment_method_accountless(text,text,uuid,text,text,text) to service_role;
