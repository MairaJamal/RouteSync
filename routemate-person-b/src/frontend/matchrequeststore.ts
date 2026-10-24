/**
 * Two-sided match-request store. A chat only exists — and a ride is
 * only treated as confirmed — after BOTH riders have approved, and this
 * store is the single source of truth for that approval state.
 *
 * Same persistence pattern as chatStore.ts: a Map in memory, mirrored to
 * .data/match-requests.json so tsx/watch restarts don't wipe pending
 * requests mid-approval. No Supabase table — requests are short-lived
 * (24h) handshake state, not ledger data.
 *
 * Identity note: a user may be referenced by public.users.id OR by their
 * Supabase auth uid. Callers pass ALIAS LISTS (from resolveUserAliases in
 * apiHandler.ts) into the find/has/is* helpers so both forms match.
 */
import fs from "fs";
import path from "path";

export type MatchRequestStatus =
  | "pending"
  | "awaiting_requester"
  | "confirmed"
  | "declined"
  | "cancelled"
  | "expired";

export type RequestGenderPreference = "any" | "male_only" | "female_only";
export type RequestVehicleType = "none" | "car" | "bike" | "ride_hailing";
export type RequestMatchType = "peer_share" | "owner_passenger" | "shared_ride_hailing";

/** What the requester shares when they send the request (step 1). */
export interface MatchRequestPreferences {
  genderPreference: RequestGenderPreference;
  /** ISO timestamp the requester plans to depart at. */
  departureTime: string;
  flexibilityMinutes: number;
  /** -1 = no limit, 0 = solo only, n = at most n other passengers. */
  maxCoPassengers: number;
  vehicleType: RequestVehicleType;
  pickupNote: string;
  note: string;
}

/** What the recipient shares when they accept (step 2). Null until then. */
export interface MatchRequestConditions {
  agreesToPreferences: boolean;
  pickupSpot: string;
  departureTimeNote: string;
  genderPreference: RequestGenderPreference;
  /** null = "no change", happy with whatever the requester asked for. */
  maxCoPassengers: number | null;
  fareAgreed: boolean;
  note: string;
}

/** A snapshot of the match as it looked when the request was sent, so
 *  the ride + chat can still be created after finalize even if the
 *  requester refreshed the page and lost their match list. */
export interface MatchRequestSnapshotPoint {
  lat: number;
  lng: number;
  address_label: string;
}

export interface MatchRequestSnapshot {
  originLabel: string;
  destinationLabel: string;
  origin: MatchRequestSnapshotPoint;
  destination: MatchRequestSnapshotPoint;
  overlapPct: number;
  detourAddedMinutes: number;
  matchType: RequestMatchType;
  fareShareFromPkr: number;
  fareShareToPkr: number;
}

/** Group carpool context: set when this request asks to JOIN a host
 *  driver's car (the offered trip lives under the host's user id), so
 *  the handshake and the chat can be treated as multi-party state —
 *  host + already-confirmed riders + this requester — instead of a
 *  standalone 1:1 request. Null for plain peer-to-peer requests. */
export interface MatchRequestGroup {
  hostUserId: string;
  hostTripRequestId: string;
}

export interface MatchRequest {
  id: string;
  fromUserId: string;
  fromName: string;
  toUserId: string;
  toName: string;
  fromTripRequestId: string | null;
  toTripRequestId: string | null;
  status: MatchRequestStatus;
  preferences: MatchRequestPreferences;
  conditions: MatchRequestConditions | null;
  snapshot: MatchRequestSnapshot;
  /** Present when the request targets a host driver's offered trip. */
  group?: MatchRequestGroup | null;
  /** Set by attachChatToRequest once the requester gives the final OK. */
  chatId: string | null;
  createdAt: string;
  updatedAt: string;
  respondedAt: string | null;
  confirmedAt: string | null;
  expiresAt: string;
}

const STORE_DIR = path.join(process.cwd(), ".data");
const STORE_PATH = path.join(STORE_DIR, "match-requests.json");

const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
/** Resolved requests (declined/cancelled/expired) stay visible this long
 *  so the other side can actually see the outcome before it disappears. */
const RESOLVED_VISIBLE_MS = 24 * 60 * 60 * 1000;

const requestsById = new Map<string, MatchRequest>();

function persist() {
  try {
    if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify([...requestsById.values()]), "utf8");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[matchRequestStore] persist failed:", err instanceof Error ? err.message : err);
  }
}

function hydrate() {
  try {
    if (!fs.existsSync(STORE_PATH)) return;
    const rows = JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) as MatchRequest[];
    requestsById.clear();
    for (const row of rows ?? []) {
      if (row?.id) requestsById.set(row.id, row);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[matchRequestStore] hydrate failed:", err instanceof Error ? err.message : err);
  }
}

