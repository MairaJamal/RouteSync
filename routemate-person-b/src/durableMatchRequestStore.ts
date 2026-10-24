import type { MatchRequest, MatchRequestConditions, MatchRequestGroup } from "./frontend/matchrequeststore";

type DbClient = {
  from: (table: string) => any;
};

type MatchRequestInput = {
  fromUserId: string;
  fromName: string;
  toUserId: string;
  toName: string;
  fromTripRequestId?: string | null;
  toTripRequestId?: string | null;
  preferences: MatchRequest["preferences"];
  snapshot: MatchRequest["snapshot"];
  group?: MatchRequestGroup | null;
};

function rowToRequest(row: Record<string, any>): MatchRequest {
  const storedSnapshot = (row.snapshot ?? {}) as Record<string, any>;
  const group = (storedSnapshot.__group ?? null) as MatchRequestGroup | null;
  const { __group: _ignored, ...snapshot } = storedSnapshot;
  return {
    id: String(row.id),
    fromUserId: String(row.from_user_id),
    fromName: String(row.from_name ?? ""),
    toUserId: String(row.to_user_id),
    toName: String(row.to_name ?? ""),
    fromTripRequestId: row.from_trip_request_id ?? null,
    toTripRequestId: row.to_trip_request_id ?? null,
    status: row.status,
    preferences: row.preferences ?? {},
    conditions: row.conditions ?? null,
    snapshot: snapshot as MatchRequest["snapshot"],
    group,
    chatId: row.chat_id ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    respondedAt: row.responded_at ?? null,
    confirmedAt: row.confirmed_at ?? null,
    expiresAt: String(row.expires_at),
  };
}

function requestRow(request: MatchRequest) {
  return {
    id: request.id,
    from_user_id: request.fromUserId,
    from_name: request.fromName,
    to_user_id: request.toUserId,
    to_name: request.toName,
    from_trip_request_id: request.fromTripRequestId,
    to_trip_request_id: request.toTripRequestId,
    status: request.status,
    preferences: request.preferences,
    conditions: request.conditions,
    snapshot: { ...request.snapshot, __group: request.group ?? null },
    chat_id: request.chatId,
    created_at: request.createdAt,
    updated_at: request.updatedAt,
    responded_at: request.respondedAt,
    confirmed_at: request.confirmedAt,
    expires_at: request.expiresAt,
  };
}

function partyFilter(aliases: string[]) {
  const ids = [...new Set(aliases.filter(Boolean))];
  return ids.length ? ids : ["00000000-0000-0000-0000-000000000000"];
}

