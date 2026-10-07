-- Recording consent and private media. Only Edge Functions with the service role
-- can create or change records and objects. Admins can read metadata through RLS.
create table if not exists public.call_recordings (
  id uuid primary key default gen_random_uuid(),
  call_session_id text not null,
  user_id uuid references auth.users(id),
  host_id uuid not null references public.hosts(id),
  host_name text not null,
  caller_name text not null,
  caller_email text not null,
  call_type text not null default 'video' check (call_type = 'video'),
  consented_at timestamptz not null,
  consent_version text not null,
  consent_text text not null,
  capture_token_hash text not null,
  started_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  storage_path text,
  mime_type text,
  file_size bigint check (file_size is null or file_size >= 0),
  status text not null default 'pending' check (status in ('pending','recording','processing','ready','failed','deleted')),
  failure_code text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  expires_at timestamptz not null default (now() + interval '30 days')
);
create index if not exists call_recordings_host_created_idx on public.call_recordings(host_id, created_at desc);
create index if not exists call_recordings_expiry_idx on public.call_recordings(expires_at) where status <> 'deleted';
alter table public.call_recordings enable row level security;
create policy "admins read recording metadata" on public.call_recordings for select to authenticated using (public.is_admin());

create table if not exists public.call_recording_audit (
  id uuid primary key default gen_random_uuid(),
  recording_id uuid not null references public.call_recordings(id),
  admin_user_id uuid references auth.users(id),
  action text not null check (action in ('play','delete','expire')),
  created_at timestamptz not null default now()
);
alter table public.call_recording_audit enable row level security;
create policy "admins read recording audit" on public.call_recording_audit for select to authenticated using (public.is_admin());

insert into storage.buckets (id, name, public) values ('call-recordings','call-recordings',false)
on conflict (id) do update set public = false;
-- Deliberately no storage.objects policy: object operations require a short
-- lived signed token issued by our Edge Function or its service role.
