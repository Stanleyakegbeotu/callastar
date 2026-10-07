-- Incremental backend foundation. Existing hosts/plans/calls/chat tables remain
-- authoritative; this migration only adds missing columns and operational tables.

alter table public.hosts add column if not exists base_follower_count bigint not null default 0;
alter table public.hosts add column if not exists base_like_count bigint not null default 0;
alter table public.hosts add column if not exists tracked_follower_count bigint not null default 0;
alter table public.hosts add column if not exists tracked_like_count bigint not null default 0;
alter table public.hosts add column if not exists cover_path text;
alter table public.hosts add column if not exists remote_audio_path text;
alter table public.hosts add column if not exists remote_video_asset_id text;
alter table public.hosts add column if not exists remote_audio_asset_id text;
alter table public.call_ids add column if not exists code_ciphertext text;

alter table public.host_media drop constraint if exists host_media_kind_check;
alter table public.host_media add constraint host_media_kind_check check (kind in ('remote_video','remote_audio','poster'));

create table if not exists public.host_assets (
  id text primary key,
  host_id uuid not null references public.hosts(id) on delete cascade,
  kind text not null check (kind in ('avatar','cover','remote_video','remote_audio')),
  storage_path text not null unique,
  file_name text not null,
  mime_type text not null,
  file_size_bytes bigint not null check (file_size_bytes >= 0),
  duration_seconds numeric,
  width integer,
  height integer,
  has_audio boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.host_assets enable row level security;
create policy "admins manage host assets" on public.host_assets for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

alter table public.call_sessions add column if not exists connecting_at timestamptz;
alter table public.call_sessions add column if not exists ringing_at timestamptz;
alter table public.call_sessions add column if not exists duration_seconds integer;
alter table public.call_sessions add column if not exists failure_code text;
alter table public.call_sessions add column if not exists source_kind text;
alter table public.call_sessions add column if not exists call_id_snapshot text;
alter table public.call_sessions add column if not exists profile_name_snapshot text;
alter table public.call_sessions drop constraint if exists call_sessions_status_check;
alter table public.call_sessions add constraint call_sessions_status_check
  check (status in ('connecting','ringing','active','ended','failed','cancelled','declined','no_answer'));

create table if not exists public.profile_engagement (
  host_id uuid not null references public.hosts(id) on delete cascade,
  customer_email_normalized text not null,
  following boolean not null default false,
  liked boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key(host_id, customer_email_normalized)
);
alter table public.profile_engagement enable row level security;
create policy "admins manage profile engagement" on public.profile_engagement for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create or replace function public.callastar_track_profile_engagement()
returns trigger language plpgsql security definer set search_path = public as $$
declare follower_delta integer := 0; like_delta integer := 0;
begin
  if tg_op = 'INSERT' then
    follower_delta := new.following::integer; like_delta := new.liked::integer;
  else
    follower_delta := new.following::integer - old.following::integer;
    like_delta := new.liked::integer - old.liked::integer;
  end if;
  update public.hosts set tracked_follower_count = greatest(0, tracked_follower_count + follower_delta),
    tracked_like_count = greatest(0, tracked_like_count + like_delta) where id = new.host_id;
  return new;
end $$;
create trigger profile_engagement_counts after insert or update of following, liked on public.profile_engagement
  for each row execute function public.callastar_track_profile_engagement();

create table if not exists public.app_settings (
  key text primary key check (key = 'global'),
  whatsapp_support_number text,
  whatsapp_support_number_display text,
  formspree_endpoint text,
  updated_at timestamptz not null default now()
);
insert into public.app_settings(key, whatsapp_support_number, whatsapp_support_number_display)
values ('global', '14062813342', '+1 (406) 281-3342')
on conflict (key) do nothing;
alter table public.app_settings enable row level security;
create policy "admins manage app settings" on public.app_settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create table if not exists public.admin_notifications (
  id uuid primary key default gen_random_uuid(),
  notification_type text not null,
  title text not null,
  body text not null default '',
  entity_kind text not null check (entity_kind in ('subscription_request','support_conversation','call_session','call_evidence','system')),
  entity_id text not null,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists admin_notifications_unread_created_idx
  on public.admin_notifications(created_at desc) where read_at is null;
alter table public.admin_notifications enable row level security;
create policy "admins read notifications" on public.admin_notifications for select to authenticated using (public.is_admin());
create policy "admins update notifications" on public.admin_notifications for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "admins manage call sessions" on public.call_sessions for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins append call events" on public.call_events for insert to authenticated with check (public.is_admin());

create table if not exists public.admin_notification_events (
  idempotency_key text primary key,
  event_type text not null,
  entity_id text not null,
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.admin_notification_events enable row level security;

create table if not exists public.admin_notification_rate_limits (
  rate_key text primary key,
  window_start timestamptz not null,
  request_count integer not null default 0
);
alter table public.admin_notification_rate_limits enable row level security;
create or replace function public.callastar_take_notification_rate_limit(p_rate_key text)
returns boolean language plpgsql security definer set search_path = public as $$
declare allowed boolean;
begin
  insert into public.admin_notification_rate_limits(rate_key, window_start, request_count)
    values (p_rate_key, date_trunc('minute', now()), 1)
    on conflict (rate_key) do update set
      request_count = case when admin_notification_rate_limits.window_start < date_trunc('minute', now()) then 1 else admin_notification_rate_limits.request_count + 1 end,
      window_start = case when admin_notification_rate_limits.window_start < date_trunc('minute', now()) then date_trunc('minute', now()) else admin_notification_rate_limits.window_start end;
  select request_count <= 12 into allowed from public.admin_notification_rate_limits where rate_key = p_rate_key;
  return coalesce(allowed, false);
end $$;
revoke all on function public.callastar_take_notification_rate_limit(text) from public, anon, authenticated;
grant execute on function public.callastar_take_notification_rate_limit(text) to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('host-call-media', 'host-call-media', false, 104857600, array['video/mp4','video/webm','audio/mpeg','audio/aac','audio/mp4','audio/wav','audio/ogg','audio/webm'])
on conflict (id) do update set public = false;