hydrate();

function isOpen(r: MatchRequest): boolean {
  return r.status === "pending" || r.status === "awaiting_requester";
}

function touches(r: MatchRequest): void {
  r.updatedAt = new Date().toISOString();
}

/**
 * Sweep stale state. Unanswered requests past expiresAt become
 * "expired"; resolved requests older than RESOLVED_VISIBLE_MS are
 * dropped from the listing (confirmed ones stay — they are the durable
 * record that a pair mutually approved, and the chat gate checks them).
 * Called lazily before every read, mirroring expireStaleConsents().
 */
export function expireStaleMatchRequests(): void {
  const now = Date.now();
  let changed = false;
  for (const [id, r] of requestsById) {
    if (isOpen(r) && Date.parse(r.expiresAt) <= now) {
      r.status = "expired";
      touches(r);
      changed = true;
    } else if (r.status !== "confirmed" && now - Date.parse(r.updatedAt) > RESOLVED_VISIBLE_MS) {
      requestsById.delete(id);
      changed = true;
    }
  }
  if (changed) persist();
}

export function createMatchRequest(input: {
  fromUserId: string;
  fromName: string;
  toUserId: string;
  toName: string;
  fromTripRequestId?: string | null;
  toTripRequestId?: string | null;
  preferences: MatchRequestPreferences;
  snapshot: MatchRequestSnapshot;
  group?: MatchRequestGroup | null;
}): MatchRequest {
  const nowIso = new Date().toISOString();
  const request: MatchRequest = {
    id: `mreq_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    fromUserId: input.fromUserId,
    fromName: input.fromName,
    toUserId: input.toUserId,
    toName: input.toName,
    fromTripRequestId: input.fromTripRequestId ?? null,
    toTripRequestId: input.toTripRequestId ?? null,
    group: input.group ?? null,
    status: "pending",
    preferences: input.preferences,
    conditions: null,
    snapshot: input.snapshot,
    chatId: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    respondedAt: null,
    confirmedAt: null,
    expiresAt: new Date(Date.now() + REQUEST_TTL_MS).toISOString(),
  };
  requestsById.set(request.id, request);
  persist();
  return request;
}

/** Re-sending while the requester's own request is still pending edits
 *  it in place instead of stacking duplicates (409 only for genuinely
 *  conflicting states). */
export function updatePendingRequest(
  id: string,
  patch: {
    preferences?: MatchRequestPreferences;
    snapshot?: MatchRequestSnapshot;
    toTripRequestId?: string | null;
  }
): MatchRequest | null {
  expireStaleMatchRequests();
  const r = requestsById.get(id);
  if (!r || r.status !== "pending") return null;
  if (patch.preferences) r.preferences = patch.preferences;
  if (patch.snapshot) r.snapshot = patch.snapshot;
  if (patch.toTripRequestId !== undefined) r.toTripRequestId = patch.toTripRequestId;
  touches(r);
  persist();
  return r;
}

export function getMatchRequest(id: string): MatchRequest | null {
  expireStaleMatchRequests();
  return requestsById.get(id) ?? null;
}

function overlaps(ids: string[], value: string): boolean {
  return ids.includes(value);
}

function pairMatches(r: MatchRequest, a: string[], b: string[]): boolean {
  return (
    (overlaps(a, r.fromUserId) && overlaps(b, r.toUserId)) ||
    (overlaps(b, r.fromUserId) && overlaps(a, r.toUserId))
  );
}

/** The open (pending / awaiting_requester) request between this pair,
 *  in either direction — newest first. */
export function findOpenRequestBetween(a: string[], b: string[]): MatchRequest | null {
  expireStaleMatchRequests();
  const candidates = [...requestsById.values()]
    .filter((r) => isOpen(r) && pairMatches(r, a, b))
    .sort((x, y) => y.createdAt.localeCompare(x.createdAt));
  return candidates[0] ?? null;
}

/** Did this pair ever complete a mutual approval? This is the gate in
 *  POST /api/match-chats — threads may only exist after confirmation. */
export function hasConfirmedRequestBetween(a: string[], b: string[]): boolean {
  expireStaleMatchRequests();
  for (const r of requestsById.values()) {
    if (r.status === "confirmed" && pairMatches(r, a, b)) return true;
  }
  return false;
}

export function respondToRequest(
  id: string,
  decision: "accept" | "decline",
  conditions?: MatchRequestConditions
): MatchRequest | null {
  expireStaleMatchRequests();
  const r = requestsById.get(id);
  if (!r) return null;
  if (decision === "decline") {
    r.status = "declined";
    r.respondedAt = new Date().toISOString();
    touches(r);
    persist();
    return r;
  }
  if (r.status !== "pending") return null;
  if (!conditions) return null;
  r.conditions = conditions;
  r.status = "awaiting_requester";
  r.respondedAt = new Date().toISOString();
  touches(r);
  persist();
  return r;
}

/** The requester's final OK (or withdrawal) after the recipient shared
 *  their conditions. Confirmation is the ONLY path that leads to a chat. */
export function finalizeRequest(
  id: string,
  decision: "confirm" | "withdraw"
): MatchRequest | null {
  expireStaleMatchRequests();
  const r = requestsById.get(id);
  if (!r) return null;
  if (r.status !== "awaiting_requester") return null;
  r.status = decision === "confirm" ? "confirmed" : "cancelled";
  if (decision === "confirm") r.confirmedAt = new Date().toISOString();
  touches(r);
  persist();
  return r;
}

/** Requester closes their own still-open request at any point. */
export function cancelRequest(id: string): MatchRequest | null {
  expireStaleMatchRequests();
  const r = requestsById.get(id);
  if (!r) return null;
  if (!isOpen(r)) return null;
  r.status = "cancelled";
  touches(r);
  persist();
  return r;
}

export function attachChatToRequest(id: string, chatId: string): MatchRequest | null {
  const r = requestsById.get(id);
  if (!r) return null;
  r.chatId = chatId;
  touches(r);
  persist();
  return r;
}

/** Everything this user (by any alias) is party to — both directions. */
export function listRequestsForUser(aliases: string[]): MatchRequest[] {
  expireStaleMatchRequests();
  return [...requestsById.values()]
    .filter((r) => overlaps(aliases, r.fromUserId) || overlaps(aliases, r.toUserId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function isRequester(r: MatchRequest, aliases: string[]): boolean {
  return overlaps(aliases, r.fromUserId);
}

export function isRecipient(r: MatchRequest, aliases: string[]): boolean {
  return overlaps(aliases, r.toUserId);
}

/** Stable identity of the carpool group a request belongs to — the host
 *  driver plus the specific trip they offered. Requests sharing one
 *  groupId describe one car: host + Rider 1 + joining Rider 2… */
export function groupIdOf(r: MatchRequest): string | null {
  if (!r.group?.hostUserId || !r.group?.hostTripRequestId) return null;
  return `grp_${r.group.hostUserId}_${r.group.hostTripRequestId}`;
}

/** Everyone already confirmed into a host's car (the joiner on each
 *  confirmed request), oldest confirmation first. */
export function listConfirmedGroupMembers(
  hostUserId: string,
  hostTripRequestId: string
): { userId: string; displayName: string; joinedAt: string }[] {
  expireStaleMatchRequests();
  const byUserId = new Map<string, { userId: string; displayName: string; joinedAt: string }>();
  for (const r of requestsById.values()) {
    if (r.status !== "confirmed") continue;
    if (r.group?.hostUserId !== hostUserId || r.group?.hostTripRequestId !== hostTripRequestId) {
      continue;
    }
    const member =
      r.fromUserId === hostUserId
        ? { userId: r.toUserId, displayName: r.toName }
        : { userId: r.fromUserId, displayName: r.fromName };
    if (!member.userId || member.userId === hostUserId) continue;
    const joinedAt = r.confirmedAt ?? r.updatedAt;
    const prev = byUserId.get(member.userId);
    if (!prev || joinedAt < prev.joinedAt) {
      byUserId.set(member.userId, { ...member, joinedAt });
    }
  }
  return [...byUserId.values()].sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
}

/** Every still-relevant request (confirmed OR open) where one of these
 *  users is a party. The /matches endpoint uses this to work out who is
 *  already riding in whose car — including requests made before the
 *  group field existed — so co-riders nest inside the host's card
 *  instead of showing as standalone options. */
export function listRideShareRequests(userIds: string[]): MatchRequest[] {
  expireStaleMatchRequests();
  const set = new Set(userIds.filter(Boolean));
  return [...requestsById.values()].filter(
    (r) =>
      (r.status === "confirmed" || r.status === "pending" || r.status === "awaiting_requester") &&
      (set.has(r.fromUserId) || set.has(r.toUserId))
  );
}

/** Every still-live request in the store, whoever it's between.
 *
 *  Ride discovery needs the whole carpool graph, not just the viewer's
 *  neighbourhood: a car whose host never owned a `rides` row can only be
 *  reassembled by following confirmed handshakes between people the
 *  viewer has never met. */
export function listAllLiveShareRequests(): MatchRequest[] {
  expireStaleMatchRequests();
  return [...requestsById.values()].filter(
    (r) => r.status === "confirmed" || r.status === "pending" || r.status === "awaiting_requester"
  );
}
