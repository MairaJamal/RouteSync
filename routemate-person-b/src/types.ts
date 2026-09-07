// ─────────────────────────────────────────────────────────────
// Shared Contract Types — MUST match Person A's DB schema/JSON
// exactly (field names, casing). Copied from the hackathon plan.
// ─────────────────────────────────────────────────────────────

export interface LocationPoint {
  lat: number; // e.g. 33.6844
  lng: number; // e.g. 73.0479
  address_label: string; // e.g. "F-10 Markaz, Islamabad"
}

// NOTE (Day 4 fix): Person A's DB `gender` enum is
// ('male', 'female', 'non_binary') — the original type here only had
// 'male'|'female' and would have silently mis-typed any non_binary row.
export type Gender = "male" | "female" | "non_binary";
export type GenderPreference = "any" | "male_only" | "female_only";

export interface GeoJSONLineString {
  type: "LineString";
  coordinates: [number, number][]; // [lng, lat] — OSRM/GeoJSON order
}

// Day 8: does this rider bring their own vehicle to the match? "none"
// (or the field being absent) means the classic peer-to-peer flow — two
// people who each already have their own way there, sharing a route and
// splitting the fare. "car"/"bike" means: if this rider matches with
// someone who has no vehicle, THEY are the owner/driver of that ride, not
// a peer splitting a fare — see matchPipeline.ts's owner/passenger fare
// path and calculateOwnerPassengerFare() in fareSplit.ts.
/** "ride_hailing" (Day 11): a group splitting one Yango/inDrive/Careem
 *  fare, where NOBODY in the app owns or drives the vehicle — the
 *  actual driver is outside the app entirely. This is economically
 *  and trust-wise distinct from "car"/"bike": there's no owner who
 *  rides free and no per-km fare to compute, because the fare is
 *  whatever the ride-hailing app already quoted, not something OSRM
 *  distance can derive. See resolveVehicleRoles() in
 *  matchPipeline.ts and calculateSharedHailingFareSplit() in
 *  fareSplit.ts. */
export type VehicleType = "none" | "car" | "bike" | "ride_hailing";

export interface TripRequest {
  request_id: string;
  user_id: string;
  user_name: string;
  user_gender: Gender;
  gender_preference: GenderPreference;
  /** Day 7: opt-in "the ride owner/driver must also satisfy my gendered
   *  preference" flag. Undefined on rows created before the migration. */
  require_driver_gender_match?: boolean;
  /** Day 8: undefined/omitted is treated identically to "none" — rows
   *  created before this migration keep working with zero special
   *  handling. See VehicleType above. */
  vehicle_type?: VehicleType;
  /** Only meaningful when vehicle_type === "ride_hailing" — the total
   *  fare this rider already has a quote for from the ride-hailing
   *  app (in PKR), divided by km each person travels on the trip.
   *  Settlement itself happens outside the app (cash/manual) — this
   *  is purely so the app can show an accurate per-person amount. */
  ride_hailing_fare_pkr?: number;
  origin: LocationPoint;
  destination: LocationPoint;
  route_geometry?: GeoJSONLineString;
  status: "pending" | "matched" | "expired" | "cancelled";
}

export interface OSRMRouteResult {
  distance_m: number;
  duration_s: number;
  geometry: GeoJSONLineString;
  /** Present when getRoute() is called with 3+ waypoints — one entry per
   *  leg between consecutive waypoints, in order. Used to split fares by
   *  actual road distance per leg rather than an even split. */
  legs?: { distance_m: number; duration_s: number }[];
}

/** Convert ONLY at the OSRM call boundary. Never pass raw [lat,lng] arrays elsewhere. */
export function formatForOSRM(pt: LocationPoint): [number, number] {
  return [pt.lng, pt.lat];
}

// ─────────────────────────────────────────────────────────────
// Flexible Ride-Pooling Capacity Types
// ─────────────────────────────────────────────────────────────

