-- migrations/006_entitlements.sql
--
-- PLANS in server.js has carried bulk/commercial/watermark/templates flags
-- since the cost-control pass, but nothing ever read them -- no route checks
-- planConfig.bulk or planConfig.commercial anywhere. They were designed for a
-- feature-unlock model that didn't exist yet.
--
-- This table is that model: a feature grant separate from the credit ledger,
-- so "can this user use X" (entitlements) and "who pays for the compute"
-- (credits / BYOK) are no longer the same question. A grant can come from a
-- plan (source='plan', re-derived whenever the plan changes) or a standalone
-- purchase (source='purchase', tied to a payment).
--
-- Apply after 005. Safe to re-run.

create table if not exists entitlements (
    id                  uuid primary key default gen_random_uuid(),
    user_id             uuid not null references users(id) on delete cascade,
    feature             text not null,
    source              text not null default 'plan',      -- 'plan' | 'purchase' | 'trial' | 'admin_grant'
    quantity            integer,                            -- null = unlimited while active
    remaining_quantity  integer,                            -- null = unlimited
    expires_at          timestamptz,                        -- null = never expires
    status              text not null default 'active',     -- 'active' | 'revoked'
    reference_id        text,                                -- plan id or payment id that granted this
    metadata            jsonb not null default '{}'::jsonb,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists entitlements_user_feature_idx on entitlements (user_id, feature);
create index if not exists entitlements_status_idx on entitlements (status);

alter table entitlements enable row level security;

-- Spends `p_amount` from a user's active, quantity-limited grants for a
-- feature. Two concurrent requests against remaining_quantity = 1 must not
-- both succeed: a JS read-then-write can only detect that race after it's
-- already lost, so the decision and the write happen here, in one
-- transaction, with the rows locked (select ... for update) for the
-- duration. Unlimited grants (quantity is null) short-circuit to true
-- without locking or writing anything.
create or replace function consume_entitlement(p_user_id uuid, p_feature text, p_amount integer)
returns boolean
language plpgsql
as $$
declare
    v_has_unlimited boolean;
    v_total_remaining integer;
    v_grant record;
    v_to_spend integer := p_amount;
    v_spend integer;
begin
    select exists(
        select 1 from entitlements
        where user_id = p_user_id and feature = p_feature and status = 'active'
          and (expires_at is null or expires_at > now())
          and quantity is null
    ) into v_has_unlimited;

    if v_has_unlimited then
        return true;
    end if;

    -- Lock every candidate row up front so a second concurrent call blocks
    -- here until this transaction commits, rather than both readers seeing
    -- the same pre-spend remaining_quantity.
    select coalesce(sum(remaining_quantity), 0) into v_total_remaining
    from (
        select remaining_quantity from entitlements
        where user_id = p_user_id and feature = p_feature and status = 'active'
          and (expires_at is null or expires_at > now())
          and quantity is not null and remaining_quantity > 0
        for update
    ) locked_rows;

    if v_total_remaining < p_amount then
        return false;
    end if;

    for v_grant in
        select id, remaining_quantity from entitlements
        where user_id = p_user_id and feature = p_feature and status = 'active'
          and (expires_at is null or expires_at > now())
          and quantity is not null and remaining_quantity > 0
        order by created_at desc
    loop
        exit when v_to_spend <= 0;
        v_spend := least(v_to_spend, v_grant.remaining_quantity);
        update entitlements set remaining_quantity = remaining_quantity - v_spend, updated_at = now()
        where id = v_grant.id;
        v_to_spend := v_to_spend - v_spend;
    end loop;

    return v_to_spend <= 0;
end;
$$;
