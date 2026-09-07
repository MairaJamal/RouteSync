/* NEW: Qwen-powered natural-language trip request box (Alibaba Cloud AI
   Hackathon feature). Lets a user type "from G-9 to NUST by 9am, women
   only" instead of filling the form field-by-field. Deliberately a
   self-contained component — it never invents coordinates itself; it
   calls POST /api/trip-requests/parse for structured text fields, then
   geocodes origin/destination through the SAME Photon flow every other
   part of the app already trusts (searchPlaces in ./places), and hands
   the fully-resolved draft back to the parent via onParsed. Drop this
   above <LocationSearchForm /> and use onParsed to prefill it. */
import { useState } from "react";
import { searchPlaces } from "./places";
import { LocationPoint, GenderPreference } from "../types";
import { API_URL } from "./apiBase";

export interface ParsedTripDraft {
  origin: LocationPoint | null;
  destination: LocationPoint | null;
  requested_departure_at: string | null;
  window_minutes: number | null;
  preference: GenderPreference | null;
  require_driver_gender_match: boolean;
  parsed_by: "qwen" | "heuristic_fallback";
}

interface Props {
  authToken: string;
  onParsed: (draft: ParsedTripDraft) => void;
}

export default function NaturalLanguageTripInput({ authToken, onParsed }: Props) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUsedFallback, setLastUsedFallback] = useState(false);
  const [isListening, setIsListening] = useState(false);

  function handleVoiceInput() {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setError("Speech recognition is not supported in this browser (works best on Chrome/Edge).");
      return;
    }
    try {
      const recognition = new SpeechRecognition();
      recognition.lang = "en-US";
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        setIsListening(true);
        setError(null);
      };
      recognition.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        setText(transcript);
        setIsListening(false);
      };
      recognition.onerror = (event: any) => {
        setIsListening(false);
        if (event.error !== "no-speech") {
          setError(`Voice input: ${event.error}`);
        }
      };
      recognition.onend = () => {
        setIsListening(false);
      };
      recognition.start();
    } catch (err) {
      setIsListening(false);
      setError("Microphone access could not be started.");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || loading) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/trip-requests/parse`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`Parse request failed (${res.status})`);
      const parsed = await res.json();
      setLastUsedFallback(parsed.parsed_by === "heuristic_fallback");

      // Geocode whatever place text Qwen (or the fallback parser) found,
      // through the same trusted Photon path the rest of the app uses.
      // We never trust a place name→coordinate mapping from the LLM.
      const [origin, destination] = await Promise.all([
        parsed.origin_text ? geocodeFirst(parsed.origin_text) : Promise.resolve(null),
        parsed.destination_text ? geocodeFirst(parsed.destination_text) : Promise.resolve(null),
      ]);

      onParsed({
        origin,
        destination,
        requested_departure_at: parsed.requested_departure_at,
        window_minutes: parsed.window_minutes,
        preference: parsed.preference,
        require_driver_gender_match: parsed.require_driver_gender_match,
        parsed_by: parsed.parsed_by,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong parsing that.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        padding: "12px",
        border: "1px solid var(--rm-border)",
        borderRadius: "8px",
        background: "var(--rm-paper)",
      }}
    >
      <label
        htmlFor="nl-trip-input"
        style={{
          fontFamily: "var(--rm-font-display)",
          fontSize: "12px",
          fontWeight: 600,
          letterSpacing: "0.02em",
          color: "var(--rm-ink)",
        }}
      >
        Or just describe your trip
      </label>
      <div style={{ display: "flex", gap: "8px" }}>
        <input
          id="nl-trip-input"
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={isListening ? "Listening... Speak your trip" : '"from G-9 to NUST by 9am, women only"'}
          style={{
            flex: 1,
            padding: "10px 12px",
            borderRadius: "6px",
            border: `1px solid ${isListening ? "var(--rm-alert)" : "var(--rm-border)"}`,
            fontFamily: "var(--rm-font-body)",
            fontSize: "14px",
            background: isListening ? "var(--rm-alert-tint)" : "var(--rm-paper-raised)",
            color: "var(--rm-ink)",
          }}
        />
        <button
          type="button"
          onClick={handleVoiceInput}
          title="Voice Trip Input (Speak your route)"
          style={{
            padding: "10px 12px",
            borderRadius: "6px",
            border: "1px solid var(--rm-border)",
            background: isListening ? "var(--rm-alert)" : "var(--rm-paper-raised)",
            color: isListening ? "#ffffff" : "var(--rm-ink)",
            fontFamily: "var(--rm-font-display)",
            fontSize: "13px",
            fontWeight: 600,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: "4px",
            transition: "all 0.2s ease",
          }}
        >
          <span>🎙️</span>
          <span>{isListening ? "Listening…" : "Speak"}</span>
        </button>
        <button
          type="submit"
          disabled={loading || !text.trim()}
          style={{
            padding: "10px 16px",
            borderRadius: "6px",
            border: "none",
            background: "var(--rm-signal)",
            color: "var(--rm-signal-ink)",
            fontFamily: "var(--rm-font-display)",
            fontWeight: 600,
            cursor: loading ? "wait" : "pointer",
            opacity: loading || !text.trim() ? 0.6 : 1,
          }}
        >
          {loading ? "Parsing…" : "Fill form"}
        </button>
      </div>
      {error && (
        <p role="alert" style={{ color: "#B3261E", fontSize: "13px", margin: 0 }}>
          {error}
        </p>
      )}
      {lastUsedFallback && !error && (
        <p style={{ color: "var(--rm-ink)", opacity: 0.7, fontSize: "12px", margin: 0 }}>
          Parsed with the offline fallback (Qwen wasn't reachable) — double-check the fields below.
        </p>
      )}
    </form>
  );
}

async function geocodeFirst(query: string): Promise<LocationPoint | null> {
  try {
    const results = await searchPlaces(query);
    return results[0]?.point ?? null;
  } catch {
    return null;
  }
}
