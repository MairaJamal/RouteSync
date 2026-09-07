/* Changed: Complete Unit Test Suite for Flexible Ride-Pooling Capacity matching rules and race condition handling. */
import { canAddPassenger, bookPooledRideAtomic } from "./poolingCapacity";
import { RideWithBookings, PassengerCandidate } from "./types";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`✅ PASS: ${message}`);
}

async function runPoolingTests() {
  console.log("\n🧪 Running Flexible Ride-Pooling Capacity Test Suite...\n");

  const mockOrigin = { lat: 33.6844, lng: 73.0479, address_label: "F-10 Markaz" };
  const mockDest = { lat: 33.6432, lng: 72.9902, address_label: "NUST Gate 1" };

  function createBaseRide(driverMaxCoPassengers = 3, availableSeats = 3): RideWithBookings {
    return {
      id: "ride-101",
      driver_id: "driver-1",
      origin: mockOrigin,
      destination: mockDest,
      departure_time: new Date().toISOString(),
      total_seats: availableSeats + 1,
      available_seats: availableSeats,
      driver_max_co_passengers: driverMaxCoPassengers,
      status: "active",
      passengers: [],
    };
  }

  // ─────────────────────────────────────────────────────────────
  // TEST 1: Solo passenger (max=0) never gets pooled
  // ─────────────────────────────────────────────────────────────
  {
    const ride = createBaseRide(3, 3);
    const passengerSolo: PassengerCandidate = {
      passenger_id: "rider-solo",
      seats_requested: 1,
      max_co_passengers: 0, // Solo / Private preference
      pickup_point: mockOrigin,
      dropoff_point: mockDest,
    };

    const checkSolo = canAddPassenger(passengerSolo, ride);
    assert(checkSolo.canAdd === true, "Solo passenger can join an empty ride");

    // Add solo passenger
    ride.passengers.push({
      id: "b-1",
      ride_id: ride.id,
      passenger_id: passengerSolo.passenger_id,
      pickup_point: mockOrigin,
      dropoff_point: mockDest,
      seats_requested: 1,
      max_co_passengers: 0,
      status: "accepted",
    });

    const candidateSecond: PassengerCandidate = {
      passenger_id: "rider-2",
      seats_requested: 1,
      max_co_passengers: 3,
      pickup_point: mockOrigin,
      dropoff_point: mockDest,
    };

    const checkSecond = canAddPassenger(candidateSecond, ride);
    assert(
      checkSecond.canAdd === false && checkSecond.reason === "EXISTING_PASSENGER_CAP_VIOLATED",
      "Solo passenger (max=0) blocks any subsequent passengers from joining"
    );
  }

  // ─────────────────────────────────────────────────────────────
  // TEST 2: Passenger with max=3 correctly capped when matched with max=1 passenger
  // ─────────────────────────────────────────────────────────────
  {
    const ride = createBaseRide(4, 4);

    const passengerA: PassengerCandidate = {
      passenger_id: "rider-A",
      seats_requested: 1,
      max_co_passengers: 3, // Open to up to 3 others
      pickup_point: mockOrigin,
      dropoff_point: mockDest,
    };

    const passengerB: PassengerCandidate = {
      passenger_id: "rider-B",
      seats_requested: 1,
      max_co_passengers: 1, // Only open to up to 1 other
      pickup_point: mockOrigin,
      dropoff_point: mockDest,
    };

    assert(canAddPassenger(passengerA, ride).canAdd === true, "Passenger A (max=3) joins empty ride");

    ride.passengers.push({
      id: "b-A",
      ride_id: ride.id,
      passenger_id: passengerA.passenger_id,
      pickup_point: mockOrigin,
      dropoff_point: mockDest,
      seats_requested: 1,
      max_co_passengers: 3,
      status: "accepted",
    });

    assert(canAddPassenger(passengerB, ride).canAdd === true, "Passenger B (max=1) successfully joins Passenger A (max=3)");
  }

  // ─────────────────────────────────────────────────────────────
  // TEST 3: Rejecting a 3rd passenger that would violate an existing rider's limit (max=1)
  // ─────────────────────────────────────────────────────────────
  {
    const ride = createBaseRide(4, 4);

    // Ride currently has Passenger A (max=3) and Passenger B (max=1)
    ride.passengers.push(
      {
        id: "b-A",
        ride_id: ride.id,
        passenger_id: "rider-A",
        pickup_point: mockOrigin,
        dropoff_point: mockDest,
        seats_requested: 1,
        max_co_passengers: 3,
        status: "accepted",
      },
      {
        id: "b-B",
        ride_id: ride.id,
        passenger_id: "rider-B",
        pickup_point: mockOrigin,
        dropoff_point: mockDest,
        seats_requested: 1,
        max_co_passengers: 1,
        status: "accepted",
      }
    );

    const passengerC: PassengerCandidate = {
      passenger_id: "rider-C",
      seats_requested: 1,
      max_co_passengers: 3, // C is willing to share with 3, but B's limit is 1
      pickup_point: mockOrigin,
      dropoff_point: mockDest,
    };

    const checkC = canAddPassenger(passengerC, ride);
    assert(
      checkC.canAdd === false && checkC.reason === "EXISTING_PASSENGER_CAP_VIOLATED",
      "Rejecting 3rd passenger C because adding C violates existing Passenger B's max=1 limit"
    );
  }

  // ─────────────────────────────────────────────────────────────
  // TEST 4: Driver's own cap enforced independent of passenger limits
  // ─────────────────────────────────────────────────────────────
  {
    const ride = createBaseRide(1, 4); // Driver cap = 1, physical seats = 4

    const passenger1: PassengerCandidate = {
      passenger_id: "rider-1",
      seats_requested: 1,
      max_co_passengers: 5,
      pickup_point: mockOrigin,
      dropoff_point: mockDest,
    };

    assert(canAddPassenger(passenger1, ride).canAdd === true, "Passenger 1 joins when proposed count <= driver cap");

    ride.passengers.push({
      id: "b-1",
      ride_id: ride.id,
      passenger_id: passenger1.passenger_id,
      pickup_point: mockOrigin,
      dropoff_point: mockDest,
      seats_requested: 1,
      max_co_passengers: 5,
      status: "accepted",
    });

    const passenger2: PassengerCandidate = {
      passenger_id: "rider-2",
      seats_requested: 1,
      max_co_passengers: 5,
      pickup_point: mockOrigin,
      dropoff_point: mockDest,
    };

    const checkDriverCap = canAddPassenger(passenger2, ride);
    assert(
      checkDriverCap.canAdd === false && checkDriverCap.reason === "DRIVER_CAP_EXCEEDED",
      "Driver cap (max=1) enforced even when passengers opt into max=5"
    );
  }

  // ─────────────────────────────────────────────────────────────
  // TEST 5: Concurrent booking race condition handled correctly
  // ─────────────────────────────────────────────────────────────
  {
    const ride = createBaseRide(3, 1); // Only 1 seat available!

    const passengerX: PassengerCandidate = {
      passenger_id: "rider-X",
      seats_requested: 1,
      max_co_passengers: 3,
      pickup_point: mockOrigin,
      dropoff_point: mockDest,
    };

    const passengerY: PassengerCandidate = {
      passenger_id: "rider-Y",
      seats_requested: 1,
      max_co_passengers: 3,
      pickup_point: mockOrigin,
      dropoff_point: mockDest,
    };

    // Simulate 2 simultaneous booking attempts
    const [resX, resY] = await Promise.all([
      bookPooledRideAtomic(ride, passengerX),
      bookPooledRideAtomic(ride, passengerY),
    ]);

    const successCount = (resX.success ? 1 : 0) + (resY.success ? 1 : 0);
    assert(
      successCount === 1,
      "Concurrent booking race condition prevented overbooking: exactly 1 booking succeeded"
    );
    assert(ride.available_seats === 0, "Available seats updated correctly to 0");
  }

  // ─────────────────────────────────────────────────────────────
  // TEST 6 (Day 7 group safety): same-gender pairing always allowed,
  // even with restrictive preferences
  // ─────────────────────────────────────────────────────────────
  {
    const ride = createBaseRide(3, 3);
    ride.driver_gender = "female";
    ride.driver_preference = "female_only";

    const passenger: PassengerCandidate = {
      passenger_id: "rider-f",
      seats_requested: 1,
      max_co_passengers: 3,
      pickup_point: mockOrigin,
      dropoff_point: mockDest,
      passenger_gender: "female",
      passenger_preference: "any",
    };

    assert(
      canAddPassenger(passenger, ride).canAdd === true,
      "Same-gender pairing (female driver + female passenger) allowed regardless of preferences"
    );
  }

  // ─────────────────────────────────────────────────────────────
  // TEST 7 (Day 7 group safety): mixed-gender 1:1 pairing allowed
  // when BOTH sides opted into 'any'
  // ─────────────────────────────────────────────────────────────
  {
    const ride = createBaseRide(3, 3);
    ride.driver_gender = "male";
    ride.driver_preference = "any";

    const passenger: PassengerCandidate = {
      passenger_id: "rider-mixed-ok",
      seats_requested: 1,
      max_co_passengers: 3,
      pickup_point: mockOrigin,
      dropoff_point: mockDest,
      passenger_gender: "female",
      passenger_preference: "any",
    };

    assert(
      canAddPassenger(passenger, ride).canAdd === true,
      "Mixed-gender 1:1 pairing allowed when both driver and passenger prefer 'any'"
    );
  }

  // ─────────────────────────────────────────────────────────────
  // TEST 8 (Day 7 group safety): mixed-gender 1:1 pairing blocked
  // when EITHER side did not opt into 'any'
  // ─────────────────────────────────────────────────────────────
  {
    const rideA = createBaseRide(3, 3);
    rideA.driver_gender = "male";
    rideA.driver_preference = "any";

    const restrictivePassenger: PassengerCandidate = {
      passenger_id: "rider-restrictive",
      seats_requested: 1,
      max_co_passengers: 3,
      pickup_point: mockOrigin,
      dropoff_point: mockDest,
      passenger_gender: "female",
      passenger_preference: "female_only",
    };

    const checkA = canAddPassenger(restrictivePassenger, rideA);
    assert(
      checkA.canAdd === false && checkA.reason === "GROUP_SAFETY_MIXED_PAIR",
      "Mixed pair blocked when passenger preference is not 'any' (GROUP_SAFETY_MIXED_PAIR)"
    );

    const rideB = createBaseRide(3, 3);
    rideB.driver_gender = "male";
    rideB.driver_preference = "male_only";

    const openPassenger: PassengerCandidate = {
      passenger_id: "rider-open",
      seats_requested: 1,
      max_co_passengers: 3,
      pickup_point: mockOrigin,
      dropoff_point: mockDest,
      passenger_gender: "female",
      passenger_preference: "any",
    };

    const checkB = canAddPassenger(openPassenger, rideB);
    assert(
      checkB.canAdd === false && checkB.reason === "GROUP_SAFETY_MIXED_PAIR",
      "Mixed pair blocked when driver preference is not 'any' (GROUP_SAFETY_MIXED_PAIR)"
    );
  }

  // ─────────────────────────────────────────────────────────────
  // TEST 9 (Day 7 group safety): rides without gender metadata keep
  // legacy behavior (no regression for older flows)
  // ─────────────────────────────────────────────────────────────
  {
    const ride = createBaseRide(3, 3); // no driver_gender / driver_preference

    const passenger: PassengerCandidate = {
      passenger_id: "rider-legacy",
      seats_requested: 1,
      max_co_passengers: 3,
      pickup_point: mockOrigin,
      dropoff_point: mockDest, // no passenger_gender / passenger_preference
    };

    assert(
      canAddPassenger(passenger, ride).canAdd === true,
      "Rides without gender metadata behave exactly as before Day 7"
    );
  }

  // ─────────────────────────────────────────────────────────────
  // TEST 10 (Day 7 group safety): pools of 3+ riders are unaffected
  // by the mixed-pair rule
  // ─────────────────────────────────────────────────────────────
  {
    const ride = createBaseRide(3, 3);
    ride.driver_gender = "male";
    ride.driver_preference = "female_only"; // deliberately NOT 'any'

    ride.passengers.push({
      id: "b-first",
      ride_id: ride.id,
      passenger_id: "rider-first",
      pickup_point: mockOrigin,
      dropoff_point: mockDest,
      seats_requested: 1,
      max_co_passengers: 3,
      status: "accepted",
    });

    const thirdRider: PassengerCandidate = {
      passenger_id: "rider-third",
      seats_requested: 1,
      max_co_passengers: 3,
      pickup_point: mockOrigin,
      dropoff_point: mockDest,
      passenger_gender: "male",
      passenger_preference: "any",
    };

    const checkPool = canAddPassenger(thirdRider, ride);
    assert(
      checkPool.canAdd === true,
      "3+ rider pools bypass the mixed-pair rule (proposed total riders = 3)"
    );
  }

  console.log("\n🎉 All Flexible Ride-Pooling Capacity Tests Passed (10/10)!\n");
}

runPoolingTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
