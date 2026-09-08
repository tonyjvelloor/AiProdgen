-- migrations/004_usage_attribution.sql
--
-- Splits generation into the two funding models the product actually has:
--
--   platform  -- run on the platform's provider key; this is COGS
--   byok      -- run on the customer's own key; costs the platform nothing
--
-- Without this, a BYOK run and an uninstrumented run are indistinguishable:
-- both have a zero provider_cost. Cost coverage cannot be measured, and
-- "cost per generation" is understated by however many runs were customer-funded.
--
-- Apply after 003. Safe to re-run.

alter table ai_runs add column if not exists funded_by text not null default 'platform';

-- Engine attribution for cost-by-engine reporting. `job` already carries this
-- for the V2 engines; the legacy routes will populate it too.
create index if not exists ai_runs_funded_idx on ai_runs (funded_by, started_at desc);
create index if not exists ai_runs_user_started_idx on ai_runs (user_id, started_at desc);
create index if not exists ai_runs_job_idx on ai_runs (job, started_at desc);
