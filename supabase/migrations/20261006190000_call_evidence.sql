create table if not exists public.call_evidence (
  id uuid primary key default gen_random_uuid(),
  call_session_id text not null unique,
  caller_name text not null,
  caller_email text not null,
  host_id uuid not null references public.hosts(id),
  host_name text not null,
  package_id text,
  package_name text,
  plan_type text not null default 'free_trial' check (plan_type in ('free_trial','plus','pro','subscription')),
  call_type text not null check (call_type = 'video'),
  consent_at timestamptz,
  session_started_at timestamptz not null,
  answered_at timestamptz not null,
  captured_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  call_status text not null default 'active',
  termination_reason text,
  evidence_status text not null default 'pending' check (evidence_status in ('pending','ready','failed')),
  image_path text,
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  failure_reason text,
  capture_token_hash text not null,
  created_at timestamptz not null default now()
);
alter table public.call_evidence add column if not exists package_id text;
alter table public.call_evidence add column if not exists package_name text;
alter table public.call_evidence add column if not exists plan_type text not null default 'free_trial';
alter table public.call_evidence add column if not exists width integer;
alter table public.call_evidence add column if not exists height integer;
create index if not exists call_evidence_host_created_idx on public.call_evidence(host_id, created_at desc);
alter table public.call_evidence enable row level security;
create policy "admins read call evidence" on public.call_evidence for select using (public.is_admin());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('call-evidence', 'call-evidence', false, 2097152, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = 2097152, allowed_mime_types = array['image/jpeg'];
create policy "admins read call evidence files" on storage.objects for select to authenticated
  using (bucket_id = 'call-evidence' and public.is_admin());