export interface UserProfile {
  id: string;
  name: string;
  gender: Gender;
  default_max_co_passengers: number; // default pre-fill for new requests
}

export interface Ride {
  id: string;
  driver_id: string;
  /** Day 7 group-safety metadata — optional so existing callers that don't
   *  carry gender info keep compiling; when present on BOTH the ride and the
   *  candidate, canAddPassenger enforces the mixed-gender 1:1 rule. */
  driver_gender?: Gender;
  driver_preference?: GenderPreference;
  origin: LocationPoint;
  destination: LocationPoint;
  departure_time: string;
  total_seats: number;
  available_seats: number;
  driver_max_co_passengers: number; // driver's cap on co-passengers
  status: "active" | "full" | "completed" | "cancelled";
}

export interface RideBooking {
  id: string;
  ride_id: string;
  passenger_id: string;
  passenger_name?: string;
  pickup_point: LocationPoint;
  dropoff_point: LocationPoint;
  seats_requested: number;
  /** max_co_passengers: How many OTHER passengers this rider is willing to share with:
   *  0 = private/solo only, 1 = up to 1 other, N = up to N others, -1 (or null) = no limit */
  max_co_passengers: number;
  /** Day 9: "pending_consent" means this booking would bring the pool to 3+
   *  total riders and is waiting on a unanimous vote from everyone in the
   *  new group (driver + existing passengers + this joiner) before it
   *  becomes "accepted". See ride_consents / respond_to_ride_consent(). */
  status: "pending" | "pending_consent" | "accepted" | "completed" | "cancelled";
  /** Only set while status === "pending_consent". Past this timestamp
   *  the booking is stale and must be treated as cancelled — see
   *  CONSENT_EXPIRY_MINUTES / expireStaleConsentBookings() in
   *  poolingCapacity.ts. A rider who never votes must not be able to
   *  hold a seat hostage indefinitely. */
  expires_at?: string | null;
  /** Set once the ~5-minute-left reminder has been sent for this
   *  booking, so notify_near_expiry_consents() never nudges twice. */
  nudged_at?: string | null;
}

// ─────────────────────────────────────────────────────────────
// Day 9: Group consent (3+ rider pools) & carbon savings ledger
// ─────────────────────────────────────────────────────────────

/** "expired" is distinct from "declined": nobody said no, the window
 *  just ran out. Kept separate so the UI can tell a rider "Ali didn't
 *  respond in time" instead of implying Ali actively rejected it. */
export type ConsentStatus = "awaiting" | "agreed" | "declined" | "expired";

/** One row per (booking, rider) vote. Populated automatically by
 *  book_pooled_ride() whenever a join would bring a pool to 3+ total
 *  riders — every current rider AND the joining candidate gets one. */
export interface RideConsent {
  id: string;
  ride_id: string;
  booking_id: string;
  rider_id: string;
  status: ConsentStatus;
  requested_at?: string;
  responded_at?: string | null;
}

export type ConsentOutcomeReason =
  | "SUCCESS"
  | "AWAITING_GROUP_CONSENT"
  | "ALL_AGREED"
  | "AWAITING_OTHERS"
  | "DECLINED"
  | "ALREADY_RESPONDED"
  | "NOT_A_VOTER_ON_THIS_BOOKING"
  | "NOT_AWAITING_CONSENT"
  | "BOOKING_NOT_FOUND"
  | "CONSENT_EXPIRED";

/** One row per rider per completed ride — sum by rider_id for a
 *  profile-level running "CO2 avoided" total, not just a one-off
 *  number shown at the fare-estimate stage. */
export interface CarbonSavingsRow {
  id: string;
  ride_id: string;
  rider_id: string;
  co2_saved_kg: number;
  rider_count: number;
  distance_km: number;
  created_at?: string;
}

export interface PassengerCandidate {
  passenger_id: string;
  passenger_name?: string;
  /** Day 7 group-safety metadata — see Ride.driver_gender note. */
  passenger_gender?: Gender;
  passenger_preference?: GenderPreference;
  seats_requested: number;
  max_co_passengers: number;
  pickup_point: LocationPoint;
  dropoff_point: LocationPoint;
}

