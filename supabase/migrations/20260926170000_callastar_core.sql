-- CallaStar's additive production data layer. Never stores plaintext Call IDs
-- or caller session tokens. Apply with `supabase db push` only after linking
-- and reviewing the target project.

create extension if not exists pgcrypto;

create or replace function public.callastar_set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$ begin new.updated_at = now(); return new; end; $$;

create table if not exists public.admin_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select exists (select 1 from public.admin_profiles where user_id = auth.uid()); $$;

create table if not exists public.hosts (
  id uuid primary key default gen_random_uuid(),
  display_name text not null check (char_length(trim(display_name)) between 2 and 120),
  short_bio text,
  slug text unique,
  status text not null default 'active' check (status in ('active', 'inactive')),
  avatar_path text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.host_media (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references public.hosts(id) on delete cascade,
  kind text not null check (kind in ('remote_video', 'poster')),
  storage_path text not null,
  mime_type text,
  file_size_bytes bigint check (file_size_bytes is null or file_size_bytes >= 0),
  duration_seconds numeric check (duration_seconds is null or duration_seconds >= 0),
  has_audio boolean not null default true,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists host_media_one_active_remote_video
  on public.host_media(host_id) where kind = 'remote_video' and is_active;

create table if not exists public.call_ids (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references public.hosts(id) on delete cascade,
  code_hash text not null unique,
  code_last4 text not null check (char_length(code_last4) = 4),
  status text not null default 'active' check (status in ('active', 'revoked')),
  expires_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create table if not exists public.call_sessions (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references public.hosts(id),
  call_id_id uuid references public.call_ids(id),
  call_type text not null check (call_type in ('video', 'audio')),
  visitor_name text not null,
  visitor_email text not null,
  visitor_phone text not null,
  session_token_hash text not null,
  status text not null default 'connecting' check (status in ('connecting', 'ringing', 'active', 'ended', 'failed', 'cancelled')),
  error_code text,
  created_at timestamptz not null default now(),
  connected_at timestamptz,
  ended_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.call_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.call_sessions(id) on delete cascade,
  event_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists call_sessions_host_created_idx on public.call_sessions(host_id, created_at desc);
create index if not exists call_events_session_created_idx on public.call_events(session_id, created_at);

create trigger admin_profiles_updated_at before update on public.admin_profiles for each row execute function public.callastar_set_updated_at();
create trigger hosts_updated_at before update on public.hosts for each row execute function public.callastar_set_updated_at();
create trigger host_media_updated_at before update on public.host_media for each row execute function public.callastar_set_updated_at();
create trigger call_sessions_updated_at before update on public.call_sessions for each row execute function public.callastar_set_updated_at();

alter table public.admin_profiles enable row level security;
alter table public.hosts enable row level security;
alter table public.host_media enable row level security;
alter table public.call_ids enable row level security;
alter table public.call_sessions enable row level security;
alter table public.call_events enable row level security;

create policy "admins read own profile" on public.admin_profiles for select using (user_id = auth.uid());
create policy "admins manage hosts" on public.hosts for all using (public.is_admin()) with check (public.is_admin());
create policy "admins manage host media" on public.host_media for all using (public.is_admin()) with check (public.is_admin());
create policy "admins read call ids" on public.call_ids for select using (public.is_admin());
create policy "admins update call ids" on public.call_ids for update using (public.is_admin()) with check (public.is_admin());
create policy "admins delete call ids" on public.call_ids for delete using (public.is_admin());
create policy "admins read sessions" on public.call_sessions for select using (public.is_admin());
create policy "admins read events" on public.call_events for select using (public.is_admin());

insert into storage.buckets (id, name, public) values ('host-avatars', 'host-avatars', false), ('host-call-media', 'host-call-media', false)
on conflict (id) do update set public = false;

create policy "admins manage avatars" on storage.objects for all to authenticated
  using (bucket_id = 'host-avatars' and public.is_admin()) with check (bucket_id = 'host-avatars' and public.is_admin());
create policy "admins manage call media" on storage.objects for all to authenticated
  using (bucket_id = 'host-call-media' and public.is_admin()) with check (bucket_id = 'host-call-media' and public.is_admin());
