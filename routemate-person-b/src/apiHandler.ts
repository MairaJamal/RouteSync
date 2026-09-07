import { Router, Request, Response, NextFunction } from "express";
import { createClient } from "@supabase/supabase-js";
import { evaluateFullMatch } from "./matchPipeline";
import { canAddPassenger } from "./poolingCapacity";
import { getRoute } from "./osrmClient";
import { estimateSoloFares } from "./fareEstimates";
import {
  validateEmergencyContact,
  normalizePhoneInput,
  validateRatingInput,
  isValidReportReason,
  MAX_EMERGENCY_CONTACTS,
} from "./safety";
import { matchVerifiedDomain } from "./verification";
import { TripRequest, RideWithBookings, RideBooking, RatingSummary } from "./types";
import { co2SavedSummary } from "./carbonImpact";
import {
  isValidPakistaniCnic,
  isValidVehiclePlate,
  normalizeCnic,
  normalizeVehiclePlate,
  maskCnicToLast4,
} from "./vehicleDeclaration";
import {
  getStoredVehicleDeclaration,
  upsertStoredVehicleDeclaration,
} from "./vehicleDeclarationStore";
import { requireAuth, requireBodyFieldMatchesAuth, requireQueryFieldMatchesAuth } from "./auth";
import { parseTripRequestText } from "./nlpParser";
import {
  upsertMatchChat,
  getMatchChat,
  listMatchChatsForUser,
  addMatchChatMessage,
  userCanAccessChat,
  grantChatAccessIfAlias,
} from "./chatStore";
import {
  upsertIdentityProfile,
  getIdentityProfilePublic,
  getStoredCnic,
  IdDocumentType,
} from "./identityStore";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    "[apiHandler] Missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY. " +
      "Copy .env.example to .env and fill in your project's values."
  );
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ─────────────────────────────────────────────────────────────
// Day 7: DB capability probe. The Day 7 migrations add new tables and
// columns; until they're applied to a Supabase project, endpoints that
// need them answer with a clear DB_MIGRATION_PENDING error instead of a
// raw Postgres failure, and the matches endpoint simply skips the new
// filters/enrichments. Probed once per process (restart or POST
// /api/admin/refresh-db-capabilities after applying the migrations).
// ─────────────────────────────────────────────────────────────

interface DbCapabilities {
  requireDriverGenderMatchCol: boolean;
  vehicleTypeCol: boolean;
  userVerifiedCols: boolean;
  emergencyContactsTable: boolean;
  sosEventsTable: boolean;
  ratingsTable: boolean;
  userReportsTable: boolean;
  blockedUsersTable: boolean;
  ridesTable: boolean;
  rideConsentsTable: boolean;
  carbonSavingsTable: boolean;
  notificationsTable: boolean;
  rideHailingFareCol: boolean;
  driverVehicleDeclarationsTable: boolean;
}

async function probeRelation(select: string, table: string): Promise<boolean> {
  const { error } = await supabase.from(table).select(select).limit(1);
  return !error;
}

async function probeDbCapabilities(): Promise<DbCapabilities> {
  const [
    requireDriverGenderMatchCol,
    vehicleTypeCol,
    userVerifiedCols,
    emergencyContactsTable,
    sosEventsTable,
    ratingsTable,
    userReportsTable,
    blockedUsersTable,
    ridesTable,
    rideConsentsTable,
    carbonSavingsTable,
  ] = await Promise.all([
    probeRelation("require_driver_gender_match", "trip_requests"),
    probeRelation("vehicle_type", "trip_requests"),
    probeRelation("is_verified", "users"),
    probeRelation("id", "emergency_contacts"),
    probeRelation("id", "sos_events"),
    probeRelation("id", "ratings"),
    probeRelation("id", "user_reports"),
    probeRelation("id", "blocked_users"),
    probeRelation("id", "rides"),
    probeRelation("id", "ride_consents"),
    probeRelation("id", "carbon_savings"),
  ]);
  const notificationsTable = await probeRelation("id", "notifications");
  const rideHailingFareCol = await probeRelation("ride_hailing_fare_pkr", "trip_requests");
  const driverVehicleDeclarationsTable = await probeRelation("user_id", "driver_vehicle_declarations");
  return {
    requireDriverGenderMatchCol,
    vehicleTypeCol,
    userVerifiedCols,
    emergencyContactsTable,
    sosEventsTable,
    ratingsTable,
    userReportsTable,
    blockedUsersTable,
    ridesTable,
    rideConsentsTable,
    carbonSavingsTable,
    notificationsTable,
    rideHailingFareCol,
    driverVehicleDeclarationsTable,
  };
}

let capsPromise: Promise<DbCapabilities> | null = null;
function getDbCapabilities(force = false): Promise<DbCapabilities> {
  if (!capsPromise || force) capsPromise = probeDbCapabilities();
  return capsPromise;
}

// Best-effort sweep of stale pending_consent bookings, called
// opportunistically before any read or vote on ride_consents. A
// separate pg_cron job (see 20260905000000_consent_expiry.sql) covers
// this proactively when available, but that's optional — this call
// is what actually guarantees a rider never sees, or votes on, a
// booking whose deadline has already passed. Failure here is
// non-fatal: worst case a stale row is visible for a few more seconds
// until the next call catches it, not a broken request.
async function expireStaleConsents(): Promise<void> {
  try {
    await supabase.rpc("expire_stale_consent_bookings");
  } catch {
    // Ignore — this is a cleanup nicety, not the point of the request.
  }
  try {
    await supabase.rpc("notify_near_expiry_consents");
  } catch {
    // Same — best-effort, the pg_cron job (if enabled) covers this too.
  }
}

function migrationPending(res: Response, feature: string) {
  return res.status(503).json({
    error: "DB_MIGRATION_PENDING",
    details:
      `${feature} isn't available yet: the Day 7 migration that creates it hasn't been ` +
      "applied to this Supabase project. Run supabase/migrations/20260901* (see README " +
      "Day 7), then restart the API server or POST /api/admin/refresh-db-capabilities.",
  });
}

// Strongly typed row mapping helper
function mapToTripRequest(row: Record<string, any>): TripRequest {
  return {
    request_id: row.id,
    user_id: row.user_id,
    user_name: row.users?.display_name ?? String(row.user_id).slice(0, 8),
    user_gender: row.users?.gender ?? "male",
    gender_preference: row.preference,
    require_driver_gender_match: Boolean(row.require_driver_gender_match),
    vehicle_type: (row.vehicle_type as TripRequest["vehicle_type"]) ?? "none",
    ride_hailing_fare_pkr:
      row.ride_hailing_fare_pkr != null ? Number(row.ride_hailing_fare_pkr) : undefined,
    origin: {
      lat: Number(row.origin_lat),
      lng: Number(row.origin_lng),
      address_label: row.origin_address_label ?? "Unnamed origin",
    },
    destination: {
      lat: Number(row.destination_lat),
      lng: Number(row.destination_lng),
      address_label: row.destination_address_label ?? "Unnamed destination",
    },
    status: row.status,
  };
}

function mapToRideWithBookings(
  rideRow: Record<string, any>,
  bookingRows: Record<string, any>[]
): RideWithBookings {
  const passengers: RideBooking[] = bookingRows.map((b) => ({
    id: b.id,
    ride_id: b.ride_id,
    passenger_id: b.passenger_id,
    pickup_point: {
      lat: Number(b.pickup_lat),
      lng: Number(b.pickup_lng),
      address_label: b.pickup_label ?? "",
    },
    dropoff_point: {
      lat: Number(b.dropoff_lat),
      lng: Number(b.dropoff_lng),
      address_label: b.dropoff_label ?? "",
    },
    seats_requested: b.seats_requested,
    max_co_passengers: b.max_co_passengers ?? -1,
    status: b.status,
  }));

  return {
    id: rideRow.id,
    driver_id: rideRow.driver_id,
    origin: {
      lat: Number(rideRow.origin_lat),
      lng: Number(rideRow.origin_lng),
      address_label: rideRow.origin_label ?? "",
    },
    destination: {
      lat: Number(rideRow.destination_lat),
      lng: Number(rideRow.destination_lng),
      address_label: rideRow.destination_label ?? "",
    },
    departure_time: rideRow.departure_time,
    total_seats: rideRow.total_seats,
    available_seats: rideRow.available_seats,
    driver_max_co_passengers: rideRow.driver_max_co_passengers ?? -1,
    status: rideRow.status,
    passengers,
  };
}

/** Aggregate raw rating rows into per-user summaries (1-decimal average). */
function aggregateRatingRows(rows: { rated_user_id: string; stars: number }[]): Record<string, RatingSummary> {
  const acc: Record<string, { total: number; count: number }> = {};
  for (const r of rows) {
    const entry = (acc[r.rated_user_id] ??= { total: 0, count: 0 });
    entry.total += r.stars;
    entry.count += 1;
  }
  const out: Record<string, RatingSummary> = {};
  for (const [userId, { total, count }] of Object.entries(acc)) {
    out[userId] = { avg_stars: Math.round((total / count) * 10) / 10, rating_count: count };
  }
  return out;
}

export const matchesRouter = Router();

// ─────────────────────────────────────────────────────────────
// Qwen-powered natural-language trip request parsing. This is a pure
// text-in/structured-JSON-out endpoint — it never touches the database
// and never resolves place names to coordinates itself (see nlpParser.ts
// for why). The frontend geocodes the returned origin_text/destination_text
// via the existing Photon flow (frontend/places.ts) before creating an
// actual trip_requests row through POST /api/trip-requests.
// ─────────────────────────────────────────────────────────────
matchesRouter.post("/api/trip-requests/parse", requireAuth, async (req: Request, res: Response) => {
  const { text } = req.body;
  if (typeof text !== "string" || text.trim().length === 0) {
    return res.status(400).json({ error: "MISSING_TEXT" });
  }
  if (text.length > 500) {
    return res.status(400).json({ error: "TEXT_TOO_LONG" });
  }

  const parsed = await parseTripRequestText(text);
  return res.json(parsed);
});

