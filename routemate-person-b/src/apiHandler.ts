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
  buildSosMessage,
  buildGoogleMapsLink,
  buildWhatsAppLink,
} from "./safety";
import { findNearestPoliceStations } from "./policeLocator";
import { dispatchSosAlert, isSosGatewayConfigured, SosAlertPayload } from "./sosGateway";
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
  getGroupChat,
  addChatParticipant,
  listMatchChatsForUser,
  addMatchChatMessage,
  userCanAccessChat,
  grantChatAccessIfAlias,
} from "./chatStore";
import {
  upsertIdentityProfile,
  getIdentityProfilePublic,
  getStoredCnic,
  rememberCnicIfMissing,
  IdDocumentType,
} from "./identityStore";
import {
  createMatchRequest,
  updatePendingRequest,
  getMatchRequest,
  findOpenRequestBetween,
  hasConfirmedRequestBetween,
  respondToRequest,
  finalizeRequest,
  cancelRequest,
  attachChatToRequest,
  listRequestsForUser,
  expireStaleMatchRequests,
  isRequester,
  isRecipient,
  groupIdOf,
  listConfirmedGroupMembers,
  listRideShareRequests,
  listAllLiveShareRequests,
  MatchRequest,
  MatchRequestGroup,
  MatchRequestPreferences,
  MatchRequestConditions,
  MatchRequestSnapshot,
  RequestGenderPreference,
  RequestVehicleType,
  RequestMatchType,
} from "./frontend/matchrequeststore";
import {
  durableCreateMatchRequest,
  durableGetMatchRequest,
  durableListRequestsForUser,
  durableFindOpenRequest,
  durableUpdatePendingRequest,
  durableRespondToRequest,
  durableFinalizeRequest,
  durableCancelRequest,
  durableAttachChat,
  durableHasConfirmedRequest,
} from "./durableMatchRequestStore";

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
  sosAlertsTable: boolean;
  ratingsTable: boolean;
  userReportsTable: boolean;
  blockedUsersTable: boolean;
  ridesTable: boolean;
  rideConsentsTable: boolean;
  carbonSavingsTable: boolean;
  notificationsTable: boolean;
  rideHailingFareCol: boolean;
  partySizeCol: boolean;
  driverVehicleDeclarationsTable: boolean;
  rideMessagesTable: boolean;
  liveLocationsTable: boolean;
  tripTrackingStateTable: boolean;
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
  const sosAlertsTable = await probeRelation("id", "sos_alerts");
  const rideHailingFareCol = await probeRelation("ride_hailing_fare_pkr", "trip_requests");
  const partySizeCol = await probeRelation("party_size", "trip_requests");
  const driverVehicleDeclarationsTable = await probeRelation("user_id", "driver_vehicle_declarations");
  const rideMessagesTable = await probeRelation("id", "ride_messages");
  const liveLocationsTable = await probeRelation("ride_id", "live_locations");
  const tripTrackingStateTable = await probeRelation("ride_id", "trip_tracking_state");
  return {
    requireDriverGenderMatchCol,
    vehicleTypeCol,
    userVerifiedCols,
    emergencyContactsTable,
    sosEventsTable,
    sosAlertsTable,
    ratingsTable,
    userReportsTable,
    blockedUsersTable,
    ridesTable,
    rideConsentsTable,
    carbonSavingsTable,
    notificationsTable,
    rideHailingFareCol,
    partySizeCol,
    driverVehicleDeclarationsTable,
    rideMessagesTable,
    liveLocationsTable,
    tripTrackingStateTable,
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
    role: b.role,
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
    primary_rider_id: rideRow.primary_rider_id ?? null,
    ride_mode: rideRow.ride_mode,
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
    party_size,
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
  // "I am 2 people": a party is ONE trip request with party_size people
  // travelling together (lead included), 1..4. Never one request per person.
  const partySize = party_size ?? 1;
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > 4) {
    return res.status(400).json({ error: "INVALID_PARTY_SIZE" });
  }
  if (partySize > 1 && !caps.partySizeCol) {
    return migrationPending(res, "The 'I am 2 people' party-size option");
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
  if (caps.partySizeCol && partySize > 1) insertRow.party_size = partySize;

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

  // Role gating, mirroring buildMockMatches in mockCandidates.ts. There is
  // no role column on trip_requests — vehicle_type IS the role signal:
  // "car"/"bike" = offering a seat, "none" = looking to join a driver,
  // "ride_hailing" = splitting a cab. Without this, two people who are both
  // merely looking for a ride match each other, and one gets rendered as if
  // they were offering. Only applied when the column actually exists, so
  // pre-migration databases keep their old (ungated) behaviour.
  const viewerVehicle = String(targetRowData.vehicle_type ?? "none");
  const viewerOffersSeat = viewerVehicle === "car" || viewerVehicle === "bike";
  const viewerJoinsDriver = viewerVehicle === "none";
  const rowOffersSeat = (row: Record<string, any>) => {
    const v = String(row.vehicle_type ?? "none");
    return v === "car" || v === "bike";
  };

  const visibleCandidates = candidateRows.filter((row: Record<string, any>) => {
    if (row.user_id === targetReq.user_id) return false;
    if (excludedUserIds.has(row.user_id)) return false;
    if (verifiedOnly && caps.userVerifiedCols && row.users?.is_verified !== true) return false;
    if (caps.vehicleTypeCol) {
      // A driver offering seats is matched with passengers, never with
      // another driver; a passenger looking to join a car/bike is matched
      // with vehicle owners only. Cab-splitting is open to everyone.
      if (viewerOffersSeat && rowOffersSeat(row)) return false;
      if (viewerJoinsDriver && !rowOffersSeat(row)) return false;
    }
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

  type GroupMemberView = { user_id: string; display_name: string };

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
      // Group carpool view: when the CANDIDATE hosts this trip (their car),
      // bundle the riders already confirmed into it so the UI can render
      // one unified card (driver + co-riders) instead of lone profiles.
      group:
        (result.match_type === "owner_passenger" || result.match_type === "shared_ride_hailing") &&
        result.owner_user_id === candidateReq.user_id
          ? {
              host_user_id: candidateReq.user_id,
              host_display_name: candidateReq.user_name,
              host_trip_request_id: candidateReq.request_id,
              members: listConfirmedGroupMembers(candidateReq.user_id, candidateReq.request_id).map(
                (m): GroupMemberView => ({ user_id: m.userId, display_name: m.displayName })
              ),
              pending_members: [] as GroupMemberView[],
            }
          : null,
      legs: result.legs,
      route_geometry: {
        requester: result.requester_route_geometry,
        candidate: result.candidate_route_geometry,
        combined: result.combined_route_geometry,
      },
    }))
    .sort((a, b) => b.overlap_pct - a.overlap_pct);

  // ── Group nesting: a rider already committed to someone's car must
  // appear INSIDE that host's card, never as a standalone duplicate.
  // Memberships come from the request store; requests made before the
  // group field existed are resolved by checking which side's trip
  // actually carries the vehicle. Open (pending) joins count too, so a
  // person mid-handshake isn't offered twice.
  const hostKeyOf = (u: string, t: string) => `${u}|${t}`;
  const shareReqs = listRideShareRequests(
    [targetReq.user_id, ...matches.map((m) => m.candidate_user_id)].filter(Boolean)
  );
  const legacyTripIds = new Set<string>();
  for (const r of shareReqs) {
    if (!r.group) {
      if (r.fromTripRequestId) legacyTripIds.add(r.fromTripRequestId);
      if (r.toTripRequestId) legacyTripIds.add(r.toTripRequestId);
    }
  }
  const tripVehById: Record<string, { vehicle_type: string }> = {};
  if (legacyTripIds.size > 0) {
    const { data: tripVehRows } = await supabase
      .from("trip_requests")
      .select("id, vehicle_type")
      .in("id", [...legacyTripIds]);
    for (const t of tripVehRows ?? []) {
      tripVehById[t.id] = { vehicle_type: String(t.vehicle_type ?? "none") };
    }
  }

  const membersByHost = new Map<string, { confirmed: GroupMemberView[]; pending: GroupMemberView[] }>();
  const hostKeysByMember = new Map<string, string[]>();
  const VEHICLED_TYPES = new Set(["car", "bike", "ride_hailing"]);
  for (const r of shareReqs) {
    let hostUserId: string;
    let hostTripId: string;
    let memberUserId: string;
    let memberName: string;
    if (r.group?.hostUserId && r.group?.hostTripRequestId) {
      hostUserId = r.group.hostUserId;
      hostTripId = r.group.hostTripRequestId;
      const hostIsFrom = r.fromUserId === hostUserId;
      memberUserId = hostIsFrom ? r.toUserId : r.fromUserId;
      memberName = hostIsFrom ? r.toName : r.fromName;
    } else {
      const fromVeh = r.fromTripRequestId ? tripVehById[r.fromTripRequestId]?.vehicle_type : undefined;
      const toVeh = r.toTripRequestId ? tripVehById[r.toTripRequestId]?.vehicle_type : undefined;
      const fromOwns = Boolean(fromVeh && VEHICLED_TYPES.has(fromVeh));
      const toOwns = Boolean(toVeh && VEHICLED_TYPES.has(toVeh));
      if (toOwns && !fromOwns && r.toTripRequestId) {
        hostUserId = r.toUserId;
        hostTripId = r.toTripRequestId;
        memberUserId = r.fromUserId;
        memberName = r.fromName;
      } else if (fromOwns && !toOwns && r.fromTripRequestId) {
        hostUserId = r.fromUserId;
        hostTripId = r.fromTripRequestId;
        memberUserId = r.toUserId;
        memberName = r.toName;
      } else {
        continue; // genuine peer share — both really are standalone options
      }
    }
    // The viewer is never a nested rider of their own results, and a
    // host key only matters if that host's card can actually be shown.
    if (!memberUserId || memberUserId === targetReq.user_id) continue;
    const key = hostKeyOf(hostUserId, hostTripId);
    const bucket = membersByHost.get(key) ?? { confirmed: [], pending: [] };
    const view: GroupMemberView = { user_id: memberUserId, display_name: memberName || "Carpool mate" };
    const into = r.status === "confirmed" ? bucket.confirmed : bucket.pending;
    if (
      !bucket.confirmed.some((x) => x.user_id === memberUserId) &&
      !into.some((x) => x.user_id === memberUserId)
    ) {
      into.push(view);
    }
    membersByHost.set(key, bucket);
    const keys = hostKeysByMember.get(memberUserId) ?? [];
    if (!keys.includes(key)) keys.push(key);
    hostKeysByMember.set(memberUserId, keys);
  }

  for (const m of matches) {
    if (!m.group) continue;
    const bucket = membersByHost.get(hostKeyOf(m.group.host_user_id, m.group.host_trip_request_id));
    if (!bucket) continue;
    for (const c of bucket.confirmed) {
      if (
        !m.group.members.some((x) => x.user_id === c.user_id) &&
        !m.group.pending_members.some((x) => x.user_id === c.user_id)
      ) {
        m.group.members.push(c);
      }
    }
    for (const p of bucket.pending) {
      if (
        !m.group.members.some((x) => x.user_id === p.user_id) &&
        !m.group.pending_members.some((x) => x.user_id === p.user_id)
      ) {
        m.group.pending_members.push(p);
      }
    }
  }

  const hostKeysInResults = new Set<string>();
  for (const m of matches) {
    if (m.group) hostKeysInResults.add(hostKeyOf(m.group.host_user_id, m.group.host_trip_request_id));
  }
  // Drop a candidate's standalone card only when they are nested inside
  // a host card that IS being shown — never silently lose a person.
  const visibleMatches = matches.filter((m) => {
    const keys = hostKeysByMember.get(m.candidate_user_id);
    return !keys || !keys.some((k) => hostKeysInResults.has(k));
  });

  return res.json({ matches: visibleMatches, ...responseExtras });
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

