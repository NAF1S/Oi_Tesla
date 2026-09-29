-- ---------------------------------------------------------------------------
-- TeslaPay -- the simulated wallet, and paying for a completed ride.
--
-- The product rule this file exists to enforce: a passenger settles a completed
-- journey either from their TeslaPay balance or in cash, and money that moves
-- moves exactly once. Everything below is a constraint, a trigger or an index
-- behind one of those sentences.
--
-- Money is `numeric(14,2)`, like every other amount in this schema. The rule for
-- a balance is that it can never go negative and it can never disagree with the
-- ledger: both are enforced here rather than trusted to the service.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Enums
-- PostgreSQL has no CREATE TYPE IF NOT EXISTS, so this is guarded by catalog.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_method') THEN
    CREATE TYPE payment_method AS ENUM ('TESLA_PAY', 'CASH');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_status') THEN
    -- PENDING: the trip is done and the passenger owes this, but has not chosen.
    -- PAID:    settled, by a named method, at a known instant. Terminal.
    CREATE TYPE payment_status AS ENUM ('PENDING', 'PAID');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'wallet_entry_direction') THEN
    CREATE TYPE wallet_entry_direction AS ENUM ('DEBIT', 'CREDIT');
  END IF;
END $$;

-- The passenger's timeline needs to say that a journey was settled. `ADD VALUE`
-- cannot be used in the same transaction that adds it, so nothing in this file
-- reads this value back -- the service does, later.
ALTER TYPE ride_event_type ADD VALUE IF NOT EXISTS 'RIDE_PAID';

