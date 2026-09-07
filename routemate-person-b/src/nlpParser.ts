import { GenderPreference } from "./types";

// ─────────────────────────────────────────────────────────────
// Natural-language trip request parsing, backed by Qwen (Alibaba Cloud
// DashScope's OpenAI-compatible endpoint). A user types something like:
//
//   "I need to get from G-9 to NUST by 9am tomorrow, women only please"
//
// and this turns it into the structured fields the rest of the pipeline
// already understands. It deliberately does NOT try to resolve place
// names to coordinates itself — an LLM guessing lat/lng is exactly the
// kind of hallucination risk that shouldn't touch a matching/safety
// pipeline. Coordinates still come from Photon (see frontend/places.ts),
// the same trusted source every other flow uses; this module only ever
// extracts free-text labels for the caller to geocode downstream.
// ─────────────────────────────────────────────────────────────

export interface ParsedTripRequest {
  origin_text: string | null;
  destination_text: string | null;
  /** ISO 8601 if the model could resolve a concrete time against
   *  `referenceTime`; null if the utterance had no time information. */
  requested_departure_at: string | null;
  window_minutes: number | null;
  preference: GenderPreference | null;
  require_driver_gender_match: boolean;
  /** true when Qwen was reachable and produced this result; false means
   *  the heuristic fallback parser ran instead (network/key issue). The
   *  frontend surfaces this so a demo never silently shows a worse parse
   *  as if it were the real thing — same "never fake success" pattern as
   *  DB_MIGRATION_PENDING elsewhere in this codebase. */
  parsed_by: "qwen" | "heuristic_fallback";
  /** Present only when parsed_by is "heuristic_fallback". */
  fallback_reason?: string;
}

const QWEN_API_KEY = process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY;
// DashScope's OpenAI-compatible endpoint. Use the international endpoint by
// default; set QWEN_BASE_URL to the mainland China endpoint if needed.
const QWEN_BASE_URL =
  process.env.QWEN_BASE_URL || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const QWEN_MODEL = process.env.QWEN_MODEL || "qwen-plus";

const SYSTEM_PROMPT = `You extract structured carpool trip-request fields from a single
user utterance in Islamabad/Rawalpindi, Pakistan. Respond with ONLY a JSON object
(no markdown fences, no commentary) matching exactly this shape:

{
  "origin_text": string | null,
  "destination_text": string | null,
  "requested_departure_at": string | null,   // ISO 8601, resolved against the
                                              // reference time given below
  "window_minutes": number | null,           // flexibility around that time
  "preference": "any" | "male_only" | "female_only" | null,
  "require_driver_gender_match": boolean
}

Rules:
- Never invent a place name that isn't stated or clearly implied. If origin
  or destination is missing from the utterance, use null for it.
- "women only" / "females only" / "ladies only" -> preference "female_only".
  "men only" -> preference "male_only". No gender mentioned -> null (do not
  default to "any" yourself; let the caller decide the default).
- "also want the driver to be a woman/female" or similar -> set
  require_driver_gender_match true. Otherwise false.
- If a rough time is given ("around 9", "tonight", "in an hour") resolve it
  against the reference time into a real ISO timestamp; if no time is
  mentioned at all, requested_departure_at is null.
- window_minutes: explicit flexibility if stated ("give or take 20 min" ->
  20); otherwise a sensible default of 15 when a time was given, null when
  no time was given.
- Output must be valid JSON and nothing else.`;

/**
 * Calls Qwen via DashScope's OpenAI-compatible chat completions endpoint.
 * Throws on any failure (missing key, network error, bad JSON) so the
 * caller's fallback path is exercised — this function never silently
 * returns a partial/guessed result.
 */
async function callQwen(utterance: string, referenceTime: Date): Promise<ParsedTripRequest> {
  if (!QWEN_API_KEY) {
    throw new Error("QWEN_API_KEY (or DASHSCOPE_API_KEY) is not set");
  }

  const res = await fetch(`${QWEN_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${QWEN_API_KEY}`,
    },
    body: JSON.stringify({
      model: QWEN_MODEL,
      messages: [
        {
          role: "system",
          content: `${SYSTEM_PROMPT}\n\nReference time (use this for resolving relative times): ${referenceTime.toISOString()}`,
        },
        { role: "user", content: utterance },
      ],
      temperature: 0,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    throw new Error(`Qwen request failed: ${res.status} ${res.statusText}`);
  }

  const data: any = await res.json();
  const raw: string | undefined = data?.choices?.[0]?.message?.content;
  if (!raw) {
    throw new Error("Qwen response had no message content");
  }

  let parsed: any;
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("Qwen response was not valid JSON");
  }

  return {
    origin_text: typeof parsed.origin_text === "string" ? parsed.origin_text : null,
    destination_text: typeof parsed.destination_text === "string" ? parsed.destination_text : null,
    requested_departure_at:
      typeof parsed.requested_departure_at === "string" ? parsed.requested_departure_at : null,
    window_minutes: typeof parsed.window_minutes === "number" ? parsed.window_minutes : null,
    preference: isGenderPreference(parsed.preference) ? parsed.preference : null,
    require_driver_gender_match: parsed.require_driver_gender_match === true,
    parsed_by: "qwen",
  };
}