export interface RideWithBookings extends Ride {
  passengers: RideBooking[];
}

// ─────────────────────────────────────────────────────────────
// Day 10: In-app notification feed. A pending consent vote used to
// be invisible unless a rider happened to have the app open and
// polling; this closes that gap without depending on push/SMS infra
// (no device tokens or user phone numbers exist yet — see the
// migration comment for why this is the feed, not push, for now).
// ─────────────────────────────────────────────────────────────

export type NotificationKind =
  | "consent_requested" // a join needs this rider's vote
  | "consent_reminder" // ~5 minutes left and this rider hasn't voted yet
  | "consent_resolved" // the group finished voting (accepted or declined)
  | "consent_expired"; // nobody finished voting in time

export interface AppNotification {
  id: string;
  user_id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  ride_id?: string | null;
  booking_id?: string | null;
  created_at: string;
  read_at?: string | null;
}

export type CapacityRejectionReason =
  | "DRIVER_CAP_EXCEEDED"
  | "PASSENGER_CAP_EXCEEDED"
  | "EXISTING_PASSENGER_CAP_VIOLATED"
  | "INSUFFICIENT_SEATS"
  | "RIDE_NOT_ACTIVE"
  | "GROUP_SAFETY_MIXED_PAIR";

export interface CapacityCheckResult {
  canAdd: boolean;
  proposedCoPassengerCount: number;
  reason?: CapacityRejectionReason;
  effectiveRideCap?: number;
}

// ─────────────────────────────────────────────────────────────
// Day 7: Safety & Trust contract types
// ─────────────────────────────────────────────────────────────

export interface EmergencyContact {
  id: string;
  user_id: string;
  contact_name: string;
  contact_phone: string; // E.164, e.g. +923001234567
  created_at?: string;
}

// ─────────────────────────────────────────────────────────────
// Day 12: self-attested vehicle details for car/bike owners. See
// vehicleDeclaration.ts for the "this is not verification" rationale
// and why the full CNIC never appears in either of these shapes.
// ─────────────────────────────────────────────────────────────

/** What the OWNER sees about their own declaration — never the full
 *  CNIC, only its last 4 digits, so there's no representation of it
 *  anywhere in the app worth exposing even to its own owner. */
export interface OwnVehicleDeclaration {
  vehicle_plate: string;
  vehicle_make_model?: string | null;
  cnic_last4: string;
  declared_at: string;
}

/** What a MATCHED RIDER sees about someone else's declaration — no
 *  CNIC information at all, not even the last 4 digits. Just enough
 *  to visually confirm the car at pickup, plus a boolean so the UI
 *  can say "self-declared" rather than implying anything stronger. */
export interface PublicVehicleDeclaration {
  vehicle_plate: string;
  vehicle_make_model?: string | null;
  declared_at: string;
}

export interface SosEvent {
  id?: string;
  user_id: string;
  trip_request_id?: string | null;
  ride_id?: string | null;
  lat: number;
  lng: number;
  triggered_at?: string;
}

export interface Rating {
  id?: string;
  ride_id: string;
  rater_id: string;
  rated_user_id: string;
  stars: number; // 1-5
  comment?: string | null; // max 500 chars
  created_at?: string;
}

export interface RatingSummary {
  avg_stars: number; // rounded to 1 decimal; 0 when unrated
  rating_count: number;
}

export type ReportReason =
  | "unsafe_driving"
  | "inappropriate_behavior"
  | "no_show"
  | "other";

export interface UserReport {
  id?: string;
  reporter_id: string;
  reported_user_id: string;
  ride_id?: string | null;
  reason: ReportReason;
  details?: string | null; // max 500 chars
  status?: "open" | "reviewed";
  created_at?: string;
}

export interface BlockedUser {
  id: string;
  blocker_id: string;
  blocked_id: string;
  created_at?: string;
}