matchesRouter.post(
  "/api/trip-requests",
  requireAuth,
  requireBodyFieldMatchesAuth("user_id"),
  async (req: Request, res: Response) => {
  const {
    origin,
    destination,
    requested_departure_at,
    window_minutes,
    preference,
    require_driver_gender_match,
    vehicle_type,
  } = req.body;

  // Identity comes from the verified JWT. Resolve the public.users row
  // (id may equal auth.uid(), or be linked via auth_user_id).
  const authUserId = req.auth!.userId;

  if (!origin?.lat || !origin?.lng || !destination?.lat || !destination?.lng) {
    return res.status(400).json({ error: "MISSING_REQUIRED_FIELDS" });
  }
  if (vehicle_type !== undefined && !["none", "car", "bike", "ride_hailing"].includes(vehicle_type)) {
    return res.status(400).json({ error: "INVALID_VEHICLE_TYPE" });
  }
  const { ride_hailing_fare_pkr } = req.body;
  if (vehicle_type === "ride_hailing" && (typeof ride_hailing_fare_pkr !== "number" || !(ride_hailing_fare_pkr > 0))) {
    return res.status(400).json({ error: "RIDE_HAILING_FARE_REQUIRED" });
  }

  const caps = await getDbCapabilities();
  const wantsDriverGenderMatch = require_driver_gender_match === true;
  if (wantsDriverGenderMatch && !caps.requireDriverGenderMatchCol) {
    return migrationPending(res, "The 'require driver gender match' safety option");
  }
  const hasVehicleType = typeof vehicle_type === "string";
  const wantsVehicleType = hasVehicleType && vehicle_type !== "none";
  if (wantsVehicleType && !caps.vehicleTypeCol) {
    return migrationPending(res, "The 'I have a car/bike' vehicle option");
  }
  if (vehicle_type === "ride_hailing" && !caps.rideHailingFareCol) {
    return migrationPending(res, "The shared Yango/inDrive/Careem fare-split option");
  }

  // Prefer the profile linked to this auth user; create one if signup
  // never managed to write the public.users row (RLS / race).
  let appUserId: string | null = null;
  {
    const { data: byId } = await supabase
      .from("users")
      .select("id")
      .eq("id", authUserId)
      .maybeSingle();
    if (byId?.id) {
      appUserId = byId.id;
    } else {
      const { data: byAuth } = await supabase
        .from("users")
        .select("id")
        .eq("auth_user_id", authUserId)
        .maybeSingle();
      if (byAuth?.id) {
        appUserId = byAuth.id;
      }
    }
  }
  if (!appUserId) {
    const { error: profileErr } = await supabase.from("users").insert({
      id: authUserId,
      auth_user_id: authUserId,
      display_name: "RouteSync User",
      gender: "female",
    });
    if (profileErr) {
      return res.status(500).json({
        error: "USER_PROFILE_MISSING",
        details: profileErr.message,
      });
    }
    appUserId = authUserId;
  }

  // Keep a single active request per user so re-searches replace the old
  // posting instead of leaving stale candidates that confuse matching.
  await supabase
    .from("trip_requests")
    .update({ status: "cancelled" })
    .eq("user_id", appUserId)
    .eq("status", "active");

  const insertRow: Record<string, any> = {
    user_id: appUserId,
    origin_lat: origin.lat,
    origin_lng: origin.lng,
    origin_address_label: origin.address_label ?? "Unnamed origin",
    destination_lat: destination.lat,
    destination_lng: destination.lng,
    destination_address_label: destination.address_label ?? "Unnamed destination",
    requested_departure_at: requested_departure_at ?? new Date().toISOString(),
    window_minutes: window_minutes ?? 60,
    preference: preference ?? "any",
    status: "active",
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
  // Only ever send Day 7/8 columns when they're actually used — requests
  // that don't touch these flags keep working even on pre-migration DBs.
  if (wantsDriverGenderMatch) insertRow.require_driver_gender_match = true;
  if (caps.vehicleTypeCol && hasVehicleType) insertRow.vehicle_type = vehicle_type;
  if (vehicle_type === "ride_hailing") insertRow.ride_hailing_fare_pkr = ride_hailing_fare_pkr;

  const { data, error } = await supabase.from("trip_requests").insert(insertRow).select().single();

  if (error || !data) {
    return res.status(500).json({ error: "TRIP_REQUEST_CREATE_FAILED", details: error?.message });
  }

  return res.status(201).json({ trip_request_id: data.id });
});

matchesRouter.get("/api/trip-requests/:id/matches", async (req: Request, res: Response) => {
  const tripRequestId = req.params.id;
  const verifiedOnly = req.query.verified_only === "true" || req.query.verified_only === "1";

  const caps = await getDbCapabilities();

  const userSelect: string = caps.userVerifiedCols
    ? "*,users(display_name,gender,is_verified)"
    : "*,users(display_name,gender)";

  const { data: targetRow, error: targetError } = await supabase
    .from("trip_requests")
    .select(userSelect)
    .eq("id", tripRequestId)
    .single();

  if (targetError || !targetRow) {
    return res.status(404).json({ error: "TRIP_REQUEST_NOT_FOUND" });
  }

  const targetReq = mapToTripRequest(targetRow);
  const targetRowData = targetRow as Record<string, any>;

  let requesterSolo: { distance_m: number; duration_s: number } | null = null;
  try {
    const soloRoute = await getRoute([targetReq.origin, targetReq.destination]);
    requesterSolo = { distance_m: soloRoute.distance_m, duration_s: soloRoute.duration_s };
  } catch {
    requesterSolo = null;
  }
  const soloFareEstimates = requesterSolo
    ? estimateSoloFares(requesterSolo.distance_m, requesterSolo.duration_s)
    : [];

  // Pull active peer requests and let the OSRM pipeline decide overlap
  // (50% floor). The old RPC pre-filtered at 75% straight-line overlap,
  // which dropped most real partial corridor matches before scoring.
  const { data: activePeerRows, error: peersError } = await supabase
    .from("trip_requests")
    .select(userSelect)
    .eq("status", "active")
    .gt("expires_at", new Date().toISOString())
    .neq("id", tripRequestId)
    .limit(100);

  if (peersError) {
    return res.status(500).json({ error: "CANDIDATE_FETCH_FAILED", details: peersError.message });
  }

  const BBOX_DEG = 0.05; // ~5km — coarse proximity before OSRM scoring
  function near(aLat: number, aLng: number, bLat: number, bLng: number) {
    return Math.abs(aLat - bLat) <= BBOX_DEG && Math.abs(aLng - bLng) <= BBOX_DEG;
  }
  function timeWindowsOverlap(
    aAt: string,
    aWindow: number,
    bAt: string,
    bWindow: number
  ): boolean {
    const a = new Date(aAt).getTime();
    const b = new Date(bAt).getTime();
    if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
    const aW = Math.max(0, Number(aWindow) || 0) * 60_000;
    const bW = Math.max(0, Number(bWindow) || 0) * 60_000;
    return a <= b + bW && b <= a + aW;
  }

  const responseExtras: Record<string, any> = {
    trip_request_id: tripRequestId,
    requester_solo: requesterSolo,
    solo_fare_estimates: soloFareEstimates,
  };
  if (verifiedOnly && !caps.userVerifiedCols) {
    // Never silently pretend a safety filter was applied.
    responseExtras.verified_only_unavailable = true;
  }

  const candidateRows = (activePeerRows ?? []).filter((row: Record<string, any>) => {
    const originNear = near(
      Number(row.origin_lat),
      Number(row.origin_lng),
      Number(targetRowData.origin_lat),
      Number(targetRowData.origin_lng)
    );
    const destNear = near(
      Number(row.destination_lat),
      Number(row.destination_lng),
      Number(targetRowData.destination_lat),
      Number(targetRowData.destination_lng)
    );
    if (!originNear && !destNear) return false;
    return timeWindowsOverlap(
      String(targetRowData.requested_departure_at),
      Number(targetRowData.window_minutes ?? 60),
      String(row.requested_departure_at),
      Number(row.window_minutes ?? 60)
    );
  });

  if (candidateRows.length === 0) {
    return res.json({ matches: [], ...responseExtras });
  }

  // Day 7: mutual block exclusion — if EITHER side blocked the other,
  // the blocked pairing disappears from both users' match results.
  const excludedUserIds = new Set<string>();
  if (caps.blockedUsersTable) {
    const { data: blockRows } = await supabase
      .from("blocked_users")
      .select("blocker_id, blocked_id")
      .or(`blocker_id.eq.${targetReq.user_id},blocked_id.eq.${targetReq.user_id}`);
    for (const b of blockRows ?? []) {
      excludedUserIds.add(b.blocker_id === targetReq.user_id ? b.blocked_id : b.blocker_id);
    }
  }

  const visibleCandidates = candidateRows.filter((row: Record<string, any>) => {
    if (row.user_id === targetReq.user_id) return false;
    if (excludedUserIds.has(row.user_id)) return false;
    if (verifiedOnly && caps.userVerifiedCols && row.users?.is_verified !== true) return false;
    return true;
  });

  // Day 7: star averages for every visible candidate (empty when the
  // ratings migration is pending — MatchCard renders "No ratings yet").
  let ratingSummaries: Record<string, RatingSummary> = {};
  const candidateUserIds = [...new Set(visibleCandidates.map((r: Record<string, any>) => r.user_id))];
  if (caps.ratingsTable && candidateUserIds.length > 0) {
    const { data: ratingRows } = await supabase
      .from("ratings")
      .select("rated_user_id, stars")
      .in("rated_user_id", candidateUserIds);
    if (ratingRows) ratingSummaries = aggregateRatingRows(ratingRows as any);
  }

  const results = await Promise.all(
    visibleCandidates.map(async (row: Record<string, any>) => {
      const candidateReq = mapToTripRequest(row);
      try {
        const result = await evaluateFullMatch(targetReq, candidateReq);
        return { row, candidateReq, result };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "PIPELINE_ERROR";
        return { row, candidateReq, result: null, error: message };
      }
    })
  );

  // Day 12: self-declared vehicle plate for whichever rider is bringing
  // the car/bike in an owner_passenger match — batched the same way as
  // ratingSummaries above. Only fetched for cases where the CANDIDATE
  // is the owner (i.e. relevant to "me" as the one being picked up);
  // "my own" declaration isn't useful to show back to myself here.
  let ownerVehicleByUserId: Record<string, { vehicle_plate: string; vehicle_make_model: string | null }> = {};
  const ownerIdsNeedingLookup = [
    ...new Set(
      results
        .filter(
          (r): r is { row: Record<string, any>; candidateReq: TripRequest; result: NonNullable<typeof r.result> } =>
            Boolean(r.result?.should_match)
        )
        .map((r) => r.candidateReq.user_id)
    ),
  ];

  if (caps.driverVehicleDeclarationsTable && ownerIdsNeedingLookup.length > 0) {
    const { data: declarationRows } = await supabase
      .from("driver_vehicle_declarations_public")
      .select("user_id, vehicle_plate, vehicle_make_model")
      .in("user_id", ownerIdsNeedingLookup);
    for (const d of declarationRows ?? []) {
      ownerVehicleByUserId[d.user_id] = { vehicle_plate: d.vehicle_plate, vehicle_make_model: d.vehicle_make_model };
    }
  }

  for (const uid of ownerIdsNeedingLookup) {
    if (!ownerVehicleByUserId[uid]) {
      const stored = getStoredVehicleDeclaration(uid);
      if (stored) {
        ownerVehicleByUserId[uid] = {
          vehicle_plate: stored.vehiclePlate,
          vehicle_make_model: stored.vehicleMakeModel,
        };
      }
    }
  }

  const matches = results
    .filter(
      (r): r is { row: Record<string, any>; candidateReq: TripRequest; result: NonNullable<typeof r.result> } =>
        Boolean(r.result?.should_match)
    )
    .map(({ row, candidateReq, result }) => ({
      candidate_request_id: candidateReq.request_id,
      candidate_user_id: candidateReq.user_id,
      candidate_display_name: candidateReq.user_name,
      candidate_preference: candidateReq.gender_preference,
      candidate_origin_label: candidateReq.origin.address_label,
      candidate_destination_label: candidateReq.destination.address_label,
      candidate_is_verified: caps.userVerifiedCols ? row.users?.is_verified === true : false,
      candidate_verified_domain: caps.userVerifiedCols ? row.users?.verified_domain ?? null : null,
      candidate_rating: ratingSummaries[candidateReq.user_id] ?? { avg_stars: 0, rating_count: 0 },
      overlap_pct: result.overlap_pct,
      detour_added_minutes: result.detour_added_minutes,
      fare_split: result.fare_split,
      match_type: result.match_type,
      owner_user_id: result.owner_user_id,
      passenger_user_id: result.passenger_user_id,
      vehicle_type: result.vehicle_type,
      shared_fare_pkr: result.shared_fare_pkr,
      shared_fare_note: result.shared_fare_note,
      owner_vehicle_declared: Boolean(ownerVehicleByUserId[candidateReq.user_id]),
      owner_vehicle_plate: ownerVehicleByUserId[candidateReq.user_id]?.vehicle_plate ?? null,
      owner_vehicle_make_model: ownerVehicleByUserId[candidateReq.user_id]?.vehicle_make_model ?? null,
      legs: result.legs,
      route_geometry: {
        requester: result.requester_route_geometry,
        candidate: result.candidate_route_geometry,
        combined: result.combined_route_geometry,
      },
    }))
    .sort((a, b) => b.overlap_pct - a.overlap_pct);

  return res.json({ matches, ...responseExtras });
});

// ─────────────────────────────────────────────────────────────
// Day 7 Feature 3: user profile summary (badge + rating) and the
// zero-cost student verification flow.
// ─────────────────────────────────────────────────────────────

matchesRouter.get("/api/users/:id/profile", async (req: Request, res: Response) => {
  const caps = await getDbCapabilities();
  // Plain `string` on purpose: supabase-js' type-level select parser only
  // handles static literals; a ternary union produces ParserError types.
  const selectCols: string = caps.userVerifiedCols
    ? "id,display_name,gender,is_verified,verified_domain"
    : "id,display_name,gender";

  const { data, error } = await supabase
    .from("users")
    .select(selectCols)
    .eq("id", req.params.id)
    .single();

  // A plain-string select is untyped in supabase-js; treat the row as a
  // loose record like the rest of this handler does.
  const userRow = data as Record<string, any> | null;

  if (error || !userRow) {
    return res.status(404).json({ error: "USER_NOT_FOUND" });
  }

  let rating: RatingSummary | null = null;
  if (caps.ratingsTable) {
    const { data: ratingRows } = await supabase
      .from("ratings")
      .select("stars")
      .eq("rated_user_id", req.params.id);
    if (ratingRows && ratingRows.length > 0) {
      const total = ratingRows.reduce((sum, r) => sum + Number(r.stars), 0);
      rating = {
        avg_stars: Math.round((total / ratingRows.length) * 10) / 10,
        rating_count: ratingRows.length,
      };
    }
  }

  return res.json({
    id: userRow.id,
    display_name: userRow.display_name,
    gender: userRow.gender,
    is_verified: caps.userVerifiedCols ? userRow.is_verified === true : false,
    verified_domain: caps.userVerifiedCols ? userRow.verified_domain ?? null : null,
    rating,
  });
});

/**
 * Zero-cost verification: reuses Supabase Auth's own confirmation email.
 * The linked auth user's email must be confirmed AND its domain must be on
 * the allowlist (src/verification.ts). No third-party service, no new
 * email-sending code.
 */
matchesRouter.post(
  "/api/verify-student",
  requireAuth,
  requireBodyFieldMatchesAuth("user_id"),
  async (req: Request, res: Response) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: "MISSING_REQUIRED_FIELDS" });

  const caps = await getDbCapabilities();
  if (!caps.userVerifiedCols) return migrationPending(res, "Student verification");

  const { data: userRow, error } = await supabase
    .from("users")
    .select("id, auth_user_id, is_verified, verified_domain")
    .eq("id", user_id)
    .single();

  if (error || !userRow) return res.status(404).json({ error: "USER_NOT_FOUND" });

  if (userRow.is_verified) {
    return res.json({ is_verified: true, verified_domain: userRow.verified_domain });
  }

  if (!userRow.auth_user_id) {
    return res.status(409).json({
      error: "NO_AUTH_EMAIL",
      details:
        "This profile isn't linked to a Supabase Auth account, so there's no email to verify. " +
        "Sign up with a university email and the badge is granted automatically after confirmation.",
    });
  }

  const { data: authUser, error: authError } = await supabase.auth.admin.getUserById(userRow.auth_user_id);
  if (authError || !authUser?.user?.email) {
    return res.status(502).json({ error: "AUTH_LOOKUP_FAILED", details: authError?.message });
  }

  if (!authUser.user.email_confirmed_at) {
    return res.status(409).json({
      error: "EMAIL_NOT_CONFIRMED",
      details: "Confirm the email Supabase Auth sent you, then try again.",
    });
  }

  const matchedDomain = matchVerifiedDomain(authUser.user.email);
  if (!matchedDomain) {
    return res.status(422).json({
      error: "DOMAIN_NOT_ON_ALLOWLIST",
      details: "That email domain isn't a recognized Pakistani university/institution domain.",
    });
  }

  const { error: updateError } = await supabase
    .from("users")
    .update({ is_verified: true, verified_domain: matchedDomain })
    .eq("id", user_id);

  if (updateError) {
    return res.status(500).json({ error: "VERIFICATION_UPDATE_FAILED", details: updateError.message });
  }

  return res.json({ is_verified: true, verified_domain: matchedDomain });
});

