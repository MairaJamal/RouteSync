import { createClient } from "@supabase/supabase-js";

export type RideLifecycleStatus = "confirmed" | "started" | "completed";

interface RideLifecycleRecord {
  rideId: string;
  status: RideLifecycleStatus;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = "routesync-ride-lifecycle";

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("[rideLifecycleStore] Missing Supabase configuration");
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let bucketReady: Promise<void> | null = null;

async function ensureBucket(): Promise<void> {
  if (!bucketReady) {
    bucketReady = (async () => {
      const { error } = await supabase.storage.createBucket(BUCKET, { public: false });
      if (error && !/already exists|duplicate/i.test(error.message)) {
        throw new Error(`Could not initialize ride lifecycle storage: ${error.message}`);
      }
    })().catch((error) => {
      bucketReady = null;
      throw error;
    });
  }
  await bucketReady;
}

function pathFor(rideId: string): string {
  return `rides/${rideId}.json`;
}

async function write(record: RideLifecycleRecord): Promise<void> {
  await ensureBucket();
  const { error } = await supabase.storage.from(BUCKET).upload(
    pathFor(record.rideId),
    new Blob([JSON.stringify(record)], { type: "application/json" }),
    { contentType: "application/json", cacheControl: "no-cache", upsert: true }
  );
  if (error) throw new Error(`Could not save ride lifecycle: ${error.message}`);
}

export async function getRideLifecycle(rideId: string): Promise<RideLifecycleRecord> {
  await ensureBucket();
  const { data } = await supabase.storage.from(BUCKET).download(pathFor(rideId));
  if (!data) {
    const record: RideLifecycleRecord = {
      rideId,
      status: "confirmed",
      updatedAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
    };
    await write(record);
    return record;
  }
  try {
    return JSON.parse(await data.text()) as RideLifecycleRecord;
  } catch {
    const record: RideLifecycleRecord = {
      rideId,
      status: "confirmed",
      updatedAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
    };
    await write(record);
    return record;
  }
}

export async function setRideLifecycle(
  rideId: string,
  status: RideLifecycleStatus
): Promise<RideLifecycleRecord> {
  const current = await getRideLifecycle(rideId);
  if (status === "started" && current.status === "completed") return current;
  if (status === "completed" && current.status !== "started" && current.status !== "completed") {
    throw new Error("RIDE_MUST_BE_STARTED_FIRST");
  }
  const now = new Date().toISOString();
  const next: RideLifecycleRecord = {
    ...current,
    rideId,
    status,
    updatedAt: now,
    startedAt: status === "started" ? current.startedAt ?? now : current.startedAt,
    completedAt: status === "completed" ? current.completedAt ?? now : current.completedAt,
  };
  await write(next);
  return next;
}