function isGenderPreference(v: unknown): v is GenderPreference {
  return v === "any" || v === "male_only" || v === "female_only";
}

// ─────────────────────────────────────────────────────────────
// Heuristic fallback — pure, offline, zero-dependency. Runs whenever Qwen
// is unreachable or unconfigured so a demo (or a dev without an API key)
// still gets a usable, if less capable, parse instead of a hard failure:
// degrade visibly, never fake full capability silently.
// ─────────────────────────────────────────────────────────────

const FEMALE_ONLY_PATTERN = /\b(women|woman|female|ladies|girls)[\s-]*only\b/i;
const MALE_ONLY_PATTERN = /\b(men|man|male|boys)[\s-]*only\b/i;
const DRIVER_GENDER_PATTERN = /\bdriver\b.{0,20}\b(female|woman|women)\b/i;

const TIME_PATTERNS: { pattern: RegExp; toDate: (m: RegExpMatchArray, ref: Date) => Date }[] = [
  {
    // "9am", "9:30 pm", "9 am"
    pattern: /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i,
    toDate: (m, ref) => {
      let hour = parseInt(m[1], 10) % 12;
      if (m[3].toLowerCase() === "pm") hour += 12;
      const minute = m[2] ? parseInt(m[2], 10) : 0;
      const d = new Date(ref);
      d.setHours(hour, minute, 0, 0);
      if (d.getTime() < ref.getTime()) d.setDate(d.getDate() + 1);
      return d;
    },
  },
  {
    pattern: /\bin (\d+) ?(minutes?|mins?|hours?|hrs?)\b/i,
    toDate: (m, ref) => {
      const amount = parseInt(m[1], 10);
      const unitIsHours = /hour|hr/i.test(m[2]);
      const d = new Date(ref);
      d.setMinutes(d.getMinutes() + amount * (unitIsHours ? 60 : 1));
      return d;
    },
  },
];

function extractPlaces(text: string): { origin_text: string | null; destination_text: string | null } {
  // Matches "from X to Y" — the dominant phrasing for this domain. Anything
  // more elaborate is exactly why the Qwen path exists; this is a floor,
  // not a replacement.
  const match = text.match(/from\s+(.+?)\s+to\s+(.+?)(?:[.,]|\s+(?:by|at|around|before|after)\s|$)/i);
  if (match) {
    return { origin_text: match[1].trim(), destination_text: match[2].trim() };
  }
  const toOnly = text.match(/\bto\s+(.+?)(?:[.,]|\s+(?:by|at|around|before|after)\s|$)/i);
  if (toOnly) {
    return { origin_text: null, destination_text: toOnly[1].trim() };
  }
  return { origin_text: null, destination_text: null };
}

function heuristicParse(utterance: string, referenceTime: Date, reason: string): ParsedTripRequest {
  const { origin_text, destination_text } = extractPlaces(utterance);

  let requested_departure_at: string | null = null;
  let window_minutes: number | null = null;
  for (const { pattern, toDate } of TIME_PATTERNS) {
    const m = utterance.match(pattern);
    if (m) {
      requested_departure_at = toDate(m, referenceTime).toISOString();
      window_minutes = 15;
      break;
    }
  }

  const windowMatch = utterance.match(/give or take (\d+)|(?:±|\+\/-)\s*(\d+)\s*min/i);
  if (windowMatch) {
    window_minutes = parseInt(windowMatch[1] ?? windowMatch[2], 10);
  }

  let preference: GenderPreference | null = null;
  if (FEMALE_ONLY_PATTERN.test(utterance)) preference = "female_only";
  else if (MALE_ONLY_PATTERN.test(utterance)) preference = "male_only";

  return {
    origin_text,
    destination_text,
    requested_departure_at,
    window_minutes,
    preference,
    require_driver_gender_match: DRIVER_GENDER_PATTERN.test(utterance),
    parsed_by: "heuristic_fallback",
    fallback_reason: reason,
  };
}

/**
 * parseTripRequestText — the single entry point. Tries Qwen first; on any
 * failure (no key, network error, malformed response), falls back to the
 * offline heuristic parser rather than erroring out the whole request flow.
 */
export async function parseTripRequestText(
  utterance: string,
  referenceTime: Date = new Date()
): Promise<ParsedTripRequest> {
  const trimmed = utterance.trim();
  if (!trimmed) {
    return {
      origin_text: null,
      destination_text: null,
      requested_departure_at: null,
      window_minutes: null,
      preference: null,
      require_driver_gender_match: false,
      parsed_by: "heuristic_fallback",
      fallback_reason: "EMPTY_INPUT",
    };
  }

  try {
    return await callQwen(trimmed, referenceTime);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "UNKNOWN_ERROR";
    return heuristicParse(trimmed, referenceTime, reason);
  }
}
