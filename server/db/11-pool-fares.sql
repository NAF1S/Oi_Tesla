-- Versioned shared-fare allocation: what each passenger in a pool owes, based on
-- the route legs they were actually on board for.
--
-- WHAT THIS FILE ADDS
--
--   1. `pool_fare_calculations` - one immutable, versioned calculation per pool
--      plan version, with at most one CURRENT row per pool.
--   2. `pool_fare_legs` - the ordered travel legs of the plan, each with its
--      per-edge route snapshot, what it cost to drive, and how many passengers
--      were on board to fund it.
--   3. `passenger_fare_allocations` - one row per member per calculation: the
--      shares they were given, the caps that were applied, and the final fare
--      with each reduction recorded separately.
--   4. `passenger_fare_leg_shares` - the per-leg split of a leg's cost, with the
--      rounding residual stored explicitly.
--   5. The new pool events (`SHARED_FARE_CALCULATED`, `SHARED_FARE_SUPERSEDED`)
--      and passenger ride events (`PASSENGER_FARE_ALLOCATED`,
--      `PASSENGER_FARE_REDUCED`).
--
-- WHAT THIS FILE DOES NOT DO
--
-- No payment, no wallet, no refund, no driver payout, no cancellation fee and no
-- trip operation. A fare here is an ESTIMATE for a pool that has not started:
-- every stop must still be PENDING for a calculation to be written, and the
-- FINALIZED status exists for the trip milestone that will settle it.
--
-- WHY THE MONEY COLUMNS ARE numeric AND THE IDENTITY CHECKS ARE CONSTRAINTS
--
-- Every amount is numeric(14,6), like fare_quotes, so nothing is ever stored as
-- a binary float. Each row then carries the arithmetic that produced it as a
-- CHECK -- a leg's components must add up to its total, an allocation's capping
-- must add up to its fare, a share's residual must match the share -- so a row
-- with a breakdown that does not add up cannot be written by any code path,
-- including one written later by mistake.

