import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

async function testConnections() {
  console.log("=== Testing RouteMate Supabase & System Connectivity ===\n");

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const demoEmail = process.env.VITE_DEMO_USER_EMAIL;
  const demoPassword = process.env.VITE_DEMO_USER_PASSWORD;
  const demoUserId = process.env.VITE_DEMO_USER_ID;

  console.log("Supabase URL:", supabaseUrl);
  console.log("Backend Service Role Key set?", !!serviceKey);
  console.log("Frontend/Anon Key set?", !!anonKey);

  // 1. Test Backend Connection (Service Role)
  console.log("\n--- 1. Testing Backend (Service Role) Connection ---");
  if (!supabaseUrl || !serviceKey) {
    console.error("FAIL: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  } else {
    try {
      const backendClient = createClient(supabaseUrl, serviceKey);
      
      // Probe common tables
      const tables = [
        "users",
        "rides",
        "trip_requests",
        "ride_bookings",
        "emergency_contacts",
        "sos_events",
        "ratings",
        "user_reports",
        "blocked_users"
      ];

      for (const t of tables) {
        const { data, error } = await backendClient.from(t).select("*").limit(2);
        if (error) {
          console.log(`Table '${t}': ⚠️ Error (${error.code}) - ${error.message}`);
        } else {
          console.log(`Table '${t}': ✅ Connected. Rows returned: ${data?.length}`);
        }
      }

      // Check if demo user exists in users table
      if (demoUserId) {
        const { data: userRow, error: userErr } = await backendClient
          .from("users")
          .select("*")
          .eq("id", demoUserId)
          .maybeSingle();
        if (userErr) {
          console.log(`Demo user lookup error: ${userErr.message}`);
        } else if (userRow) {
          console.log(`Demo user in 'users' table: ✅ Found (${userRow.name || userRow.email || userRow.id})`);
        } else {
          console.log(`Demo user in 'users' table: ⚠️ Not found with id ${demoUserId}`);
        }
      }
    } catch (e: any) {
      console.error("Backend client connection failed:", e.message);
    }
  }

  // 2. Test Frontend Connection (Anon Key + Auth Sign-in)
  console.log("\n--- 2. Testing Frontend (Anon Key & Demo Auth) Connection ---");
  if (!supabaseUrl || !anonKey) {
    console.error("FAIL: Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY");
  } else {
    try {
      const frontendClient = createClient(supabaseUrl, anonKey);
      
      // Test anonymous public read on rides or public tables
      const { data: publicRides, error: publicRidesErr } = await frontendClient
        .from("rides")
        .select("id")
        .limit(1);
      if (publicRidesErr) {
        console.log("Anon query 'rides':", publicRidesErr.message);
      } else {
        console.log("Anon query 'rides': ✅ Success");
      }

      // Test Demo User Sign In
      if (demoEmail && demoPassword) {
        console.log(`Attempting sign-in for demo user: ${demoEmail}...`);
        const { data: authData, error: authErr } = await frontendClient.auth.signInWithPassword({
          email: demoEmail,
          password: demoPassword,
        });

        if (authErr) {
          console.log(`Frontend Demo Auth: ❌ Failed - ${authErr.message}`);
        } else if (authData.session) {
          console.log(`Frontend Demo Auth: ✅ Success! User ID: ${authData.user.id}`);
          console.log(`Access Token acquired (length: ${authData.session.access_token.length})`);
        } else {
          console.log("Frontend Demo Auth: ⚠️ No session returned");
        }
      } else {
        console.log("Frontend Demo Auth: VITE_DEMO_USER_EMAIL or PASSWORD not set.");
      }
    } catch (e: any) {
      console.error("Frontend client connection failed:", e.message);
    }
  }

  console.log("\n=== Test Finished ===");
}

testConnections();
