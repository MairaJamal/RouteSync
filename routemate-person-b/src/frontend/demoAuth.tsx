/* Frontend auth helper. The backend's requireAuth middleware (src/auth.ts)
   verifies a real Supabase JWT on every identity-sensitive endpoint — it
   no longer trusts a bare user_id in the request body. This file is what
   actually gets that JWT for the frontend to send.

   Login / signup UI (AuthScreen) uses signIn / signUp here. Tokens are
   cached in memory for the tab session; getAuthToken reads the active
   Supabase session rather than silently signing in a demo user. */
import { createClient } from "@supabase/supabase-js";
import { Gender } from "../types";
import { UserRole } from "./LocationSearchForm";
import { API_URL } from "./apiBase";

const SUPABASE_URL = (import.meta as any).env?.VITE_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = (import.meta as any).env?.VITE_SUPABASE_ANON_KEY ?? "";

export type IdDocumentType = "university_card" | "office_card";

export interface SignupIdentity {
  cnicNumber: string;
  idDocumentType: IdDocumentType;
  institutionName: string;
  cardNumber?: string;
}

export interface SignupVehicle {
  plate: string;
  makeModel: string;
}

/** Set only after the user completes Sign In / Sign Up in AuthScreen.
 *  Prevents the old silent demo JWT (left in localStorage) from skipping
 *  the login gate on first open. */
const EXPLICIT_AUTH_KEY = "rm_explicit_auth";

function markExplicitAuth() {
  try {
    localStorage.setItem(EXPLICIT_AUTH_KEY, "1");
  } catch {
    /* ignore quota / private-mode failures */
  }
}

function clearExplicitAuth() {
  try {
    localStorage.removeItem(EXPLICIT_AUTH_KEY);
  } catch {
    /* ignore */
  }
}

function hasExplicitAuth(): boolean {
  try {
    return localStorage.getItem(EXPLICIT_AUTH_KEY) === "1";
  } catch {
    return false;
  }
}

export interface AuthUserSession {
  userId: string;
  displayName: string;
  gender: Gender;
  isVerified: boolean;
  verifiedDomain: string | null;
  preferredRole: UserRole;
}

let client: ReturnType<typeof createClient> | null = null;
function getClient() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error(
      "VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set — see .env.example. " +
        "Without these the frontend can't sign in and every auth-protected API call will 401."
    );
  }
  if (!client) client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return client;
}

let cachedToken: string | null = null;
let inFlight: Promise<string> | null = null;

function setCachedToken(token: string | null) {
  cachedToken = token;
}

async function loadProfileForAuthUser(
  authUserId: string,
  fallbackName?: string,
  fallbackGender?: Gender,
  preferredRole: UserRole = "LOOKING"
): Promise<AuthUserSession> {
  const supabase = getClient();
  const { data: byAuth } = await supabase
    .from("users")
    .select("id, display_name, gender, is_verified, verified_domain")
    .eq("auth_user_id", authUserId)
    .maybeSingle();

  const row =
    byAuth ??
    (
      await supabase
        .from("users")
        .select("id, display_name, gender, is_verified, verified_domain")
        .eq("id", authUserId)
        .maybeSingle()
    ).data;

  if (!row) {
    throw new Error(
      "Signed in, but no RouteSync profile was found. Please sign up first or contact support."
    );
  }

  return {
    userId: row.id as string,
    displayName: (row.display_name as string) || fallbackName || "RouteSync User",
    gender: (row.gender as Gender) || fallbackGender || "female",
    isVerified: row.is_verified === true,
    verifiedDomain: (row.verified_domain as string | null) ?? null,
    preferredRole,
  };
}

async function ensureProfileRow(opts: {
  authUserId: string;
  displayName: string;
  gender: Gender;
  phone?: string;
}): Promise<void> {
  const supabase = getClient();
  const { error } = await supabase.from("users").upsert(
    {
      id: opts.authUserId,
      auth_user_id: opts.authUserId,
      display_name: opts.displayName,
      gender: opts.gender,
    },
    { onConflict: "id" }
  );
  if (error) {
    throw new Error(`Could not save your profile: ${error.message}`);
  }
  // Phone has no dedicated users column yet — keep it on auth metadata only.
  if (opts.phone) {
    await supabase.auth.updateUser({ data: { phone: opts.phone } });
  }
}

/** Restore an existing browser session (e.g. page refresh). Returns null if signed out.
 *  Sessions that were never created via AuthScreen (legacy silent demo login) are
 *  cleared so the login / signup screen always shows on first open. */
export async function restoreSession(): Promise<AuthUserSession | null> {
  const supabase = getClient();

  // No explicit login yet → drop any leftover demo/supabase session and show AuthScreen.
  if (!hasExplicitAuth()) {
    setCachedToken(null);
    await supabase.auth.signOut().catch(() => undefined);
    return null;
  }

  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.user) {
    setCachedToken(null);
    clearExplicitAuth();
    return null;
  }
  setCachedToken(data.session.access_token);
  const meta = data.session.user.user_metadata ?? {};
  const preferredRole: UserRole = meta.preferred_role === "OFFERING" ? "OFFERING" : "LOOKING";
  try {
    return await loadProfileForAuthUser(
      data.session.user.id,
      typeof meta.display_name === "string" ? meta.display_name : undefined,
      undefined,
      preferredRole
    );
  } catch {
    // Profile missing / broken — force a fresh login rather than showing a ghost session.
    setCachedToken(null);
    clearExplicitAuth();
    await supabase.auth.signOut().catch(() => undefined);
    return null;
  }
}

