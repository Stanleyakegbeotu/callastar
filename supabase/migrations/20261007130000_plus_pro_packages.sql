begin;

do $$
begin
  if exists (select 1 from public.subscription_requests limit 1)
    or exists (select 1 from public.call_access_grants limit 1)
    or exists (select 1 from public.support_conversations limit 1)
    or exists (select 1 from public.call_evidence limit 1) then
    raise exception 'Refusing package ID migration: package-linked production records exist';
  end if;

  if (select count(*) from public.subscription_plans where id in ('regular', 'premium', 'gold')) <> 3 then
    raise exception 'Refusing package ID migration: expected Regular, Premium, and Gold plan configuration';
  end if;
end $$;

alter table public.subscription_plans rename column price_usd_cents to price_minor_units;
alter table public.subscription_requests rename column amount_usd_cents to amount_minor_units;

alter table public.subscription_plans
  add column currency_code text not null default 'USD',
  add column sort_order integer not null default 0;
alter table public.subscription_requests
  add column currency_code text not null default 'USD';

alter table public.subscription_plans
  drop constraint if exists subscription_plans_id_check,
  add constraint subscription_plans_currency_code_valid check (currency_code ~ '^[A-Z]{3}$');
alter table public.subscription_requests
  add constraint subscription_requests_currency_code_valid check (currency_code ~ '^[A-Z]{3}$');

update public.subscription_plans
set id = 'plus', display_name = 'Plus', sort_order = 1, is_most_popular = true, currency_code = 'USD'
where id = 'premium';

update public.subscription_plans
set id = 'pro', display_name = 'Pro', sort_order = 2, is_most_popular = false, currency_code = 'USD'
where id = 'gold';

delete from public.subscription_plans where id = 'regular';

alter table public.subscription_plans
  add constraint subscription_plans_id_allowed check (id in ('plus', 'pro'));

commit;
