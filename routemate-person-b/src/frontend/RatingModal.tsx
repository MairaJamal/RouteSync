/* Day 7 Feature 4: "Rate your trip" modal, opened after a ride is
   completed. Stars 1-5 (hard constraint in the DB) plus an optional
   comment capped at 500 characters — enforced client-side before the
   server validates again.

   Low ratings (1-3 stars) additionally surface a "what went wrong?"
   review prompt and an optional safety report. When the rider picks a
   reason, the report is filed to POST /api/user-reports alongside the
   rating — the rating is the primary action, the report is best-effort
   so a report failure never blocks submitting the stars. */
import { useState } from "react";
import { validateRatingInput, REPORT_REASONS } from "../safety";
import { API_URL } from "./apiBase";
import { authedFetch } from "./demoAuth";

interface RatingModalProps {
  rideId: string;
  raterId: string;
  ratedUserId: string;
  ratedDisplayName: string;
  onClose: () => void;
  onRated: () => void;
}

/** Human labels for the DB report-reason codes. */
const REASON_LABELS: Record<string, string> = {
  unsafe_driving: "Unsafe driving",
  inappropriate_behavior: "Inappropriate behavior",
  no_show: "Rider didn't show up",
  other: "Something else",
};

/** 1-3 stars = a bad experience worth a follow-up + optional complaint. */
function isLowRating(stars: number): boolean {
  return stars >= 1 && stars <= 3;
}

