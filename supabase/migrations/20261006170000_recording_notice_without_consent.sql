-- Recording now starts automatically after a video call connects. Preserve
-- historical consent evidence, while leaving these fields empty on new rows.
alter table public.call_recordings alter column consented_at drop not null;
alter table public.call_recordings alter column consent_version drop not null;
alter table public.call_recordings alter column consent_text drop not null;
