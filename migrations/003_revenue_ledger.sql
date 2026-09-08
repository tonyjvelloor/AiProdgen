-- migrations/003_revenue_ledger.sql
--
-- There is no record of money received. Razorpay payments are verified and
-- acted on, but nothing is written down, so getAdminStats reported revenue: 0
-- and /api/admin/metrics returned a hardcoded "$29.00" and "82%" margin.
--
-- Without this table, gross margin cannot be computed at all, and the CEO
-- dashboard reports the same healthy numbers whether the business is making
-- money or losing it on every generation.
--
-- Apply after 002. Safe to re-run.

create table if not exists payments (
    razorpay_payment_id text        primary key,
    razorpay_order_id   text,
    user_id             uuid        references users(id) on delete set null,
    email               text,
    kind                text        not null,          -- 'plan' | 'credits'
    plan_id             text,
    credits             integer,
    amount              integer     not null,          -- smallest currency unit
    currency            text        not null default 'INR',
    status              text        not null default 'captured',
    created_at          timestamptz not null default now()
);

create index if not exists payments_created_idx on payments (created_at desc);
create index if not exists payments_user_idx    on payments (user_id, created_at desc);

alter table payments enable row level security;
