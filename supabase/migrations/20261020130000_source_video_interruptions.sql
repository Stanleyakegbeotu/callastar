-- Call presentation timelines belong to one immutable host video asset.
-- Replacing a file creates a new host_assets row, so old markers cannot leak.
alter table public.host_assets
  add column if not exists interruptions jsonb not null default '[]'::jsonb;

alter table public.host_assets
  drop constraint if exists host_assets_interruptions_array_check;
alter table public.host_assets
  add constraint host_assets_interruptions_array_check
  check (jsonb_typeof(interruptions) = 'array');
