-- ─────────────────────────────────────────────────────────────
-- Migration: Flexible Ride-Pooling Capacity Preferences & Concurrency
-- Adds driver_max_co_passengers, RideBooking max_co_passengers,
-- default_max_co_passengers on users, and atomic row-locking RPC.
-- ─────────────────────────────────────────────────────────────

-- 1. Add default_max_co_passengers to users table
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS default_max_co_passengers INT DEFAULT 3;

-- 2. Create rides table if not existing (or alter)
CREATE TABLE IF NOT EXISTS rides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id UUID REFERENCES users(id) ON DELETE CASCADE,
  origin_lat NUMERIC(9,6) NOT NULL,
  origin_lng NUMERIC(9,6) NOT NULL,
  origin_label TEXT,
  destination_lat NUMERIC(9,6) NOT NULL,
  destination_lng NUMERIC(9,6) NOT NULL,
  destination_label TEXT,
  departure_time TIMESTAMP WITH TIME ZONE NOT NULL,
  total_seats INT NOT NULL DEFAULT 4,
  available_seats INT NOT NULL DEFAULT 4,
  driver_max_co_passengers INT NOT NULL DEFAULT 3, -- Driver's cap on co-passengers
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Create ride_bookings table
CREATE TABLE IF NOT EXISTS ride_bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id UUID REFERENCES rides(id) ON DELETE CASCADE,
  passenger_id UUID REFERENCES users(id) ON DELETE CASCADE,
  pickup_lat NUMERIC(9,6) NOT NULL,
  pickup_lng NUMERIC(9,6) NOT NULL,
  pickup_label TEXT,
  dropoff_lat NUMERIC(9,6) NOT NULL,
  dropoff_lng NUMERIC(9,6) NOT NULL,
  dropoff_label TEXT,
  seats_requested INT NOT NULL DEFAULT 1,
  max_co_passengers INT DEFAULT 3, -- 0 = solo/private, 1 = up to 1 other, N = up to N, -1 = no limit
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for fast lookup of bookings per ride
CREATE INDEX IF NOT EXISTS idx_ride_bookings_ride_status ON ride_bookings(ride_id, status);

-- 4. Atomic Row-Locking Stored Procedure: book_pooled_ride
-- Uses SELECT ... FOR UPDATE to lock the Ride row, avoiding concurrent race conditions.
CREATE OR REPLACE FUNCTION book_pooled_ride(
  p_ride_id UUID,
  p_passenger_id UUID,
  p_pickup_lat NUMERIC,
  p_pickup_lng NUMERIC,
  p_pickup_label TEXT,
  p_dropoff_lat NUMERIC,
  p_dropoff_lng NUMERIC,
  p_dropoff_label TEXT,
  p_seats_requested INT,
  p_max_co_passengers INT
)
RETURNS TABLE (
  booking_id UUID,
  success BOOLEAN,
  reason TEXT
) 
LANGUAGE plpgsql
AS $$
DECLARE
  v_ride RECORD;
  v_existing_booking RECORD;
  v_proposed_count INT;
BEGIN
  -- Row-level lock on the targeted Ride record to block concurrent booking updates
  SELECT * INTO v_ride
  FROM rides
  WHERE id = p_ride_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::UUID, FALSE, 'RIDE_NOT_FOUND';
    RETURN;
  END IF;

  IF v_ride.status != 'active' THEN
    RETURN QUERY SELECT NULL::UUID, FALSE, 'RIDE_NOT_ACTIVE';
    RETURN;
  END IF;

  -- Calculate proposed co-passenger count after adding p_passenger
  SELECT COUNT(*) INTO v_proposed_count
  FROM ride_bookings
  WHERE ride_id = p_ride_id AND status IN ('accepted', 'pending');

  v_proposed_count := v_proposed_count + 1;

  -- 1. Check Driver Cap
  IF v_ride.driver_max_co_passengers IS NOT NULL AND v_proposed_count > v_ride.driver_max_co_passengers THEN
    RETURN QUERY SELECT NULL::UUID, FALSE, 'DRIVER_CAP_EXCEEDED';
    RETURN;
  END IF;

  -- 2. Check Candidate Passenger Cap
  IF p_max_co_passengers IS NOT NULL AND p_max_co_passengers != -1 AND v_proposed_count > p_max_co_passengers THEN
    RETURN QUERY SELECT NULL::UUID, FALSE, 'PASSENGER_CAP_EXCEEDED';
    RETURN;
  END IF;

  -- 3. Check Existing Passengers' Caps ("most restrictive passenger wins")
  FOR v_existing_booking IN 
    SELECT max_co_passengers 
    FROM ride_bookings 
    WHERE ride_id = p_ride_id AND status IN ('accepted', 'pending')
  LOOP
    IF v_existing_booking.max_co_passengers IS NOT NULL 
       AND v_existing_booking.max_co_passengers != -1 
       AND v_proposed_count > v_existing_booking.max_co_passengers THEN
      RETURN QUERY SELECT NULL::UUID, FALSE, 'EXISTING_PASSENGER_CAP_VIOLATED';
      RETURN;
    END IF;
  END LOOP;

  -- 4. Check Seat Availability
  IF v_ride.available_seats < p_seats_requested THEN
    RETURN QUERY SELECT NULL::UUID, FALSE, 'INSUFFICIENT_SEATS';
    RETURN;
  END IF;

  -- Insert Booking and deduct available seats atomically
  INSERT INTO ride_bookings (
    ride_id, passenger_id, pickup_lat, pickup_lng, pickup_label,
    dropoff_lat, dropoff_lng, dropoff_label, seats_requested, max_co_passengers, status
  ) VALUES (
    p_ride_id, p_passenger_id, p_pickup_lat, p_pickup_lng, p_pickup_label,
    p_dropoff_lat, p_dropoff_lng, p_dropoff_label, p_seats_requested, p_max_co_passengers, 'accepted'
  ) RETURNING id INTO booking_id;

  UPDATE rides
  SET available_seats = available_seats - p_seats_requested
  WHERE id = p_ride_id;

  RETURN QUERY SELECT booking_id, TRUE, 'SUCCESS';
END;
$$;
