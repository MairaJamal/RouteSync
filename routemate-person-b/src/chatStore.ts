/**
 * Durable match-chat storage.
 *
 * The old implementation wrote JSON under the server filesystem. That works
 * locally but is ephemeral on Vercel serverless instances, so a restart could
 * orphan a chat ID while the browser still held it. Threads are now stored as
 * JSON objects in a private Supabase Storage bucket using the service role.
 */
import { createClient } from "@supabase/supabase-js";

export interface StoredChatMessage {
  id: string;
  senderId: string;
  text: string;
  createdAt: string;
}

export interface MatchChatThread {
  id: string;
  participantIds: string[];
  participantNames: Record<string, string>;
  originLabel: string;
  destinationLabel: string;
  fareSharePkr: number;
  rideId: string | null;
  createdAt: string;
  messages: StoredChatMessage[];
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = "routesync-chat-data";

if (!supabaseUrl || !supabaseKey) {
  throw new Error("[chatStore] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let bucketReady: Promise<void> | null = null;

async function ensureBucket(): Promise<void> {
  if (!bucketReady) {
    bucketReady = (async () => {
      const { error } = await supabase.storage.createBucket(BUCKET, { public: false });
      if (error && !/already exists|duplicate/i.test(error.message)) {
        throw new Error(`Could not initialize chat storage: ${error.message}`);
      }
    })().catch((error) => {
      bucketReady = null;
      throw error;
    });
  }
  await bucketReady;
}

function objectPath(threadId: string): string {
  return `threads/${threadId}.json`;
}

async function readThread(threadId: string): Promise<MatchChatThread | null> {
  await ensureBucket();
  const { data, error } = await supabase.storage.from(BUCKET).download(objectPath(threadId));
  if (error || !data) return null;
  try {
    return JSON.parse(await data.text()) as MatchChatThread;
  } catch {
    return null;
  }
}

async function writeThread(thread: MatchChatThread): Promise<void> {
  await ensureBucket();
  const { error } = await supabase.storage.from(BUCKET).upload(
    objectPath(thread.id),
    new Blob([JSON.stringify(thread)], { type: "application/json" }),
    { contentType: "application/json", upsert: true, cacheControl: "no-cache" }
  );
  if (error) throw new Error(`Could not save chat thread: ${error.message}`);
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join("::");
}

function threadIdForPair(a: string, b: string): string {
  return `chat_${pairKey(a, b).replace(/[^a-zA-Z0-9]/g, "_")}`;
}

export async function upsertMatchChat(input: {
  myUserId: string;
  myDisplayName: string;
  peerUserId: string;
  peerDisplayName: string;
  originLabel: string;
  destinationLabel: string;
  fareSharePkr: number;
  rideId?: string | null;
}): Promise<MatchChatThread> {
  const id = threadIdForPair(input.myUserId, input.peerUserId);
  const existing = await readThread(id);
  if (existing) {
    if (!existing.participantIds.includes(input.myUserId)) existing.participantIds.push(input.myUserId);
    if (!existing.participantIds.includes(input.peerUserId)) existing.participantIds.push(input.peerUserId);
    existing.participantNames[input.myUserId] = input.myDisplayName || existing.participantNames[input.myUserId] || "You";
    existing.participantNames[input.peerUserId] = input.peerDisplayName || existing.participantNames[input.peerUserId] || "Carpool mate";
    if (input.rideId) existing.rideId = input.rideId;
    if (input.originLabel) existing.originLabel = input.originLabel;
    if (input.destinationLabel) existing.destinationLabel = input.destinationLabel;
    if (Number.isFinite(input.fareSharePkr)) existing.fareSharePkr = input.fareSharePkr;
    await writeThread(existing);
    return existing;
  }

  const thread: MatchChatThread = {
    id,
    participantIds: [input.myUserId, input.peerUserId],
    participantNames: {
      [input.myUserId]: input.myDisplayName || "You",
      [input.peerUserId]: input.peerDisplayName || "Carpool mate",
    },
    originLabel: input.originLabel || "Pickup",
    destinationLabel: input.destinationLabel || "Drop-off",
    fareSharePkr: Number.isFinite(input.fareSharePkr) ? input.fareSharePkr : 0,
    rideId: input.rideId ?? null,
    createdAt: new Date().toISOString(),
    messages: [],
  };
  await writeThread(thread);
  return thread;
}

export async function getMatchChat(threadId: string): Promise<MatchChatThread | null> {
  return readThread(threadId);
}

export async function listMatchChatsForUser(userId: string): Promise<MatchChatThread[]> {
  await ensureBucket();
  const { data, error } = await supabase.storage.from(BUCKET).list("threads", { limit: 1000 });
  if (error) throw new Error(`Could not list chat threads: ${error.message}`);
  const threads = await Promise.all(
    (data ?? [])
      .filter((entry) => entry.name.endsWith(".json"))
      .map((entry) => readThread(entry.name.slice(0, -5)))
  );
  return threads
    .filter((thread): thread is MatchChatThread => Boolean(thread && thread.participantIds.includes(userId)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function addMatchChatMessage(
  threadId: string,
  senderId: string,
  text: string
): Promise<StoredChatMessage | null> {
  const thread = await readThread(threadId);
  if (!thread || !thread.participantIds.includes(senderId)) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const msg: StoredChatMessage = {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    senderId,
    text: trimmed.slice(0, 2000),
    createdAt: new Date().toISOString(),
  };
  thread.messages.push(msg);
  if (thread.messages.length > 500) thread.messages.splice(0, thread.messages.length - 500);
  await writeThread(thread);
  return msg;
}

export async function userCanAccessChat(threadId: string, userId: string): Promise<boolean> {
  const thread = await readThread(threadId);
  return Boolean(thread && thread.participantIds.includes(userId));
}

/** If any known alias of this user is already on the thread, add userId too. */
export async function grantChatAccessIfAlias(
  threadId: string,
  userId: string,
  aliases: string[]
): Promise<boolean> {
  const thread = await readThread(threadId);
  if (!thread) return false;
  if (thread.participantIds.includes(userId)) return true;
  if (!aliases.some((alias) => alias && thread.participantIds.includes(alias))) return false;
  thread.participantIds.push(userId);
  await writeThread(thread);
  return true;
}