// ─────────────────────────────────────────────────────────────
// Day 7 Feature 2: emergency contacts + SOS audit trail.
// ─────────────────────────────────────────────────────────────

matchesRouter.get(
  "/api/emergency-contacts",
  requireAuth,
  requireQueryFieldMatchesAuth("user_id"),
  async (req: Request, res: Response) => {
  const userId = req.query.user_id as string | undefined;
  if (!userId) return res.status(400).json({ error: "MISSING_REQUIRED_FIELDS" });

  const caps = await getDbCapabilities();
  if (!caps.emergencyContactsTable) return migrationPending(res, "Emergency contacts");

  const { data, error } = await supabase
    .from("emergency_contacts")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  if (error) return res.status(500).json({ error: "CONTACTS_FETCH_FAILED", details: error.message });
  return res.json({ contacts: data ?? [] });
});

matchesRouter.post(
  "/api/emergency-contacts",
  requireAuth,
  requireBodyFieldMatchesAuth("user_id"),
  async (req: Request, res: Response) => {
  const { user_id, contact_name, contact_phone } = req.body;
  if (!user_id) return res.status(400).json({ error: "MISSING_REQUIRED_FIELDS" });

  const caps = await getDbCapabilities();
  if (!caps.emergencyContactsTable) return migrationPending(res, "Emergency contacts");

  const validationError = validateEmergencyContact(contact_name, contact_phone);
  if (validationError) return res.status(400).json({ error: validationError });

  const { count, error: countError } = await supabase
    .from("emergency_contacts")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user_id);

  if (countError) return res.status(500).json({ error: "CONTACTS_FETCH_FAILED", details: countError.message });
  if ((count ?? 0) >= MAX_EMERGENCY_CONTACTS) {
    return res.status(409).json({ error: "EMERGENCY_CONTACT_LIMIT_REACHED" });
  }

  const { data, error } = await supabase
    .from("emergency_contacts")
    .insert({
      user_id,
      contact_name: String(contact_name).trim(),
      contact_phone: normalizePhoneInput(String(contact_phone)),
    })
    .select()
    .single();

  if (error) {
    const msg = error.message ?? "";
    if (msg.includes("emergency_contacts_user_id_contact_phone_key")) {
      return res.status(409).json({ error: "DUPLICATE_CONTACT_PHONE" });
    }
    return res.status(500).json({ error: "CONTACT_CREATE_FAILED", details: error.message });
  }

  return res.status(201).json({ contact: data });
});

matchesRouter.delete(
  "/api/emergency-contacts/:id",
  requireAuth,
  requireQueryFieldMatchesAuth("user_id"),
  async (req: Request, res: Response) => {
  const userId = req.query.user_id as string | undefined;
  if (!userId) return res.status(400).json({ error: "MISSING_REQUIRED_FIELDS" });

  const caps = await getDbCapabilities();
  if (!caps.emergencyContactsTable) return migrationPending(res, "Emergency contacts");

  const { error } = await supabase
    .from("emergency_contacts")
    .delete()
    .eq("id", req.params.id)
    .eq("user_id", userId);

  if (error) return res.status(500).json({ error: "CONTACT_DELETE_FAILED", details: error.message });
  return res.json({ deleted: true });
});

