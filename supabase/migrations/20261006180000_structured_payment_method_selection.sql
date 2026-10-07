alter table public.support_messages
  add column if not exists action_type text,
  add column if not exists action_value text;

alter table public.support_messages
  add constraint support_messages_action_type_check
  check (action_type is null or action_type in (
    'select_payment_method',
    'continue_payment_method_selection',
    'payment_method_help'
  ));

alter table public.support_messages
  add constraint support_messages_payment_method_value_check
  check (action_type <> 'select_payment_method' or (action_value is not null and action_value in (
    'bank_transfer', 'cash_app', 'cryptocurrency', 'gift_cards', 'paypal'
  )));

create or replace function public.select_support_payment_method(
  p_conversation_id text,
  p_plan_id text,
  p_checkout_intent_id text,
  p_method text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conversation public.support_conversations;
  v_draft jsonb;
  v_message_id text := 'event:' || p_conversation_id || ':payment-method:' || p_checkout_intent_id;
  v_label text;
  v_email text := lower(auth.jwt() ->> 'email');
begin
  if auth.uid() is null or v_email is null then
    raise exception 'verified email sign-in required';
  end if;

  v_label := case p_method
    when 'bank_transfer' then 'Bank Transfer'
    when 'cash_app' then 'Cash App'
    when 'cryptocurrency' then 'Cryptocurrency'
    when 'gift_cards' then 'Gift Cards'
    when 'paypal' then 'PayPal'
    else null
  end;
  if v_label is null then raise exception 'invalid payment method'; end if;

  select * into v_conversation
    from public.support_conversations
    where id = p_conversation_id
    for update;
  if not found or v_conversation.customer_email_normalized <> v_email then
    raise exception 'conversation is unavailable';
  end if;

  v_draft := coalesce(v_conversation.checkout_draft, '{}'::jsonb);
  if v_draft ->> 'planId' is distinct from p_plan_id
    or coalesce(v_draft ->> 'checkoutIntentId', p_conversation_id || ':' || p_plan_id) is distinct from p_checkout_intent_id then
    return false;
  end if;

  if v_draft ->> 'selectedPaymentMethod' is not null then
    return v_draft ->> 'selectedPaymentMethod' = p_method;
  end if;
  if v_draft ->> 'paymentDecision' is distinct from 'yes'
    or v_draft ->> 'subscriptionFollowupStatus' is distinct from 'awaiting_payment_method' then
    return false;
  end if;
  if exists (
    select 1 from public.support_messages
    where conversation_id = p_conversation_id and sender = 'admin'
  ) then
    return false;
  end if;

  insert into public.support_messages(
    id, conversation_id, sender, body, action_type, action_value, created_at
  ) values (
    v_message_id, p_conversation_id, 'customer', v_label,
    'select_payment_method', p_method, now()
  ) on conflict (id) do nothing;

  update public.support_conversations
    set checkout_draft = v_draft || jsonb_build_object(
          'checkoutIntentId', p_checkout_intent_id,
          'selectedPaymentMethod', p_method,
          'subscriptionFollowupStatus', 'payment_method_selected'
        ),
        last_message_preview = v_label,
        last_message_at = now(),
        last_message_sender = 'customer',
        unread_for_admin = unread_for_admin + 1,
        status = 'open',
        updated_at = now()
    where id = p_conversation_id;

  return true;
end;
$$;

revoke all on function public.select_support_payment_method(text, text, text, text) from public;
grant execute on function public.select_support_payment_method(text, text, text, text) to authenticated;