export default function RatingModal({
  rideId,
  raterId,
  ratedUserId,
  ratedDisplayName,
  onClose,
  onRated,
}: RatingModalProps) {
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState("");
  const [reportReason, setReportReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const low = isLowRating(stars);

  async function handleSubmit() {
    setError(null);
    const validation = validateRatingInput(stars, comment);
    if (validation === "INVALID_STARS") {
      setError("Pick a star rating from 1 to 5.");
      return;
    }
    if (validation === "COMMENT_TOO_LONG") {
      setError("Comment must be 500 characters or fewer.");
      return;
    }

    setSubmitting(true);
    try {
      // 1. The rating is the primary, required action.
      const res = await authedFetch(`${API_URL}/api/ratings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ride_id: rideId,
          rater_id: raterId,
          rated_user_id: ratedUserId,
          stars,
          comment: comment.trim() || null,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (res.status === 503) {
        setError("Ratings aren't enabled on this database yet (Day 7 migration pending).");
        return;
      }
      if (!res.ok) {
        if (payload.error === "RATING_ALREADY_EXISTS") {
          setError("You already rated this rider for this ride.");
        } else if (payload.error === "CANNOT_RATE_SELF") {
          setError("You can't rate yourself.");
        } else {
          setError(payload.details || payload.error || "Couldn't save the rating.");
        }
        return;
      }

      // 2. Optional safety report for a low rating with a chosen reason.
      //    Best-effort: a failure here doesn't undo the saved rating.
      if (low && reportReason) {
        try {
          await authedFetch(`${API_URL}/api/user-reports`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              reporter_id: raterId,
              reported_user_id: ratedUserId,
              ride_id: rideId,
              reason: reportReason,
              details: comment.trim() || null,
            }),
          });
        } catch {
          // Swallow — the rating succeeded; the complaint simply wasn't filed.
        }
      }

      onRated();
      onClose();
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 150,
        background: "rgba(27, 31, 39, 0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "400px",
          maxHeight: "90vh",
          overflowY: "auto",
          background: "var(--rm-paper-raised)",
          border: "1px solid var(--rm-border)",
          borderRadius: "calc(var(--rm-radius) + 4px)",
          padding: "20px",
          display: "flex",
          flexDirection: "column",
          gap: "14px",
          fontFamily: "var(--rm-font-body)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: "15px", fontWeight: 600, color: "var(--rm-ink)" }}>
            ⭐ Rate your trip with {ratedDisplayName}
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "transparent", border: "none", fontSize: "18px", cursor: "pointer", color: "var(--rm-ink-soft)" }}
          >
            ✕
          </button>
        </div>

        <div style={{ display: "flex", gap: "6px", justifyContent: "center" }}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              aria-label={`${n} star${n > 1 ? "s" : ""}`}
              onClick={() => setStars(n)}
              style={{
                fontSize: "30px",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                color: n <= stars ? "var(--rm-star)" : "var(--rm-border)",
                transition: "color 0.1s ease",
                padding: "2px",
              }}
            >
              ★
            </button>
          ))}
        </div>

        {/* Low-rating follow-up: encourage a written review + optional complaint */}
        {low && (
          <div
            style={{
              border: "1px solid var(--rm-danger)",
              background: "rgba(217, 79, 74, 0.06)",
              borderRadius: "var(--rm-radius)",
              padding: "12px",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
            }}
          >
            <div style={{ fontSize: "12.5px", fontWeight: 600, color: "var(--rm-ink)" }}>
              We're sorry this trip wasn't good. What went wrong?
            </div>

            <label style={{ display: "flex", flexDirection: "column", gap: "5px", fontSize: "11px", color: "var(--rm-ink-soft)" }}>
              Report a problem (optional)
              <select
                value={reportReason}
                onChange={(e) => setReportReason(e.target.value)}
                style={{
                  padding: "9px 10px",
                  fontSize: "13px",
                  fontFamily: "var(--rm-font-body)",
                  border: "1px solid var(--rm-border)",
                  borderRadius: "var(--rm-radius)",
                  outline: "none",
                  background: "var(--rm-paper)",
                  color: "var(--rm-ink)",
                }}
              >
                <option value="">— No report, just the rating —</option>
                {REPORT_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {REASON_LABELS[r] ?? r}
                  </option>
                ))}
              </select>
            </label>

            {reportReason && (
              <div style={{ fontSize: "11px", color: "var(--rm-ink-soft)" }}>
                🛡️ Our safety team will review this along with your rating.
              </div>
            )}
          </div>
        )}

        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={
            low
              ? "Tell us more about what happened (optional, but it really helps)…"
              : "Optional comment — what went well?"
          }
          rows={low ? 4 : 3}
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "10px 12px",
            fontSize: "13px",
            fontFamily: "var(--rm-font-body)",
            border: low ? "1px solid var(--rm-danger)" : "1px solid var(--rm-border)",
            borderRadius: "var(--rm-radius)",
            resize: "vertical",
            outline: "none",
            background: "var(--rm-paper)",
            color: "var(--rm-ink)",
          }}
        />
        <div style={{ fontSize: "11px", color: comment.length > 500 ? "var(--rm-danger)" : "var(--rm-ink-soft)", textAlign: "right" }}>
          {comment.length}/500
        </div>

        {error && <div style={{ fontSize: "12px", color: "var(--rm-danger)" }}>{error}</div>}

        <div style={{ display: "flex", gap: "10px" }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              flex: 1,
              padding: "10px",
              fontFamily: "var(--rm-font-display)",
              fontSize: "12px",
              fontWeight: 600,
              color: "var(--rm-ink-soft)",
              background: "transparent",
              border: "1px solid var(--rm-border)",
              borderRadius: "var(--rm-radius)",
              cursor: "pointer",
            }}
          >
            Skip
          </button>
          <button
            type="button"
            disabled={submitting || stars === 0}
            onClick={handleSubmit}
            style={{
              flex: 1,
              padding: "10px",
              fontFamily: "var(--rm-font-display)",
              fontSize: "12px",
              fontWeight: 600,
              color: "var(--rm-signal-ink)",
              background: stars === 0 ? "var(--rm-border)" : "var(--rm-signal)",
              border: "none",
              borderRadius: "var(--rm-radius)",
              cursor: stars === 0 ? "not-allowed" : "pointer",
            }}
          >
            {submitting ? "Saving…" : low && reportReason ? "Submit & report" : "Submit rating"}
          </button>
        </div>
      </div>
    </div>
  );
}
