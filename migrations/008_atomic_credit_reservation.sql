-- migrations/008_atomic_credit_reservation.sql
--
-- Atomic credit reservation with row-locking to eliminate race conditions
-- and prevent credit overspending under concurrent requests.
-- Apply after 007. Safe to re-run.

create or replace function reserve_credits(p_user_id uuid, p_amount integer, p_reference_id text default null)
returns boolean
language plpgsql
as $$
declare
    v_balance integer;
begin
    -- 1. Idempotency check: if this reservation already exists for this reference_id, do not charge twice
    if p_reference_id is not null and exists (
        select 1 from credit_transactions 
        where user_id = p_user_id and reference_id = p_reference_id and type = 'reservation'
    ) then
        return true;
    end if;

    -- 2. Lock the user's row in users table to serialize concurrent reservation requests
    perform 1 from users where id = p_user_id for update;

    -- 3. Calculate true balance under the row lock
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
end;
$$;
