-- Cross-device customer support and subscription recovery.
-- Customer access requires a verified Supabase email session. Admin access is
-- governed by public.is_admin(); no service-role key is shipped to the app.

create table if not exists public.subscription_plans (
  id text primary key check (id in ('regular', 'premium', 'gold')),
  display_name text not null,
  price_usd_cents integer not null check (price_usd_cents >= 0),
  session_duration_minutes integer not null check (session_duration_minutes > 0),
  support_priority text not null default 'standard' check (support_priority in ('standard', 'priority', 'highest')),
  description text not null default '',
  features jsonb not null default '[]'::jsonb check (jsonb_typeof(features) = 'array'),
  is_active boolean not null default true,
  is_most_popular boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists subscription_plans_one_popular
  on public.subscription_plans (is_most_popular) where is_most_popular;

insert into public.subscription_plans
  (id, display_name, price_usd_cents, session_duration_minutes, support_priority, description, features, is_active, is_most_popular)
values
  ('regular', 'Regular', 1900, 15, 'standard', 'A simple way to enjoy a focused CallaStar session.',
   '["Stable calls, subject to your network and device", "Uninterrupted sessions when connection conditions allow", "Secure conversations with built-in protections", "HD video and audio where your device and connection support it", "Free meet-and-greet pass included with every package", "One-time access with no recurring billing", "Up to 15 minutes per supported session"]'::jsonb, true, false),
  ('premium', 'Premium', 3900, 30, 'priority', 'More time to enjoy your CallaStar sessions.',
   '["Stable calls, subject to your network and device", "Uninterrupted sessions when connection conditions allow", "Secure conversations with built-in protections", "HD video and audio where your device and connection support it", "Free meet-and-greet pass included with every package", "One-time access with no recurring billing", "Up to 30 minutes per supported session"]'::jsonb, true, true),
  ('gold', 'Gold Access', 6900, 60, 'highest', 'The longest session option for an unhurried experience.',
   '["Stable calls, subject to your network and device", "Uninterrupted sessions when connection conditions allow", "Secure conversations with built-in protections", "HD video and audio where your device and connection support it", "Free meet-and-greet pass included with every package", "One-time access with no recurring billing", "Up to 60 minutes per supported session"]'::jsonb, true, false)
on conflict (id) do nothing;

update public.subscription_plans
set features = features || '["Free meet-and-greet pass included with every package"]'::jsonb
where not features @> '["Free meet-and-greet pass included with every package"]'::jsonb;

create table if not exists public.subscription_requests (
  id text primary key,
  reference text not null unique,
  session_id text not null,
  profile_id text not null,
  profile_name text not null,
  customer_email text not null,
  customer_email_normalized text not null,
  plan_id text not null references public.subscription_plans(id),
  plan_name_snapshot text not null,
  amount_usd_cents integer not null check (amount_usd_cents >= 0),
  channel text not null check (channel in ('whatsapp', 'in_app')),
  status text not null default 'awaiting_payment' check (status in ('awaiting_payment', 'proof_submitted', 'reviewing', 'confirmed', 'needs_attention', 'cancelled')),
  conversation_id text,
  proof_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz
);
create index if not exists subscription_requests_email_created_idx
  on public.subscription_requests(customer_email_normalized, created_at desc);
create index if not exists subscription_requests_profile_created_idx
  on public.subscription_requests(profile_id, created_at desc);
create index if not exists subscription_requests_status_idx
  on public.subscription_requests(status);
create index if not exists subscription_requests_session_idx
  on public.subscription_requests(session_id);

create table if not exists public.call_access_grants (
  id text primary key,
  session_id text not null,
  request_id text not null unique references public.subscription_requests(id) on delete cascade,
  plan_id text not null references public.subscription_plans(id),
  customer_email_normalized text not null,
  consumed_by_session_id text,
  consumed_at timestamptz,
  status text not null default 'active' check (status in ('active', 'revoked')),
  granted_at timestamptz not null default now()
);
create index if not exists call_access_grants_email_idx on public.call_access_grants(customer_email_normalized, granted_at);

create table if not exists public.support_conversations (
  id text primary key,
  customer_email text not null,
  customer_email_normalized text not null,
  customer_name text not null default '',
  subject text not null,
  status text not null default 'open' check (status in ('open', 'pending', 'resolved')),
  subscription_request_id text references public.subscription_requests(id) on delete set null,
  package_brief_seen_at timestamptz,
  checkout_draft jsonb,
  last_message_preview text not null default '',
  last_message_at timestamptz not null default now(),
  last_message_sender text not null default 'customer' check (last_message_sender in ('customer', 'admin', 'assistant')),
  unread_for_admin integer not null default 0 check (unread_for_admin >= 0),
  unread_for_customer integer not null default 0 check (unread_for_customer >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists support_conversations_email_idx on public.support_conversations(customer_email_normalized, last_message_at desc);
create index if not exists support_conversations_status_idx on public.support_conversations(status, last_message_at desc);
create index if not exists support_conversations_request_idx on public.support_conversations(subscription_request_id);

create table if not exists public.support_messages (
  id text primary key,
  conversation_id text not null references public.support_conversations(id) on delete cascade,
  sender text not null check (sender in ('customer', 'admin', 'assistant')),
  body text not null default '',
  attachment_id text,
  reply_to_message_id text references public.support_messages(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists support_messages_conversation_created_idx on public.support_messages(conversation_id, created_at);

create table if not exists public.support_assets (
  id text primary key,
  conversation_id text not null references public.support_conversations(id) on delete cascade,
  message_id text not null references public.support_messages(id) on delete cascade,
  file_name text not null,
  mime_type text not null,
  file_size bigint not null check (file_size >= 0),
  width integer,
  height integer,
  storage_path text not null unique,
  created_at timestamptz not null default now()
);
create index if not exists support_assets_conversation_idx on public.support_assets(conversation_id);

alter table public.subscription_plans enable row level security;
alter table public.subscription_requests enable row level security;
alter table public.call_access_grants enable row level security;
alter table public.support_conversations enable row level security;
alter table public.support_messages enable row level security;
alter table public.support_assets enable row level security;

create policy "customers and admins read available plans" on public.subscription_plans
  for select to anon, authenticated using (is_active or public.is_admin());
create policy "admins manage plans" on public.subscription_plans
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "customers and admins read requests" on public.subscription_requests
  for select to authenticated using (
    public.is_admin() or customer_email_normalized = lower(auth.jwt() ->> 'email')
  );
create policy "customers create own requests" on public.subscription_requests
  for insert to authenticated with check (
    customer_email_normalized = lower(auth.jwt() ->> 'email') and status = 'awaiting_payment'
  );
create policy "admins manage requests" on public.subscription_requests
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "customers and admins read grants" on public.call_access_grants
  for select to authenticated using (
    public.is_admin() or customer_email_normalized = lower(auth.jwt() ->> 'email')
  );

create policy "customers and admins read conversations" on public.support_conversations
  for select to authenticated using (
    public.is_admin() or customer_email_normalized = lower(auth.jwt() ->> 'email')
  );
create policy "customers create own conversations" on public.support_conversations
  for insert to authenticated with check (
    customer_email_normalized = lower(auth.jwt() ->> 'email')
  );
create policy "customers and admins update own conversations" on public.support_conversations
  for update to authenticated using (
    public.is_admin() or customer_email_normalized = lower(auth.jwt() ->> 'email')
  ) with check (
    public.is_admin() or customer_email_normalized = lower(auth.jwt() ->> 'email')
  );

create policy "conversation members read messages" on public.support_messages
  for select to authenticated using (
    public.is_admin() or exists (
      select 1 from public.support_conversations c
      where c.id = conversation_id and c.customer_email_normalized = lower(auth.jwt() ->> 'email')
    )
  );
create policy "conversation members send messages" on public.support_messages
  for insert to authenticated with check (
    (public.is_admin() and sender = 'admin') or
    (sender in ('customer', 'assistant') and exists (
      select 1 from public.support_conversations c
      where c.id = conversation_id and c.customer_email_normalized = lower(auth.jwt() ->> 'email')
    ))
  );

create policy "conversation members read attachment metadata" on public.support_assets
  for select to authenticated using (
    public.is_admin() or exists (
      select 1 from public.support_conversations c
      where c.id = conversation_id and c.customer_email_normalized = lower(auth.jwt() ->> 'email')
    )
  );
create policy "conversation members add attachment metadata" on public.support_assets
  for insert to authenticated with check (
    (public.is_admin()) or exists (
      select 1 from public.support_conversations c
      where c.id = conversation_id and c.customer_email_normalized = lower(auth.jwt() ->> 'email')
    )
  );

create or replace function public.confirm_subscription_request(p_request_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.subscription_requests;
  v_grant public.call_access_grants;
begin
  if not public.is_admin() then raise exception 'admin access required'; end if;
  select * into v_request from public.subscription_requests where id = p_request_id for update;
  if not found then raise exception 'subscription request not found'; end if;
  update public.subscription_requests
    set status = 'confirmed', confirmed_at = coalesce(confirmed_at, now()), updated_at = now()
    where id = p_request_id returning * into v_request;
  insert into public.call_access_grants(id, session_id, request_id, plan_id, customer_email_normalized, granted_at)
    values (gen_random_uuid()::text, v_request.session_id, v_request.id, v_request.plan_id, v_request.customer_email_normalized, now())
    on conflict (request_id) do nothing;
  select * into v_grant from public.call_access_grants where request_id = p_request_id;
  return jsonb_build_object('request', to_jsonb(v_request), 'grant', to_jsonb(v_grant));
end;
$$;
revoke all on function public.confirm_subscription_request(text) from public;
grant execute on function public.confirm_subscription_request(text) to authenticated;

create or replace function public.claim_call_access(p_session_id text)
returns setof public.call_access_grants
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_grant public.call_access_grants;
begin
  if v_email is null then raise exception 'verified email sign-in required'; end if;
  select * into v_grant from public.call_access_grants
    where status = 'active' and consumed_by_session_id = p_session_id
      and customer_email_normalized = v_email limit 1;
  if found then return next v_grant; return; end if;
  select * into v_grant from public.call_access_grants
    where status = 'active' and consumed_by_session_id is null
      and customer_email_normalized = v_email
    order by granted_at for update skip locked limit 1;
  if not found then return; end if;
  update public.call_access_grants set consumed_by_session_id = p_session_id, consumed_at = now()
    where id = v_grant.id returning * into v_grant;
  return next v_grant;
end;
$$;
revoke all on function public.claim_call_access(text) from public;
grant execute on function public.claim_call_access(text) to authenticated;

insert into storage.buckets (id, name, public)
values ('support-attachments', 'support-attachments', false)
on conflict (id) do update set public = false;

create policy "admins read support attachments" on storage.objects
  for select to authenticated using (bucket_id = 'support-attachments' and public.is_admin());
create policy "customers read own support attachments" on storage.objects
  for select to authenticated using (
    bucket_id = 'support-attachments' and exists (
      select 1 from public.support_conversations c
      where c.id = (storage.foldername(name))[1]
        and c.customer_email_normalized = lower(auth.jwt() ->> 'email')
    )
  );
create policy "conversation members add support attachments" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'support-attachments' and (
      public.is_admin() or exists (
        select 1 from public.support_conversations c
        where c.id = (storage.foldername(name))[1]
          and c.customer_email_normalized = lower(auth.jwt() ->> 'email')
      )
    )
  );