/** SOS: nearest police station(s) to a position, via OpenStreetMap
 *  Overpass. Best-effort by design — a failed/slow lookup returns an
 *  empty list rather than an error, because the SOS modal always
 *  offers the national helpline (15) and the rider's emergency
 *  contacts regardless of what this returns. Auth is required so the
 *  public Overpass mirrors aren't turned into an open proxy. */
matchesRouter.get(
  "/api/sos/nearest-police",
  requireAuth,
  async (req: Request, res: Response) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ error: "INVALID_COORDINATES" });
    }

    const stations = await findNearestPoliceStations(lat, lng);
    return res.json({ stations });
  }
);

/** SOS auto-dispatch. Composes ONE live-location message and prepares
 *  it for every recipient — each emergency contact plus the nearest
 *  police station — records the whole thing to sos_alerts (when the
 *  migration is applied), and returns per-recipient delivery status +
 *  the deep link the rider uses to complete the send on-device.
 *
 *  HONESTY GUARANTEE: with no gateway configured (the default), every
 *  status is 'logged' — the platform recorded + prepared the alert, it
 *  did NOT text anyone. The frontend must render 'logged' as "ready —
 *  tap to send", never as "sent". See src/sosGateway.ts. */
matchesRouter.post(
  "/api/sos/dispatch",
  requireAuth,
  requireBodyFieldMatchesAuth("user_id"),
  async (req: Request, res: Response) => {
    const { user_id, trip_request_id, ride_id, companion_name } = req.body;
    const lat = Number(req.body.lat);
    const lng = Number(req.body.lng);
    if (!user_id || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ error: "MISSING_REQUIRED_FIELDS" });
    }

    const caps = await getDbCapabilities();

    // 1. Parent audit row (the trigger + position). Best-effort: if the
    //    sos_events table is missing we continue without an event id.
    let sosEventId: string | null = null;
    if (caps.sosEventsTable) {
      const { data: evt } = await supabase
        .from("sos_events")
        .insert({ user_id, trip_request_id: trip_request_id ?? null, ride_id: ride_id ?? null, lat, lng })
        .select("id")
        .single();
      sosEventId = evt?.id ?? null;
    }

    // 2. Recipients: emergency contacts + nearest police station.
    const locationLink = buildGoogleMapsLink(lat, lng);
    const contacts = caps.emergencyContactsTable
      ? (await supabase.from("emergency_contacts").select("*").eq("user_id", user_id).order("created_at", { ascending: true })).data ?? []
      : [];
    const stations = await findNearestPoliceStations(lat, lng, { limit: 1 });
    const nearestPolice = stations[0] ?? null;

    // The shared message names the nearest station when we found one.
    const message = buildSosMessage(locationLink, companion_name ?? undefined, nearestPolice?.name);

    type Recipient = { name: string; phone?: string; kind: "emergency_contact" | "police"; channel: "whatsapp" | "sms" | "call" | "log" };
    const recipients: Recipient[] = [
      ...contacts.map((c: any) => ({ name: c.contact_name, phone: c.contact_phone, kind: "emergency_contact" as const, channel: "whatsapp" as const })),
    ];
    if (nearestPolice) {
      const policePhone = nearestPolice.phone ? nearestPolice.phone.split(";")[0].trim() : undefined;
      recipients.push({ name: nearestPolice.name, phone: policePhone, kind: "police", channel: policePhone ? "call" : "log" });
    }

    // 3. Attempt delivery for each (gateway or 'logged'), in parallel.
    const results = await Promise.all(
      recipients.map(async (r) => {
        const payload: SosAlertPayload = { ...r, message, locationLink };
        const status = await dispatchSosAlert(payload);
        const deepLink =
          r.kind === "emergency_contact" && r.phone
            ? buildWhatsAppLink(r.phone, message)
            : r.phone
              ? `tel:${r.phone.replace(/[^0-9+]/g, "")}`
              : null;
        return { ...r, status, deep_link: deepLink };
      })
    );

    // 4. Persist the audit rows when the table exists. A failure here
    //    never blocks the response — the alerts above are already ready.
    if (caps.sosAlertsTable) {
      const rows = results.map((r) => ({
        sos_event_id: sosEventId,
        user_id,
        recipient_name: r.name,
        recipient_phone: r.phone ?? null,
        recipient_kind: r.kind,
        channel: r.channel,
        status: r.status,
        message,
        location_link: locationLink,
        lat,
        lng,
      }));
      const { error } = await supabase.from("sos_alerts").insert(rows);
      if (error) console.warn("[sos/dispatch] sos_alerts insert failed:", error.message);
    }

    return res.status(201).json({
      sos_event_id: sosEventId,
      message,
      location_link: locationLink,
      nearest_police: nearestPolice,
      gateway_configured: isSosGatewayConfigured(),
      persisted: caps.sosAlertsTable,
      recipients: results,
    });
  }
);

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

  // Seats are the driver's own declaration, so they are stored, not assumed:
  // 4 was hardcoded here, which made a "1 seat" offer look like a 4-seat one
  // to everyone browsing it. Clamped instead of rejected so a stray value
  // can't strand an already-posted ride.
  const requestedSeats = Number(req.body.total_seats);
  const totalSeats = Number.isFinite(requestedSeats)
    ? Math.min(8, Math.max(1, Math.round(requestedSeats)))
    : 4;
  const requestedCap = Number(req.body.driver_max_co_passengers);
  const maxCoPassengers = Number.isFinite(requestedCap)
    ? Math.min(8, Math.max(-1, Math.round(requestedCap)))
    : totalSeats - 1;

  const corridor = coarseCorridorOf(origin, destination);
  const { data: ownActive } = await supabase
    .from("rides")
    .select("*")
    .eq("driver_id", driver_id)
    .eq("status", "active");

  // Re-posting the same corridor refreshes the driver's existing car instead
  // of stacking a second identical listing in ride discovery.
  const sameCorridor = (ownActive ?? []).find((r: Record<string, any>) => {
    const rowCorridor = coarseCorridorOf(
      { lat: r.origin_lat, lng: r.origin_lng },
      { lat: r.destination_lat, lng: r.destination_lng }
    );
    return corridor !== null && rowCorridor === corridor;
  }) as Record<string, any> | undefined;

  if (sameCorridor) {
    const occupied = Number(sameCorridor.total_seats ?? 0) - Number(sameCorridor.available_seats ?? 0);
    const patch: Record<string, any> = {
      departure_time: departure_time ?? sameCorridor.departure_time ?? new Date().toISOString(),
      origin_label: origin.address_label ?? sameCorridor.origin_label ?? null,
      destination_label: destination.address_label ?? sameCorridor.destination_label ?? null,
    };
    // Never resize a car people are already riding in — that could push its
    // free seats below the seats already taken.
    if (!(occupied > 0)) {
      patch.total_seats = totalSeats;
      patch.available_seats = totalSeats;
      patch.driver_max_co_passengers = maxCoPassengers;
    }
    const { data: refreshed, error: refreshError } = await supabase
      .from("rides")
      .update(patch)
      .eq("id", sameCorridor.id)
      .select()
      .single();
    if (refreshError) return res.status(500).json({ error: "RIDE_UPDATE_FAILED", details: refreshError.message });
    return res.status(200).json({ ride_id: refreshed!.id, reused: true });
  }

  // A new corridor replaces the driver's previous one, but only when nobody
  // is booked into it: an empty listing for a route they no longer travels
  // is a ghost that keeps showing up for other people.
  const { data: staleBookings } =
    (ownActive ?? []).length > 0
      ? await supabase
          .from("ride_bookings")
          .select("ride_id")
          .in(
            "ride_id",
            (ownActive ?? []).map((r: Record<string, any>) => r.id)
          )
          .in("status", ["accepted", "pending", "pending_consent"])
      : { data: [] as { ride_id: string }[] };
  const ridden = new Set((staleBookings ?? []).map((b: Record<string, any>) => String(b.ride_id)));
  const ghosts = (ownActive ?? []).filter((r: Record<string, any>) => !ridden.has(String(r.id)));
  if (ghosts.length > 0) {
    await supabase
      .from("rides")
      .update({ status: "cancelled" })
      .in("id", ghosts.map((r: Record<string, any>) => r.id));
  }

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
      total_seats: totalSeats,
      available_seats: totalSeats,
      driver_max_co_passengers: maxCoPassengers,
      status: "active",
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: "RIDE_CREATE_FAILED", details: error.message });
  return res.status(201).json({ ride_id: data.id, replaced_listings: ghosts.length });
});

