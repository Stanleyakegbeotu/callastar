-- Secure the single-admin model and expose a non-identifying first-run check.
-- Keep user_id as the existing auth.users foreign key for compatibility.

alter table public.admin_profiles
  add column if not exists role text not null default 'admin',
  add column if not exists is_active boolean not null default true;

alter table public.admin_profiles
  drop constraint if exists admin_profiles_role_check;
alter table public.admin_profiles
  add constraint admin_profiles_role_check check (role = 'admin');

-- Only one active CallaStar administrator can exist, even if bootstrap calls
-- race or someone bypasses the UI.
create unique index if not exists admin_profiles_single_active_admin
  on public.admin_profiles ((is_active)) where is_active;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admin_profiles
    where user_id = auth.uid() and role = 'admin' and is_active
  );
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated, service_role;

create or replace function public.admin_exists()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admin_profiles where role = 'admin' and is_active
  );
$$;
revoke all on function public.admin_exists() from public;
grant execute on function public.admin_exists() to anon, authenticated;

drop policy if exists "admins read own profile" on public.admin_profiles;
create policy "admins read own profile" on public.admin_profiles
  for select to authenticated
  using (user_id = auth.uid() and role = 'admin' and is_active);

