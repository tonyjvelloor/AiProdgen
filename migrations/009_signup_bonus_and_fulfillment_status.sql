-- migrations/009_signup_bonus_and_fulfillment_status.sql
--
-- 1. Database-level unique constraint to enforce one-time signup bonus per user.
-- Eliminates duplicate bonus credit grants under concurrent signups or activations.
-- Clean up any existing duplicate bonus records first to prevent ERROR 23505.
delete from credit_transactions a
where type = 'credit' and source = 'bonus' and reference_id is not null
  and exists (
    select 1 from credit_transactions b
    where b.type = 'credit' and b.source = 'bonus' and b.reference_id = a.reference_id
      and b.user_id = a.user_id
      and (b.created_at < a.created_at or (b.created_at = a.created_at and b.id < a.id))
  );

create unique index if not exists credit_transactions_bonus_uniq 
on credit_transactions (user_id, reference_id) 
where type = 'credit' and source = 'bonus' and reference_id is not null;

-- 2. Add fulfillment_status to payments table to separate financial capture status ('captured')
-- from product fulfillment state ('pending', 'fulfilled').
alter table payments add column if not exists fulfillment_status text default 'pending';
create index if not exists payments_fulfillment_status_idx on payments (fulfillment_status);

-- Backfill existing payments: any captured payment prior to this migration is treated as fulfilled
update payments set fulfillment_status = 'fulfilled' where fulfillment_status = 'pending' and status = 'captured';