/** One `rides` row per CAR, not per pairing.
 *
 *  Every confirmation used to mint its own row with `driver_id` set to
 *  whoever happened to press the final OK — so a passenger became the
 *  phantom driver of a second ride, and one three-person car showed up in
 *  ride discovery as two or three separate listings. Confirmation now runs
 *  through here instead: the host of the car owns one active ride row per
 *  corridor, and each confirmed rider gets an accepted booking on it —
 *  which is exactly what ride completion, ratings, CO₂ and the participant
 *  list already read.
 *
 *  Best-effort by design: a null return never blocks a confirmation, since
 *  the chat and the "Confirmed rides" card are the point of that flow.
 */
async function attachRiderToHostRide(input: {
  hostUserId: string;
  riderUserId: string;
  origin: { lat: number; lng: number; address_label?: string | null };
  destination: { lat: number; lng: number; address_label?: string | null };
  departureTime?: string | null;
}): Promise<string | null> {
  const caps = await getDbCapabilities();
  if (!caps.ridesTable) return null;

  const { hostUserId, riderUserId, origin, destination } = input;
  if (!hostUserId || !riderUserId || hostUserId === riderUserId) return null;

  // ~1 km tolerance: the same F-10 → G-10 pin re-dropped a few metres away
  // is still the same car, not a new corridor.
  const near = (
    lat: unknown,
    lng: unknown,
    point: { lat: number; lng: number }
  ): boolean =>
    Math.abs(Number(lat) - point.lat) < 0.01 && Math.abs(Number(lng) - point.lng) < 0.01;

  const { data: openRides } = await supabase
    .from("rides")
    .select("id, available_seats, origin_lat, origin_lng, destination_lat, destination_lng")
    .eq("driver_id", hostUserId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(25);

  let ride =
    (openRides ?? []).find(
      (r: any) =>
        Number(r.available_seats) > 0 &&
        near(r.origin_lat, r.origin_lng, origin) &&
        near(r.destination_lat, r.destination_lng, destination)
    ) ?? null;

  if (!ride) {
    const { data: created } = await supabase
      .from("rides")
      .insert({
        driver_id: hostUserId,
        origin_lat: origin.lat,
        origin_lng: origin.lng,
        origin_label: origin.address_label ?? null,
        destination_lat: destination.lat,
        destination_lng: destination.lng,
        destination_label: destination.address_label ?? null,
        departure_time: input.departureTime ?? new Date().toISOString(),
        total_seats: 4,
        available_seats: 4,
        driver_max_co_passengers: 3,
        status: "active",
      })
      .select()
      .single();
    ride = created ?? null;
  }
  if (!ride?.id) return null;

  const { data: alreadyBooked } = await supabase
    .from("ride_bookings")
    .select("id")
    .eq("ride_id", ride.id)
    .eq("passenger_id", riderUserId)
    .in("status", ["pending", "accepted"])
    .maybeSingle();

  if (!alreadyBooked) {
    const { error: bookingError } = await supabase.from("ride_bookings").insert({
      ride_id: ride.id,
      passenger_id: riderUserId,
      pickup_lat: origin.lat,
      pickup_lng: origin.lng,
      pickup_label: origin.address_label ?? null,
      dropoff_lat: destination.lat,
      dropoff_lng: destination.lng,
      dropoff_label: destination.address_label ?? null,
      seats_requested: 1,
      status: "accepted",
    });
    if (!bookingError) {
      await supabase
        .from("rides")
        .update({ available_seats: Math.max(0, Number(ride.available_seats ?? 1) - 1) })
        .eq("id", ride.id);
    }
  }

  return String(ride.id);
}

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

  // Completion is a fact about the ride, not about whoever taps the button
  // first. Whoever else joins later still gets their rating prompt, but the
  // second call must not re-write a ride that is already closed.
  const alreadyCompleted = rideRow.status === "completed";
  if (!alreadyCompleted) {
    await supabase.from("rides").update({ status: "completed" }).eq("id", req.params.id);
    await supabase
      .from("ride_bookings")
      .update({ status: "completed" })
      .eq("ride_id", req.params.id)
      .in("status", ["accepted", "pending"]);
  }

  // Day 9: write the CO2-avoided ledger for this ride so every
  // rider's profile running total picks it up, not just a one-off
  // number shown at the fare-estimate stage.
  let carbonSavings: { rider_id: string; co2_saved_kg: number }[] = [];
  if (caps.carbonSavingsTable && !alreadyCompleted) {
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
    already_completed: alreadyCompleted,
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
  const {
    passenger_id, max_co_passengers, seats_requested, pickup_point, dropoff_point,
    party_member_names,
  } = req.body;

  if (!passenger_id || max_co_passengers === undefined || !pickup_point || !dropoff_point) {
    return res.status(400).json({ error: "MISSING_REQUIRED_FIELDS" });
  }

  // One booking for a whole party: seats_requested = party_size (1..4),
  // with optional names (max 3, excluding the lead) so the driver knows
  // who is coming. Server-side validation only — never trust the client.
  const partySize = seats_requested ?? 1;
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > 4) {
    return res.status(400).json({ error: "INVALID_PARTY_SIZE" });
  }
  if (party_member_names != null) {
    const ok =
      Array.isArray(party_member_names) &&
      party_member_names.length <= 3 &&
      party_member_names.every((n) => typeof n === "string" && n.trim().length > 0);
    if (!ok) return res.status(400).json({ error: "INVALID_PARTY_MEMBER_NAMES" });
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
    p_seats_requested: partySize,
    p_max_co_passengers: max_co_passengers,
    p_party_member_names: party_member_names ?? null,
  });

  if (error) {
    return res.status(500).json({ error: "BOOKING_RPC_FAILED", details: error.message });
  }

  const outcome = Array.isArray(data) ? data[0] : data;

  if (!outcome?.success) {
    // PARTY_TOO_LARGE_FOR_REMAINING_SEATS carries the free seat count so
    // the UI can say "only N seats left" instead of a bare no.
    return res.status(409).json({
      error: "BOOKING_REJECTED",
      reason: outcome?.reason ?? "UNKNOWN",
      remaining_seats: outcome?.remaining_seats ?? null,
    });
  }

  // Day 9: a 3+ person pool doesn't finalize immediately — it's booked
  // as pending_consent and waits on the dual-consent vote (see
  // /api/rides/:id/bookings/:bookingId/consent below). Tell the caller
  // which case this was so the frontend can show "waiting on group"
  // instead of "you're in" for AWAITING_GROUP_CONSENT.
  return res.status(201).json({
    success: true,
    booking_id: outcome.booking_id,
    status: outcome.reason === "AWAITING_GROUP_CONSENT" ? "pending_consent" : "accepted",
    reason: outcome.reason,
    remaining_seats: outcome.remaining_seats ?? null,
  });
});

