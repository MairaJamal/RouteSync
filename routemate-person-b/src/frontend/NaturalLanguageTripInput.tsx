/* NEW: Qwen-powered natural-language trip request box (Alibaba Cloud AI
   Hackathon feature). Lets a user type "from G-9 to NUST by 9am, women
   only" instead of filling the form field-by-field. Deliberately a
   self-contained component — it never invents coordinates itself; it
   calls POST /api/trip-requests/parse for structured text fields, then
   geocodes origin/destination through the SAME Photon flow every other
   part of the app already trusts (searchPlaces in ./places), and hands
   the fully-resolved draft back to the parent via onParsed. Drop this
   above <LocationSearchForm /> and use onParsed to prefill it. */
import { useState, useRef, useEffect } from "react";
import { searchPlaces } from "./places";
import { LocationPoint, GenderPreference } from "../types";
import { API_URL } from "./apiBase";
import { authedFetch } from "./demoAuth";

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
  authToken?: string;
  onParsed: (draft: ParsedTripDraft) => void;
}

export default function NaturalLanguageTripInput({ authToken, onParsed }: Props) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUsedFallback, setLastUsedFallback] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<any>(null);

  // Clean up recognition on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          /* ignore */
        }
      }
    };
  }, []);

  async function handleVoiceInput() {
    // If currently listening, toggle off
    if (isListening && recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        /* ignore */
      }
      setIsListening(false);
      return;
    }

    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition ||
      (window as any).mozSpeechRecognition ||
      (window as any).msSpeechRecognition;

    if (!SpeechRecognition) {
      setError(
        "Speech recognition is not supported in this browser. Please use Google Chrome or Microsoft Edge, or type your trip below."
      );
      return;
    }

    // Explicitly check/request microphone access so the browser prompts the user
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Release the stream immediately so the SpeechRecognition engine can capture it
        stream.getTracks().forEach((track) => track.stop());
      } catch (micErr: any) {
        if (micErr?.name === "NotAllowedError" || micErr?.name === "PermissionDeniedError") {
          setError("Microphone permission was denied. Please click the lock or tune icon in your browser's address bar to allow microphone access.");
          return;
        }
        if (micErr?.name === "NotFoundError" || micErr?.name === "DevicesNotFoundError") {
          setError("No microphone was detected on this device. Please connect a microphone or headset.");
          return;
        }
      }
    }

    try {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          /* ignore */
        }
      }

      const recognition = new SpeechRecognition();
      recognitionRef.current = recognition;

      recognition.lang = navigator.language || "en-US";
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      recognition.continuous = false;

      recognition.onstart = () => {
        setIsListening(true);
        setError(null);
      };

      recognition.onresult = (event: any) => {
        let finalTranscript = "";
        let interimTranscript = "";

        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript;
          } else {
            interimTranscript += event.results[i][0].transcript;
          }
        }

        const currentText = finalTranscript || interimTranscript;
        if (currentText.trim()) {
          setText(currentText);
        }
      };

      recognition.onerror = (event: any) => {
        setIsListening(false);
        const errType = event.error;
        if (errType === "no-speech") {
          setError("No speech was detected. Please try speaking closer to the microphone.");
        } else if (errType === "not-allowed" || errType === "service-not-allowed") {
          setError("Microphone access blocked. Click the lock/tune icon in your browser's address bar to allow microphone access.");
        } else if (errType === "network") {
          setError("Network error connecting to speech recognition service. Please check your internet connection.");
        } else if (errType !== "aborted") {
          setError(`Voice input error: ${errType}`);
        }
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognition.start();
    } catch (err: any) {
      setIsListening(false);
      setError(
        err?.message?.includes("already started")
          ? "Voice recognition already active. Please speak now."
          : "Could not initialize voice recognition. Please type your trip description."
      );
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || loading) return;

    setLoading(true);
    setError(null);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (authToken) headers.Authorization = `Bearer ${authToken}`;
      const res = await authedFetch(`${API_URL}/api/trip-requests/parse`, {
        method: "POST",
        headers,
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
