-- migrations/005_workspace_status.sql
--
-- PolicyEngine carried a commented-out workspace check:
--
--     // 3. Workspace Active (Mock check for now)
--     // if (workspace.status !== 'active') reasons.push("Workspace is inactive.");
--
-- There was no status column to check, so account suspension could not be
-- enforced at all: a suspended or non-paying workspace kept generating.
--
-- Apply after 004. Safe to re-run.

alter table workspaces add column if not exists status text not null default 'active';

-- 'active' | 'suspended' | 'closed'
create index if not exists workspaces_owner_status_idx on workspaces (owner_id, status);
