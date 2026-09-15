-- migrations/007_referrals_commissions.sql
--
-- Agency Reseller V2, Release D (Partner Program). Two ledgers, deliberately
-- separate from `entitlements` -- a commission is a financial record, not a
-- feature grant (see lib/commissions.js and lib/referrals.js). Neither table
-- is read by any entitlement check; neither entitlement code writes here.
--
-- Apply after 006. Safe to re-run.

alter table users add column if not exists referral_code text unique;
create index if not exists users_referral_code_idx on users (referral_code);

create table if not exists referrals (
    id                  uuid primary key default gen_random_uuid(),
    referrer_user_id    uuid not null references users(id) on delete cascade,
    referred_user_id    uuid not null references users(id) on delete cascade,
    referral_code       text not null,
    attribution_source  text not null default 'link',
    attributed_at       timestamptz not null default now(),
    converted_at        timestamptz,
    status              text not null default 'pending', -- 'pending' | 'converted' | 'expired'
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    -- One referred customer, one partner, for life -- this is what actually
    -- enforces "second partner's later click does not re-attribute" (spec
    -- Test 6), not just application logic.
    unique (referred_user_id)
);
create index if not exists referrals_referrer_idx on referrals (referrer_user_id);
create index if not exists referrals_status_idx on referrals (status);
alter table referrals enable row level security;

create table if not exists commissions (
    id                  uuid primary key default gen_random_uuid(),
    partner_id          uuid not null references users(id) on delete cascade,
    referred_user_id    uuid not null references users(id) on delete cascade,
    payment_id          text not null,
    order_id            text,
    commission_type     text not null,          -- 'initial' | 'recurring'
    commission_rate     numeric not null,
    gross_amount        integer not null,        -- smallest currency unit
    commission_base     integer not null,        -- what the rate applied to (= gross_amount in V1)
    commission_amount   integer not null,        -- smallest currency unit
    currency             text not null default 'USD',
    status              text not null default 'pending', -- 'pending' | 'available' | 'paid' | 'reversed'
    eligible_at         timestamptz not null,     -- created_at + the 30-day hold window
    paid_at             timestamptz,
    payout_reference    text,
    payout_method       text,
    reversed_at          timestamptz,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    -- One commission per payment, ever -- the actual guarantee behind
    -- "duplicate payment -> ONE commission" (spec Test 2), enforced at the
    -- database rather than trusted to application logic alone.
    unique (payment_id)
);
create index if not exists commissions_partner_status_idx on commissions (partner_id, status);
alter table commissions enable row level security;
