-- migrations/001_production_readiness.sql
--
-- Backfills the columns and tables the application code expects but that the
-- move to Supabase never created. Until this runs, database.js cannot store a
-- password, persist a paid plan, or record usage.
--
-- Apply in the Supabase SQL editor (Dashboard -> SQL Editor -> New query),
-- then verify with:  node scripts/check_deploy.js
--
-- Safe to re-run.

-- ---------------------------------------------------------------- users
-- The users table shipped with only id / email / created_at /
-- email_verified_at. mapUser() substituted a fake bcrypt hash because there
-- was nowhere to read a real one from, which made login impossible.
alter table users add column if not exists password_hash      text;
alter table users add column if not exists is_active          boolean     not null default true;
alter table users add column if not exists is_admin           boolean     not null default false;
alter table users add column if not exists plan               text        not null default 'free_explorer';
alter table users add column if not exists billing_cycle      text;
alter table users add column if not exists plan_activated_at  timestamptz;
alter table users add column if not exists monthly_gen_count  integer     not null default 0;
alter table users add column if not exists monthly_ugc_count  integer     not null default 0;
alter table users add column if not exists usage_period_start timestamptz not null default date_trunc('month', now());

create index if not exists users_email_idx on users (lower(email));

-- ------------------------------------------------------- pending_orders
-- Razorpay order created -> payment verified. Without this the amount and
-- currency a user was quoted cannot be checked against what they paid.
create table if not exists pending_orders (
    razorpay_order_id text primary key,
    email             text        not null,
    amount            integer     not null,      -- smallest currency unit
    currency          text        not null default 'INR',
    created_at        timestamptz not null default now()
);

create index if not exists pending_orders_email_idx on pending_orders (email);

-- --------------------------------------------------------- ugc_projects
create table if not exists ugc_projects (
    id         uuid        primary key default gen_random_uuid(),
    user_id    uuid        not null references users(id) on delete cascade,
    name       text        not null default 'Untitled Project',
    workflow   jsonb,
    thumbnail  text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists ugc_projects_user_idx on ugc_projects (user_id, created_at desc);

-- -------------------------------------------------------- gallery_items
create table if not exists gallery_items (
    id         uuid        primary key default gen_random_uuid(),
    user_id    uuid        not null references users(id) on delete cascade,
    project_id uuid        references ugc_projects(id) on delete set null,
    type       text,
    url        text        not null,
    prompt     text,
    is_public  boolean     not null default false,
    created_at timestamptz not null default now()
);

create index if not exists gallery_items_user_idx   on gallery_items (user_id, created_at desc);
create index if not exists gallery_items_public_idx on gallery_items (created_at desc) where is_public;

-- -------------------------------------------------------- upscale_usage
create table if not exists upscale_usage (
    id           uuid        primary key default gen_random_uuid(),
    user_id      uuid        not null references users(id) on delete cascade,
    credits      integer     not null default 1,
    scale        integer,
    face_enhance boolean     not null default false,
    created_at   timestamptz not null default now()
);

create index if not exists upscale_usage_user_idx on upscale_usage (user_id, created_at desc);

-- ------------------------------------------------------------------ RLS
-- Every query in this app goes through the service-role key, which bypasses
-- RLS entirely. Enabling it here means that if an anon/publishable key is ever
-- used from the browser, these tables are closed by default rather than open.
alter table pending_orders enable row level security;
alter table ugc_projects   enable row level security;
alter table gallery_items  enable row level security;
alter table upscale_usage  enable row level security;

drop policy if exists gallery_public_read on gallery_items;
create policy gallery_public_read on gallery_items for select using (is_public);
