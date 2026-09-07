/**
 * Match chat store shared by every browser hitting this API instance.
 * Persisted to .data/match-chats.json so tsx/watch restarts don't wipe
 * conversations mid-chat.
 */
import fs from "fs";
import path from "path";

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

const STORE_DIR = path.join(process.cwd(), ".data");
const STORE_PATH = path.join(STORE_DIR, "match-chats.json");

const threadsById = new Map<string, MatchChatThread>();
const threadsByPair = new Map<string, string>(); // pairKey -> threadId

function pairKey(a: string, b: string): string {
  return [a, b].sort().join("::");
}

function persist() {
  try {
    if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
    const payload = {
      threads: [...threadsById.values()],
      pairs: [...threadsByPair.entries()],
    };
    fs.writeFileSync(STORE_PATH, JSON.stringify(payload), "utf8");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[chatStore] persist failed:", err instanceof Error ? err.message : err);
  }
}

function hydrate() {
  try {
    if (!fs.existsSync(STORE_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) as {
      threads?: MatchChatThread[];
      pairs?: [string, string][];
    };
    threadsById.clear();
    threadsByPair.clear();
    for (const t of raw.threads ?? []) {
      if (t?.id) threadsById.set(t.id, t);
    }
    for (const [k, v] of raw.pairs ?? []) {
      threadsByPair.set(k, v);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[chatStore] hydrate failed:", err instanceof Error ? err.message : err);
  }
}

hydrate();

export function upsertMatchChat(input: {
  myUserId: string;
  myDisplayName: string;
  peerUserId: string;
  peerDisplayName: string;
  originLabel: string;
  destinationLabel: string;
  fareSharePkr: number;
  rideId?: string | null;
}): MatchChatThread {
  const key = pairKey(input.myUserId, input.peerUserId);
  const existingId = threadsByPair.get(key);
  if (existingId) {
    const existing = threadsById.get(existingId);
    if (existing) {
      if (!existing.participantIds.includes(input.myUserId)) {
        existing.participantIds.push(input.myUserId);
      }
      if (!existing.participantIds.includes(input.peerUserId)) {
        existing.participantIds.push(input.peerUserId);
      }
      existing.participantNames[input.myUserId] =
        input.myDisplayName || existing.participantNames[input.myUserId];
      existing.participantNames[input.peerUserId] =
        input.peerDisplayName || existing.participantNames[input.peerUserId];
      if (input.rideId) existing.rideId = input.rideId;
      if (input.originLabel) existing.originLabel = input.originLabel;
      if (input.destinationLabel) existing.destinationLabel = input.destinationLabel;
      if (Number.isFinite(input.fareSharePkr)) existing.fareSharePkr = input.fareSharePkr;
      persist();
      return existing;
    }
  }

  const id = `chat_${key.replace(/[^a-zA-Z0-9]/g, "_")}`;
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
  threadsById.set(id, thread);
  threadsByPair.set(key, id);
  persist();
  return thread;
}

export function getMatchChat(threadId: string): MatchChatThread | null {
  return threadsById.get(threadId) ?? null;
}

export function listMatchChatsForUser(userId: string): MatchChatThread[] {
  return [...threadsById.values()]
    .filter((t) => t.participantIds.includes(userId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function addMatchChatMessage(
  threadId: string,
  senderId: string,
  text: string
): StoredChatMessage | null {
  const thread = threadsById.get(threadId);
  if (!thread) return null;
  if (!thread.participantIds.includes(senderId)) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const msg: StoredChatMessage = {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    senderId,
    text: trimmed.slice(0, 2000),
    createdAt: new Date().toISOString(),
  };
  thread.messages.push(msg);
  if (thread.messages.length > 500) {
    thread.messages.splice(0, thread.messages.length - 500);
  }
  persist();
  return msg;
}

export function userCanAccessChat(threadId: string, userId: string): boolean {
  const thread = threadsById.get(threadId);
  return Boolean(thread && thread.participantIds.includes(userId));
}

/** If any known alias of this user is already on the thread, add userId too. */
export function grantChatAccessIfAlias(
  threadId: string,
  userId: string,
  aliases: string[]
): boolean {
  const thread = threadsById.get(threadId);
  if (!thread) return false;
  if (thread.participantIds.includes(userId)) return true;
  const hit = aliases.some((a) => a && thread.participantIds.includes(a));
  if (!hit) return false;
  thread.participantIds.push(userId);
  persist();
  return true;
}