export async function signIn(email: string, password: string): Promise<AuthUserSession> {
  const supabase = getClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session?.user) {
    throw new Error(error?.message ?? "Sign-in failed — check your email and password.");
  }
  setCachedToken(data.session.access_token);
  markExplicitAuth();
  const meta = data.session.user.user_metadata ?? {};
  const preferredRole: UserRole = meta.preferred_role === "OFFERING" ? "OFFERING" : "LOOKING";
  return loadProfileForAuthUser(
    data.session.user.id,
    typeof meta.display_name === "string" ? meta.display_name : undefined,
    undefined,
    preferredRole
  );
}

async function saveSignupExtras(
  userId: string,
  identity: SignupIdentity,
  vehicle?: SignupVehicle
): Promise<void> {
  const idRes = await authedFetch(`${API_URL}/api/users/${userId}/identity-profile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cnic_number: identity.cnicNumber,
      id_document_type: identity.idDocumentType,
      institution_name: identity.institutionName,
      card_number: identity.cardNumber ?? "",
    }),
  });
  if (!idRes.ok) {
    const body = await idRes.json().catch(() => null);
    throw new Error(body?.details ?? body?.error ?? "Could not save CNIC / ID card details.");
  }

  if (!vehicle) return;

  const vehRes = await authedFetch(`${API_URL}/api/users/${userId}/vehicle-declaration`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cnic_number: identity.cnicNumber,
      vehicle_plate: vehicle.plate,
      vehicle_make_model: vehicle.makeModel,
    }),
  });
  if (vehRes.status === 503) {
    // Migration not applied yet — account still works; details can be added later.
    return;
  }
  if (!vehRes.ok) {
    const body = await vehRes.json().catch(() => null);
    throw new Error(body?.details ?? body?.error ?? "Could not save vehicle details.");
  }
}

export async function signUp(opts: {
  email: string;
  password: string;
  displayName: string;
  phone?: string;
  gender: Gender;
  preferredRole: UserRole;
  identity: SignupIdentity;
  vehicle?: SignupVehicle;
}): Promise<AuthUserSession> {
  if (!opts.displayName.trim()) {
    throw new Error("Please enter your name.");
  }
  if (!opts.identity?.cnicNumber?.trim()) {
    throw new Error("CNIC is required at signup.");
  }
  const supabase = getClient();
  const { data, error } = await supabase.auth.signUp({
    email: opts.email,
    password: opts.password,
    options: {
      data: {
        display_name: opts.displayName.trim(),
        phone: opts.phone || null,
        preferred_role: opts.preferredRole,
        gender: opts.gender,
      },
    },
  });
  if (error) {
    throw new Error(error.message);
  }
  if (!data.session?.user) {
    // Email confirmation may be required — try immediate password sign-in;
    // if that also fails, ask the user to confirm email.
    const retry = await supabase.auth.signInWithPassword({
      email: opts.email,
      password: opts.password,
    });
    if (retry.error || !retry.data.session?.user) {
      throw new Error(
        "Account created — confirm the email Supabase sent you, then sign in."
      );
    }
    setCachedToken(retry.data.session.access_token);
    markExplicitAuth();
    await ensureProfileRow({
      authUserId: retry.data.session.user.id,
      displayName: opts.displayName.trim(),
      gender: opts.gender,
      phone: opts.phone,
    });
    const session = await loadProfileForAuthUser(
      retry.data.session.user.id,
      opts.displayName.trim(),
      opts.gender,
      opts.preferredRole
    );
    await saveSignupExtras(session.userId, opts.identity, opts.vehicle);
    return session;
  }

  setCachedToken(data.session.access_token);
  markExplicitAuth();
  await ensureProfileRow({
    authUserId: data.session.user.id,
    displayName: opts.displayName.trim(),
    gender: opts.gender,
    phone: opts.phone,
  });
  const session = await loadProfileForAuthUser(
    data.session.user.id,
    opts.displayName.trim(),
    opts.gender,
    opts.preferredRole
  );
  await saveSignupExtras(session.userId, opts.identity, opts.vehicle);
  return session;
}

export async function signOut(): Promise<void> {
  setCachedToken(null);
  clearExplicitAuth();
  const supabase = getClient();
  await supabase.auth.signOut();
}

/** Returns a valid access token from the active session. */
export async function getAuthToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const supabase = getClient();
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session?.access_token) {
      throw new Error("Not signed in — open the login screen and sign in again.");
    }
    cachedToken = data.session.access_token;
    return cachedToken;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** Convenience wrapper: fetch() with the signed-in user's Authorization header
 *  already attached. Falls through to a normal, unauthenticated fetch
 *  with a console warning if sign-in fails, rather than hard-crashing the
 *  whole app — matches this codebase's "degrade visibly" pattern. */
export async function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let token: string | null = null;
  try {
    token = await getAuthToken();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[auth] Could not get an auth token — request will likely 401.",
      err instanceof Error ? err.message : err
    );
  }
  const headers = new Headers(init.headers ?? {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(url, { ...init, headers });
}