/** SOS audit trail. The wa.me alerts themselves open client-side (free,
 *  no gateway); this row exists so the user has their own record. */
matchesRouter.post(
  "/api/sos-events",
  requireAuth,
  requireBodyFieldMatchesAuth("user_id"),
  async (req: Request, res: Response) => {
  const { user_id, trip_request_id, ride_id, lat, lng } = req.body;
  if (!user_id || typeof lat !== "number" || typeof lng !== "number") {
    return res.status(400).json({ error: "MISSING_REQUIRED_FIELDS" });
  }

  const caps = await getDbCapabilities();
  if (!caps.sosEventsTable) return migrationPending(res, "SOS event logging");

  const { data, error } = await supabase
    .from("sos_events")
    .insert({
      user_id,
      trip_request_id: trip_request_id ?? null,
      ride_id: ride_id ?? null,
      lat,
      lng,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: "SOS_EVENT_CREATE_FAILED", details: error.message });
  return res.status(201).json({ sos_event_id: data.id });
});

// ─────────────────────────────────────────────────────────────
// Day 7 Feature 4: ratings, reports, blocks.
// ─────────────────────────────────────────────────────────────

matchesRouter.post(
  "/api/ratings",
  requireAuth,
  requireBodyFieldMatchesAuth("rater_id"),
  async (req: Request, res: Response) => {
  const { ride_id, rater_id, rated_user_id, stars, comment } = req.body;
  if (!ride_id || !rater_id || !rated_user_id) {
    return res.status(400).json({ error: "MISSING_REQUIRED_FIELDS" });
  }
  if (rater_id === rated_user_id) {
    return res.status(400).json({ error: "CANNOT_RATE_SELF" });
  }

  const caps = await getDbCapabilities();
  if (!caps.ratingsTable) return migrationPending(res, "Post-ride ratings");

  const validationError = validateRatingInput(stars, comment);
  if (validationError) return res.status(400).json({ error: validationError });

  const { data, error } = await supabase
    .from("ratings")
    .insert({
      ride_id,
      rater_id,
      rated_user_id,
      stars,
      comment: comment != null ? String(comment).trim() : null,
    })
    .select()
    .single();

  if (error) {
    const msg = error.message ?? "";
    if (msg.includes("ratings_ride_id_rater_id_rated_user_id_key") || msg.includes("duplicate key")) {
      return res.status(409).json({ error: "RATING_ALREADY_EXISTS" });
    }
    return res.status(500).json({ error: "RATING_CREATE_FAILED", details: error.message });
  }

  return res.status(201).json({ rating_id: data.id });
});

matchesRouter.get("/api/users/:id/rating-summary", async (req: Request, res: Response) => {
  const caps = await getDbCapabilities();
  if (!caps.ratingsTable) return migrationPending(res, "Post-ride ratings");

  const { data: ratingRows, error } = await supabase
    .from("ratings")
    .select("stars")
    .eq("rated_user_id", req.params.id);

  if (error) return res.status(500).json({ error: "RATINGS_FETCH_FAILED", details: error.message });

  if (!ratingRows || ratingRows.length === 0) {
    return res.json({ avg_stars: 0, rating_count: 0 });
  }
  const total = ratingRows.reduce((sum, r) => sum + Number(r.stars), 0);
  return res.json({
    avg_stars: Math.round((total / ratingRows.length) * 10) / 10,
    rating_count: ratingRows.length,
  });
});

/** Individual comments are private to the writer and the rated user
 *  (documented default in 20260901000300_ratings_reports_blocks.sql). */
matchesRouter.get(
  "/api/ratings",
  requireAuth,
  requireQueryFieldMatchesAuth("viewer_id"),
  async (req: Request, res: Response) => {
  const ratedUserId = req.query.rated_user_id as string | undefined;
  const viewerId = req.query.viewer_id as string | undefined;
  if (!ratedUserId || !viewerId) return res.status(400).json({ error: "MISSING_REQUIRED_FIELDS" });

  const caps = await getDbCapabilities();
  if (!caps.ratingsTable) return migrationPending(res, "Post-ride ratings");
  if (viewerId !== ratedUserId) {
    // Only the rated user may browse their own rating details; a rater
    // fetches their own rows via the rater_id filter below.
    const { data: ownRows } = await supabase
      .from("ratings")
      .select("*")
      .eq("rated_user_id", ratedUserId)
      .eq("rater_id", viewerId);
    return res.json({ ratings: ownRows ?? [] });
  }

  const { data, error } = await supabase
    .from("ratings")
    .select("*")
    .eq("rated_user_id", ratedUserId)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: "RATINGS_FETCH_FAILED", details: error.message });
  return res.json({ ratings: data ?? [] });
});

matchesRouter.post(
  "/api/user-reports",
  requireAuth,
  requireBodyFieldMatchesAuth("reporter_id"),
  async (req: Request, res: Response) => {
  const { reporter_id, reported_user_id, ride_id, reason, details } = req.body;
  if (!reporter_id || !reported_user_id) {
    return res.status(400).json({ error: "MISSING_REQUIRED_FIELDS" });
  }
  if (reporter_id === reported_user_id) {
    return res.status(400).json({ error: "CANNOT_REPORT_SELF" });
  }
  if (!isValidReportReason(reason)) {
    return res.status(400).json({ error: "INVALID_REPORT_REASON" });
  }
  if (details != null && (typeof details !== "string" || details.trim().length > 500)) {
    return res.status(400).json({ error: "DETAILS_TOO_LONG" });
  }

  const caps = await getDbCapabilities();
  if (!caps.userReportsTable) return migrationPending(res, "User reports");

  const { data, error } = await supabase
    .from("user_reports")
    .insert({
      reporter_id,
      reported_user_id,
      ride_id: ride_id ?? null,
      reason,
      details: details != null ? String(details).trim() : null,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: "REPORT_CREATE_FAILED", details: error.message });
  return res.status(201).json({ report_id: data.id });
});

matchesRouter.post(
  "/api/blocked-users",
  requireAuth,
  requireBodyFieldMatchesAuth("blocker_id"),
  async (req: Request, res: Response) => {
  const { blocker_id, blocked_id } = req.body;
  if (!blocker_id || !blocked_id) return res.status(400).json({ error: "MISSING_REQUIRED_FIELDS" });
  if (blocker_id === blocked_id) return res.status(400).json({ error: "CANNOT_BLOCK_SELF" });

  const caps = await getDbCapabilities();
  if (!caps.blockedUsersTable) return migrationPending(res, "User blocking");

  const { data: existing } = await supabase
    .from("blocked_users")
    .select("id")
    .eq("blocker_id", blocker_id)
    .eq("blocked_id", blocked_id)
    .maybeSingle();

  if (existing) return res.json({ block_id: existing.id, already_blocked: true });

  const { data, error } = await supabase
    .from("blocked_users")
    .insert({ blocker_id, blocked_id })
    .select()
    .single();

  if (error) return res.status(500).json({ error: "BLOCK_CREATE_FAILED", details: error.message });
  return res.status(201).json({ block_id: data.id });
});

