-- migrations/002_async_job_ownership.sql
--
-- Video and image generation hand the client a provider job id (a Replicate
-- prediction id, or a Veo operation name) which it then polls. The status
-- routes looked that id up directly against the provider, so any signed-in
-- user holding someone else's id could read their result.
--
-- This records who started each job so the status routes can check.
--
-- Apply after 001. Safe to re-run.

create table if not exists async_jobs (
    external_id text        primary key,   -- Replicate prediction id or Veo operation name
    user_id     uuid        not null references users(id) on delete cascade,
    provider    text        not null,      -- 'replicate' | 'veo'
    kind        text,                      -- 'video' | 'image' | 'ugc_scene'
    created_at  timestamptz not null default now()
);

create index if not exists async_jobs_user_idx on async_jobs (user_id, created_at desc);

alter table async_jobs enable row level security;