// Live occupancy of a ride, counted in PEOPLE (parties included, pending
// bookings treated as reserved) — see get_ride_occupancy() in
// supabase/migrations/20261023000000_party_size.sql. Redaction
// (ride_hail_share joiner details hidden from non-hosts) is enforced
// inside the RPC, never in the client.
matchesRouter.get(
  "/api/rides/:id/occupancy",
  requireAuth,
  async (req: Request, res: Response) => {
  const viewerId = await resolveCanonicalUserId(req.auth!.userId);
  if (!viewerId) return res.status(403).json({ error: "NOT_A_RIDE_PARTICIPANT" });

  const { data, error } = await supabase.rpc("get_ride_occupancy", {
    p_ride_id: req.params.id,
    p_viewer_id: viewerId,
  });

  if (error) {
    return res.status(500).json({ error: "OCCUPANCY_RPC_FAILED", details: error.message });
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return res.status(403).json({ error: "NOT_A_RIDE_PARTICIPANT" });

  return res.json({
    ride_id: row.ride_id,
    total_people_capacity: row.total_people_capacity,
    occupied_people: row.occupied_people,
    seats_left: row.seats_left,
    status: row.status,
    co_riders: row.co_riders,
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
// RouteSync Phase 3: ride group chat, live location sharing, and
// authorised participant listing. All three are gated on the caller being
// an actual member of the ride (driver / primary rider / ride-hail booker
// / accepted passenger), enforced SERVER-SIDE — never from client UI state.
// The tables + get_ride_participants(viewer) RPC come from the Phase 1/3
// migrations; capability flags give a clean 503 until they're applied.
// ─────────────────────────────────────────────────────────────

/** First element of an array-or-object RPC result (Supabase RETURNS TABLE
 *  comes back as an array; a scalar RPC as an object). */
function one<T = any>(data: any): T | null {
  if (data == null) return null;
  return (Array.isArray(data) ? data[0] : data) as T;
}

/** Result of the server-side ride-membership check. `userId` is the
 *  canonical public.users.id the acting auth uid resolves to. */
type RideActor = { rideId: string; userId: string };

async function getRideMembership(
  rideId: string,
  authUid: string
): Promise<{ actor: RideActor } | { deny: { status: number; body: Record<string, string> } }> {
  const userId = await resolveCanonicalUserId(authUid);
  if (!userId) return { deny: { status: 403, body: { error: "NO_PROFILE_FOR_TOKEN" } } };

  const { data: rideRow } = await supabase.from("rides").select("id").eq("id", rideId).maybeSingle();
  if (!rideRow) return { deny: { status: 404, body: { error: "RIDE_NOT_FOUND" } } };

  const aliases = await resolveUserAliases(authUid);
  const placeholders = aliases.map((a) => `"${a}"`).join(",");

  // Hosts are members outright; a passenger is one only once ACCEPTED
  // (pending / pending_consent bookings can't chat or share location yet).
  const { data: hostRow } = await supabase
    .from("rides")
    .select("id")
    .eq("id", rideId)
    .or(`driver_id.in.(${placeholders}),primary_rider_id.in.(${placeholders}),booked_by.in.(${placeholders})`)
    .maybeSingle();
  if (hostRow) return { actor: { rideId, userId } };

  const { data: bookingRow } = await supabase
    .from("ride_bookings")
    .select("id")
    .eq("ride_id", rideId)
    .eq("status", "accepted")
    .in("passenger_id", aliases)
    .maybeSingle();
  if (bookingRow) return { actor: { rideId, userId } };

  return { deny: { status: 403, body: { error: "NOT_A_RIDE_PARTICIPANT" } } };
}

/** Route guard: 404 unknown ride / 403 non-member / 503 migration pending,
 *  otherwise attaches the resolved actor to req and continues. */
function requireRideMembership(capKey: keyof DbCapabilities, feature: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const caps = await getDbCapabilities();
    if (!caps[capKey]) return migrationPending(res, feature);
    const outcome = await getRideMembership(String(req.params.id), req.auth!.userId);
    if ("deny" in outcome) return res.status(outcome.deny.status).json(outcome.deny.body);
    (req as Request & { rideActor?: RideActor }).rideActor = outcome.actor;
    next();
  };
}

matchesRouter.post(
  "/api/rides/:id/messages",
  requireAuth,
  requireRideMembership("rideMessagesTable", "Ride group chat"),
  async (req: Request, res: Response) => {
    const actor = (req as Request & { rideActor: RideActor }).rideActor!;
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    if (!body) return res.status(400).json({ error: "MISSING_REQUIRED_FIELDS" });
    if (body.length > 2000) return res.status(413).json({ error: "MESSAGE_TOO_LONG" });

    const { data: posted, error } = await supabase
      .from("ride_messages")
      .insert({ ride_id: actor.rideId, sender_id: actor.userId, body })
      .select("id, ride_id, sender_id, body, created_at, users:sender_id(display_name)")
      .single();
    if (error) return res.status(500).json({ error: "MESSAGE_POST_FAILED", details: error.message });
    const data = posted as Record<string, any>;

    return res.status(201).json({
      id: data.id,
      sender_id: data.sender_id,
      sender_name: data.users?.display_name ?? null,
      body: data.body,
      created_at: data.created_at,
      mine: true,
    });
  }
);

matchesRouter.get(
  "/api/rides/:id/messages",
  requireAuth,
  requireRideMembership("rideMessagesTable", "Ride group chat"),
  async (req: Request, res: Response) => {
    const actor = (req as Request & { rideActor: RideActor }).rideActor!;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));

    const { data, error } = await supabase
      .from("ride_messages")
      .select("id, sender_id, body, created_at, users:sender_id(display_name)")
      .eq("ride_id", actor.rideId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) return res.status(500).json({ error: "MESSAGE_FETCH_FAILED", details: error.message });

    const messages = (data ?? []).slice().reverse();
    return res.json({
      ride_id: actor.rideId,
      messages: messages.map((m: any) => ({
        id: m.id,
        sender_id: m.sender_id,
        sender_name: m.users?.display_name ?? null,
        body: m.body,
        created_at: m.created_at,
        mine: m.sender_id === actor.userId,
      })),
    });
  }
);

// ─────────────────────────────────────────────────────────────
// Live location sharing (RouteSync Phase 3). A rider/fellow member toggles
// sharing on/off, pushes a position every few seconds while on, and reads
// everyone's latest position. Auto-stops once the ride is completed.
// ─────────────────────────────────────────────────────────────
matchesRouter.post(
  "/api/rides/:id/tracking",
  requireAuth,
  requireRideMembership("tripTrackingStateTable", "Live location sharing"),
  async (req: Request, res: Response) => {
    const actor = (req as Request & { rideActor: RideActor }).rideActor!;
    if (typeof req.body?.enabled !== "boolean") {
      return res.status(400).json({ error: "MISSING_REQUIRED_FIELDS" });
    }
    const enabled = req.body.enabled;

    const { data: rideRow } = await supabase
      .from("rides").select("status").eq("id", actor.rideId).maybeSingle();
    if (enabled && rideRow?.status === "completed") {
      return res.status(409).json({ error: "RIDE_ALREADY_COMPLETED" });
    }

    const nowIso = new Date().toISOString();
    const values = enabled
      ? { sharing: true, started_at: nowIso, stopped_at: null }
      : { sharing: false, stopped_at: nowIso };
    const { data, error } = await supabase
      .from("trip_tracking_state")
      .upsert({ ride_id: actor.rideId, user_id: actor.userId, ...values }, { onConflict: "ride_id,user_id" })
      .select("ride_id, user_id, sharing, started_at, stopped_at")
      .single();
    if (error) return res.status(500).json({ error: "TRACKING_UPDATE_FAILED", details: error.message });
    return res.json(data as Record<string, any>);
  }
);

matchesRouter.post(
  "/api/rides/:id/location",
  requireAuth,
  requireRideMembership("liveLocationsTable", "Live location sharing"),
  async (req: Request, res: Response) => {
    const actor = (req as Request & { rideActor: RideActor }).rideActor!;
    const { lat, lng } = req.body ?? {};
    if (typeof lat !== "number" || typeof lng !== "number" || Number.isNaN(lat) || Number.isNaN(lng)) {
      return res.status(400).json({ error: "INVALID_COORDINATES" });
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ error: "COORDINATES_OUT_OF_RANGE" });
    }

    // Pushes are only accepted while the member's toggle is on — a stale
    // client that forgot to stop can't keep writing after it opted out.
    const { data: state } = await supabase
      .from("trip_tracking_state")
      .select("sharing")
      .eq("ride_id", actor.rideId)
      .eq("user_id", actor.userId)
      .maybeSingle();
    if (!state?.sharing) return res.status(403).json({ error: "SHARING_NOT_ENABLED" });

    const { data: rideRow } = await supabase
      .from("rides").select("status").eq("id", actor.rideId).maybeSingle();
    if (rideRow?.status === "completed") return res.status(409).json({ error: "RIDE_ALREADY_COMPLETED" });

    const row: Record<string, any> = {
      ride_id: actor.rideId,
      user_id: actor.userId,
      lat,
      lng,
      updated_at: new Date().toISOString(),
    };
    if (typeof req.body.accuracy === "number") row.accuracy = req.body.accuracy;
    if (typeof req.body.heading === "number") row.heading = req.body.heading;

    const { data, error } = await supabase
      .from("live_locations")
      .upsert(row, { onConflict: "ride_id,user_id" })
      .select("ride_id, user_id, lat, lng, accuracy, heading, updated_at")
      .single();
    if (error) return res.status(500).json({ error: "LOCATION_WRITE_FAILED", details: error.message });
    return res.status(201).json(data as Record<string, any>);
  }
);

matchesRouter.get(
  "/api/rides/:id/locations",
  requireAuth,
  requireRideMembership("liveLocationsTable", "Live location sharing"),
  async (req: Request, res: Response) => {
    const actor = (req as Request & { rideActor: RideActor }).rideActor!;

    const { data, error } = await supabase
      .from("live_locations")
      .select("user_id, lat, lng, accuracy, heading, updated_at, users:user_id(display_name)")
      .eq("ride_id", actor.rideId);
    if (error) return res.status(500).json({ error: "LOCATION_FETCH_FAILED", details: error.message });

    // Only members currently sharing appear; a stopped member's last fix
    // is hidden so the map reflects who is actually being tracked now.
    const { data: sharingRows } = await supabase
      .from("trip_tracking_state")
      .select("user_id, sharing")
      .eq("ride_id", actor.rideId)
      .eq("sharing", true);
    const active = new Set((sharingRows ?? []).map((s: any) => s.user_id));

    return res.json({
      ride_id: actor.rideId,
      locations: (data ?? [])
        .filter((l: any) => active.has(l.user_id) || l.user_id === actor.userId)
        .map((l: any) => ({
          user_id: l.user_id,
          display_name: (l as Record<string, any>).users?.display_name ?? null,
          lat: Number(l.lat),
          lng: Number(l.lng),
          accuracy: l.accuracy != null ? Number(l.accuracy) : null,
          heading: l.heading != null ? Number(l.heading) : null,
          updated_at: l.updated_at,
          mine: l.user_id === actor.userId,
        })),
    });
  }
);

// ─────────────────────────────────────────────────────────────
// Ride participants, with server-side joiner-detail redaction for
// ride_hail_share mode. Delegates to the get_ride_participants(ride, viewer)
// RPC so the masking rules live in exactly one place (the DB), not the UI.
// ─────────────────────────────────────────────────────────────
matchesRouter.get(
  "/api/rides/:id/participants",
  requireAuth,
  requireRideMembership("ridesTable", "Ride participants"),
  async (req: Request, res: Response) => {
    const actor = (req as Request & { rideActor: RideActor }).rideActor!;

    const { data, error } = await supabase.rpc("get_ride_participants", {
      p_ride_id: actor.rideId,
      p_viewer_id: actor.userId,
    });
    if (error) return res.status(500).json({ error: "PARTICIPANTS_FETCH_FAILED", details: error.message });

    return res.json({
      ride_id: actor.rideId,
      viewer_id: actor.userId,
      participants: (data ?? []).map((p: any) => ({
        user_id: p.user_id,
        role: p.role,
        display_name: p.display_name,
        is_verified: p.is_verified,
        seats_requested: p.seats_requested,
        pickup_label: p.pickup_label,
        dropoff_label: p.dropoff_label,
        details_visible: p.details_visible,
      })),
    });
  }
);

// ─────────────────────────────────────────────────────────────
// Day 9 (part 2): the UI in front of the group-consent backend.
//   - "Join an existing shared ride" needs a way to browse open
//     rides the current user isn't already on.
//   - The consent vote itself needs a way for a rider to discover
//     "someone wants to join a ride you're already on" without
//     already knowing the ride_id/booking_id — a notification list,
//     not a lookup.
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Ride discovery: rebuilding "one car" out of the `rides` table.
//
// Rows there used to be minted per confirmation and owned by whoever
// pressed the final OK, so one three-person car can exist as three rows,
// each "driven" by a different passenger. Discovery has to undo that. The
// trustworthy evidence is the handshake store — every confirmed request
// names two people who are now in one car, and usually who hosts it —
// plus accepted seat bookings. Cars are rebuilt by joining those, then
// re-attributed to their host.
//
// Merging is always corridor-scoped. Folding by person alone once put a
// F-10 → G-10 group behind a NUST route label, which is worse than the
// duplicate it replaced.
// ─────────────────────────────────────────────────────────────

type BrowseMember = { user_id: string; display_name: string };

type BrowseCar = {
  /** Canonical row a join books against: the host's own row when they
   *  have one on this corridor, otherwise the oldest row in the car. */
  ride_id: string;
  /** Who actually drives — not necessarily `row.driver_id`. */
  driver_id: string;
  driver_display_name: string;
  driver_is_verified: boolean;
  row: Record<string, any>;
  /** Every row folded into this car. A join echoing any of them back is
   *  still a join into the same car, so the host claim stays verifiable
   *  for cars whose surviving rows predate the fix. */
  ride_ids: string[];
  corridor_key: string;
  members: Map<string, BrowseMember>;
  pending: Map<string, BrowseMember>;
  booked: number;
  total_seats: number;
  available_seats: number;
};

