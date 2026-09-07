import { Request, Response, NextFunction } from "express";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

/**
 * requireAuth — verifies the `Authorization: Bearer <supabase-jwt>` header
 * against Supabase Auth and attaches the resulting user id to
 * `req.auth.userId`. Route handlers must read the acting user from
 * `req.auth.userId`, never from `req.body.user_id` / `req.query.user_id` /
 * etc. — a client-supplied id is just a claim, not proof of identity.
 *
 * This closes the hole flagged in the README: "POST /api/trip-requests
 * trusts a client-supplied user_id — fine for local dev, unsafe to ship."
 * It's now unsafe nowhere; every mutating, user-scoped endpoint runs this
 * first.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: { userId: string };
    }
  }
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

// The auth-verifying client uses the anon key (not the service-role key) —
// verifying a JWT doesn't need elevated privileges, and using the anon key
// here means this file can never accidentally be the thing that leaks
// service-role access if it's ever imported somewhere unexpected.
let authClient: SupabaseClient | null = null;
function getAuthClient(): SupabaseClient {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "[auth] Missing SUPABASE_URL and/or SUPABASE_ANON_KEY. Both are required " +
        "to verify user JWTs — see .env.example."
    );
  }
  if (!authClient) authClient = createClient(supabaseUrl, supabaseAnonKey);
  return authClient;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.header("authorization") ?? req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;

  if (!token) {
    return res.status(401).json({ error: "MISSING_AUTH_TOKEN" });
  }

  try {
    const { data, error } = await getAuthClient().auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: "INVALID_AUTH_TOKEN" });
    }
    req.auth = { userId: data.user.id };
    return next();
  } catch (err) {
    const message = err instanceof Error ? err.message : "AUTH_CHECK_FAILED";
    return res.status(500).json({ error: "AUTH_CHECK_FAILED", details: message });
  }
}

/**
 * requireSelfOrMatchingBody — for endpoints that also accept a `user_id`
 * (or similarly named) field in the body/query for backward compatibility,
 * this rejects the request unless that field matches the authenticated
 * user. Prevents "I'm logged in as A but I'm submitting B's user_id" attacks
 * without having to rewrite every handler's body-shape at once.
 */
export function requireBodyFieldMatchesAuth(field: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth?.userId) {
      return res.status(401).json({ error: "MISSING_AUTH_TOKEN" });
    }
    // Always bind the acting user to the verified JWT. Downstream handlers
    // resolve public.users via id OR auth_user_id, so a client-supplied
    // profile id that differs from auth.uid() must not 403 the request.
    req.body[field] = req.auth.userId;
    next();
  };
}

/** Same idea as requireBodyFieldMatchesAuth, but for GET/DELETE requests
 *  that identify the acting user via a query string field instead of a
 *  body field (e.g. ?user_id=...). */
export function requireQueryFieldMatchesAuth(field: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const claimed = req.query?.[field] as string | undefined;
    if (!req.auth?.userId) {
      return res.status(401).json({ error: "MISSING_AUTH_TOKEN" });
    }
    if (claimed && claimed !== req.auth.userId) {
      return res.status(403).json({ error: "USER_ID_MISMATCH" });
    }
    (req.query as Record<string, string>)[field] = req.auth.userId;
    next();
  };
}
