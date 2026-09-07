// Offline mock-candidate engine tests (frontend/mockCandidates.ts).
//
// Verifies the fallback dataset served when the Supabase-backed live
// search is unreachable: real Islamabad sector-grid coordinates produce
// non-zero buffered-intersection overlap on "F-10 → NUST Gate 1"-style
// queries (no hardcoded percentages anywhere), the join-a-driver sub-mode
// filters to registered vehicle owners, cab splits conserve the quoted
// fare to the rupee, and the gender / verified / role gates behave like
// the live pipeline's. Pure geometry — no network, no OSRM.
import { buildMockMatches, buildRequesterRoute } from "./frontend/mockCandidates";
import { analyzeSharedSegments, haversineDistance, OVERLAP_BUFFER_M } from "./routeOverlap";
import { Gender, GenderPreference, LocationPoint } from "./types";

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail: string = "") {
  if (cond) {
    pass++;
    console.log(`✅ ${label}`);
  } else {
    fail++;
    console.log(`❌ ${label}${detail ? " — " + detail : ""}`);
  }
}

function loc(lat: number, lng: number, label: string): LocationPoint {
  return { lat, lng, address_label: label };
}

// Sector-grid reference points (same values the frontend quick pins use).
const F10_MARKAZ = loc(33.6938, 73.0135, "F-10 Markaz");
const NUST_GATE_1 = loc(33.6425, 72.993, "NUST H-12 Gate 1");
const F7_JINNAH_SUPER = loc(33.72, 73.055, "F-7 Jinnah Super");
const F11_MARKAZ = loc(33.6844, 72.9886, "F-11 Markaz");
const G9_MARKAZ = loc(33.6917, 73.0336, "G-9 Markaz");

function opts(overrides: Partial<Parameters<typeof buildMockMatches>[0]> = {}) {
  return {
    origin: F10_MARKAZ,
    destination: NUST_GATE_1,
    userRole: "LOOKING" as const,
    vehicleType: "none" as const,
    currentUserGender: "female" as Gender,
    userPreference: "any" as GenderPreference,
    requireDriverGenderMatch: false,
    verifiedOnly: false,
    currentUserId: "usr-test-self",
    ...overrides,
  };
}

function summarize(ms: ReturnType<typeof buildMockMatches>): string {
  return ms.map((m) => `${m.candidateDisplayName} ${m.overlapPct}%`).join(", ") || "(none)";
}

