/* Dev diagnostic (read-only) — replays the /matches gating against the live
   trip_requests rows to show exactly which gate drops a candidate pair
   (bbox, time window, gender, overlap, detour cap). Use when a search
   returns nothing and the reason is silent server-side.
   Run: npx tsx src/diag_matches.ts   (requires .env Supabase keys) */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { evaluateFullMatch } from "./matchPipeline";
import { getRoute } from "./osrmClient";
import type { TripRequest } from "./types";

/* Same mapping the /matches endpoint uses (apiHandler.mapToTripRequest). */
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

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

const BBOX_DEG = 0.05;
function near(aLat: number, aLng: number, bLat: number, bLng: number) {
  return Math.abs(aLat - bLat) <= BBOX_DEG && Math.abs(aLng - bLng) <= BBOX_DEG;
}
function timeWindowsOverlap(aAt: string, aWindow: number, bAt: string, bWindow: number): boolean {
  const a = new Date(aAt).getTime();
  const b = new Date(bAt).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  const aW = Math.max(0, Number(aWindow) || 0) * 60_000;
  const bW = Math.max(0, Number(bWindow) || 0) * 60_000;
  return a <= b + bW && b <= a + aW;
}

async function main() {
  console.log("=== OSRM reachability ===");
  try {
    const r = await getRoute([
      { lat: 33.6844, lng: 73.0479, address_label: "F-10 Markaz" },
      { lat: 33.6484, lng: 72.9922, address_label: "NUST Gate 1" },
    ]);
    console.log(`OK — ${ (r.distance_m / 1000).toFixed(1) } km, ${ Math.round(r.duration_s / 60) } min`);
  } catch (e: any) {
    console.log(`OSRM FAILED: ${e.message}  → every live match silently drops`);
  }

  console.log("\n=== Recent trip_requests (last 20) ===");
  const { data: rows, error } = await supabase
    .from("trip_requests")
    .select("*,users(display_name,gender,is_verified)")
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) {
    console.log("QUERY ERROR:", error.message);
    return;
  }
  const now = new Date();
  for (const r of rows ?? []) {
    console.log(
      [
        r.id.slice(0, 8),
        `user=${String(r.user_id).slice(0, 8)} (${(r as any).users?.display_name ?? "?"})`,
        `status=${r.status}`,
        `veh=${r.vehicle_type ?? "-"}`,
        `pref=${r.preference ?? "-"}`,
        `genderReq=${(r as any).users?.gender ?? "-"}`,
        `${r.origin_address_label ?? r.origin_lat?.toFixed(3)} -> ${r.destination_address_label ?? r.destination_lng?.toFixed(3)}`,
        `dep=${r.requested_departure_at}`,
        `win=${r.window_minutes}m`,
        `expires=${r.expires_at}`,
        `created=${r.created_at}`,
        r.expires_at && new Date(r.expires_at) < now ? "[EXPIRED]" : "",
        new Date(String(r.requested_departure_at)) < now ? "[dep-in-past]" : "",
      ].join(" | ")
    );
  }

  // Replay the endpoint gates for every PAIR of distinct users among rows
  // that pass the raw query filters, oldest-active as candidate.
  const eligible = (rows ?? []).filter(
    (r: any) => r.status === "active" && r.expires_at && new Date(r.expires_at) > now
  );
  console.log(`\n=== Pairwise gate replay (${eligible.length} active+unexpired rows) ===`);
  if (eligible.length < 2) {
    console.log("Less than 2 eligible rows — check status/expires above. Common causes:");
    console.log(" - second search cancelled nothing but first row expired (24h) or flipped to 'matched'");
    console.log(" - both accounts resolve to the SAME user_id (then the pair is filtered by design)");
  }
  for (const target of eligible) {
    for (const cand of eligible) {
      if (cand.id === target.id || cand.user_id === target.user_id) continue;
      const originNear = near(Number(target.origin_lat), Number(target.origin_lng), Number(cand.origin_lat), Number(cand.origin_lng));
      const destNear = near(Number(target.destination_lat), Number(target.destination_lng), Number(cand.destination_lat), Number(cand.destination_lng));
      const tWin = timeWindowsOverlap(
        String(target.requested_departure_at), Number(target.window_minutes ?? 60),
        String(cand.requested_departure_at), Number(cand.window_minutes ?? 60)
      );
      const gates = `originNear=${originNear} destNear=${destNear} timeOverlap=${tWin}`;
      if (!(originNear || destNear) || !tWin) {
        console.log(`[${String(target.id).slice(0, 8)} ← ${String(cand.id).slice(0, 8)}] PRE-FILTER REJECT: ${gates}`);
        continue;
      }
      try {
        const verdict = await evaluateFullMatch(mapToTripRequest(target), mapToTripRequest(cand));
        console.log(
          `[${String(target.id).slice(0, 8)} ← ${String(cand.id).slice(0, 8)}] PIPELINE: ` +
            `should_match=${verdict.should_match} reason=${verdict.reason ?? "-"} ` +
            `overlap=${verdict.overlap_pct.toFixed(1)}% detour=${verdict.detour_added_minutes}m ` +
            `type=${verdict.match_type} (${gates})`
        );
      } catch (e: any) {
        console.log(`[${String(target.id).slice(0, 8)} ← ${String(cand.id).slice(0, 8)}] PIPELINE THREW: ${e.message}`);
      }
    }
  }
}

main().catch((e) => console.error("DIAG FAILED:", e));