/** ~1 km per endpoint: the same sector pin re-dropped a few metres away
 *  is still the same corridor, but F-10 Markaz and NUST Gate 1 are not. */
function coarseCorridorOf(
  origin: { lat: unknown; lng: unknown } | null | undefined,
  destination: { lat: unknown; lng: unknown } | null | undefined
): string | null {
  if (!origin || !destination) return null;
  const oLat = Number(origin.lat);
  const oLng = Number(origin.lng);
  const dLat = Number(destination.lat);
  const dLng = Number(destination.lng);
  if (![oLat, oLng, dLat, dLng].every((n) => Number.isFinite(n))) return null;
  return `${oLat.toFixed(2)},${oLng.toFixed(2)}>${dLat.toFixed(2)},${dLng.toFixed(2)}`;
}

async function loadBrowseCars(): Promise<BrowseCar[]> {
  const caps = await getDbCapabilities();
  if (!caps.ridesTable) return [];

  const { data: rideRows } = await supabase
    .from("rides")
    .select("*, users:driver_id(display_name, is_verified)")
    .eq("status", "active")
    .gt("available_seats", 0)
    .order("created_at", { ascending: true })
    .limit(100);
  if (!rideRows || rideRows.length === 0) return [];

  const corridorOfRow = (r: Record<string, any>): string =>
    coarseCorridorOf(
      { lat: r.origin_lat, lng: r.origin_lng },
      { lat: r.destination_lat, lng: r.destination_lng }
    ) ?? `row:${r.id}`;

  const { data: bookingRows } = await supabase
    .from("ride_bookings")
    .select("ride_id, passenger_id, status, users:passenger_id(display_name)")
    .in(
      "ride_id",
      rideRows.map((r) => r.id)
    )
    .in("status", ["accepted", "pending", "pending_consent"]);

  // ── Union-find over (corridor, person) ──────────────────────────────
  const nodeName = (corridor: string, userId: string) => `${corridor}#${userId}`;
  const parent = new Map<string, string>();
  const find = (node: string): string => {
    if (!parent.has(node)) parent.set(node, node);
    let root = node;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    let walk = node;
    while (parent.get(walk) !== root) {
      const next = parent.get(walk) as string;
      parent.set(walk, root);
      walk = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const compKey = (corridor: string, userId: string) => `${corridor}|${find(nodeName(corridor, userId))}`;

  for (const r of rideRows) find(nodeName(corridorOfRow(r), r.driver_id));

  // A *confirmed* handshake is what proves two people share a car. An open
  // one is a pending seat, which is drawn inside the card, not merged.
  const liveRequests = listAllLiveShareRequests();
  /** corridor#user → how many confirmed handshakes name them the host. */
  const hostVotes = new Map<string, number>();
  for (const req of liveRequests) {
    if (req.status !== "confirmed") continue;
    const corridor = coarseCorridorOf(req.snapshot?.origin, req.snapshot?.destination);
    if (!corridor) continue;
    union(nodeName(corridor, req.fromUserId), nodeName(corridor, req.toUserId));
    if (req.group?.hostUserId) {
      const key = nodeName(corridor, req.group.hostUserId);
      hostVotes.set(key, (hostVotes.get(key) ?? 0) + 1);
    }
  }

  // ── Who is actually going which way, and in what vehicle ────────────
  // `vehicle_type` is 'none' for most real accounts — only the ride-hailing
  // and declaration flows ever write it — so it cannot be the test for
  // whether a car is real. An active trip request on the SAME corridor can.
  const driverIds = [...new Set(rideRows.map((r) => r.driver_id).filter(Boolean))];
  const tripSelect = caps.vehicleTypeCol
    ? "user_id, vehicle_type, origin_lat, origin_lng, destination_lat, destination_lng"
    : "user_id, origin_lat, origin_lng, destination_lat, destination_lng";
  const { data: tripRows, error: tripsError } = driverIds.length
    ? await supabase
        .from("trip_requests")
        .select(tripSelect)
        .in("user_id", driverIds)
        .eq("status", "active")
        .limit(2000)
    : { data: [] as any[], error: null };
  const tripsKnown = !tripsError;
  const VEHICLED = new Set(["car", "bike", "ride_hailing"]);
  const corridorsOffered = new Map<string, Set<string>>();
  const corridorsWithVehicle = new Set<string>();
  for (const t of tripRows ?? []) {
    const corridor = coarseCorridorOf(
      { lat: t.origin_lat, lng: t.origin_lng },
      { lat: t.destination_lat, lng: t.destination_lng }
    );
    if (!corridor || !t.user_id) continue;
    const set = corridorsOffered.get(t.user_id) ?? new Set<string>();
    set.add(corridor);
    corridorsOffered.set(t.user_id, set);
    if (caps.vehicleTypeCol && VEHICLED.has(String(t.vehicle_type ?? "none"))) {
      corridorsWithVehicle.add(nodeName(corridor, t.user_id));
    }
  }

  // ── Names ───────────────────────────────────────────────────────────
  const names = new Map<string, string>();
  const verified = new Map<string, boolean>();
  for (const r of rideRows) {
    if (!r.driver_id) continue;
    if (r.users?.display_name) names.set(r.driver_id, String(r.users.display_name));
    if (r.users?.is_verified) verified.set(r.driver_id, true);
  }
  for (const req of liveRequests) {
    if (req.fromUserId && req.fromName) names.set(req.fromUserId, req.fromName);
    if (req.toUserId && req.toName) names.set(req.toUserId, req.toName);
  }
  // `any[]` on purpose: supabase-js' type-level select parser models the
  // `users:passenger_id(...)` embed as a row array here, but the FK embed
  // returns a single object at runtime.
  for (const b of (bookingRows ?? []) as any[]) {
    if (b.passenger_id && b.users?.display_name) names.set(b.passenger_id, String(b.users.display_name));
  }

  // ── One draft per corridor-component ────────────────────────────────
  type Draft = { corridor: string; rows: Record<string, any>[] };
  const drafts = new Map<string, Draft>();
  const draftOfRide = new Map<string, Draft>();
  for (const r of rideRows) {
    const corridor = corridorOfRow(r);
    const key = compKey(corridor, r.driver_id);
    const draft = drafts.get(key) ?? { corridor, rows: [] };
    draft.rows.push(r);
    drafts.set(key, draft);
    draftOfRide.set(r.id, draft);
  }

  const occupants = new Map<string, { confirmed: Set<string>; pending: Set<string> }>();
  const addTo = (key: string, userId: string, confirmed: boolean) => {
    const bucket = occupants.get(key) ?? { confirmed: new Set<string>(), pending: new Set<string>() };
    (confirmed ? bucket.confirmed : bucket.pending).add(userId);
    occupants.set(key, bucket);
  };
  // A driver is in their own car until evidence says otherwise.
  for (const [key, draft] of drafts) {
    for (const r of draft.rows) addTo(key, r.driver_id, true);
  }
  // Then fold in everyone the store says shares that corridor, including a
  // host who never owned a `rides` row at all.
  for (const req of liveRequests) {
    const corridor = coarseCorridorOf(req.snapshot?.origin, req.snapshot?.destination);
    if (!corridor) continue;
    if (req.status === "confirmed") {
      addTo(compKey(corridor, req.fromUserId), req.fromUserId, true);
      addTo(compKey(corridor, req.toUserId), req.toUserId, true);
      continue;
    }
    // An open join belongs to the car it is addressed to: the stamped
    // host, or else whichever side already owns that car.
    const hostSide =
      req.group?.hostUserId ??
      (drafts.has(compKey(corridor, req.toUserId)) && !drafts.has(compKey(corridor, req.fromUserId))
        ? req.toUserId
        : drafts.has(compKey(corridor, req.fromUserId)) &&
            !drafts.has(compKey(corridor, req.toUserId))
          ? req.fromUserId
          : null);
    if (!hostSide) continue;
    const guest = hostSide === req.fromUserId ? req.toUserId : req.fromUserId;
    if (guest && guest !== hostSide) addTo(compKey(corridor, hostSide), guest, false);
  }
  for (const b of bookingRows ?? []) {
    const draft = draftOfRide.get(b.ride_id);
    if (!draft || !b.passenger_id) continue;
    addTo(compKey(draft.corridor, draft.rows[0].driver_id), b.passenger_id, b.status === "accepted");
  }

  // ── Host, canonical row, seats ──────────────────────────────────────
  const cars: BrowseCar[] = [];
  for (const [key, draft] of drafts) {
    const bucket = occupants.get(key) ?? { confirmed: new Set<string>(), pending: new Set<string>() };
    const candidates = [...new Set([...bucket.confirmed, ...draft.rows.map((r) => r.driver_id)])];

    // Whoever the confirmed handshakes keep naming as host; then whoever
    // brings the vehicle; then whoever owns the oldest row on this corridor.
    let host: string | null = null;
    let bestVotes = 0;
    for (const u of candidates) {
      const votes = hostVotes.get(nodeName(draft.corridor, u)) ?? 0;
      if (votes > bestVotes) {
        host = u;
        bestVotes = votes;
      }
    }
    if (!host) host = candidates.find((u) => corridorsWithVehicle.has(nodeName(draft.corridor, u))) ?? null;
    if (!host) {
      const offered = draft.rows.find((r) => corridorsOffered.get(r.driver_id)?.has(draft.corridor));
      host = offered?.driver_id ?? draft.rows[0].driver_id;
    }
    if (!host) continue;

    const canonical = draft.rows.find((r) => r.driver_id === host) ?? draft.rows[0];
    const car: BrowseCar = {
      ride_id: canonical.id,
      driver_id: host,
      driver_display_name: names.get(host) ?? "Driver",
      driver_is_verified: verified.get(host) === true,
      row: canonical as Record<string, any>,
      ride_ids: draft.rows.map((r) => r.id),
      corridor_key: draft.corridor,
      members: new Map(),
      pending: new Map(),
      booked: 0,
      total_seats: Number(canonical.total_seats ?? 4),
      available_seats: Number(canonical.available_seats ?? 4),
    };
    for (const u of bucket.confirmed) {
      if (u === host) continue;
      car.members.set(u, { user_id: u, display_name: names.get(u) ?? "A rider" });
    }
    for (const u of bucket.pending) {
      if (u === host || car.members.has(u)) continue;
      car.pending.set(u, { user_id: u, display_name: names.get(u) ?? "A rider" });
    }
    const rideIdsOfCar = new Set(car.ride_ids);
    car.booked = (bookingRows ?? []).filter(
      (b) => rideIdsOfCar.has(b.ride_id) && b.status === "accepted"
    ).length;
    // Seats reflect who is actually in the car, not whichever duplicate
    // row happens to still read 4/4.
    car.available_seats = Math.max(0, car.total_seats - car.members.size);
    cars.push(car);
  }

  // A car is only an offer while somebody is genuinely going that way.
  // But a driver with no active request at all is legacy or seeded demo
  // data, so hide only when they ARE offering and this corridor isn't part
  // of it — and never hide a car that already has people in it.
  return cars.filter(
    (car) =>
      car.members.size > 0 ||
      car.pending.size > 0 ||
      car.booked > 0 ||
      !tripsKnown ||
      !corridorsOffered.has(car.driver_id) ||
      corridorsOffered.get(car.driver_id)?.has(car.corridor_key) === true
  );
}

/** The car a `rides` row belongs to, so a join can be checked against the
 *  real host even when the row itself predates the fix. */
async function findCarOwningRide(rideId: string): Promise<BrowseCar | null> {
  const cars = await loadBrowseCars();
  return cars.find((c) => c.ride_ids.includes(rideId)) ?? null;
}

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
  const cars = await loadBrowseCars();

  const listings = cars
    // Already in this car (or the one offering it)? Not an option.
    .filter(
      (car) =>
        car.driver_id !== viewerId && !car.members.has(viewerId) && !car.pending.has(viewerId)
    )
    .map((car) => {
      const members = [...car.members.values()];
      const pendingMembers = [...car.pending.values()].filter((p) => !car.members.has(p.user_id));
      const riderCount = members.length + 1; // + whoever hosts the car
      const r = car.row;
      const distanceKm = r.distance_km ?? null;
      return {
        ride_id: car.ride_id,
        // Who the join is addressed to: the person hosting the car, which
        // for a rebuilt legacy car is NOT whoever the surviving `rides`
        // row happens to name. A join sends the approve-and-chat request
        // here and this is who can approve it.
        owner_user_id: car.driver_id,
        driver_display_name: car.driver_display_name,
        driver_is_verified: car.driver_is_verified,
        origin_label: r.origin_label,
        destination_label: r.destination_label,
        // Full coordinate points so the frontend can build a match-request
        // snapshot (the approve → conditions → chat handshake) from a ride.
        origin: { lat: r.origin_lat, lng: r.origin_lng, address_label: r.origin_label },
        destination: { lat: r.destination_lat, lng: r.destination_lng, address_label: r.destination_label },
        departure_time: r.departure_time,
        // Counted from who is actually in the car, since duplicate rows
        // each still read their own untouched seat total.
        available_seats: car.available_seats,
        total_seats: car.total_seats,
        driver_max_co_passengers: r.driver_max_co_passengers,
        current_rider_count: riderCount,
        // Who's already in this car — the card renders one group, not
        // lone profiles, and a join is addressed to the whole car.
        members,
        pending_members: pendingMembers,
        // Stable key the frontend echoes back as the request's group, so
        // every join into this car folds into ONE group chat. A ride row
        // has no trip_request column, so the ride id IS the car's identity.
        group_key: car.ride_id,
        // Riders after this viewer joins — used by the frontend to warn
        // "this join will need everyone's approval" before they even submit.
        will_need_group_consent: riderCount + 1 >= 3,
        co2_saved_summary: distanceKm ? co2SavedSummary(distanceKm, riderCount + 1) : null,
      };
    })
    .sort((a, b) => String(a.departure_time ?? "").localeCompare(String(b.departure_time ?? "")));

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
    const cnicFromBodyValid = isValidPakistaniCnic(cnicFromBody) ? normalizeCnic(cnicFromBody) : null;
    const cnic =
      cnicFromBodyValid ||
      getStoredCnic(profileId) ||
      getStoredCnic(authId);

    if (!cnic || !isValidPakistaniCnic(cnic)) {
      return res.status(400).json({
        error: "INVALID_CNIC",
        details: "CNIC missing — add it at signup, or send 12345-1234567-1 with this request.",
      });
    }
    // A CNIC supplied inline (accounts whose signup never stored one) is
    // remembered so the next search doesn't need it again.
    if (cnicFromBodyValid) {
      rememberCnicIfMissing(profileId, cnicFromBodyValid);
      if (authId !== profileId) rememberCnicIfMissing(authId, cnicFromBodyValid);
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

/** Public users.id for either a users.id or a Supabase auth uid — used
 *  wherever a thread/record must be keyed to ONE stable id per person
 *  (chat upserts, request participants) so the same pair never ends up
 *  with two rows that differ only by which id form was used. */
async function resolveCanonicalUserId(anyId: string): Promise<string | null> {
  if (!anyId || typeof anyId !== "string") return null;
  const { data: byId } = await supabase
    .from("users")
    .select("id")
    .eq("id", anyId)
    .maybeSingle();
  if (byId?.id) return byId.id;
  const { data: byAuth } = await supabase
    .from("users")
    .select("id")
    .eq("auth_user_id", anyId)
    .maybeSingle();
  return byAuth?.id ?? null;
}

async function lookupDisplayName(userId: string): Promise<string | null> {
  const { data } = await supabase
    .from("users")
    .select("display_name")
    .eq("id", userId)
    .maybeSingle();
  const name = (data as Record<string, any> | null)?.display_name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

// ─────────────────────────────────────────────────────────────
// Match-request input sanitizers. Everything arriving from a client is
// trimmed + length-capped, enums are validated (never trusted), numbers
// are clamped to sane ranges, and coordinates are range-checked.
// ─────────────────────────────────────────────────────────────

function cleanText(value: unknown, maxLen = 200): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLen);
}

function cleanGenderPreference(value: unknown): RequestGenderPreference {
  return value === "male_only" || value === "female_only" ? value : "any";
}

function cleanVehicleType(value: unknown): RequestVehicleType {
  return value === "car" || value === "bike" || value === "ride_hailing" ? value : "none";
}

function cleanMatchType(value: unknown): RequestMatchType {
  return value === "owner_passenger" || value === "shared_ride_hailing" ? value : "peer_share";
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanIsoDate(value: unknown, fallback: string): string {
  const t = Date.parse(String(value ?? ""));
  return Number.isFinite(t) ? new Date(t).toISOString() : fallback;
}

function cleanLatLng(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < -180 || n > 180) return null;
  return n;
}

function cleanSnapshotPoint(value: any): { lat: number; lng: number; address_label: string } | null {
  const lat = cleanLatLng(value?.lat);
  const lng = cleanLatLng(value?.lng);
  if (lat === null || lng === null || Math.abs(lat) > 90) return null;
  return {
    lat,
    lng,
    address_label: cleanText(value?.address_label, 160) || "Unnamed location",
  };
}

/** Alias-list membership check: does any known id of this viewer match
 *  the stored participant id? All identity decisions go through this. */
function viewerAliasesFor(...ids: (string | null | undefined)[]): string[] {
  return [...new Set(ids.filter((x): x is string => typeof x === "string" && x.length > 0))];
}

/** Snake_case wire format, with role/peer fields computed relative to
 *  the viewer so the frontend never has to know who started the request. */
function serializeMatchRequest(r: MatchRequest, viewerAliases: string[]) {
  const requester = isRequester(r, viewerAliases);
  const preferences = {
    gender_preference: r.preferences.genderPreference,
    departure_time: r.preferences.departureTime,
    flexibility_minutes: r.preferences.flexibilityMinutes,
    max_co_passengers: r.preferences.maxCoPassengers,
    vehicle_type: r.preferences.vehicleType,
    pickup_note: r.preferences.pickupNote,
    note: r.preferences.note,
  };
  const conditions = r.conditions
    ? {
        agrees_to_preferences: r.conditions.agreesToPreferences,
        pickup_spot: r.conditions.pickupSpot,
        departure_time_note: r.conditions.departureTimeNote,
        gender_preference: r.conditions.genderPreference,
        max_co_passengers: r.conditions.maxCoPassengers,
        fare_agreed: r.conditions.fareAgreed,
        note: r.conditions.note,
      }
    : null;
  const snapshot = {
    origin_label: r.snapshot.originLabel,
    destination_label: r.snapshot.destinationLabel,
    origin: r.snapshot.origin,
    destination: r.snapshot.destination,
    overlap_pct: r.snapshot.overlapPct,
    detour_added_minutes: r.snapshot.detourAddedMinutes,
    match_type: r.snapshot.matchType,
    fare_share_from_pkr: r.snapshot.fareShareFromPkr,
    fare_share_to_pkr: r.snapshot.fareShareToPkr,
  };
  return {
    id: r.id,
    status: r.status,
    role: requester ? ("requester" as const) : ("recipient" as const),
    peer_user_id: requester ? r.toUserId : r.fromUserId,
    peer_name: requester ? r.toName : r.fromName,
    from_user_id: r.fromUserId,
    from_name: r.fromName,
    to_user_id: r.toUserId,
    to_name: r.toName,
    from_trip_request_id: r.fromTripRequestId,
    to_trip_request_id: r.toTripRequestId,
    group: r.group
      ? {
          host_user_id: r.group.hostUserId,
          host_trip_request_id: r.group.hostTripRequestId,
          group_id: groupIdOf(r),
        }
      : null,
    preferences,
    conditions,
    snapshot,
    chat_id: r.chatId,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    responded_at: r.respondedAt,
    confirmed_at: r.confirmedAt,
    expires_at: r.expiresAt,
  };
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

    // Two-sided approval gate: a thread may only exist once BOTH riders
    // approved a match request (finalize stored a confirmed request).
    // Without that, any authenticated user could open a chat with any
    // other user by guessing an id.
    const authId = req.auth!.userId;
    const myAliases = await resolveUserAliases(authId);
    const peerAliases = await resolveUserAliases(String(peer_user_id));
    if (!hasConfirmedRequestBetween(myAliases, peerAliases)) {
      return res.status(403).json({
        error: "APPROVAL_REQUIRED",
        details:
          "A chat opens only after you and this rider have both approved a ride request — " +
          "send a request, wait for them to accept, then give the final OK.",
      });
    }

    // Key the thread by canonical users.id (never the auth uid variant)
    // so the approval flow's finalize-thread and this ride-id update are
    // the same thread for a pair.
    const myCanonical = (await resolveCanonicalUserId(authId)) ?? authId;
    const peerCanonical = (await resolveCanonicalUserId(String(peer_user_id))) ?? String(peer_user_id);
    if (myCanonical === peerCanonical) {
      return res.status(400).json({ error: "MISSING_REQUIRED_FIELDS" });
    }

    const thread = upsertMatchChat({
      myUserId: myCanonical,
      myDisplayName: typeof my_display_name === "string" ? my_display_name : "You",
      peerUserId: peerCanonical,
      peerDisplayName: typeof peer_display_name === "string" ? peer_display_name : "Carpool mate",
      originLabel: typeof origin_label === "string" ? origin_label : "Pickup",
      destinationLabel: typeof destination_label === "string" ? destination_label : "Drop-off",
      fareSharePkr: Number(fare_share_pkr) || 0,
      rideId: typeof ride_id === "string" ? ride_id : null,
    });

    return res.status(201).json({
      chat_id: thread.id,
      peer_user_id: peerCanonical,
      peer_display_name: thread.participantNames[peerCanonical],
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

    const meIds = new Set<string>([
      ...(await resolveUserAliases(authId)),
      ...(await resolveUserAliases(pathId)),
      authId,
      pathId,
    ]);
    const seen = new Map<string, NonNullable<ReturnType<typeof getMatchChat>>>();
    for (const uid of meIds) {
      for (const t of listMatchChatsForUser(uid)) seen.set(t.id, t);
    }
    const threads = [...seen.values()];

    // A chat thread never finishes on its own — the RIDE does. Without the
    // ride's real status, every participant keeps being offered "Arrived —
    // complete trip & rate" long after somebody else finished that ride,
    // because the only thing that ever hid the card was one browser's
    // localStorage archive. Status is server truth, so it reaches everyone.
    const rideIds = [...new Set(threads.map((t) => t.rideId).filter(Boolean) as string[])];
    let rideStatusById = new Map<string, string>();
    if (rideIds.length > 0 && (await getDbCapabilities()).ridesTable) {
      const { data: rideRows } = await supabase
        .from("rides")
        .select("id, status")
        .in("id", rideIds);
      rideStatusById = new Map(
        (rideRows ?? []).map((r: Record<string, any>) => [String(r.id), String(r.status)])
      );
    }

    return res.json({
      chats: threads.map((t) => {
        const peerId = t.participantIds.find((id) => !meIds.has(id)) ?? "";
        const isGroupThread = Boolean(t.groupId) && t.participantIds.length > 2;
        return {
          chat_id: t.id,
          peer_user_id: peerId,
          peer_display_name: isGroupThread
            ? `🚗 Carpool group · ${t.participantIds.length} riders`
            : (t.participantNames[peerId] ?? "Carpool mate"),
          member_count: t.participantIds.length,
          group_id: t.groupId ?? null,
          origin_label: t.originLabel,
          destination_label: t.destinationLabel,
          fare_share_pkr: t.fareSharePkr,
          ride_id: t.rideId,
          ride_status: t.rideId ? (rideStatusById.get(String(t.rideId)) ?? null) : null,
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

// ─────────────────────────────────────────────────────────────
// Two-sided ride approval: match requests.
//
// "Accept Ride" no longer confirms anything on its own. Rider A sends
// a request (preferences + a snapshot of the match); rider B either
// declines or accepts AND shares their conditions; A then gives the
// final OK — and only that finalize step creates the chat thread (and
// passes the APPROVAL_REQUIRED gate above). The acting user always
// comes from the JWT; participant checks use alias lists so a users.id
// and its auth uid are the same person everywhere in this flow.
// ─────────────────────────────────────────────────────────────

matchesRouter.post(
  "/api/match-requests",
  requireAuth,
  requireBodyFieldMatchesAuth("from_user_id"),
  async (req: Request, res: Response) => {
    const authId = req.auth!.userId;
    const { to_user_id, from_trip_request_id, to_trip_request_id } = req.body;
    if (!to_user_id || typeof to_user_id !== "string") {
      return res.status(400).json({ error: "MISSING_REQUIRED_FIELDS" });
    }

    const canonicalFrom = (await resolveCanonicalUserId(authId)) ?? authId;
    const canonicalTo = await resolveCanonicalUserId(to_user_id);
    if (!canonicalTo) return res.status(404).json({ error: "USER_NOT_FOUND" });
    if (canonicalTo === canonicalFrom) {
      return res.status(400).json({ error: "CANNOT_REQUEST_SELF" });
    }

    const rawPrefs = (req.body.preferences ?? {}) as Record<string, any>;
    const rawSnap = (req.body.snapshot ?? {}) as Record<string, any>;
    const origin = cleanSnapshotPoint(rawSnap.origin);
    const destination = cleanSnapshotPoint(rawSnap.destination);
    if (!origin || !destination) {
      return res.status(400).json({ error: "INVALID_SNAPSHOT", details: "Origin and destination with valid coordinates are required." });
    }

    const preferences: MatchRequestPreferences = {
      genderPreference: cleanGenderPreference(rawPrefs.gender_preference ?? rawPrefs.genderPreference),
      departureTime: cleanIsoDate(rawPrefs.departure_time ?? rawPrefs.departureTime, new Date().toISOString()),
      flexibilityMinutes: Math.round(clampNumber(rawPrefs.flexibility_minutes ?? rawPrefs.flexibilityMinutes, 0, 240, 0)),
      maxCoPassengers: Math.round(clampNumber(rawPrefs.max_co_passengers ?? rawPrefs.maxCoPassengers, -1, 8, -1)),
      vehicleType: cleanVehicleType(rawPrefs.vehicle_type ?? rawPrefs.vehicleType),
      pickupNote: cleanText(rawPrefs.pickup_note ?? rawPrefs.pickupNote, 200),
      note: cleanText(rawPrefs.note, 500),
    };
    const snapshot: MatchRequestSnapshot = {
      originLabel: cleanText(rawSnap.origin_label ?? rawSnap.originLabel, 160) || origin.address_label,
      destinationLabel: cleanText(rawSnap.destination_label ?? rawSnap.destinationLabel, 160) || destination.address_label,
      origin,
      destination,
      overlapPct: Math.round(clampNumber(rawSnap.overlap_pct ?? rawSnap.overlapPct, 0, 100, 0)),
      detourAddedMinutes: Math.round(clampNumber(rawSnap.detour_added_minutes ?? rawSnap.detourAddedMinutes, 0, 600, 0)),
      matchType: cleanMatchType(rawSnap.match_type ?? rawSnap.matchType),
      fareShareFromPkr: Math.round(clampNumber(rawSnap.fare_share_from_pkr ?? rawSnap.fareShareFromPkr, 0, 1_000_000, 0)),
      fareShareToPkr: Math.round(clampNumber(rawSnap.fare_share_to_pkr ?? rawSnap.fareShareToPkr, 0, 1_000_000, 0)),
    };

    // Group carpool context (optional): the request targets a host driver's
    // offered trip rather than a standalone profile. The host must actually
    // be one of the two parties — anything else is dropped, never trusted.
    const rawGroup = (req.body.group ?? {}) as Record<string, any>;
    let group: MatchRequestGroup | null =
      typeof rawGroup.host_user_id === "string" && typeof rawGroup.host_trip_request_id === "string" && rawGroup.host_trip_request_id
        ? { hostUserId: rawGroup.host_user_id, hostTripRequestId: rawGroup.host_trip_request_id }
        : null;
    if (group && group.hostUserId !== canonicalTo && group.hostUserId !== canonicalFrom) {
      // A joiner addressing a whole car sends one request to every rider in
      // it, so the host is often neither party. The claim is still checkable
      // — but against the CAR, not against the row's driver: a car rebuilt
      // from legacy per-confirmation rows is named after a co-rider while
      // its real host is somebody else entirely.
      const dbCaps = await getDbCapabilities();
      const claimedIds = [rawGroup.host_ride_id, rawGroup.host_trip_request_id].filter(
        (v: unknown): v is string => typeof v === "string" && v.length > 0
      );
      let verifiedHost = false;
      if (dbCaps.ridesTable) {
        for (const claimed of claimedIds) {
          const car = await findCarOwningRide(claimed);
          if (car && car.driver_id === group.hostUserId) {
            verifiedHost = true;
            break;
          }
        }
      }
      if (!verifiedHost) group = null;
    }

    // Mutual blocks kill the request before it can be sent — same rule
    // the match feed already applies.
    const caps = await getDbCapabilities();
    if (caps.blockedUsersTable) {
      const myAliases = await resolveUserAliases(authId);
      const theirAliases = await resolveUserAliases(to_user_id);
      const { data: mineBlocks } = await supabase
        .from("blocked_users")
        .select("id")
        .in("blocker_id", myAliases)
        .in("blocked_id", theirAliases);
      const { data: theirBlocks } = await supabase
        .from("blocked_users")
        .select("id")
        .in("blocker_id", theirAliases)
        .in("blocked_id", myAliases);
      if ((mineBlocks?.length ?? 0) > 0 || (theirBlocks?.length ?? 0) > 0) {
        return res.status(403).json({
          error: "USER_BLOCKED",
          details: "This rider can't be contacted — one of you has blocked the other.",
        });
      }
    }

    const viewerAliases = viewerAliasesFor(authId, canonicalFrom, ...(await resolveUserAliases(authId)));

    const myAliasList = viewerAliases;
    const peerAliasList = viewerAliasesFor(to_user_id, canonicalTo, ...(await resolveUserAliases(to_user_id)));
    const open = await durableFindOpenRequest(supabase, myAliasList, peerAliasList);
    if (open) {
      // Re-sending while MY request to them is still pending just edits
      // it in place (e.g. they tweaked departure time and hit send again).
      if (open.status === "pending" && isRequester(open, myAliasList)) {
        const updated = await durableUpdatePendingRequest(supabase, open.id, {
          preferences,
          snapshot,
          toTripRequestId:
            typeof to_trip_request_id === "string" ? to_trip_request_id : open.toTripRequestId,
        });
        if (updated) {
          return res.json({ request: serializeMatchRequest(updated, viewerAliases), updated: true });
        }
      }
      // Anything else (theirs-pending-on-me, or mine awaiting my final
      // OK) is a genuine conflict — the UI must resolve it first.
      const theyAskedMe = isRecipient(open, myAliasList);
      return res.status(409).json({
        error: "REQUEST_ALREADY_OPEN",
        details: theyAskedMe
          ? `${open.fromName} has already sent you an open ride request — answer it in "Ride requests for you" instead of sending your own.`
          : `You already have an open request with ${open.toName} — check "Your ride requests" instead of sending another one.`,
      });
    }

    let created: MatchRequest;
    try {
      created = await durableCreateMatchRequest(supabase, {
        fromUserId: canonicalFrom,
        fromName: (await lookupDisplayName(canonicalFrom)) ?? "You",
        toUserId: canonicalTo,
        toName: (await lookupDisplayName(canonicalTo)) ?? "Carpool mate",
        fromTripRequestId: typeof from_trip_request_id === "string" ? from_trip_request_id : null,
        toTripRequestId: typeof to_trip_request_id === "string" ? to_trip_request_id : null,
        preferences,
        snapshot,
        group,
      });
    } catch (error) {
      return res.status(500).json({
        error: "MATCH_REQUEST_CREATE_FAILED",
        details: error instanceof Error ? error.message : "The persistent request store is unavailable.",
      });
    }
    return res.status(201).json({ request: serializeMatchRequest(created, viewerAliases) });
  }
);

matchesRouter.get(
  "/api/users/:id/match-requests",
  requireAuth,
  async (req: Request, res: Response) => {
    const authId = req.auth!.userId;
    const pathId = String(req.params.id);
    // Same path-id vs auth-id rule as /api/users/:id/match-chats.
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

    const viewerAliases = viewerAliasesFor(
      authId,
      pathId,
      ...(await resolveUserAliases(authId)),
      ...(await resolveUserAliases(pathId))
    );

    const all = await durableListRequestsForUser(supabase, viewerAliases);
    return res.json({
      incoming: all
        .filter((r) => isRecipient(r, viewerAliases))
        .map((r) => serializeMatchRequest(r, viewerAliases)),
      outgoing: all
        .filter((r) => isRequester(r, viewerAliases))
        .map((r) => serializeMatchRequest(r, viewerAliases)),
    });
  }
);

matchesRouter.post(
  "/api/match-requests/:id/respond",
  requireAuth,
  async (req: Request, res: Response) => {
    const authId = req.auth!.userId;
    const viewerAliases = viewerAliasesFor(authId, ...(await resolveUserAliases(authId)));

    const request = await durableGetMatchRequest(supabase, String(req.params.id));
    if (!request) return res.status(404).json({ error: "MATCH_REQUEST_NOT_FOUND" });
    if (!isRecipient(request, viewerAliases)) {
      return res.status(403).json({ error: "NOT_RECIPIENT" });
    }
    if (request.status !== "pending") {
      return res.status(409).json({ error: "REQUEST_NOT_PENDING" });
    }

    const { decision } = req.body;
    if (decision !== "accept" && decision !== "decline") {
      return res.status(400).json({ error: "INVALID_DECISION" });
    }

    if (decision === "decline") {
      const declined = await durableRespondToRequest(supabase, request.id, "decline");
      if (!declined) return res.status(409).json({ error: "REQUEST_NOT_PENDING" });
      return res.json({ request: serializeMatchRequest(declined, viewerAliases) });
    }

    // Accepting means actively agreeing to what the requester asked
    // for — both confirmations are mandatory, no silent defaults.
    const raw = (req.body.conditions ?? {}) as Record<string, any>;
    const agrees = raw.agrees_to_preferences ?? raw.agreesToPreferences;
    const fare = raw.fare_agreed ?? raw.fareAgreed;
    if (agrees !== true) {
      return res.status(400).json({
        error: "PREFERENCES_NOT_AGREED",
        details: "Tick \"I'm OK with their preferences\" before accepting.",
      });
    }
    if (fare !== true) {
      return res.status(400).json({
        error: "FARE_NOT_AGREED",
        details: "Tick \"I agree to the fare split\" before accepting.",
      });
    }
    const rawCap = raw.max_co_passengers ?? raw.maxCoPassengers;
    const conditions: MatchRequestConditions = {
      agreesToPreferences: true,
      pickupSpot: cleanText(raw.pickup_spot ?? raw.pickupSpot, 200),
      departureTimeNote: cleanText(raw.departure_time_note ?? raw.departureTimeNote, 200),
      genderPreference: cleanGenderPreference(raw.gender_preference ?? raw.genderPreference),
      maxCoPassengers:
        rawCap === null || rawCap === undefined ? null : Math.round(clampNumber(rawCap, -1, 8, -1)),
      fareAgreed: true,
      note: cleanText(raw.note, 500),
    };
    const accepted = await durableRespondToRequest(supabase, request.id, "accept", conditions);
    if (!accepted) return res.status(409).json({ error: "REQUEST_NOT_PENDING" });
    return res.json({ request: serializeMatchRequest(accepted, viewerAliases) });
  }
);

matchesRouter.post(
  "/api/match-requests/:id/finalize",
  requireAuth,
  async (req: Request, res: Response) => {
    const authId = req.auth!.userId;
    const viewerAliases = viewerAliasesFor(authId, ...(await resolveUserAliases(authId)));

    const request = await durableGetMatchRequest(supabase, String(req.params.id));
    if (!request) return res.status(404).json({ error: "MATCH_REQUEST_NOT_FOUND" });
    if (!isRequester(request, viewerAliases)) {
      return res.status(403).json({ error: "NOT_REQUESTER" });
    }
    if (request.status !== "awaiting_requester") {
      return res.status(409).json({ error: "REQUEST_NOT_AWAITING_YOU" });
    }

    const { decision } = req.body;
    if (decision !== "confirm" && decision !== "withdraw") {
      return res.status(400).json({ error: "INVALID_DECISION" });
    }
    const finalized = await durableFinalizeRequest(supabase, request.id, decision);
    if (!finalized) return res.status(409).json({ error: "REQUEST_NOT_AWAITING_YOU" });

    if (decision === "withdraw") {
      return res.json({ request: serializeMatchRequest(finalized, viewerAliases) });
    }

    // The first OK is B's acceptance; this second OK is A's. Only now
    // does a chat exist — created server-side from the request's own
    // snapshot so a page refresh in between can't lose the ride.
    const canonicalFrom = (await resolveCanonicalUserId(finalized.fromUserId)) ?? finalized.fromUserId;
    const canonicalTo = (await resolveCanonicalUserId(finalized.toUserId)) ?? finalized.toUserId;
    // Group carpool: once a group thread exists (first confirmed rider +
    // host), every later confirmation joins THAT thread instead of opening
    // a parallel 1:1 chat — driver + Rider 1 + Rider 2 coordinate in one
    // conversation. First confirmation still creates the pair thread and
    // stamps it with the group id.
    const groupId = groupIdOf(finalized);
    const groupThread = groupId ? getGroupChat(groupId) : null;

    // Fold this pairing into the CAR's ride row rather than minting a new
    // one: the host of the group owns the ride, and whoever isn't the host
    // is booked onto it. Without a group (a plain 1:1 share) the requester
    // is the host, which is the behaviour the rating flow already assumes.
    let rideIdForThread: string | null = null;
    try {
      const hostUserId = finalized.group?.hostUserId ?? canonicalFrom;
      const riderUserId = hostUserId === canonicalFrom ? canonicalTo : canonicalFrom;
      rideIdForThread = await attachRiderToHostRide({
        hostUserId,
        riderUserId,
        origin: finalized.snapshot.origin,
        destination: finalized.snapshot.destination,
        departureTime: finalized.preferences.departureTime,
      });
    } catch {
      // Ride bookkeeping is best-effort — the confirmation already stands.
    }

    let thread;
    if (groupThread) {
      addChatParticipant(groupThread.id, canonicalFrom, finalized.fromName || "You");
      addChatParticipant(groupThread.id, canonicalTo, finalized.toName || "Carpool mate");
      // The group thread is the chat for the whole car, so it carries the
      // car's ride id — every later rider gets the same one.
      if (rideIdForThread && !groupThread.rideId) groupThread.rideId = rideIdForThread;
      thread = groupThread;
    } else {
      thread = upsertMatchChat({
        myUserId: canonicalFrom,
        myDisplayName: finalized.fromName || "You",
        peerUserId: canonicalTo,
        peerDisplayName: finalized.toName || "Carpool mate",
        originLabel: finalized.snapshot.originLabel,
        destinationLabel: finalized.snapshot.destinationLabel,
        fareSharePkr: finalized.snapshot.fareShareFromPkr,
        rideId: rideIdForThread,
        groupId,
      });
    }
    const withChat = await durableAttachChat(supabase, finalized.id, thread.id);
    return res.json({
      request: serializeMatchRequest(withChat ?? finalized, viewerAliases),
      chat_id: thread.id,
      ride_id: rideIdForThread ?? thread.rideId ?? null,
    });
  }
);

matchesRouter.post(
  "/api/match-requests/:id/cancel",
  requireAuth,
  async (req: Request, res: Response) => {
    const authId = req.auth!.userId;
    const viewerAliases = viewerAliasesFor(authId, ...(await resolveUserAliases(authId)));

    const request = await durableGetMatchRequest(supabase, String(req.params.id));
    if (!request) return res.status(404).json({ error: "MATCH_REQUEST_NOT_FOUND" });
    if (!isRequester(request, viewerAliases)) {
      return res.status(403).json({ error: "NOT_REQUESTER" });
    }
    const cancelled = await durableCancelRequest(supabase, request.id);
    if (!cancelled) {
      return res.status(409).json({ error: "REQUEST_NOT_OPEN" });
    }
    return res.json({ request: serializeMatchRequest(cancelled, viewerAliases) });
  }
);