function run() {
  console.log("── Part 1: geometry — Islamabad corridor queries get non-zero overlap ──");

  const q1 = buildMockMatches(opts());
  console.log(`  [diag] F-10→NUST join-driver: ${summarize(q1)}`);
  check("F-10→NUST query returns at least one match", q1.length >= 1, `got ${q1.length}`);
  check("Every returned overlap percentage is non-zero", q1.every((m) => m.overlapPct > 0));

  const zara = q1.find((m) => m.candidateUserId === "usr-zara-nust");
  check(
    "Identical corridor (Zara: F-10→NUST Gate 1) yields ~full overlap",
    !!zara && zara.overlapPct >= 95,
    zara ? `got ${zara.overlapPct}%` : "match missing"
  );
  check(
    "Converging corridor (Hamza: G-9→NUST) still surfaces above the 15% mock floor",
    q1.some((m) => m.candidateUserId === "usr-hamza-fast"),
    summarize(q1)
  );
  const overlaps = q1.map((m) => m.overlapPct);
  check("Results sorted by overlap, best first", overlaps.every((v, i) => i === 0 || overlaps[i - 1] >= v));

  // Raw analysis API the engine delegates to — the Task 3 guarantee that
  // spatial intersection math produces measurable shared length here.
  const requesterRoute = buildRequesterRoute(F10_MARKAZ, NUST_GATE_1);
  const twinRoute = buildRequesterRoute(F10_MARKAZ, NUST_GATE_1);
  const analysis = analyzeSharedSegments(requesterRoute, twinRoute, OVERLAP_BUFFER_M);
  check(
    "analyzeSharedSegments: identical routes share the full length",
    analysis.totalM > 5000 &&
      analysis.sharedM > 5000 &&
      analysis.firstSharedM === 0 &&
      analysis.lastSharedM !== null &&
      analysis.lastSharedM > 5000,
    `totalM=${analysis.totalM.toFixed(0)} sharedM=${analysis.sharedM.toFixed(0)}`
  );

  if (zara) {
    // Legs must reconstruct the corridor: blue+green+purple distances sum
    // to roughly the straight-line length (tiny legs may collapse).
    const legSum = zara.legs.reduce((s, l) => s + l.distance_m, 0);
    const straightM = haversineDistance(
      [F10_MARKAZ.lng, F10_MARKAZ.lat],
      [NUST_GATE_1.lng, NUST_GATE_1.lat]
    );
    check(
      "Leg distances sum to the route length (±10%)",
      legSum >= straightM * 0.9 && legSum <= straightM * 1.1,
      `legSum=${legSum}m straight=${straightM.toFixed(0)}m`
    );
    check(
      "Match exposes a real shared (green) leg with positive distance",
      zara.legs.some((l) => l.name === "shared_overlap" && l.distance_m > 0)
    );
    check("Detour minutes are non-negative", zara.detourAddedMinutes >= 0);
  }

  console.log("\n── Part 2: join-a-driver filters registered vehicle owners ──");

  check(
    "Join-a-driver excludes Ayesha (no vehicle of her own)",
    !q1.some((m) => m.candidateUserId === "usr-ayesha-qau")
  );
  check(
    "Join-a-driver matches are owner_passenger with the candidate as owner",
    q1.every((m) => m.matchType === "owner_passenger" && m.ownerUserId === m.candidateUserId)
  );
  if (zara) {
    const selfFare = zara.fareSplit.find((f) => f.user_id === "usr-test-self")?.total_fare;
    const ownerFare = zara.fareSplit.find((f) => f.user_id === "usr-zara-nust")?.total_fare;
    check(
      "Joining a driver: passenger pays per-km, owner rides free",
      (selfFare ?? 0) > 0 && ownerFare === 0,
      `passenger=${selfFare} owner=${ownerFare}`
    );
    check("Candidate's vehicle type carries through (car)", zara.vehicleType === "car");
  }

  console.log("\n── Part 3: passenger-side safety filters ──");

  const q2 = buildMockMatches(opts({ requireDriverGenderMatch: true }));
  console.log(`  [diag] F-10→NUST female-driver-only: ${summarize(q2)}`);
  check(
    "Female-driver filter keeps Zara (female owner)",
    q2.some((m) => m.candidateUserId === "usr-zara-nust")
  );
  check(
    "Female-driver filter drops every male candidate",
    q2.every((m) => m.candidateUserId !== "usr-hamza-fast" && m.candidateUserId !== "usr-bilal-comsats"),
    summarize(q2)
  );

  const q3 = buildMockMatches(opts({ currentUserGender: "male" }));
  console.log(`  [diag] F-10→NUST male rider: ${summarize(q3)}`);
  check(
    "Mutual compatibility: male rider is excluded from Zara's women-only ride",
    !q3.some((m) => m.candidateUserId === "usr-zara-nust")
  );
  check(
    "Male rider still sees gender-neutral owners (Hamza)",
    q3.some((m) => m.candidateUserId === "usr-hamza-fast"),
    summarize(q3)
  );

  console.log("\n── Part 4: OFFERING mode (driver posting a ride) ──");

  const q4 = buildMockMatches(opts({ origin: F7_JINNAH_SUPER, userRole: "OFFERING", vehicleType: "car" }));
  console.log(`  [diag] F-7→NUST offering: ${summarize(q4)}`);
  const ayesha = q4.find((m) => m.candidateUserId === "usr-ayesha-qau");
  check("Offering a ride matches the passenger on that corridor (Ayesha)", !!ayesha, summarize(q4));
  check(
    "Offering excludes every other vehicle owner",
    q4.every(
      (m) =>
        m.candidateUserId !== "usr-zara-nust" &&
        m.candidateUserId !== "usr-hamza-fast" &&
        m.candidateUserId !== "usr-bilal-comsats"
    )
  );
  if (ayesha) {
    check(
      "Driver match: current user is the owner",
      ayesha.ownerUserId === "usr-test-self"
    );
    check(
      "Driver match: owner rides free, passenger pays per-km",
      ayesha.fareSplit.find((f) => f.user_id === "usr-test-self")?.total_fare === 0 &&
        (ayesha.fareSplit.find((f) => f.user_id === "usr-ayesha-qau")?.total_fare ?? 0) > 0
    );
    check("Driver match: vehicle type follows the driver's declaration", ayesha.vehicleType === "car");
  }

  console.log("\n── Part 5: split a Yango/inDrive cab ──");

  const q5 = buildMockMatches(opts({ vehicleType: "ride_hailing", rideHailingFarePkr: 900 }));
  console.log(`  [diag] F-10→NUST split-cab 900: ${summarize(q5)}`);
  check("Split-cab mode returns matches", q5.length >= 1, `got ${q5.length}`);
  check(
    "Split-cab matches are shared_ride_hailing with no owner and vehicle ride_hailing",
    q5.every(
      (m) => m.matchType === "shared_ride_hailing" && m.ownerUserId === undefined && m.vehicleType === "ride_hailing"
    )
  );
  check(
    "Quoted fare conserves exactly across riders (shares sum to total)",
    q5.every(
      (m) => m.sharedFarePkr === 900 && Math.abs(m.fareSplit.reduce((s, f) => s + f.total_fare, 0) - 900) < 0.01
    )
  );
  const zaraCab = q5.find((m) => m.candidateUserId === "usr-zara-nust");
  const zaraSelfShare = zaraCab?.fareSplit.find((f) => f.user_id === "usr-test-self")?.total_fare ?? 0;
  const zaraCandShare = zaraCab?.fareSplit.find((f) => f.user_id === "usr-zara-nust")?.total_fare ?? 0;
  check(
    "Km-weighted split: both riders pay > 0 and sum to 900",
    !!zaraCab && zaraSelfShare > 0 && zaraCandShare > 0 && Math.abs(zaraSelfShare + zaraCandShare - 900) < 0.01,
    `self=${zaraSelfShare} cand=${zaraCandShare}`
  );
  const q5odd = buildMockMatches(opts({ vehicleType: "ride_hailing", rideHailingFarePkr: 901 }));
  check(
    "Odd quote never loses a rupee (shares sum to 901)",
    q5odd.every((m) => Math.abs(m.fareSplit.reduce((s, f) => s + f.total_fare, 0) - 901) < 0.01)
  );
  const q5none = buildMockMatches(opts({ vehicleType: "ride_hailing" }));
  check("Split-cab without a fare quote returns nothing", q5none.length === 0);

  console.log("\n── Part 6: verified-only filter ──");

  const q7 = buildMockMatches(opts({ origin: F11_MARKAZ, destination: G9_MARKAZ, currentUserGender: "male" }));
  console.log(`  [diag] F-11→G-9 male join-driver: ${summarize(q7)}`);
  check(
    "Unverified Bilal matches his own corridor (F-11→G-9 bike owner)",
    q7.some((m) => m.candidateUserId === "usr-bilal-comsats"),
    summarize(q7)
  );
  const q7v = buildMockMatches(
    opts({ origin: F11_MARKAZ, destination: G9_MARKAZ, currentUserGender: "male", verifiedOnly: true })
  );
  console.log(`  [diag] F-11→G-9 verified-only: ${summarize(q7v)}`);
  check(
    "Verified-only filter drops unverified Bilal",
    !q7v.some((m) => m.candidateUserId === "usr-bilal-comsats"),
    summarize(q7v)
  );

  console.log(`\n📋 Mock Candidate Tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("❌ Some mock candidate tests failed.");
    process.exit(1);
  }
  console.log("🎉 All Mock Candidate Tests Passed!\n");
}

run();
