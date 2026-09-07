import { createClient } from "@supabase/supabase-js";
import { evaluateFullMatch } from "./matchPipeline";
import { TripRequest } from "./types";

const supabaseUrl = process.env.SUPABASE_URL || "YOUR_SUPABASE_URL";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "YOUR_SERVICE_ROLE_KEY";
const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Maps a `trip_requests` row (joined with its owner's gender) to Person B's
 * TripRequest contract type. `trip_requests` has no route_geometry column —
 * that's intentional (Person A's schema keeps only named scalar lat/lng
 * columns per the coordinate contract); the real polyline is fetched live
 * from OSRM inside evaluateFullMatch, not read off the row.
 */
function mapToTripRequest(row: any): TripRequest {
  return {
    request_id: row.id,
    user_id: row.user_id,
    user_name: row.users?.display_name ?? row.user_id.slice(0, 8),
    user_gender: row.users?.gender ?? "male",
    gender_preference: row.preference,
    origin: {
      lat: Number(row.origin_lat),
      lng: Number(row.origin_lng),
      address_label: row.origin_address_label,
    },
    destination: {
      lat: Number(row.destination_lat),
      lng: Number(row.destination_lng),
      address_label: row.destination_address_label,
    },
    status: row.status,
  };
}

/**
 * processTripRequestMatches — Day 3 "combine modules" entry point. Runs
 * whenever a new trip_request is inserted (call this from a DB webhook /
 * Realtime subscription in production; testRun.ts calls it directly for
 * local testing). Evaluates the new request against every other active
 * request and writes any approved matches + fare estimates back to Supabase.
 */
export async function processTripRequestMatches(targetRequestId: string) {
  const { data: targetRow, error: targetError } = await supabase
    .from("trip_requests")
    .select("*, users(display_name, gender)")
    .eq("id", targetRequestId)
    .single();

  if (targetError || !targetRow) {
    console.error("❌ Error fetching target trip:", targetError);
    return;
  }

  const { data: candidateRows, error: candidatesError } = await supabase
    .from("trip_requests")
    .select("*, users(display_name, gender)")
    .eq("status", "active")
    .neq("id", targetRequestId);

  if (candidatesError) {
    console.error("❌ Error fetching candidates:", candidatesError);
    return;
  }
  if (!candidateRows || candidateRows.length === 0) {
    console.warn("⚠️  No active candidate trip requests found.");
    return;
  }

  const targetReq = mapToTripRequest(targetRow);
  let matchesCreated = 0;

  for (const candidateRow of candidateRows) {
    const candidateReq = mapToTripRequest(candidateRow);

    let result;
    try {
      result = await evaluateFullMatch(targetReq, candidateReq);
    } catch (err) {
      console.error(`❌ Pipeline error for ${candidateRow.id}:`, err);
      continue;
    }

    if (!result.should_match) {
      console.log(
        `🛡️ Skipped ${candidateRow.id}: ${result.reason}` +
          (result.overlap_pct ? ` (overlap ${result.overlap_pct}%)` : "") +
          (result.detour_added_minutes !== null ? ` (detour +${result.detour_added_minutes}min)` : "")
      );
      continue;
    }

    const { data: matchData, error: matchError } = await supabase
      .from("matches")
      .upsert(
        {
          trip_request_id: targetRequestId,
          candidate_trip_request_id: candidateRow.id,
          status: "pending",
          overlap_pct: result.overlap_pct,
        },
        { onConflict: "trip_request_id,candidate_trip_request_id" }
      )
      .select()
      .single();

    if (matchError) {
      console.error(`❌ Match save error for ${candidateRow.id}:`, matchError.message);
      continue;
    }

    const requesterShare = result.fare_split.find((f) => f.user_id === targetReq.user_id);
    const candidateShare = result.fare_split.find((f) => f.user_id === candidateReq.user_id);

    const { error: fareError } = await supabase.from("fare_estimates").upsert(
      {
        match_id: matchData.id,
        amount: requesterShare?.total_fare ?? 0,
        currency: "PKR",
        provider: "person_b_algo",
        breakdown: {
          requester_fare: requesterShare?.total_fare ?? 0,
          candidate_fare: candidateShare?.total_fare ?? 0,
          legs: result.legs,
          detour_added_minutes: result.detour_added_minutes,
          route_geometry: {
            requester: result.requester_route_geometry,
            candidate: result.candidate_route_geometry,
            combined: result.combined_route_geometry,
          },
        },
      },
      { onConflict: "match_id" }
    );

    if (fareError) {
      console.error(`❌ Fare estimate save error for match ${matchData.id}:`, fareError.message);
      continue;
    }

    matchesCreated++;
    console.log(
      `✅ Match created: ${matchData.id} (overlap ${result.overlap_pct}%, +${result.detour_added_minutes}min detour)`
    );
  }

  console.log(`🎉 Done. ${matchesCreated}/${candidateRows.length} candidates matched for ${targetRequestId}.`);
}