-- ---------------------------------------------------------------------------
-- 1. The status of a calculation
--
-- CURRENT means "this is what the pool owes right now". SUPERSEDED means "the
-- pool's plan changed and this was the previous answer". FINALIZED is reserved
-- for the trip milestone that settles a completed ride; nothing in this
-- milestone writes it, and the trigger below only allows the two transitions
-- that exist today.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  CREATE TYPE pool_fare_calculation_status AS ENUM ('CURRENT', 'SUPERSEDED', 'FINALIZED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 2. One calculation per pool plan version
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pool_fare_calculations (
  id                          uuid NOT NULL DEFAULT gen_random_uuid(),
  ride_pool_id                uuid NOT NULL,
  pool_version                integer NOT NULL,
  pricing_policy_id           uuid NOT NULL,
  pricing_code                text NOT NULL,
  pricing_version             integer NOT NULL,
  shared_fare_rule_version    text NOT NULL,
  status                      pool_fare_calculation_status NOT NULL DEFAULT 'CURRENT',
  currency                    text NOT NULL,
  traffic_profile             traffic_profile NOT NULL,
  route_distance_meters       integer NOT NULL,
  route_duration_seconds      integer NOT NULL,
  total_variable_route_cost   numeric(14, 6) NOT NULL,
  total_passenger_base_fare   numeric(14, 6) NOT NULL,
  total_uncapped_passenger_fare numeric(14, 6) NOT NULL,
  total_minimum_fare_uplift   numeric(14, 6) NOT NULL,
  total_final_passenger_fare  numeric(14, 6) NOT NULL,
  total_solo_cap_reduction    numeric(14, 6) NOT NULL,
  total_no_increase_reduction numeric(14, 6) NOT NULL,
  created_at                  timestamptz(6) NOT NULL DEFAULT now(),
  finalized_at                timestamptz(6),

  CONSTRAINT pool_fare_calculations_pkey PRIMARY KEY (id),
  CONSTRAINT pool_fare_calculations_pool_fk
    FOREIGN KEY (ride_pool_id) REFERENCES ride_pools (id) ON DELETE CASCADE,
  CONSTRAINT pool_fare_calculations_policy_fk
    FOREIGN KEY (pricing_policy_id) REFERENCES fare_policies (id) ON DELETE RESTRICT,

  -- A calculation describes a plan that exists: pool versions start at 1 and
  -- there is always at least one leg, so the route it was measured over is real.
  CONSTRAINT pool_fare_calculations_version_positive CHECK (pool_version > 0),
  CONSTRAINT pool_fare_calculations_route_positive CHECK (
    route_distance_meters > 0 AND route_duration_seconds > 0
  ),

  -- No amount can be negative: a reduction is stored as a positive amount that
  -- was taken off, never as a negative fare.
  CONSTRAINT pool_fare_calculations_amounts_not_negative CHECK (
    total_variable_route_cost >= 0
    AND total_passenger_base_fare >= 0
    AND total_uncapped_passenger_fare >= 0
    AND total_minimum_fare_uplift >= 0
    AND total_final_passenger_fare >= 0
    AND total_solo_cap_reduction >= 0
    AND total_no_increase_reduction >= 0
  ),

  -- The passengers were asked for the base fares plus the legs, and the minimum
  -- fare then raised some of those fares -- which is money the platform funds, not
  -- money a passenger produced. Every unit is accounted for twice over: once as
  -- "what the pool would charge before the protections", and once as what was
  -- actually charged plus the two reductions.
  CONSTRAINT pool_fare_calculations_totals_consistent CHECK (
    total_uncapped_passenger_fare = total_passenger_base_fare + total_variable_route_cost
    AND total_final_passenger_fare + total_solo_cap_reduction + total_no_increase_reduction
        = total_uncapped_passenger_fare + total_minimum_fare_uplift
  ),

  -- FINALIZED means a trip settled it; an estimate must not claim to be one.
  CONSTRAINT pool_fare_calculations_finalized_consistent CHECK (
    (status = 'FINALIZED' AND finalized_at IS NOT NULL)
    OR (status <> 'FINALIZED' AND finalized_at IS NULL)
  )
);

-- One CURRENT calculation per pool. This is the index that makes "what does this
-- pool owe right now" a single answer, and it is what two concurrent
-- recalculations collide on.
CREATE UNIQUE INDEX IF NOT EXISTS one_current_pool_fare_calculation_per_pool
  ON pool_fare_calculations (ride_pool_id)
  WHERE status = 'CURRENT';

-- One answer per plan version per rule version: recalculating the same version
-- twice is a no-op rather than a second row, which is what makes the
-- recalculation service idempotent under retries.
CREATE UNIQUE INDEX IF NOT EXISTS pool_fare_calculations_version_rule_unique
  ON pool_fare_calculations (ride_pool_id, pool_version, shared_fare_rule_version);

CREATE INDEX IF NOT EXISTS pool_fare_calculations_pool_created_idx
  ON pool_fare_calculations (ride_pool_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 3. The legs of the plan
--
-- One row per consecutive PoolStop pair, in sequence order. The approach to the
-- first pickup is deliberately *not* a leg: this milestone shares only the
-- passenger-carrying part of the journey.
--
-- `onboard_passenger_count` is the number of passengers in the vehicle for this
-- leg, derived from the stop actions before it. A leg with nobody on board is
-- still recorded -- the driver drove it, and it has to stay auditable -- but it
-- funds nothing: all four money columns are zero, and `total_leg_cost` of 0 is
-- exactly what the CHECK below requires of it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pool_fare_legs (
  id                      uuid NOT NULL DEFAULT gen_random_uuid(),
  fare_calculation_id     uuid NOT NULL,
  sequence                integer NOT NULL,
  from_pool_stop_id       uuid NOT NULL,
  to_pool_stop_id         uuid NOT NULL,
  distance_meters         integer NOT NULL,
  duration_seconds        integer NOT NULL,
  distance_cost           numeric(14, 6) NOT NULL,
  time_cost               numeric(14, 6) NOT NULL,
  traffic_adjustment      numeric(14, 6) NOT NULL,
  total_leg_cost          numeric(14, 6) NOT NULL,
  onboard_passenger_count integer NOT NULL,
  route_snapshot          jsonb NOT NULL,
  created_at              timestamptz(6) NOT NULL DEFAULT now(),

  CONSTRAINT pool_fare_legs_pkey PRIMARY KEY (id),
  CONSTRAINT pool_fare_legs_calculation_fk
    FOREIGN KEY (fare_calculation_id) REFERENCES pool_fare_calculations (id) ON DELETE CASCADE,
  CONSTRAINT pool_fare_legs_from_stop_fk
    FOREIGN KEY (from_pool_stop_id) REFERENCES pool_stops (id) ON DELETE CASCADE,
  CONSTRAINT pool_fare_legs_to_stop_fk
    FOREIGN KEY (to_pool_stop_id) REFERENCES pool_stops (id) ON DELETE CASCADE,

  CONSTRAINT pool_fare_legs_sequence_positive CHECK (sequence > 0),
  CONSTRAINT pool_fare_legs_is_a_leg CHECK (from_pool_stop_id <> to_pool_stop_id),
  -- A leg can be zero metres long: two passengers collected at the same stop are
  -- two stops and one leg between them, and the driver did not move. It is still
  -- a leg with passengers on board, it still gets one share each, and those
  -- shares are zero because there was nothing to drive.
  CONSTRAINT pool_fare_legs_measurements_not_negative CHECK (
    distance_meters >= 0 AND duration_seconds >= 0
  ),
  CONSTRAINT pool_fare_legs_onboard_not_negative CHECK (onboard_passenger_count >= 0),
  CONSTRAINT pool_fare_legs_snapshot_is_object CHECK (jsonb_typeof(route_snapshot) = 'object'),

  -- Third-party consent is a real constraint here: a leg with nobody on board
  -- cannot be funded, and a leg with passenger-mileage behind it cannot be free.
  CONSTRAINT pool_fare_legs_unfunded_is_free CHECK (
    (onboard_passenger_count = 0 AND total_leg_cost = 0 AND distance_cost = 0
      AND time_cost = 0 AND traffic_adjustment = 0)
    OR onboard_passenger_count > 0
  ),

  -- The traffic multiplier is applied once, as an adjustment on top of the
  -- distance and time cost, so the total is literally the sum of the three.
  CONSTRAINT pool_fare_legs_total_consistent CHECK (
    total_leg_cost = distance_cost + time_cost + traffic_adjustment
  ),

  CONSTRAINT pool_fare_legs_amounts_not_negative CHECK (
    distance_cost >= 0 AND time_cost >= 0 AND traffic_adjustment >= 0 AND total_leg_cost >= 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS pool_fare_legs_sequence_unique
  ON pool_fare_legs (fare_calculation_id, sequence);

CREATE INDEX IF NOT EXISTS pool_fare_legs_from_pool_stop_id_idx
  ON pool_fare_legs (from_pool_stop_id);

-- The pre-zero-length-leg rule, replaced: a leg between two stops at the same
-- service point is a real leg of zero length, not an unmeasurable one.
ALTER TABLE pool_fare_legs DROP CONSTRAINT IF EXISTS pool_fare_legs_distance_positive;

-- ---------------------------------------------------------------------------
-- 4. What one passenger owes
--
-- `accepted_solo_fare` is a copy of the request's own accepted fare, taken at
-- calculation time and never written back: the request stays the record of what
-- the passenger agreed to, and this row is the record of what they are charged
-- under the pooling rules.
--
-- `previous_pooled_fare_cap` is the fare this passenger was given by the
-- calculation for the preceding pool version. It is what makes "adding another
-- passenger never increases an existing passenger's fare" a stored fact rather
-- than a claim: the new fare is capped by the old one, and the amount the cap
-- took off is recorded separately.
--
-- The identity the CHECK enforces is the whole capping story:
--
--   final_fare + solo_cap_reduction + no_increase_reduction
--     = GREATEST(minimum_fare, uncapped_pooled_fare)
--
-- so no money disappears into a cap, and the two reductions are the only ways a
-- fare can come down.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS passenger_fare_allocations (
  id                          uuid NOT NULL DEFAULT gen_random_uuid(),
  fare_calculation_id         uuid NOT NULL,
  pool_member_id              uuid NOT NULL,
  ride_request_id             uuid NOT NULL,
  accepted_solo_fare          numeric(14, 6) NOT NULL,
  previous_pooled_fare_cap    numeric(14, 6),
  base_fare                   numeric(14, 6) NOT NULL,
  allocated_leg_cost          numeric(14, 6) NOT NULL,
  uncapped_pooled_fare        numeric(14, 6) NOT NULL,
  minimum_fare                numeric(14, 6) NOT NULL,
  minimum_fare_applied        boolean NOT NULL,
  solo_cap_applied            boolean NOT NULL,
  no_increase_cap_applied     boolean NOT NULL,
  solo_cap_reduction          numeric(14, 6) NOT NULL,
  no_increase_reduction       numeric(14, 6) NOT NULL,
  final_fare                  numeric(14, 6) NOT NULL,
  currency                    text NOT NULL,
  created_at                  timestamptz(6) NOT NULL DEFAULT now(),

  CONSTRAINT passenger_fare_allocations_pkey PRIMARY KEY (id),
  CONSTRAINT passenger_fare_allocations_calculation_fk
    FOREIGN KEY (fare_calculation_id) REFERENCES pool_fare_calculations (id) ON DELETE CASCADE,
  CONSTRAINT passenger_fare_allocations_member_fk
    FOREIGN KEY (pool_member_id) REFERENCES pool_members (id) ON DELETE CASCADE,
  CONSTRAINT passenger_fare_allocations_request_fk
    FOREIGN KEY (ride_request_id) REFERENCES ride_requests (id) ON DELETE RESTRICT,

  CONSTRAINT passenger_fare_allocations_amounts_not_negative CHECK (
    accepted_solo_fare >= 0
    AND (previous_pooled_fare_cap IS NULL OR previous_pooled_fare_cap >= 0)
    AND base_fare >= 0
    AND allocated_leg_cost >= 0
    AND uncapped_pooled_fare >= 0
    AND minimum_fare >= 0
    AND solo_cap_reduction >= 0
    AND no_increase_reduction >= 0
    AND final_fare >= 0
  ),

  -- A pooled fare is a base fare plus the passenger's share of the legs.
  CONSTRAINT passenger_fare_allocations_uncapped_consistent CHECK (
    uncapped_pooled_fare = base_fare + allocated_leg_cost
  ),

  -- The caps, and nothing but the caps, decide the final fare.
  CONSTRAINT passenger_fare_allocations_caps_consistent CHECK (
    final_fare + solo_cap_reduction + no_increase_reduction
      = GREATEST(minimum_fare, uncapped_pooled_fare)
  ),

  CONSTRAINT passenger_fare_allocations_cap_flags_consistent CHECK (
    (solo_cap_applied = (solo_cap_reduction > 0))
    AND (no_increase_cap_applied = (no_increase_reduction > 0))
  ),

  -- The passenger-protection guarantees, enforced by the database rather than
  -- by the service that happens to implement them today.
  CONSTRAINT passenger_fare_allocations_solo_cap_holds CHECK (
    final_fare <= accepted_solo_fare
  ),
  CONSTRAINT passenger_fare_allocations_no_increase_holds CHECK (
    previous_pooled_fare_cap IS NULL OR final_fare <= previous_pooled_fare_cap
  ),

  -- Whether the minimum fare actually raised this passenger's fare above what
  -- their share of the legs came to.
  CONSTRAINT passenger_fare_allocations_minimum_fare_flag CHECK (
    minimum_fare_applied = (minimum_fare > uncapped_pooled_fare)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS passenger_fare_allocations_member_unique
  ON passenger_fare_allocations (fare_calculation_id, pool_member_id);

CREATE INDEX IF NOT EXISTS passenger_fare_allocations_request_idx
  ON passenger_fare_allocations (ride_request_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 5. How a leg's cost was split
--
-- One row per passenger on board for that leg. `share_ratio` is 1 / N and is
-- stored so the split can be read without arithmetic; `unrounded_amount` is the
-- exact quotient the share came from; `allocated_amount` is what the passenger
-- was actually charged for the leg; and `rounding_adjustment` is the difference
-- between the two, so the residual is auditable rather than silent.
--
-- A constraint trigger (deferred to commit) then proves the invariant that makes
-- the split trustworthy: the shares of a leg add up to exactly the leg's cost,
-- and there is one share for every passenger who was on board.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS passenger_fare_leg_shares (
  id                           uuid NOT NULL DEFAULT gen_random_uuid(),
  passenger_fare_allocation_id uuid NOT NULL,
  pool_fare_leg_id             uuid NOT NULL,
  onboard_passenger_count      integer NOT NULL,
  share_ratio                  numeric(14, 10) NOT NULL,
  unrounded_amount             numeric(20, 10) NOT NULL,
  allocated_amount             numeric(14, 6) NOT NULL,
  rounding_adjustment          numeric(20, 10) NOT NULL,
  created_at                   timestamptz(6) NOT NULL DEFAULT now(),

  CONSTRAINT passenger_fare_leg_shares_pkey PRIMARY KEY (id),
  CONSTRAINT passenger_fare_leg_shares_allocation_fk
    FOREIGN KEY (passenger_fare_allocation_id) REFERENCES passenger_fare_allocations (id)
    ON DELETE CASCADE,
  CONSTRAINT passenger_fare_leg_shares_leg_fk
    FOREIGN KEY (pool_fare_leg_id) REFERENCES pool_fare_legs (id) ON DELETE CASCADE,

  CONSTRAINT passenger_fare_leg_shares_count_positive CHECK (onboard_passenger_count > 0),
  CONSTRAINT passenger_fare_leg_shares_ratio_is_one_over_n CHECK (
    share_ratio = round(1::numeric / onboard_passenger_count, 10)
  ),
  CONSTRAINT passenger_fare_leg_shares_amounts_not_negative CHECK (
    unrounded_amount >= 0 AND allocated_amount >= 0
  ),

  -- A share is the leg cost divided by the passengers on board, floored to the
  -- currency and then topped up by the residual rule. Two constraints say exactly
  -- that, and neither has to know how many decimals the policy rounds to:
  --
  --   * the stored adjustment is the exact difference between the charge and the
  --     quotient, so a share can be explained without recomputing anything;
  --   * and it is less than one whole currency unit, so rounding can never turn a
  --     share into something a division cannot explain. (The sharper bound -- one
  --     unit at the policy's scale -- cannot be written here, because a CHECK
  --     cannot read the policy. What makes it exact is
  --     `passenger_fare_leg_shares_sum_is_exact` below: the shares of a leg add
  --     up to precisely the leg's cost, so the distribution is bounded by the
  --     total it has to fit into.)
  CONSTRAINT passenger_fare_leg_shares_adjustment_consistent CHECK (
    rounding_adjustment = allocated_amount - unrounded_amount
  ),

  CONSTRAINT passenger_fare_leg_shares_within_a_unit CHECK (
    rounding_adjustment > -1 AND rounding_adjustment < 1
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS passenger_fare_leg_shares_leg_unique
  ON passenger_fare_leg_shares (passenger_fare_allocation_id, pool_fare_leg_id);

CREATE INDEX IF NOT EXISTS passenger_fare_leg_shares_pool_fare_leg_id_idx
  ON passenger_fare_leg_shares (pool_fare_leg_id);

-- ---------------------------------------------------------------------------
-- 6. Money is write-once
--
-- A calculation may only move between statuses -- CURRENT to SUPERSEDED when the
-- plan changes, CURRENT to FINALIZED when a trip settles it -- and its amounts,
-- its pool version and its rule version can never be edited afterwards. The
-- child rows are append-only outright: a leg, an allocation or a share has no
-- update that means anything, so none is allowed.
--
-- DELETE is left alone on purpose. These rows live and die with their pool
-- (the foreign keys above cascade), and refusing the delete would make it
-- impossible to remove a pool at all -- including in the test suite, which
-- resets pools between cases.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_pool_fare_calculation_update() RETURNS trigger AS $$
DECLARE
  status_allowed boolean;
BEGIN
  IF (NEW.ride_pool_id, NEW.pool_version, NEW.pricing_policy_id, NEW.pricing_code,
      NEW.pricing_version, NEW.shared_fare_rule_version, NEW.currency,
      NEW.traffic_profile, NEW.route_distance_meters, NEW.route_duration_seconds,
      NEW.total_variable_route_cost, NEW.total_passenger_base_fare,
      NEW.total_uncapped_passenger_fare, NEW.total_final_passenger_fare,
      NEW.total_solo_cap_reduction, NEW.total_no_increase_reduction, NEW.created_at)
     IS DISTINCT FROM
     (OLD.ride_pool_id, OLD.pool_version, OLD.pricing_policy_id, OLD.pricing_code,
      OLD.pricing_version, OLD.shared_fare_rule_version, OLD.currency,
      OLD.traffic_profile, OLD.route_distance_meters, OLD.route_duration_seconds,
      OLD.total_variable_route_cost, OLD.total_passenger_base_fare,
      OLD.total_uncapped_passenger_fare, OLD.total_final_passenger_fare,
      OLD.total_solo_cap_reduction, OLD.total_no_increase_reduction, OLD.created_at)
  THEN
    RAISE EXCEPTION
      'pool fare calculation % is immutable: its plan version, policy, rule version and amounts cannot change',
      OLD.id
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    status_allowed := OLD.status = 'CURRENT' AND NEW.status IN ('SUPERSEDED', 'FINALIZED');

    IF NOT status_allowed THEN
      RAISE EXCEPTION 'illegal pool fare calculation transition % -> %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.finalized_at IS DISTINCT FROM OLD.finalized_at AND NEW.status <> 'FINALIZED' THEN
    RAISE EXCEPTION 'only a FINALIZED pool fare calculation carries a finalized_at'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pool_fare_calculations_enforce_update ON pool_fare_calculations;
CREATE TRIGGER pool_fare_calculations_enforce_update
  BEFORE UPDATE ON pool_fare_calculations
  FOR EACH ROW EXECUTE FUNCTION enforce_pool_fare_calculation_update();

CREATE OR REPLACE FUNCTION prevent_pool_fare_row_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% % is append-only', TG_TABLE_NAME, OLD.id USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pool_fare_legs_append_only ON pool_fare_legs;
CREATE TRIGGER pool_fare_legs_append_only
  BEFORE UPDATE ON pool_fare_legs
  FOR EACH ROW EXECUTE FUNCTION prevent_pool_fare_row_change();

DROP TRIGGER IF EXISTS passenger_fare_allocations_append_only ON passenger_fare_allocations;
CREATE TRIGGER passenger_fare_allocations_append_only
  BEFORE UPDATE ON passenger_fare_allocations
  FOR EACH ROW EXECUTE FUNCTION prevent_pool_fare_row_change();

DROP TRIGGER IF EXISTS passenger_fare_leg_shares_append_only ON passenger_fare_leg_shares;
CREATE TRIGGER passenger_fare_leg_shares_append_only
  BEFORE UPDATE ON passenger_fare_leg_shares
  FOR EACH ROW EXECUTE FUNCTION prevent_pool_fare_row_change();

-- ---------------------------------------------------------------------------
-- 7. Never discard or create money because of division rounding
--
-- The shares of a leg must add up to exactly the leg's total, and there must be
-- exactly one share per passenger on board. This cannot be a CHECK -- it is a
-- statement about a set of rows -- so it is a constraint trigger, deferred to
-- commit because the shares are inserted one at a time.
--
-- It fires per inserted share and re-checks that whole leg, which is cheap at
-- this size (a plan has at most a handful of legs and a vehicle a handful of
-- seats) and catches the one mistake that would otherwise be invisible: a
-- half-written split.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_pool_fare_leg_fully_allocated() RETURNS trigger AS $$
DECLARE
  leg record;
BEGIN
  SELECT l.id, l.total_leg_cost, l.onboard_passenger_count,
         (SELECT count(*) FROM passenger_fare_leg_shares s WHERE s.pool_fare_leg_id = l.id)
           AS share_count,
         (SELECT coalesce(sum(s.allocated_amount), 0)
            FROM passenger_fare_leg_shares s
           WHERE s.pool_fare_leg_id = l.id) AS allocated
    INTO leg
    FROM pool_fare_legs l
   WHERE l.id = NEW.pool_fare_leg_id;

  -- The leg was deleted (its pool went away) between the insert and the commit.
  IF leg.id IS NULL THEN
    RETURN NULL;
  END IF;

  IF leg.share_count <> leg.onboard_passenger_count THEN
    RAISE EXCEPTION
      'pool fare leg % has % share(s) for % onboard passenger(s)',
      leg.id, leg.share_count, leg.onboard_passenger_count
      USING ERRCODE = '23514';
  END IF;

  IF leg.allocated <> leg.total_leg_cost THEN
    RAISE EXCEPTION
      'pool fare leg % allocates % but its cost is %',
      leg.id, leg.allocated, leg.total_leg_cost
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS passenger_fare_leg_shares_sum_is_exact ON passenger_fare_leg_shares;
CREATE CONSTRAINT TRIGGER passenger_fare_leg_shares_sum_is_exact
  AFTER INSERT ON passenger_fare_leg_shares
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_pool_fare_leg_fully_allocated();

-- ---------------------------------------------------------------------------
-- 8. The events
--
-- Added to the existing enums rather than duplicated: a pool's history is one
-- list, and a passenger's history is one list. PostgreSQL will not let a value
-- added here be used in this same transaction, which is why nothing below reads
-- them -- the services do, once the migration has committed.
-- ---------------------------------------------------------------------------
ALTER TYPE pool_event_type ADD VALUE IF NOT EXISTS 'SHARED_FARE_CALCULATED';
ALTER TYPE pool_event_type ADD VALUE IF NOT EXISTS 'SHARED_FARE_SUPERSEDED';

ALTER TYPE ride_event_type ADD VALUE IF NOT EXISTS 'PASSENGER_FARE_ALLOCATED';
ALTER TYPE ride_event_type ADD VALUE IF NOT EXISTS 'PASSENGER_FARE_REDUCED';

-- ---------------------------------------------------------------------------
-- 9. The minimum-fare uplift, added after the first version of this migration
--
-- The first attempt at `pool_fare_calculations_totals_consistent` compared the
-- final total against the uncapped one, which is only true while no minimum fare
-- applies. The constraint caught it: a passenger whose pooled shares came to
-- less than the minimum was charged the minimum, and that difference had nowhere
-- to be recorded. It does now.
-- ---------------------------------------------------------------------------
ALTER TABLE pool_fare_calculations
  ADD COLUMN IF NOT EXISTS total_minimum_fare_uplift numeric(14, 6);

UPDATE pool_fare_calculations
   SET total_minimum_fare_uplift = 0
 WHERE total_minimum_fare_uplift IS NULL;

ALTER TABLE pool_fare_calculations
  ALTER COLUMN total_minimum_fare_uplift SET NOT NULL;

-- The re-add is guarded on `total_fare_rounding_adjustment` not existing yet.
--
-- This file runs before 14-fare-rounding.sql, which widens the very same
-- constraint to account for the whole-Taka rounding adjustment. Adding the
-- narrow version unconditionally would therefore fail on any database that
-- already holds a pooled fare with a non-zero adjustment -- and every pooled
-- fare has one, now that fares are charged in whole units. The guard keeps this
-- file re-runnable, which is the property the whole migration set rests on:
-- `npm run db:migrate` applies these files again and again, in order, to
-- whatever the database already contains.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'pool_fare_calculations'
       AND column_name = 'total_fare_rounding_adjustment'
  ) THEN
    ALTER TABLE pool_fare_calculations
      DROP CONSTRAINT IF EXISTS pool_fare_calculations_totals_consistent;

    ALTER TABLE pool_fare_calculations
      ADD CONSTRAINT pool_fare_calculations_totals_consistent CHECK (
        total_uncapped_passenger_fare = total_passenger_base_fare + total_variable_route_cost
        AND total_final_passenger_fare + total_solo_cap_reduction + total_no_increase_reduction
            = total_uncapped_passenger_fare + total_minimum_fare_uplift
      );
  END IF;
END $$;

ALTER TABLE pool_fare_calculations
  DROP CONSTRAINT IF EXISTS pool_fare_calculations_amounts_not_negative;

ALTER TABLE pool_fare_calculations
  ADD CONSTRAINT pool_fare_calculations_amounts_not_negative CHECK (
    total_variable_route_cost >= 0
    AND total_passenger_base_fare >= 0
    AND total_uncapped_passenger_fare >= 0
    AND total_minimum_fare_uplift >= 0
    AND total_final_passenger_fare >= 0
    AND total_solo_cap_reduction >= 0
    AND total_no_increase_reduction >= 0
  );

-- ---------------------------------------------------------------------------
-- 10. The share residual, defined once and for good
--
-- The first version bounded a share's rounding residual by 0.000001 -- one unit
-- at six decimals, when this policy rounds to two, where one unit is 0.01 -- and
-- then defined the stored adjustment as the difference from the quotient floored
-- at six decimals, which is not what the calculator computes. The constraint
-- caught both: every correct share was refused. What is left says the same thing
-- without knowing the scale, and stores the adjustment at the precision the
-- difference actually needs.
-- ---------------------------------------------------------------------------
ALTER TABLE passenger_fare_leg_shares
  DROP CONSTRAINT IF EXISTS passenger_fare_leg_shares_adjustment_bounded;
ALTER TABLE passenger_fare_leg_shares
  DROP CONSTRAINT IF EXISTS passenger_fare_leg_shares_never_below_the_quotient;
ALTER TABLE passenger_fare_leg_shares
  DROP CONSTRAINT IF EXISTS passenger_fare_leg_shares_never_above_the_quotient;
ALTER TABLE passenger_fare_leg_shares
  DROP CONSTRAINT IF EXISTS passenger_fare_leg_shares_adjustment_consistent;
ALTER TABLE passenger_fare_leg_shares
  DROP CONSTRAINT IF EXISTS passenger_fare_leg_shares_within_a_unit;

ALTER TABLE passenger_fare_leg_shares
  ALTER COLUMN rounding_adjustment TYPE numeric(20, 10);

ALTER TABLE passenger_fare_leg_shares
  ADD CONSTRAINT passenger_fare_leg_shares_adjustment_consistent CHECK (
    rounding_adjustment = allocated_amount - unrounded_amount
  );

ALTER TABLE passenger_fare_leg_shares
  ADD CONSTRAINT passenger_fare_leg_shares_within_a_unit CHECK (
    rounding_adjustment > -1 AND rounding_adjustment < 1
  );

-- ---------------------------------------------------------------------------
-- 11. The names Prisma would have chosen
--
-- Every other foreign key in this schema was written as an inline `REFERENCES`,
-- so Postgres named it `<table>_<column>_fkey`, which is also the name Prisma
-- expects to find. These ten were named by hand instead, and the two indexes
-- below were named after the short column name rather than the column. Nothing
-- about the behaviour changes -- but `prisma migrate diff` reports the
-- difference on every run, and a diff that is noise cannot be used as a check.
-- Renaming here rather than editing the statements above keeps this file a
-- record of what was applied and makes an already-migrated database converge.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  renames text[][] := ARRAY[
    ['pool_fare_calculations', 'pool_fare_calculations_pool_fk',
     'pool_fare_calculations_ride_pool_id_fkey'],
    ['pool_fare_calculations', 'pool_fare_calculations_policy_fk',
     'pool_fare_calculations_pricing_policy_id_fkey'],
    ['pool_fare_legs', 'pool_fare_legs_calculation_fk',
     'pool_fare_legs_fare_calculation_id_fkey'],
    ['pool_fare_legs', 'pool_fare_legs_from_stop_fk',
     'pool_fare_legs_from_pool_stop_id_fkey'],
    ['pool_fare_legs', 'pool_fare_legs_to_stop_fk',
     'pool_fare_legs_to_pool_stop_id_fkey'],
    ['passenger_fare_allocations', 'passenger_fare_allocations_calculation_fk',
     'passenger_fare_allocations_fare_calculation_id_fkey'],
    ['passenger_fare_allocations', 'passenger_fare_allocations_member_fk',
     'passenger_fare_allocations_pool_member_id_fkey'],
    ['passenger_fare_allocations', 'passenger_fare_allocations_request_fk',
     'passenger_fare_allocations_ride_request_id_fkey'],
    ['passenger_fare_leg_shares', 'passenger_fare_leg_shares_allocation_fk',
     'passenger_fare_leg_shares_passenger_fare_allocation_id_fkey'],
    ['passenger_fare_leg_shares', 'passenger_fare_leg_shares_leg_fk',
     'passenger_fare_leg_shares_pool_fare_leg_id_fkey']
  ];
  i integer;
BEGIN
  FOR i IN 1 .. array_length(renames, 1) LOOP
    IF EXISTS (
      SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname = renames[i][1]
         AND c.conname = renames[i][2]
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I RENAME CONSTRAINT %I TO %I',
        renames[i][1], renames[i][2], renames[i][3]
      );
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  stale text[] := ARRAY[
    'pool_fare_legs_from_stop_idx',
    'passenger_fare_leg_shares_leg_idx'
  ];
  name text;
BEGIN
  FOREACH name IN ARRAY stale LOOP
    -- The names above are the ones Prisma expects, so the statements that create
    -- these indexes now use them; an already-migrated database still has the old
    -- ones. Dropping is idempotent in a way renaming is not: the `CREATE INDEX IF
    -- NOT EXISTS` above re-creates the old name on every run, and a rename would
    -- then collide with the index it produced the time before.
    EXECUTE format('DROP INDEX IF EXISTS %I', name);
  END LOOP;
END $$;
