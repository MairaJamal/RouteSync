/* Day 7 Feature 4: the ··· safety menu (Report / Block) reused on the
   MatchCard and inside the MatchChatDrawer. Reporting is anonymous to
   the other rider (reports are reporter-only readable via RLS); a block
   hides both directions of future matching immediately. */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ReportReason } from "../types";
import { REPORT_REASONS } from "../safety";
import { API_URL } from "./apiBase";
import { authedFetch } from "./demoAuth";

const REASON_LABELS: Record<ReportReason, string> = {
  unsafe_driving: "Unsafe driving",
  inappropriate_behavior: "Inappropriate behavior",
  no_show: "No-show",
  other: "Other",
};

/** Raw API error codes → human messages, so riders never see machine text. */
const ERROR_MESSAGES: Record<string, string> = {
  CANNOT_REPORT_SELF: "You can't report yourself.",
  CANNOT_BLOCK_SELF: "You can't block yourself.",
  MISSING_REQUIRED_FIELDS: "Some required information is missing.",
  INVALID_REPORT_REASON: "Please pick one of the listed reasons.",
};

function friendlyError(payload: { error?: string; details?: string } | null, fallback: string): string {
  if (payload?.error && ERROR_MESSAGES[payload.error]) return ERROR_MESSAGES[payload.error];
  return payload?.details || fallback;
}

interface SafetyMenuProps {
  reporterId: string;
  reportedUserId: string;
  reportedDisplayName: string;
  rideId?: string | null;
  onBlocked?: () => void;
  align?: "left" | "right";
}

export default function SafetyMenu({
  reporterId,
  reportedUserId,
  reportedDisplayName,
  rideId,
  onBlocked,
  align = "right",
}: SafetyMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [blockConfirmOpen, setBlockConfirmOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  async function handleBlock() {
    setBlockConfirmOpen(false);
    setNotice(null);
    try {
      const res = await authedFetch(`${API_URL}/api/blocked-users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blocker_id: reporterId, blocked_id: reportedUserId }),
      });
      if (res.status === 503) {
        setNotice("Blocking isn't enabled on this database yet (Day 7 migration pending). The rider was hidden for this session anyway.");
        onBlocked?.();
        return;
      }
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        setNotice(friendlyError(payload, "Couldn't block this rider."));
        return;
      }
      setNotice(`${reportedDisplayName} is blocked. You won't be matched with each other again.`);
      onBlocked?.();
    } catch {
      setNotice("Couldn't reach the server to record the block.");
      onBlocked?.();
    }
  }

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        aria-label={`Safety options for ${reportedDisplayName}`}
        onClick={() => setMenuOpen((o) => !o)}
        style={{
          background: "transparent",
          border: "1px solid var(--rm-border)",
          borderRadius: "8px",
          padding: "4px 9px",
          cursor: "pointer",
          fontSize: "14px",
          color: "var(--rm-ink-soft)",
          lineHeight: 1,
        }}
      >
        ···
      </button>

      {menuOpen && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            [align]: 0,
            zIndex: 40,
            minWidth: "170px",
            background: "var(--rm-paper-raised)",
            border: "1px solid var(--rm-border)",
            borderRadius: "var(--rm-radius)",
            boxShadow: "0 8px 24px rgba(27,31,39,0.14)",
            overflow: "hidden",
            fontFamily: "var(--rm-font-body)",
          }}
        >
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              setReportOpen(true);
            }}
            style={menuItemStyle}
          >
            🚩 Report {reportedDisplayName.split(" ")[0]}
          </button>
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              setBlockConfirmOpen(true);
            }}
            style={{ ...menuItemStyle, color: "var(--rm-danger)", borderBottom: "none" }}
          >
            🚫 Block rider
          </button>
        </div>
      )}

      {notice && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            [align]: 0,
            zIndex: 41,
            width: "240px",
            fontSize: "12px",
            padding: "10px 12px",
            background: "var(--rm-paper-raised)",
            border: "1px solid var(--rm-border)",
            borderRadius: "8px",
            boxShadow: "0 8px 24px rgba(27,31,39,0.14)",
            color: "var(--rm-ink)",
          }}
        >
          {notice}
        </div>
      )}

      {blockConfirmOpen && (
        <ConfirmOverlay
          title={`Block ${reportedDisplayName}?`}
          body="You won't see each other in matches anymore. This applies in both directions and you can't undo it from the app yet."
          confirmLabel="Block rider"
          danger
          onCancel={() => setBlockConfirmOpen(false)}
          onConfirm={handleBlock}
        />
      )}

      {reportOpen && (
        <ReportModal
          reporterId={reporterId}
          reportedUserId={reportedUserId}
          reportedDisplayName={reportedDisplayName}
          rideId={rideId ?? null}
          onClose={() => setReportOpen(false)}
          onSubmitted={(msg) => setNotice(msg)}
        />
      )}
    </div>
  );
}

const menuItemStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  padding: "10px 14px",
  fontSize: "13px",
  background: "transparent",
  border: "none",
  borderBottom: "1px solid var(--rm-border)",
  cursor: "pointer",
  color: "var(--rm-ink)",
};

function ConfirmOverlay({
  title,
  body,
  confirmLabel,
  danger = false,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 160,
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
          maxWidth: "380px",
          background: "var(--rm-paper-raised)",
          border: `1.5px solid ${danger ? "var(--rm-danger)" : "var(--rm-border)"}`,
          borderRadius: "calc(var(--rm-radius) + 4px)",
          padding: "20px",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          fontFamily: "var(--rm-font-body)",
        }}
      >
        <div style={{ fontSize: "15px", fontWeight: 600, color: "var(--rm-ink)" }}>{title}</div>
        <div style={{ fontSize: "13px", color: "var(--rm-ink-soft)", lineHeight: 1.5 }}>{body}</div>
        <div style={{ display: "flex", gap: "10px" }}>
          <button
            type="button"
            onClick={onCancel}
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
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            style={{
              flex: 1,
              padding: "10px",
              fontFamily: "var(--rm-font-display)",
              fontSize: "12px",
              fontWeight: 600,
              color: "#ffffff",
              background: danger ? "var(--rm-danger)" : "var(--rm-signal)",
              border: "none",
              borderRadius: "var(--rm-radius)",
              cursor: "pointer",
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function ReportModal({
  reporterId,
  reportedUserId,
  reportedDisplayName,
  rideId,
  onClose,
  onSubmitted,
}: {
  reporterId: string;
  reportedUserId: string;
  reportedDisplayName: string;
  rideId: string | null;
  onClose: () => void;
  onSubmitted: (msg: string) => void;
}) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    setError(null);
    if (!reason) {
      setError("Pick a reason for the report.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await authedFetch(`${API_URL}/api/user-reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reporter_id: reporterId,
          reported_user_id: reportedUserId,
          ride_id: rideId,
          reason,
          details: details.trim() || null,
        }),
      });
      if (res.status === 503) {
        setError("Reporting isn't enabled on this database yet (Day 7 migration pending).");
        return;
      }
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        setError(friendlyError(payload, "Couldn't submit the report."));
        return;
      }
      onSubmitted(`Thanks — your report about ${reportedDisplayName} was recorded and will be reviewed.`);
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
        zIndex: 170,
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
          maxWidth: "420px",
          background: "var(--rm-paper-raised)",
          border: "1px solid var(--rm-border)",
          borderRadius: "calc(var(--rm-radius) + 4px)",
          padding: "20px",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          fontFamily: "var(--rm-font-body)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: "15px", fontWeight: 600, color: "var(--rm-ink)" }}>
            🚩 Report {reportedDisplayName}
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "transparent", border: "none", fontSize: "18px", cursor: "pointer", color: "var(--rm-ink-soft)" }}
          >
            ✕
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {REPORT_REASONS.map((r) => (
            <label
              key={r}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "8px 10px",
                fontSize: "13px",
                color: "var(--rm-ink)",
                background: reason === r ? "var(--rm-paper)" : "transparent",
                border: `1px solid ${reason === r ? "var(--rm-signal)" : "var(--rm-border)"}`,
                borderRadius: "8px",
                cursor: "pointer",
              }}
            >
              <input type="radio" name="report-reason" checked={reason === r} onChange={() => setReason(r)} />
              {REASON_LABELS[r]}
            </label>
          ))}
        </div>

        <textarea
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          placeholder="Optional details (max 500 characters)"
          rows={3}
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "10px 12px",
            fontSize: "13px",
            fontFamily: "var(--rm-font-body)",
            border: "1px solid var(--rm-border)",
            borderRadius: "var(--rm-radius)",
            resize: "vertical",
            outline: "none",
            background: "var(--rm-paper)",
            color: "var(--rm-ink)",
          }}
        />

        <div style={{ fontSize: "11px", color: "var(--rm-ink-soft)" }}>
          Reports are private — only you and RouteSync moderators can see them.
        </div>

        {error && <div style={{ fontSize: "12px", color: "var(--rm-danger)" }}>{error}</div>}

        <button
          type="button"
          disabled={submitting}
          onClick={handleSubmit}
          style={{
            padding: "11px",
            fontFamily: "var(--rm-font-display)",
            fontSize: "12px",
            fontWeight: 600,
            color: "#ffffff",
            background: "var(--rm-danger)",
            border: "none",
            borderRadius: "var(--rm-radius)",
            cursor: submitting ? "not-allowed" : "pointer",
          }}
        >
          {submitting ? "Submitting…" : "Submit report"}
        </button>
      </div>
    </div>
  );
}