matchesRouter.get(
  "/api/blocked-users",
  requireAuth,
  requireQueryFieldMatchesAuth("user_id"),
  async (req: Request, res: Response) => {
  const userId = req.query.user_id as string | undefined;
  if (!userId) return res.status(400).json({ error: "MISSING_REQUIRED_FIELDS" });

  const caps = await getDbCapabilities();
  if (!caps.blockedUsersTable) return migrationPending(res, "User blocking");

  const { data, error } = await supabase
    .from("blocked_users")
    .select("*")
    .or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`);

  if (error) return res.status(500).json({ error: "BLOCKS_FETCH_FAILED", details: error.message });
  return res.json({ blocks: data ?? [] });
});

matchesRouter.delete(
  "/api/blocked-users/:id",
  requireAuth,
  requireQueryFieldMatchesAuth("user_id"),
  async (req: Request, res: Response) => {
  const userId = req.query.user_id as string | undefined;
  if (!userId) return res.status(400).json({ error: "MISSING_REQUIRED_FIELDS" });

  const caps = await getDbCapabilities();
  if (!caps.blockedUsersTable) return migrationPending(res, "User blocking");

  const { error } = await supabase
    .from("blocked_users")
    .delete()
    .eq("id", req.params.id)
    .eq("blocker_id", userId);

  if (error) return res.status(500).json({ error: "BLOCK_DELETE_FAILED", details: error.message });
  return res.json({ deleted: true });
});

// ─────────────────────────────────────────────────────────────
// Day 7 Feature 4 support: ride lifecycle for the rating prompt.
// Confirming a match creates the ride; completing it returns the other
// riders so the frontend can open "Rate your trip" for each of them.
// ─────────────────────────────────────────────────────────────

matchesRouter.post(
  "/api/rides",
  requireAuth,
  requireBodyFieldMatchesAuth("driver_id"),
  async (req: Request, res: Response) => {
  const { driver_id, origin, destination, departure_time } = req.body;
  if (!driver_id || !origin?.lat || !origin?.lng || !destination?.lat || !destination?.lng) {
    return res.status(400).json({ error: "MISSING_REQUIRED_FIELDS" });
  }

  const caps = await getDbCapabilities();
  if (!caps.ridesTable) return migrationPending(res, "Ride creation");

  const { data, error } = await supabase
    .from("rides")
    .insert({
      driver_id,
      origin_lat: origin.lat,
      origin_lng: origin.lng,
      origin_label: origin.address_label ?? null,
      destination_lat: destination.lat,
      destination_lng: destination.lng,
      destination_label: destination.address_label ?? null,
      departure_time: departure_time ?? new Date().toISOString(),
      total_seats: 4,
      available_seats: 4,
      driver_max_co_passengers: 3,
      status: "active",
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: "RIDE_CREATE_FAILED", details: error.message });
  return res.status(201).json({ ride_id: data.id });
});

matchesRouter.post(
  "/api/rides/:id/complete",
  requireAuth,
  requireBodyFieldMatchesAuth("user_id"),
  async (req: Request, res: Response) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: "MISSING_REQUIRED_FIELDS" });

  const caps = await getDbCapabilities();
  if (!caps.ridesTable) return migrationPending(res, "Ride completion");

  const { data: rideRow, error: rideError } = await supabase
    .from("rides")
    .select("*")
    .eq("id", req.params.id)
    .single();

  if (rideError || !rideRow) return res.status(404).json({ error: "RIDE_NOT_FOUND" });

  const { data: bookingRows, error: bookingsError } = await supabase
    .from("ride_bookings")
    .select("*")
    .eq("ride_id", req.params.id);

  if (bookingsError) return res.status(500).json({ error: "BOOKINGS_FETCH_FAILED", details: bookingsError.message });

  const isParticipant =
    rideRow.driver_id === user_id || (bookingRows ?? []).some((b) => b.passenger_id === user_id);
  if (!isParticipant) return res.status(403).json({ error: "NOT_A_RIDE_PARTICIPANT" });

  await supabase.from("rides").update({ status: "completed" }).eq("id", req.params.id);
  await supabase
    .from("ride_bookings")
    .update({ status: "completed" })
    .eq("ride_id", req.params.id)
    .in("status", ["accepted", "pending"]);

  // Day 9: write the CO2-avoided ledger for this ride so every
  // rider's profile running total picks it up, not just a one-off
  // number shown at the fare-estimate stage.
  let carbonSavings: { rider_id: string; co2_saved_kg: number }[] = [];
  if (caps.carbonSavingsTable) {
    try {
      const route = await getRoute([
        { lat: Number(rideRow.origin_lat), lng: Number(rideRow.origin_lng), address_label: rideRow.origin_label ?? "" },
        { lat: Number(rideRow.destination_lat), lng: Number(rideRow.destination_lng), address_label: rideRow.destination_label ?? "" },
      ]);
      const distanceKm = route.distance_m / 1000;

      const { data: savingsRows, error: savingsError } = await supabase.rpc(
        "record_ride_carbon_savings",
        { p_ride_id: req.params.id, p_distance_km: distanceKm }
      );
      if (!savingsError && savingsRows) {
        carbonSavings = savingsRows.map((r: any) => ({
          rider_id: r.rider_id,
          co2_saved_kg: Number(r.co2_saved_kg),
        }));
      }
    } catch {
      // OSRM/route lookup failing shouldn't block ride completion —
      // the trip is still marked completed, we just skip the ledger.
    }
  }

  // Everyone else on the ride is rateable by this user.
  const riderIds = [
    rideRow.driver_id,
    ...(bookingRows ?? []).map((b) => b.passenger_id),
  ].filter((id) => id && id !== user_id);

  const ratableRiders = riderIds.length > 0
    ? await supabase.from("users").select("id,display_name").in("id", riderIds)
    : { data: [] };

  return res.json({
    ride_id: req.params.id,
    status: "completed",
    ratable_riders: (ratableRiders.data ?? []).map((u: any) => ({
      user_id: u.id,
      display_name: u.display_name,
    })),
    carbon_savings: carbonSavings, // [{ rider_id, co2_saved_kg }, ...] — this user's entry is in here too
  });
});

// Re-probe the schema after migrations are applied, without a restart.
matchesRouter.post("/api/admin/refresh-db-capabilities", requireAuth, async (_req: Request, res: Response) => {
  const caps = await getDbCapabilities(true);
  return res.json({ capabilities: caps });
});

// Running "CO2 avoided" total for a rider's profile — sums every
// completed ride's ledger row rather than showing a single share's
// number in isolation.
matchesRouter.get(
  "/api/users/:id/carbon-savings",
  requireAuth,
  (req: Request, res: Response, next: NextFunction) => {
    // This endpoint identifies the rider via the URL param, not a
    // body/query field, so it can't reuse requireBodyFieldMatchesAuth /
    // requireQueryFieldMatchesAuth as-is — same rule, applied to params.
    if (req.auth?.userId !== req.params.id) {
      return res.status(403).json({ error: "USER_ID_MISMATCH" });
    }
    next();
  },
  async (req: Request, res: Response) => {
  const caps = await getDbCapabilities();
  if (!caps.carbonSavingsTable) return migrationPending(res, "Carbon savings history");

  const { data, error } = await supabase
    .from("carbon_savings")
    .select("ride_id, co2_saved_kg, rider_count, distance_km, created_at")
    .eq("rider_id", req.params.id)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: "CARBON_SAVINGS_FETCH_FAILED", details: error.message });

  const rows = data ?? [];
  const totalKg = Number(rows.reduce((sum, r) => sum + Number(r.co2_saved_kg), 0).toFixed(2));

  return res.json({ total_co2_saved_kg: totalKg, rides: rows });
});

/** Personal dashboard aggregate: profile, rating, ride history, CO₂, est. money saved. */
matchesRouter.get(
  "/api/users/:id/dashboard",
  requireAuth,
  async (req: Request, res: Response) => {
    const authId = req.auth!.userId;
    const pathId = String(req.params.id);

    // Allow auth uid or a public.users row linked via auth_user_id.
    let profileId = pathId;
    if (pathId !== authId) {
      const { data: linked } = await supabase
        .from("users")
        .select("id")
        .eq("id", pathId)
        .eq("auth_user_id", authId)
        .maybeSingle();
      if (!linked) {
        return res.status(403).json({ error: "USER_ID_MISMATCH" });
      }
      profileId = linked.id;
    } else {
      const { data: byAuth } = await supabase
        .from("users")
        .select("id")
        .eq("auth_user_id", authId)
        .maybeSingle();
      if (byAuth?.id) profileId = byAuth.id;
    }

    const caps = await getDbCapabilities();
    const ratePerKm = Number(process.env.FARE_RATE_PER_KM ?? 30);

    const profileSelect = caps.userVerifiedCols
      ? "id,display_name,gender,is_verified,verified_domain"
      : "id,display_name,gender";

    const { data: profileRow } = await supabase
      .from("users")
      .select(profileSelect)
      .eq("id", profileId)
      .maybeSingle();

    const profile = {
      display_name: (profileRow as any)?.display_name ?? "RouteSync User",
      gender: ((profileRow as any)?.gender as string) ?? "female",
      is_verified: caps.userVerifiedCols ? (profileRow as any)?.is_verified === true : false,
      verified_domain: caps.userVerifiedCols ? (profileRow as any)?.verified_domain ?? null : null,
    };

    let rating = { avg_stars: 0, rating_count: 0 };
    if (caps.ratingsTable) {
      const { data: ratingRows } = await supabase
        .from("ratings")
        .select("stars")
        .eq("rated_user_id", profileId);
      if (ratingRows && ratingRows.length > 0) {
        const total = ratingRows.reduce((sum, r) => sum + Number(r.stars), 0);
        rating = {
          avg_stars: Math.round((total / ratingRows.length) * 10) / 10,
          rating_count: ratingRows.length,
        };
      }
    }

    const carbonByRide = new Map<
      string,
      { co2_saved_kg: number; rider_count: number; distance_km: number; created_at: string }
    >();
    let totalCo2 = 0;
    let estimatedMoneySaved = 0;

    if (caps.carbonSavingsTable) {
      const { data: carbonRows } = await supabase
        .from("carbon_savings")
        .select("ride_id, co2_saved_kg, rider_count, distance_km, created_at")
        .eq("rider_id", profileId)
        .order("created_at", { ascending: false });

      for (const row of carbonRows ?? []) {
        const co2 = Number(row.co2_saved_kg) || 0;
        const distanceKm = Number(row.distance_km) || 0;
        const riderCount = Math.max(2, Number(row.rider_count) || 2);
        totalCo2 += co2;
        // Est. vs everyone taking a solo car at RATE_PER_KM: you only pay 1/N.
        const soloFare = distanceKm * ratePerKm;
        const saved = soloFare * (1 - 1 / riderCount);
        estimatedMoneySaved += saved;
        carbonByRide.set(row.ride_id, {
          co2_saved_kg: co2,
          rider_count: riderCount,
          distance_km: distanceKm,
          created_at: row.created_at,
        });
      }
    }

    type DashRide = {
      ride_id: string;
      role: "driver" | "passenger";
      status: string;
      origin_label: string;
      destination_label: string;
      departure_time: string | null;
      completed_at: string | null;
      co2_saved_kg: number | null;
      estimated_fare_saved_pkr: number | null;
    };
    const rides: DashRide[] = [];

    if (caps.ridesTable) {
      const { data: driven } = await supabase
        .from("rides")
        .select(
          "id, status, origin_label, destination_label, departure_time, created_at, updated_at"
        )
        .eq("driver_id", profileId)
        .in("status", ["completed", "active", "full"])
        .order("created_at", { ascending: false })
        .limit(40);

      for (const r of driven ?? []) {
        const carbon = carbonByRide.get(r.id);
        const soloFare = carbon ? carbon.distance_km * ratePerKm : 0;
        const saved = carbon ? soloFare * (1 - 1 / carbon.rider_count) : null;
        rides.push({
          ride_id: r.id,
          role: "driver",
          status: r.status,
          origin_label: r.origin_label || "Pickup",
          destination_label: r.destination_label || "Drop-off",
          departure_time: r.departure_time ?? null,
          completed_at: r.status === "completed" ? r.updated_at ?? r.created_at : null,
          co2_saved_kg: carbon?.co2_saved_kg ?? null,
          estimated_fare_saved_pkr: saved != null ? Number(saved.toFixed(0)) : null,
        });
      }

      const { data: bookings } = await supabase
        .from("ride_bookings")
        .select(
          "id, ride_id, status, pickup_label, dropoff_label, created_at, rides(id, status, origin_label, destination_label, departure_time, updated_at, created_at)"
        )
        .eq("passenger_id", profileId)
        .in("status", ["accepted", "completed", "pending"])
        .order("created_at", { ascending: false })
        .limit(40);

      for (const b of bookings ?? []) {
        const ride = (b as any).rides;
        const rideId = b.ride_id;
        if (rides.some((x) => x.ride_id === rideId && x.role === "passenger")) continue;
        const carbon = carbonByRide.get(rideId);
        const soloFare = carbon ? carbon.distance_km * ratePerKm : 0;
        const saved = carbon ? soloFare * (1 - 1 / carbon.rider_count) : null;
        const status = b.status === "completed" || ride?.status === "completed" ? "completed" : b.status;
        rides.push({
          ride_id: rideId,
          role: "passenger",
          status,
          origin_label: b.pickup_label || ride?.origin_label || "Pickup",
          destination_label: b.dropoff_label || ride?.destination_label || "Drop-off",
          departure_time: ride?.departure_time ?? null,
          completed_at: status === "completed" ? ride?.updated_at ?? b.created_at : null,
          co2_saved_kg: carbon?.co2_saved_kg ?? null,
          estimated_fare_saved_pkr: saved != null ? Number(saved.toFixed(0)) : null,
        });
      }
    }

    // If we have carbon rows without matching ride labels, still surface them.
    for (const [rideId, carbon] of carbonByRide) {
      if (rides.some((r) => r.ride_id === rideId)) continue;
      const soloFare = carbon.distance_km * ratePerKm;
      const saved = soloFare * (1 - 1 / carbon.rider_count);
      rides.push({
        ride_id: rideId,
        role: "passenger",
        status: "completed",
        origin_label: "Shared ride",
        destination_label: `${carbon.distance_km.toFixed(1)} km corridor`,
        departure_time: null,
        completed_at: carbon.created_at,
        co2_saved_kg: carbon.co2_saved_kg,
        estimated_fare_saved_pkr: Number(saved.toFixed(0)),
      });
    }

    rides.sort((a, b) => {
      const at = a.completed_at || a.departure_time || "";
      const bt = b.completed_at || b.departure_time || "";
      return bt.localeCompare(at);
    });

    const completedCount = rides.filter((r) => r.status === "completed").length;

    return res.json({
      profile,
      rating,
      stats: {
        ride_count: Math.max(completedCount, rides.length),
        total_co2_saved_kg: Number(totalCo2.toFixed(2)),
        estimated_money_saved_pkr: Number(estimatedMoneySaved.toFixed(0)),
      },
      rides: rides.slice(0, 30),
    });
  }
);

matchesRouter.get("/api/admin/db-capabilities", async (_req: Request, res: Response) => {
  const caps = await getDbCapabilities();
  return res.json({ capabilities: caps });
});

matchesRouter.post(
  "/api/rides/:id/can-add-passenger",
  requireAuth,
  requireBodyFieldMatchesAuth("passenger_id"),
  async (req: Request, res: Response) => {
  const { passenger_id, max_co_passengers, seats_requested, pickup_point, dropoff_point } = req.body;

  if (!passenger_id || max_co_passengers === undefined || !pickup_point || !dropoff_point) {
    return res.status(400).json({ error: "MISSING_REQUIRED_FIELDS" });
  }

  const { data: rideRow, error: rideError } = await supabase
    .from("rides")
    .select("*")
    .eq("id", req.params.id)
    .single();

  if (rideError || !rideRow) {
    return res.status(404).json({ error: "RIDE_NOT_FOUND" });
  }

  const { data: bookingRows, error: bookingsError } = await supabase
    .from("ride_bookings")
    .select("*")
    .eq("ride_id", req.params.id)
    .in("status", ["accepted", "pending"]);

  if (bookingsError) {
    return res.status(500).json({ error: "BOOKINGS_FETCH_FAILED", details: bookingsError.message });
  }

  const ride = mapToRideWithBookings(rideRow, bookingRows ?? []);

  const result = canAddPassenger(
    {
      passenger_id,
      seats_requested: seats_requested ?? 1,
      max_co_passengers,
      pickup_point,
      dropoff_point,
    },
    ride
  );

  return res.json(result);
});

matchesRouter.post(
  "/api/rides/:id/book",
  requireAuth,
  requireBodyFieldMatchesAuth("passenger_id"),
  async (req: Request, res: Response) => {
  const { passenger_id, max_co_passengers, seats_requested, pickup_point, dropoff_point } = req.body;

  if (!passenger_id || max_co_passengers === undefined || !pickup_point || !dropoff_point) {
    return res.status(400).json({ error: "MISSING_REQUIRED_FIELDS" });
  }

  const { data, error } = await supabase.rpc("book_pooled_ride", {
    p_ride_id: req.params.id,
    p_passenger_id: passenger_id,
    p_pickup_lat: pickup_point.lat,
    p_pickup_lng: pickup_point.lng,
    p_pickup_label: pickup_point.address_label ?? null,
    p_dropoff_lat: dropoff_point.lat,
    p_dropoff_lng: dropoff_point.lng,
    p_dropoff_label: dropoff_point.address_label ?? null,
    p_seats_requested: seats_requested ?? 1,
    p_max_co_passengers: max_co_passengers,
  });

  if (error) {
    return res.status(500).json({ error: "BOOKING_RPC_FAILED", details: error.message });
  }

  const outcome = Array.isArray(data) ? data[0] : data;

  if (!outcome?.success) {
    return res.status(409).json({ error: "BOOKING_REJECTED", reason: outcome?.reason ?? "UNKNOWN" });
  }

  // Day 9: a 3+ rider pool doesn't finalize immediately — it's booked
  // as pending_consent and waits on everyone's vote (see
  // /api/rides/:id/bookings/:bookingId/consent below). Tell the caller
  // which case this was so the frontend can show "waiting on group"
  // instead of "you're in" for AWAITING_GROUP_CONSENT.
  return res.status(201).json({
    success: true,
    booking_id: outcome.booking_id,
    status: outcome.reason === "AWAITING_GROUP_CONSENT" ? "pending_consent" : "accepted",
    reason: outcome.reason,
  });
});

matchesRouter.post(
  "/api/rides/:id/bookings/:bookingId/consent",
  requireAuth,
  requireBodyFieldMatchesAuth("rider_id"),
  async (req: Request, res: Response) => {
  const { rider_id, agree } = req.body;
  if (!rider_id || typeof agree !== "boolean") {
    return res.status(400).json({ error: "MISSING_REQUIRED_FIELDS" });
  }

  const caps = await getDbCapabilities();
  if (!caps.rideConsentsTable) return migrationPending(res, "Group ride consent");

  await expireStaleConsents();

  const { data, error } = await supabase.rpc("respond_to_ride_consent", {
    p_booking_id: req.params.bookingId,
    p_rider_id: rider_id,
    p_agree: agree,
  });

  if (error) return res.status(500).json({ error: "CONSENT_RPC_FAILED", details: error.message });

  const outcome = Array.isArray(data) ? data[0] : data;
  if (!outcome?.success) {
    return res.status(409).json({ error: "CONSENT_REJECTED", reason: outcome?.reason ?? "UNKNOWN" });
  }

  return res.json({
    success: true,
    booking_status: outcome.booking_status,
    reason: outcome.reason, // ALL_AGREED | AWAITING_OTHERS | DECLINED
  });
});

// Lets the frontend show "waiting on Ali, Sara..." instead of a bare
// spinner while a pending_consent booking is still being voted on.
matchesRouter.get(
  "/api/rides/:id/bookings/:bookingId/consent",
  requireAuth,
  async (req: Request, res: Response) => {
  const caps = await getDbCapabilities();
  if (!caps.rideConsentsTable) return migrationPending(res, "Group ride consent");

  await expireStaleConsents();

  const { data, error } = await supabase
    .from("ride_consents")
    .select("rider_id, status, responded_at, users:rider_id(display_name)")
    .eq("booking_id", req.params.bookingId);

  if (error) return res.status(500).json({ error: "CONSENT_FETCH_FAILED", details: error.message });

  const votes = data ?? [];
  // Only someone actually in this vote (a rider being asked to agree)
  // may see who else has/hasn't responded — not any authenticated user.
  const isParticipant = votes.some((v: any) => v.rider_id === req.auth?.userId);
  if (!isParticipant) return res.status(403).json({ error: "NOT_A_VOTER_ON_THIS_BOOKING" });

  return res.json({
    votes: votes.map((v: any) => ({
      rider_id: v.rider_id,
      display_name: v.users?.display_name ?? null,
      status: v.status,
      responded_at: v.responded_at,
    })),
  });
});

// ─────────────────────────────────────────────────────────────
// Day 9 (part 2): the UI in front of the group-consent backend.
//   - "Join an existing shared ride" needs a way to browse open
//     rides the current user isn't already on.
//   - The consent vote itself needs a way for a rider to discover
//     "someone wants to join a ride you're already on" without
//     already knowing the ride_id/booking_id — a notification list,
//     not a lookup.
// ─────────────────────────────────────────────────────────────

// Browse rides with open seats that the current user could request to
// join (excludes rides they drive or are already booked/awaiting on).
matchesRouter.get(
  "/api/rides/active",
  requireAuth,
  requireQueryFieldMatchesAuth("viewer_id"),
  async (req: Request, res: Response) => {
  const caps = await getDbCapabilities();
  if (!caps.ridesTable) return migrationPending(res, "Ride discovery");

  const viewerId = req.query.viewer_id as string;

  const { data: rideRows, error: ridesError } = await supabase
    .from("rides")
    .select("*, users:driver_id(display_name, is_verified)")
    .eq("status", "active")
    .gt("available_seats", 0)
    .neq("driver_id", viewerId)
    .order("departure_time", { ascending: true })
    .limit(25);

  if (ridesError) return res.status(500).json({ error: "RIDES_FETCH_FAILED", details: ridesError.message });

  const rideIds = (rideRows ?? []).map((r) => r.id);
  const { data: bookingRows, error: bookingsError } = rideIds.length
    ? await supabase
        .from("ride_bookings")
        .select("ride_id, passenger_id, status")
        .in("ride_id", rideIds)
        .in("status", ["accepted", "pending", "pending_consent"])
    : { data: [] as any[], error: null };

  if (bookingsError) return res.status(500).json({ error: "BOOKINGS_FETCH_FAILED", details: bookingsError.message });

  const bookingsByRide = new Map<string, any[]>();
  for (const b of bookingRows ?? []) {
    if (!bookingsByRide.has(b.ride_id)) bookingsByRide.set(b.ride_id, []);
    bookingsByRide.get(b.ride_id)!.push(b);
  }

  const listings = (rideRows ?? [])
    // Already booked (in any non-cancelled state) on this ride? Don't list it again.
    .filter((r) => !(bookingsByRide.get(r.id) ?? []).some((b) => b.passenger_id === viewerId))
    .map((r) => {
      const activeBookings = bookingsByRide.get(r.id) ?? [];
      const riderCount = activeBookings.length + 1; // +driver
      const distanceKm =
        r.distance_km ??
        // Straight-line fallback so the list has a number even before a
        // real route is fetched; the join flow re-checks with OSRM if needed.
        null;
      return {
        ride_id: r.id,
        driver_display_name: r.users?.display_name ?? "Driver",
        driver_is_verified: Boolean(r.users?.is_verified),
        origin_label: r.origin_label,
        destination_label: r.destination_label,
        departure_time: r.departure_time,
        available_seats: r.available_seats,
        driver_max_co_passengers: r.driver_max_co_passengers,
        current_rider_count: riderCount,
        // Riders after this viewer joins — used by the frontend to warn
        // "this join will need everyone's approval" before they even submit.
        will_need_group_consent: riderCount + 1 >= 3,
        co2_saved_summary: distanceKm ? co2SavedSummary(distanceKm, riderCount + 1) : null,
      };
    });

  return res.json({ rides: listings });
});

// Everything a rider is currently being asked to vote on, across every
// ride — a notification inbox, not a per-booking lookup, since the
// rider doesn't necessarily know which ride/booking triggered the ask.
matchesRouter.get(
  "/api/users/:id/pending-consents",
  requireAuth,
  (req: Request, res: Response, next: NextFunction) => {
    if (req.auth?.userId !== req.params.id) {
      return res.status(403).json({ error: "USER_ID_MISMATCH" });
    }
    next();
  },
  async (req: Request, res: Response) => {
  const caps = await getDbCapabilities();
  if (!caps.rideConsentsTable) return migrationPending(res, "Group ride consent");

  // Sweep first so a booking whose deadline just passed doesn't show
  // up as "awaiting" for one more poll cycle before disappearing.
  await expireStaleConsents();

  const { data, error } = await supabase
    .from("ride_consents")
    .select(
      "id, ride_id, booking_id, requested_at, " +
        "rides:ride_id(origin_label, destination_label, departure_time), " +
        "ride_bookings:booking_id(passenger_id, expires_at, users:passenger_id(display_name))"
    )
    .eq("rider_id", req.params.id)
    .eq("status", "awaiting")
    .order("requested_at", { ascending: true });

  if (error) return res.status(500).json({ error: "PENDING_CONSENTS_FETCH_FAILED", details: error.message });

  return res.json({
    pending: (data ?? []).map((row: any) => ({
      ride_id: row.ride_id,
      booking_id: row.booking_id,
      requested_at: row.requested_at,
      expires_at: row.ride_bookings?.expires_at ?? null,
      origin_label: row.rides?.origin_label,
      destination_label: row.rides?.destination_label,
      departure_time: row.rides?.departure_time,
      joining_rider_name: row.ride_bookings?.users?.display_name ?? "A rider",
    })),
  });
});

// ─────────────────────────────────────────────────────────────
// Day 10: in-app notification feed. See
// supabase/migrations/20260906000000_notifications.sql for why this
// is a feed rather than push/SMS (no device tokens or rider phone
// numbers exist yet).
// ─────────────────────────────────────────────────────────────

matchesRouter.get(
  "/api/users/:id/notifications",
  requireAuth,
  (req: Request, res: Response, next: NextFunction) => {
    if (req.auth?.userId !== req.params.id) {
      return res.status(403).json({ error: "USER_ID_MISMATCH" });
    }
    next();
  },
  async (req: Request, res: Response) => {
    const caps = await getDbCapabilities();
    if (!caps.notificationsTable) return migrationPending(res, "Notifications");

    // Best-effort so anyone who opens their feed also gets swept for
    // reminders/expiries that haven't been caught yet, even on a
    // project without pg_cron enabled.
    await expireStaleConsents();

    const { data, error } = await supabase
      .from("notifications")
      .select("id, kind, title, body, ride_id, booking_id, created_at, read_at")
      .eq("user_id", req.params.id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) return res.status(500).json({ error: "NOTIFICATIONS_FETCH_FAILED", details: error.message });

    const notifications = data ?? [];
    return res.json({
      notifications,
      unread_count: notifications.filter((n: any) => !n.read_at).length,
    });
  }
);

matchesRouter.post(
  "/api/users/:id/notifications/:notificationId/read",
  requireAuth,
  (req: Request, res: Response, next: NextFunction) => {
    if (req.auth?.userId !== req.params.id) {
      return res.status(403).json({ error: "USER_ID_MISMATCH" });
    }
    next();
  },
  async (req: Request, res: Response) => {
    const caps = await getDbCapabilities();
    if (!caps.notificationsTable) return migrationPending(res, "Notifications");

    const { data, error } = await supabase.rpc("mark_notification_read", {
      p_notification_id: req.params.notificationId,
      p_user_id: req.params.id,
    });

    if (error) return res.status(500).json({ error: "MARK_READ_FAILED", details: error.message });
    return res.json({ success: true, updated: Boolean(data) });
  }
);

matchesRouter.post(
  "/api/users/:id/notifications/read-all",
  requireAuth,
  (req: Request, res: Response, next: NextFunction) => {
    if (req.auth?.userId !== req.params.id) {
      return res.status(403).json({ error: "USER_ID_MISMATCH" });
    }
    next();
  },
  async (req: Request, res: Response) => {
    const caps = await getDbCapabilities();
    if (!caps.notificationsTable) return migrationPending(res, "Notifications");

    const { data, error } = await supabase.rpc("mark_all_notifications_read", {
      p_user_id: req.params.id,
    });

    if (error) return res.status(500).json({ error: "MARK_ALL_READ_FAILED", details: error.message });
    return res.json({ success: true, updated_count: data ?? 0 });
  }
);

// ─────────────────────────────────────────────────────────────
// Signup identity — CNIC + university / office card (self-declared).
// ─────────────────────────────────────────────────────────────

matchesRouter.post(
  "/api/users/:id/identity-profile",
  requireAuth,
  async (req: Request, res: Response) => {
    const authId = req.auth!.userId;
    const pathId = String(req.params.id);
    if (pathId !== authId) {
      const { data: linked } = await supabase
        .from("users")
        .select("id")
        .eq("id", pathId)
        .eq("auth_user_id", authId)
        .maybeSingle();
      if (!linked) return res.status(403).json({ error: "USER_ID_MISMATCH" });
    }

    const { cnic_number, id_document_type, institution_name, card_number } = req.body;
    if (!isValidPakistaniCnic(typeof cnic_number === "string" ? cnic_number : "")) {
      return res.status(400).json({ error: "INVALID_CNIC", details: "Expected format: 12345-1234567-1" });
    }
    if (id_document_type !== "university_card" && id_document_type !== "office_card") {
      return res.status(400).json({ error: "INVALID_ID_DOCUMENT_TYPE" });
    }
    if (typeof institution_name !== "string" || institution_name.trim().length < 2) {
      return res.status(400).json({
        error: "MISSING_INSTITUTION",
        details: "Enter your university or office / organization name.",
      });
    }

    upsertIdentityProfile({
      userId: pathId,
      cnicNumber: normalizeCnic(cnic_number),
      idDocumentType: id_document_type as IdDocumentType,
      institutionName: institution_name.trim(),
      cardNumber: typeof card_number === "string" ? card_number : "",
    });
    // Also index under auth id so later lookups by JWT still work.
    if (pathId !== authId) {
      upsertIdentityProfile({
        userId: authId,
        cnicNumber: normalizeCnic(cnic_number),
        idDocumentType: id_document_type as IdDocumentType,
        institutionName: institution_name.trim(),
        cardNumber: typeof card_number === "string" ? card_number : "",
      });
    }

    return res.status(201).json(getIdentityProfilePublic(pathId));
  }
);

matchesRouter.get(
  "/api/users/:id/identity-profile",
  requireAuth,
  async (req: Request, res: Response) => {
    const authId = req.auth!.userId;
    const pathId = String(req.params.id);
    if (pathId !== authId) {
      const { data: linked } = await supabase
        .from("users")
        .select("id")
        .eq("id", pathId)
        .eq("auth_user_id", authId)
        .maybeSingle();
      if (!linked) return res.status(403).json({ error: "USER_ID_MISMATCH" });
    }
    const pub = getIdentityProfilePublic(pathId) ?? getIdentityProfilePublic(authId);
    if (!pub) return res.json({ declared: false });
    return res.json({ declared: true, ...pub });
  }
);

// ─────────────────────────────────────────────────────────────
// Day 12: self-attested vehicle details. NOT document verification —
// see vehicleDeclaration.ts and the migration comment for why. The
// full CNIC is never returned by either endpoint, not even to its
// own owner — only its last 4 digits (mask_cnic / RIGHT(...,4) at the
// DB layer, matching what the pure helper does on the frontend).
// ─────────────────────────────────────────────────────────────

matchesRouter.get(
  "/api/users/:id/vehicle-declaration",
  requireAuth,
  async (req: Request, res: Response) => {
    const authId = req.auth!.userId;
    const pathId = String(req.params.id);
    let profileId = pathId;
    if (pathId !== authId) {
      const { data: linked } = await supabase
        .from("users")
        .select("id")
        .eq("id", pathId)
        .eq("auth_user_id", authId)
        .maybeSingle();
      if (!linked) return res.status(403).json({ error: "USER_ID_MISMATCH" });
      profileId = linked.id;
    }

    const caps = await getDbCapabilities();
    if (!caps.driverVehicleDeclarationsTable) {
      const stored = getStoredVehicleDeclaration(profileId) || getStoredVehicleDeclaration(authId);
      if (!stored) return res.json({ declared: false });
      return res.json({
        declared: true,
        vehicle_plate: stored.vehiclePlate,
        vehicle_make_model: stored.vehicleMakeModel,
        cnic_last4: stored.cnicLast4,
        declared_at: stored.declaredAt,
      });
    }

    const { data, error } = await supabase.rpc("get_own_vehicle_declaration", { p_user_id: profileId });
    if (error) {
      const stored = getStoredVehicleDeclaration(profileId) || getStoredVehicleDeclaration(authId);
      if (stored) {
        return res.json({
          declared: true,
          vehicle_plate: stored.vehiclePlate,
          vehicle_make_model: stored.vehicleMakeModel,
          cnic_last4: stored.cnicLast4,
          declared_at: stored.declaredAt,
        });
      }
      return res.status(500).json({ error: "VEHICLE_DECLARATION_FETCH_FAILED", details: error.message });
    }

    const row = (data ?? [])[0];
    if (!row) {
      const stored = getStoredVehicleDeclaration(profileId) || getStoredVehicleDeclaration(authId);
      if (stored) {
        return res.json({
          declared: true,
          vehicle_plate: stored.vehiclePlate,
          vehicle_make_model: stored.vehicleMakeModel,
          cnic_last4: stored.cnicLast4,
          declared_at: stored.declaredAt,
        });
      }
      return res.json({ declared: false });
    }
    return res.json({
      declared: true,
      vehicle_plate: row.vehicle_plate,
      vehicle_make_model: row.vehicle_make_model,
      cnic_last4: row.cnic_last4,
      declared_at: row.declared_at,
    });
  }
);

matchesRouter.post(
  "/api/users/:id/vehicle-declaration",
  requireAuth,
  async (req: Request, res: Response) => {
    const authId = req.auth!.userId;
    const pathId = String(req.params.id);
    let profileId = pathId;
    if (pathId !== authId) {
      const { data: linked } = await supabase
        .from("users")
        .select("id")
        .eq("id", pathId)
        .eq("auth_user_id", authId)
        .maybeSingle();
      if (!linked) return res.status(403).json({ error: "USER_ID_MISMATCH" });
      profileId = linked.id;
    }

    const { cnic_number, vehicle_plate, vehicle_make_model } = req.body;
    const cnicFromBody = typeof cnic_number === "string" ? cnic_number : "";
    const cnic =
      (isValidPakistaniCnic(cnicFromBody) ? normalizeCnic(cnicFromBody) : null) ||
      getStoredCnic(profileId) ||
      getStoredCnic(authId);

    if (!cnic || !isValidPakistaniCnic(cnic)) {
      return res.status(400).json({
        error: "INVALID_CNIC",
        details: "CNIC missing — add it at signup, or send 12345-1234567-1 with this request.",
      });
    }
    if (typeof vehicle_plate !== "string" || !isValidVehiclePlate(vehicle_plate)) {
      return res.status(400).json({ error: "INVALID_VEHICLE_PLATE" });
    }

    const cleanPlate = normalizeVehiclePlate(vehicle_plate);
    const cleanModel =
      typeof vehicle_make_model === "string" && vehicle_make_model.trim() ? vehicle_make_model.trim() : null;
    const cnicLast4 = maskCnicToLast4(cnic);
    const now = new Date().toISOString();

    const caps = await getDbCapabilities();
    if (!caps.driverVehicleDeclarationsTable) {
      upsertStoredVehicleDeclaration({
        userId: profileId,
        vehiclePlate: cleanPlate,
        vehicleMakeModel: cleanModel,
        cnicLast4,
        declaredAt: now,
      });
      if (authId !== profileId) {
        upsertStoredVehicleDeclaration({
          userId: authId,
          vehiclePlate: cleanPlate,
          vehicleMakeModel: cleanModel,
          cnicLast4,
          declaredAt: now,
        });
      }
      return res.json({
        success: true,
        vehicle_plate: cleanPlate,
        vehicle_make_model: cleanModel,
        cnic_last4: cnicLast4,
        declared_at: now,
      });
    }

    const { data, error } = await supabase.rpc("upsert_vehicle_declaration", {
      p_user_id: profileId,
      p_cnic_number: normalizeCnic(cnic),
      p_vehicle_plate: cleanPlate,
      p_vehicle_make_model: cleanModel,
    });

    if (error) {
      upsertStoredVehicleDeclaration({
        userId: profileId,
        vehiclePlate: cleanPlate,
        vehicleMakeModel: cleanModel,
        cnicLast4,
        declaredAt: now,
      });
      if (authId !== profileId) {
        upsertStoredVehicleDeclaration({
          userId: authId,
          vehiclePlate: cleanPlate,
          vehicleMakeModel: cleanModel,
          cnicLast4,
          declaredAt: now,
        });
      }
      return res.json({
        success: true,
        vehicle_plate: cleanPlate,
        vehicle_make_model: cleanModel,
        cnic_last4: cnicLast4,
        declared_at: now,
      });
    }

    const row = (data ?? [])[0];
    return res.json({
      success: true,
      vehicle_plate: row?.vehicle_plate ?? cleanPlate,
      vehicle_make_model: row?.vehicle_make_model ?? cleanModel,
      cnic_last4: row?.cnic_last4 ?? cnicLast4,
      declared_at: row?.declared_at ?? now,
    });
  }
);

async function resolveUserAliases(userId: string): Promise<string[]> {
  const aliases = new Set<string>([userId]);
  const { data } = await supabase
    .from("users")
    .select("id, auth_user_id")
    .or(`id.eq.${userId},auth_user_id.eq.${userId}`);
  for (const row of data ?? []) {
    if (row.id) aliases.add(row.id);
    if (row.auth_user_id) aliases.add(row.auth_user_id);
  }
  return [...aliases];
}

async function assertChatAccess(chatId: string, userId: string): Promise<boolean> {
  if (userCanAccessChat(chatId, userId)) return true;
  const aliases = await resolveUserAliases(userId);
  return grantChatAccessIfAlias(chatId, userId, aliases);
}

matchesRouter.post(
  "/api/match-chats",
  requireAuth,
  requireBodyFieldMatchesAuth("my_user_id"),
  async (req: Request, res: Response) => {
    const {
      my_user_id,
      my_display_name,
      peer_user_id,
      peer_display_name,
      origin_label,
      destination_label,
      fare_share_pkr,
      ride_id,
    } = req.body;

    if (!my_user_id || !peer_user_id || my_user_id === peer_user_id) {
      return res.status(400).json({ error: "MISSING_REQUIRED_FIELDS" });
    }

    const thread = upsertMatchChat({
      myUserId: my_user_id,
      myDisplayName: typeof my_display_name === "string" ? my_display_name : "You",
      peerUserId: peer_user_id,
      peerDisplayName: typeof peer_display_name === "string" ? peer_display_name : "Carpool mate",
      originLabel: typeof origin_label === "string" ? origin_label : "Pickup",
      destinationLabel: typeof destination_label === "string" ? destination_label : "Drop-off",
      fareSharePkr: Number(fare_share_pkr) || 0,
      rideId: typeof ride_id === "string" ? ride_id : null,
    });

    return res.status(201).json({
      chat_id: thread.id,
      peer_user_id,
      peer_display_name: thread.participantNames[peer_user_id],
      origin_label: thread.originLabel,
      destination_label: thread.destinationLabel,
      fare_share_pkr: thread.fareSharePkr,
      ride_id: thread.rideId,
      message_count: thread.messages.length,
    });
  }
);

matchesRouter.get(
  "/api/users/:id/match-chats",
  requireAuth,
  async (req: Request, res: Response) => {
    const authId = req.auth!.userId;
    const pathId = String(req.params.id);
    if (pathId !== authId) {
      const { data: linked } = await supabase
        .from("users")
        .select("id")
        .eq("id", pathId)
        .eq("auth_user_id", authId)
        .maybeSingle();
      if (!linked) {
        return res.status(403).json({ error: "USER_ID_MISMATCH" });
      }
    }

    const meIds = new Set<string>([authId, pathId]);
    const seen = new Map<string, NonNullable<ReturnType<typeof getMatchChat>>>();
    for (const uid of meIds) {
      for (const t of listMatchChatsForUser(uid)) seen.set(t.id, t);
    }
    const threads = [...seen.values()];

    return res.json({
      chats: threads.map((t) => {
        const peerId = t.participantIds.find((id) => !meIds.has(id)) ?? "";
        return {
          chat_id: t.id,
          peer_user_id: peerId,
          peer_display_name: t.participantNames[peerId] ?? "Carpool mate",
          origin_label: t.originLabel,
          destination_label: t.destinationLabel,
          fare_share_pkr: t.fareSharePkr,
          ride_id: t.rideId,
          created_at: t.createdAt,
          last_message: t.messages.length ? t.messages[t.messages.length - 1] : null,
        };
      }),
    });
  }
);

matchesRouter.get(
  "/api/match-chats/:id/messages",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId;
    const chatId = String(req.params.id);
    if (!(await assertChatAccess(chatId, userId))) {
      return res.status(404).json({ error: "CHAT_NOT_FOUND" });
    }
    const thread = getMatchChat(chatId)!;
    const aliases = await resolveUserAliases(userId);
    return res.json({
      chat_id: thread.id,
      messages: thread.messages.map((m) => ({
        id: m.id,
        sender_id: m.senderId,
        text: m.text,
        created_at: m.createdAt,
        mine: aliases.includes(m.senderId),
      })),
    });
  }
);

matchesRouter.post(
  "/api/match-chats/:id/messages",
  requireAuth,
  requireBodyFieldMatchesAuth("user_id"),
  async (req: Request, res: Response) => {
    const { user_id, text } = req.body;
    const chatId = String(req.params.id);
    if (!user_id || typeof text !== "string") {
      return res.status(400).json({ error: "MISSING_REQUIRED_FIELDS" });
    }
    if (!(await assertChatAccess(chatId, user_id))) {
      return res.status(404).json({
        error: "CHAT_NOT_FOUND",
        details: "Chat thread was lost (server may have restarted). Close chat and Accept the match again.",
      });
    }
    const msg = addMatchChatMessage(chatId, user_id, text);
    if (!msg) {
      return res.status(403).json({
        error: "CHAT_SEND_DENIED",
        details: "You're not a participant on this chat thread.",
      });
    }
    return res.status(201).json({
      id: msg.id,
      sender_id: msg.senderId,
      text: msg.text,
      created_at: msg.createdAt,
      mine: true,
    });
  }
);
