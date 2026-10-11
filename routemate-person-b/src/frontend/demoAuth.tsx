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

/** Marks that a real AuthScreen session was accepted by the app. */
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

export interface AuthUserSession {
  userId: string;
  displayName: string;
  gender: Gender;
  isVerified: boolean;
  verifiedDomain: string | null;
  preferredRole: UserRole;
}

function metadataGender(value: unknown): Gender {
  return value === "male" || value === "non_binary" ? value : "female";
}

function metadataName(user: { email?: string | null; user_metadata?: Record<string, unknown> }): string {
  const name = user.user_metadata?.display_name;
  if (typeof name === "string" && name.trim()) return name.trim();
  return user.email?.split("@")[0] || "RouteSync User";
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
  async function findProfile(filterColumn: "auth_user_id" | "id", filterValue: string) {
    const full = await supabase
      .from("users")
      .select("id, display_name, gender, is_verified, verified_domain")
      .eq(filterColumn, filterValue)
      .maybeSingle();
    if (!full.error) return full.data;

    // Older hosted databases may not have the verified-badge migration yet.
    // Login should still work; missing optional columns simply mean unverified.
    const base = await supabase
      .from("users")
      .select("id, display_name, gender")
      .eq(filterColumn, filterValue)
      .maybeSingle();
    if (base.error) throw new Error(`Could not load your profile: ${base.error.message}`);
    return base.data;
  }

  const byAuth = await findProfile("auth_user_id", authUserId);

  const row =
    byAuth ??
    (await findProfile("id", authUserId));

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

async function ensureProfileRowIfMissing(opts: {
  authUserId: string;
  displayName: string;
  gender: Gender;
}): Promise<void> {
  const supabase = getClient();
  const { data, error } = await supabase
    .from("users")
    .select("id")
    .eq("auth_user_id", opts.authUserId)
    .maybeSingle();
  if (error) throw new Error(`Could not check your profile: ${error.message}`);
  if (!data) await ensureProfileRow(opts);
}

/** Restore an existing browser session (including the session from an email-confirmation link). */
export async function restoreSession(): Promise<AuthUserSession | null> {
  const supabase = getClient();

  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.user) {
    setCachedToken(null);
    clearExplicitAuth();
    return null;
  }
  setCachedToken(data.session.access_token);
  const user = data.session.user;
  const meta = user.user_metadata ?? {};
  const preferredRole: UserRole = meta.preferred_role === "OFFERING" ? "OFFERING" : "LOOKING";
  try {
    await ensureProfileRowIfMissing({
      authUserId: user.id,
      displayName: metadataName(user),
      gender: metadataGender(meta.gender),
    });
    markExplicitAuth();
    return await loadProfileForAuthUser(
      user.id,
      metadataName(user),
      metadataGender(meta.gender),
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
    const message = error?.message?.toLowerCase() ?? "";
    if (message.includes("email not confirmed")) {
      throw new Error("Email not confirmed. Check Inbox/Spam, then use Resend confirmation email.");
    }
    if (message.includes("invalid login credentials")) {
      throw new Error("Incorrect email or password. Use the exact signup email and password.");
    }
    throw new Error(error?.message ?? "Sign-in failed — check your email and password.");
  }
  setCachedToken(data.session.access_token);
  markExplicitAuth();
  const user = data.session.user;
  const meta = user.user_metadata ?? {};
  const preferredRole: UserRole = meta.preferred_role === "OFFERING" ? "OFFERING" : "LOOKING";
  await ensureProfileRowIfMissing({
    authUserId: user.id,
    displayName: metadataName(user),
    gender: metadataGender(meta.gender),
  });
  return loadProfileForAuthUser(
    user.id,
    metadataName(user),
    metadataGender(meta.gender),
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
    const message = error.message.toLowerCase();
    if (message.includes("already registered") || message.includes("already been registered")) {
      throw new Error("This email is already registered. Switch to Sign In and confirm the email first.");
    }
    if (message.includes("rate limit") || message.includes("email rate limit")) {
      throw new Error("Supabase email limit reached. Wait a few minutes before requesting another confirmation email.");
    }
    throw new Error(error.message);
  }
  if (!data.session?.user) {
    throw new Error(
      "Account created. Confirm the email Supabase sent you, then switch to Sign In. If it does not arrive, use Resend confirmation email once."
    );
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

/** Re-send verification without weakening Supabase email verification. */
export async function resendSignupConfirmation(email: string): Promise<void> {
  const supabase = getClient();
  const { error } = await supabase.auth.resend({ type: "signup", email: email.trim() });
  if (error) throw new Error(error.message);
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
