-- migrations/008_atomic_credit_reservation.sql
--
-- Concurrency-safe atomic credit reservation and financial idempotency enforcement.
-- Eliminates double-debits, double-grants, and race conditions under concurrent requests.
-- Apply in Supabase SQL Editor. Safe to re-run.

-- 1. Database-level partial unique indexes to strictly enforce idempotency
-- No duplicate reservation for the same reference_id can ever be inserted
create unique index if not exists credit_transactions_reservation_uniq 
on credit_transactions (user_id, reference_id) 
where type = 'reservation' and reference_id is not null;

-- No duplicate credit grant for the same payment/reference can ever be inserted
create unique index if not exists credit_transactions_grant_uniq 
on credit_transactions (reference_id, type) 
where type = 'credit' and reference_id is not null;

-- No duplicate credit refund for the same payment/reference can ever be inserted
create unique index if not exists credit_transactions_refund_uniq 
on credit_transactions (reference_id, type) 
where type = 'refund' and reference_id is not null;

-- 2. Concurrency-safe atomic reservation function
create or replace function reserve_credits(p_user_id uuid, p_amount integer, p_reference_id text default null)
returns boolean
language plpgsql
as $$
declare
    v_balance integer;
begin
    -- Sanity validations
    if p_user_id is null or p_amount is null or p_amount <= 0 then
        return false;
    end if;

    -- 1. FIRST: Acquire user row lock to serialize all concurrent operations for this user
    perform 1 from users where id = p_user_id for update;
    if not found then
        return false;
    end if;

    -- 2. SECOND: Under the row lock, check idempotency.
    -- If this reference_id was already reserved, return true immediately without double-debiting.
    if p_reference_id is not null and exists (
        select 1 from credit_transactions 
        where user_id = p_user_id and reference_id = p_reference_id and type = 'reservation'
    ) then
        return true;
    end if;

    -- 3. Calculate true ledger balance under the row lock
    select coalesce(sum(amount), 0) into v_balance
    from credit_transactions
    where user_id = p_user_id;

    -- 4. Check if sufficient balance is available
    if v_balance < p_amount then
        return false;
    end if;

    -- 5. Atomically insert reservation debit
    insert into credit_transactions (user_id, type, amount, balance_after, source, reference_id)
    values (p_user_id, 'reservation', -p_amount, v_balance - p_amount, 'reserve', p_reference_id);

    return true;
exception
    -- Idempotent catch if concurrent race hits the unique index
    when unique_violation then
        return true;
end;
$$;