-- ---------------------------------------------------------------------------
-- 2. Wallets -- one per user, passenger or driver
--
-- One table for both roles on purpose: a driver who takes a ride as a passenger
-- is one person with one balance, and the ledger does not care which role an
-- account belongs to. Which side of a payment an account is on is recorded on
-- the payment, not on the wallet.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wallet_accounts (
  id         uuid        NOT NULL DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL,
  currency   varchar(3)  NOT NULL DEFAULT 'BDT',
  balance    numeric(14,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (id),
  CONSTRAINT wallet_accounts_user_key UNIQUE (user_id),
  -- The single most important sentence in this file: a balance cannot be spent
  -- below zero, so an overdraft is refused by the database and not by a check
  -- somewhere in a service that a future caller might forget.
  CONSTRAINT wallet_accounts_balance_not_negative CHECK (balance >= 0),
  CONSTRAINT wallet_accounts_user_fkey FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

COMMENT ON COLUMN wallet_accounts.balance IS
  'Cleared TeslaPay balance. Derived from wallet_ledger and checked against it at commit.';

-- ---------------------------------------------------------------------------
-- 3. Payments -- one per passenger per journey
--
-- A row is created when the trip completes, so the passenger has something to
-- settle and the driver has something owed to them. `UNIQUE (ride_request_id)`
-- is what makes a journey payable exactly once, and is also what makes the
-- creation step safe to repeat.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id                uuid          NOT NULL DEFAULT gen_random_uuid(),
  ride_request_id   uuid          NOT NULL,
  ride_pool_id      uuid          NOT NULL,
  fare_calculation_id uuid        NOT NULL,
  payer_user_id     uuid          NOT NULL,
  driver_user_id    uuid          NOT NULL,
  amount            numeric(14,2) NOT NULL,
  currency          varchar(3)    NOT NULL DEFAULT 'BDT',
  method            payment_method,
  status            payment_status NOT NULL DEFAULT 'PENDING',
  paid_at           timestamptz,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now(),

  PRIMARY KEY (id),
  CONSTRAINT payments_ride_request_key UNIQUE (ride_request_id),
  CONSTRAINT payments_amount_positive CHECK (amount > 0),
  -- A settled payment names how it was settled and when; an unsettled one says
  -- neither. There is no third state where a passenger has half-paid.
  CONSTRAINT payments_lifecycle_consistent CHECK (
    (status = 'PENDING' AND method IS NULL AND paid_at IS NULL)
    OR (status = 'PAID' AND method IS NOT NULL AND paid_at IS NOT NULL)
  ),
  CONSTRAINT payments_ride_request_fkey FOREIGN KEY (ride_request_id)
    REFERENCES ride_requests (id) ON DELETE CASCADE,
  CONSTRAINT payments_ride_pool_fkey FOREIGN KEY (ride_pool_id)
    REFERENCES ride_pools (id) ON DELETE CASCADE,
  CONSTRAINT payments_fare_calculation_fkey FOREIGN KEY (fare_calculation_id)
    REFERENCES pool_fare_calculations (id) ON DELETE CASCADE,
  CONSTRAINT payments_payer_fkey FOREIGN KEY (payer_user_id)
    REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT payments_driver_fkey FOREIGN KEY (driver_user_id)
    REFERENCES users (id) ON DELETE CASCADE
);

-- The passenger's "what do I owe" read and the driver's "what am I owed" read.
CREATE INDEX IF NOT EXISTS payments_payer_status_idx ON payments (payer_user_id, status);
CREATE INDEX IF NOT EXISTS payments_driver_status_idx ON payments (driver_user_id, status);

-- ---------------------------------------------------------------------------
-- 4. The ledger -- append-only, and the reason a balance can be trusted
--
-- Every movement of money is a row here, one DEBIT for the payer and one CREDIT
-- for the driver. `UNIQUE (payment_id, account_id)` is the guarantee that a
-- payment moves money exactly once per account: a double submit cannot produce
-- two debits, whatever the service does.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wallet_ledger (
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  account_id    uuid        NOT NULL,
  payment_id    uuid        NOT NULL,
  direction     wallet_entry_direction NOT NULL,
  amount        numeric(14,2) NOT NULL,
  balance_after numeric(14,2) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (id),
  CONSTRAINT wallet_ledger_amount_positive CHECK (amount > 0),
  CONSTRAINT wallet_ledger_balance_after_not_negative CHECK (balance_after >= 0),
  CONSTRAINT wallet_ledger_once_per_account UNIQUE (payment_id, account_id),
  CONSTRAINT wallet_ledger_account_fkey FOREIGN KEY (account_id)
    REFERENCES wallet_accounts (id) ON DELETE CASCADE,
  CONSTRAINT wallet_ledger_payment_fkey FOREIGN KEY (payment_id)
    REFERENCES payments (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS wallet_ledger_account_created_idx
  ON wallet_ledger (account_id, created_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- 5. The ledger is a record, so it cannot be rewritten
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prevent_wallet_ledger_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'wallet_ledger is append-only'
    USING ERRCODE = '23514';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS prevent_wallet_ledger_update ON wallet_ledger;
CREATE TRIGGER prevent_wallet_ledger_update
  BEFORE UPDATE ON wallet_ledger
  FOR EACH ROW EXECUTE FUNCTION prevent_wallet_ledger_change();

-- ---------------------------------------------------------------------------
-- 6. A payment records what was owed; only the settling may change
--
-- Who owed what to whom is frozen the moment the row is written -- a later
-- repricing cannot reach back and restate a settled debt. The only permitted
-- UPDATE is PENDING -> PAID, which must arrive with a method and an instant.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_payment_update() RETURNS trigger AS $$
BEGIN
  IF NEW.ride_request_id <> OLD.ride_request_id
     OR NEW.ride_pool_id <> OLD.ride_pool_id
     OR NEW.fare_calculation_id <> OLD.fare_calculation_id
     OR NEW.payer_user_id <> OLD.payer_user_id
     OR NEW.driver_user_id <> OLD.driver_user_id
     OR NEW.amount <> OLD.amount
     OR NEW.currency <> OLD.currency
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a payment''s parties and amount are frozen'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'PAID' THEN
    RAISE EXCEPTION 'payment % is already settled', OLD.id
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status <> 'PAID' THEN
    RAISE EXCEPTION 'a payment may only move PENDING -> PAID, not to %', NEW.status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_payment_update ON payments;
CREATE TRIGGER enforce_payment_update
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION enforce_payment_update();

-- ---------------------------------------------------------------------------
-- 7. A balance must equal its ledger
--
-- The strongest guarantee in the file, and the reason `balance` is a cache and
-- not the truth. Deferred to commit, so a transaction may write the ledger and
-- the balance in either order, but the state it commits has to be consistent:
-- no silent drift, and no credit that was never recorded.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_wallet_ledger_balance() RETURNS trigger AS $$
DECLARE
  target   uuid;
  expected numeric(14,2);
  actual   numeric(14,2);
BEGIN
  IF TG_TABLE_NAME = 'wallet_ledger' THEN
    target := COALESCE(NEW.account_id, OLD.account_id);
  ELSE
    target := NEW.id;
  END IF;

  SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)
    INTO expected
    FROM wallet_ledger
   WHERE account_id = target;

  SELECT balance INTO actual FROM wallet_accounts WHERE id = target;

  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'wallet % holds % but its ledger sums to %', target, actual, expected
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wallet_ledger_matches_balance ON wallet_ledger;
CREATE CONSTRAINT TRIGGER wallet_ledger_matches_balance
  AFTER INSERT ON wallet_ledger
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_wallet_ledger_balance();

DROP TRIGGER IF EXISTS wallet_accounts_matches_ledger ON wallet_accounts;
CREATE CONSTRAINT TRIGGER wallet_accounts_matches_ledger
  AFTER UPDATE ON wallet_accounts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_wallet_ledger_balance();

-- ---------------------------------------------------------------------------
-- 8. Every existing account gets a wallet
--
-- Balances start at zero for everybody: this is a simulation of a wallet, not a
-- migration of one. A demo that needs a funded passenger funds them explicitly
-- (see the seed), so nobody is quietly credited by a migration.
-- ---------------------------------------------------------------------------
INSERT INTO wallet_accounts (user_id)
SELECT u.id FROM users u
 WHERE NOT EXISTS (SELECT 1 FROM wallet_accounts w WHERE w.user_id = u.id);

-- ---------------------------------------------------------------------------
-- 9. Convergence: not every movement is a payment
--
-- Section 4 made `payment_id` NOT NULL, which quietly said that money can only
-- enter a wallet by settling a ride. An opening balance (a demo top-up, and
-- anything a real product would call a refund or a payout) is a movement with no
-- payment behind it, and section 7's trigger would refuse a balance that the
-- ledger could not account for. So the column becomes nullable and every entry
-- says why it exists.
--
-- The uniqueness that matters is unchanged: `(payment_id, account_id)` still
-- permits one entry per account per payment, and NULLs do not conflict, so a
-- wallet may take any number of top-ups.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ledger_entry_reason') THEN
    CREATE TYPE ledger_entry_reason AS ENUM ('PAYMENT', 'TOP_UP');
  END IF;
END $$;

ALTER TABLE wallet_ledger ALTER COLUMN payment_id DROP NOT NULL;

ALTER TABLE wallet_ledger
  ADD COLUMN IF NOT EXISTS reason ledger_entry_reason NOT NULL DEFAULT 'PAYMENT';

-- A top-up never names a payment. A payment entry names one -- until the payment
-- it recorded is deleted, which is section 10, and the reason its reference is
-- allowed to be null.
ALTER TABLE wallet_ledger
  DROP CONSTRAINT IF EXISTS wallet_ledger_reason_consistent;

ALTER TABLE wallet_ledger
  ADD CONSTRAINT wallet_ledger_reason_consistent CHECK (
    reason = 'PAYMENT' OR (reason = 'TOP_UP' AND payment_id IS NULL)
  );

-- ---------------------------------------------------------------------------
-- 10. The ledger outlives the payment it recorded
--
-- Section 3 gave `wallet_ledger.payment_id` an ON DELETE CASCADE reference, which
-- reads as tidy and is wrong. A payment is reachable from a ride request
-- (`payments.ride_request_id` cascades too), so deleting a ride deleted the
-- payments and then the ledger entries -- the record of money that had already
-- moved -- while `wallet_accounts.balance` kept the debit or the credit it had
-- been given.
--
-- The two then disagreed for good, and the deferred trigger from section 6
-- (`wallet_accounts_matches_ledger`) refuses to commit a transaction that leaves
-- them disagreeing. So the damage was not confined to the rows that were deleted:
-- every later settlement by that passenger failed, on a balance that no longer had
-- any evidence behind it.
--
-- SET NULL instead. A ledger entry is a fact about a wallet, not a child of the
-- transaction that produced it: the money moved, and the entry stays. `reason`
-- still says a PAYMENT entry came from a settlement even after the payment row it
-- named has gone. The uniqueness that matters -- one entry per payment per account
-- -- is unaffected, because Postgres treats NULLs as distinct.
-- ---------------------------------------------------------------------------

ALTER TABLE wallet_ledger
  DROP CONSTRAINT IF EXISTS wallet_ledger_payment_fkey;

ALTER TABLE wallet_ledger
  ADD CONSTRAINT wallet_ledger_payment_fkey FOREIGN KEY (payment_id)
    REFERENCES payments (id) ON DELETE SET NULL;

-- Section 5's trigger refuses every UPDATE, which is right for the application and
-- wrong for the database's own bookkeeping: `ON DELETE SET NULL` above is performed
-- *as* an update, so deleting a paid-for ride hit the same guard and failed with
-- "wallet_ledger is append-only" -- the fix above turning into a new way to fail.
--
-- The exception below is that one change and nothing else. The entry's account, its
-- direction, its amount, the running balance it recorded and the instant it happened
-- are all still frozen; the only thing that can move is which payment the row says
-- it came from, and only from a real payment to nothing. An entry can never acquire
-- a different payment, which is what an append-only ledger actually needs to
-- guarantee -- not that the row is byte-identical forever, but that what it says
-- about money never changes.
CREATE OR REPLACE FUNCTION prevent_wallet_ledger_change() RETURNS trigger AS $$
BEGIN
  IF NEW.id = OLD.id
     AND NEW.account_id = OLD.account_id
     AND NEW.direction = OLD.direction
     AND NEW.amount = OLD.amount
     AND NEW.balance_after = OLD.balance_after
     AND NEW.reason = OLD.reason
     AND NEW.created_at = OLD.created_at
     AND NEW.payment_id IS NULL
     AND OLD.payment_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'wallet_ledger is append-only' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

-- The reference above stops the drift; the balances it has already caused are
-- repaired here, from the ledger. The ledger is the record of money that moved and
-- the balance is a convenience derived from it -- which is the same claim the
-- deferred trigger makes -- so where the two disagree the ledger is believed.
--
-- A no-op on a database that never drifted, and it is the only place a balance is
-- ever written without a matching entry, because it is writing the entry's own
-- total back. `wallet_accounts_balance_not_negative` still refuses a ledger whose
-- total is below zero, so a genuinely broken wallet fails loudly here rather than
-- being quietly clamped to nothing.
UPDATE wallet_accounts wa
   SET balance = (
         SELECT COALESCE(SUM(CASE WHEN wl.direction = 'CREDIT' THEN wl.amount
                                  ELSE -wl.amount END), 0)
           FROM wallet_ledger wl
          WHERE wl.account_id = wa.id
       )
 WHERE wa.balance <> (
         SELECT COALESCE(SUM(CASE WHEN wl.direction = 'CREDIT' THEN wl.amount
                                  ELSE -wl.amount END), 0)
           FROM wallet_ledger wl
          WHERE wl.account_id = wa.id
       );

-- ---------------------------------------------------------------------------
-- 11. Demo funding
--
-- A wallet that starts at zero cannot demonstrate TeslaPay, and nothing else in
-- this project credits one. So the three seeded passengers get an opening
-- balance and the driver does not -- the driver's balance is meant to grow from
-- the fares they collect, which is the thing being demonstrated.
--
-- Guarded on "this wallet has no entries at all", so it funds an account once
-- and never again: re-running `db:migrate` cannot inflate a balance, and a
-- passenger who has spent their balance stays spent. The insert and the balance
-- update are one statement, which is what lets the deferred check in section 7
-- see them together.
-- ---------------------------------------------------------------------------
WITH funded AS (
  INSERT INTO wallet_ledger (account_id, payment_id, reason, direction, amount, balance_after)
  SELECT w.id, NULL, 'TOP_UP'::ledger_entry_reason, 'CREDIT', 500.00, 500.00
    FROM wallet_accounts w
    JOIN users u ON u.id = w.user_id
   WHERE u.email IN ('nusrat@example.com', 'rafiq@example.com', 'shirin@example.com')
     AND NOT EXISTS (SELECT 1 FROM wallet_ledger l WHERE l.account_id = w.id)
  RETURNING account_id
)
UPDATE wallet_accounts w
   SET balance = w.balance + 500.00, updated_at = now()
  FROM funded
 WHERE w.id = funded.account_id;
