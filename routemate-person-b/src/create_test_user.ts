import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function addTestUser(name: string, gender: "male" | "female", originLabel: string, originLat: number, originLng: number, destLabel: string, destLat: number, destLng: number, vehicleType: "car" | "bike" | "none" = "car") {
  const newUserId = crypto.randomUUID();
  const newRequestId = crypto.randomUUID();

  console.log(`\nCreating new user: ${name} (${gender})...`);

  // 1. Insert User
  const { data: userData, error: userError } = await supabase
    .from("users")
    .insert({
      id: newUserId,
      display_name: name,
      gender: gender,
      is_verified: true,
      verified_domain: "nust.edu.pk",
    })
    .select()
    .single();

  if (userError) {
    console.error("Error creating user:", userError.message);
    return;
  }
  console.log(`✅ Created user row in 'users' table: ID = ${newUserId}`);

  // 2. Insert Active Trip Request
  const { data: tripData, error: tripError } = await supabase
    .from("trip_requests")
    .insert({
      id: newRequestId,
      user_id: newUserId,
      origin_lat: originLat,
      origin_lng: originLng,
      origin_address_label: originLabel,
      destination_lat: destLat,
      destination_lng: destLng,
      destination_address_label: destLabel,
      requested_departure_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      window_minutes: 45,
      preference: "any",
      status: "active",
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      vehicle_type: vehicleType,
      require_driver_gender_match: false,
    })
    .select()
    .single();

  if (tripError) {
    console.error("Error creating trip request:", tripError.message);
    return;
  }
  console.log(`✅ Created active trip request in 'trip_requests': ${originLabel} ➔ ${destLabel}`);
  console.log(`\n🎉 Done! Now refresh http://localhost:3000 and search between ${originLabel} and ${destLabel} to see ${name} match!`);
}

// Example: Ali Raza commuting from F-10 to NUST H-12
addTestUser(
  "Ali Raza (NUST CS)",
  "male",
  "F-10 Markaz, Islamabad",
  33.6959,
  73.0125,
  "NUST Gate 1, H-12, Islamabad",
  33.6484,
  72.9922,
  "car"
);