export async function durableCreateMatchRequest(db: DbClient, input: MatchRequestInput): Promise<MatchRequest> {
  const now = new Date().toISOString();
  const request: MatchRequest = {
    id: `mreq_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    fromUserId: input.fromUserId,
    fromName: input.fromName,
    toUserId: input.toUserId,
    toName: input.toName,
    fromTripRequestId: input.fromTripRequestId ?? null,
    toTripRequestId: input.toTripRequestId ?? null,
    status: "pending",
    preferences: input.preferences,
    conditions: null,
    snapshot: input.snapshot,
    group: input.group ?? null,
    chatId: null,
    createdAt: now,
    updatedAt: now,
    respondedAt: null,
    confirmedAt: null,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
  const { error } = await db.from("match_requests").insert(requestRow(request));
  if (error) throw new Error(`MATCH_REQUEST_CREATE_FAILED: ${error.message}`);
  return request;
}

export async function durableGetMatchRequest(db: DbClient, id: string): Promise<MatchRequest | null> {
  const { data, error } = await db.from("match_requests").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`MATCH_REQUEST_READ_FAILED: ${error.message}`);
  return data ? rowToRequest(data) : null;
}

export async function durableListRequestsForUser(db: DbClient, aliases: string[]): Promise<MatchRequest[]> {
  const ids = partyFilter(aliases);
  const { data, error } = await db
    .from("match_requests")
    .select("*")
    .or(`from_user_id.in.(${ids.join(",")}),to_user_id.in.(${ids.join(",")})`)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`MATCH_REQUEST_LIST_FAILED: ${error.message}`);
  return (data ?? []).map(rowToRequest);
}

export async function durableFindOpenRequest(db: DbClient, a: string[], b: string[]): Promise<MatchRequest | null> {
  const all = await durableListRequestsForUser(db, [...a, ...b]);
  const aSet = new Set(a);
  const bSet = new Set(b);
  return (
    all.find(
      (r) =>
        (r.status === "pending" || r.status === "awaiting_requester") &&
        ((aSet.has(r.fromUserId) && bSet.has(r.toUserId)) || (bSet.has(r.fromUserId) && aSet.has(r.toUserId)))
    ) ?? null
  );
}

export async function durableUpdatePendingRequest(
  db: DbClient,
  id: string,
  patch: { preferences?: MatchRequest["preferences"]; snapshot?: MatchRequest["snapshot"]; toTripRequestId?: string | null }
): Promise<MatchRequest | null> {
  const existing = await durableGetMatchRequest(db, id);
  if (!existing || existing.status !== "pending") return null;
  const next = { ...existing, ...patch, updatedAt: new Date().toISOString() } as MatchRequest;
  const { error } = await db.from("match_requests").update(requestRow(next)).eq("id", id);
  if (error) throw new Error(`MATCH_REQUEST_UPDATE_FAILED: ${error.message}`);
  return next;
}

export async function durableRespondToRequest(
  db: DbClient,
  id: string,
  decision: "accept" | "decline",
  conditions?: MatchRequestConditions
): Promise<MatchRequest | null> {
  const existing = await durableGetMatchRequest(db, id);
  if (!existing) return null;
  if (decision === "accept" && (existing.status !== "pending" || !conditions)) return null;
  const now = new Date().toISOString();
  const next: MatchRequest = {
    ...existing,
    status: decision === "decline" ? "declined" : "awaiting_requester",
    conditions: decision === "decline" ? existing.conditions : conditions!,
    respondedAt: now,
    updatedAt: now,
  };
  const { error } = await db.from("match_requests").update(requestRow(next)).eq("id", id);
  if (error) throw new Error(`MATCH_REQUEST_RESPOND_FAILED: ${error.message}`);
  return next;
}

export async function durableFinalizeRequest(db: DbClient, id: string, decision: "confirm" | "withdraw"): Promise<MatchRequest | null> {
  const existing = await durableGetMatchRequest(db, id);
  if (!existing || existing.status !== "awaiting_requester") return null;
  const now = new Date().toISOString();
  const next: MatchRequest = {
    ...existing,
    status: decision === "confirm" ? "confirmed" : "cancelled",
    confirmedAt: decision === "confirm" ? now : existing.confirmedAt,
    updatedAt: now,
  };
  const { error } = await db.from("match_requests").update(requestRow(next)).eq("id", id);
  if (error) throw new Error(`MATCH_REQUEST_FINALIZE_FAILED: ${error.message}`);
  return next;
}

export async function durableCancelRequest(db: DbClient, id: string): Promise<MatchRequest | null> {
  const existing = await durableGetMatchRequest(db, id);
  if (!existing || !["pending", "awaiting_requester"].includes(existing.status)) return null;
  const next: MatchRequest = { ...existing, status: "cancelled", updatedAt: new Date().toISOString() };
  const { error } = await db.from("match_requests").update(requestRow(next)).eq("id", id);
  if (error) throw new Error(`MATCH_REQUEST_CANCEL_FAILED: ${error.message}`);
  return next;
}

export async function durableAttachChat(db: DbClient, id: string, chatId: string): Promise<MatchRequest | null> {
  const existing = await durableGetMatchRequest(db, id);
  if (!existing) return null;
  const next: MatchRequest = { ...existing, chatId, updatedAt: new Date().toISOString() };
  const { error } = await db.from("match_requests").update({ chat_id: chatId, updated_at: next.updatedAt }).eq("id", id);
  if (error) throw new Error(`MATCH_REQUEST_CHAT_UPDATE_FAILED: ${error.message}`);
  return next;
}

export async function durableHasConfirmedRequest(db: DbClient, a: string[], b: string[]): Promise<boolean> {
  const all = await durableListRequestsForUser(db, [...a, ...b]);
  const aSet = new Set(a);
  const bSet = new Set(b);
  return all.some(
    (r) =>
      r.status === "confirmed" &&
      ((aSet.has(r.fromUserId) && bSet.has(r.toUserId)) || (bSet.has(r.fromUserId) && aSet.has(r.toUserId)))
  );
}
