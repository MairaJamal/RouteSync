/* Day 10: notification bell for the in-app feed backing consent
 * voting (see GET /api/users/:id/notifications). This exists because
 * a pending_consent vote used to be visible only if the rider had
 * PendingConsentsPanel open and happened to poll before the 30-minute
 * window ran out — see supabase/migrations/20260906000000_notifications.sql
 * for why this is a feed rather than push/SMS. */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { API_URL } from "./apiBase";
import { authedFetch } from "./demoAuth";

interface Notification {
  id: string;
  kind: "consent_requested" | "consent_reminder" | "consent_resolved" | "consent_expired";
  title: string;
  body: string;
  ride_id?: string | null;
  booking_id?: string | null;
  created_at: string;
  read_at?: string | null;
}

const KIND_ICON: Record<Notification["kind"], string> = {
  consent_requested: "🤝",
  consent_reminder: "⏳",
  consent_resolved: "✅",
  consent_expired: "⌛",
};

/** "just now", "12m ago", "3h ago" — enough precision for a
 *  notification feed without pulling in a date library. */
function relativeTime(iso: string, now: number): string {
  const diffMs = now - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function NotificationBell({ userId }: { userId: string }) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const containerRef = useRef<HTMLDivElement>(null);

  async function refresh() {
    try {
      const res = await authedFetch(`${API_URL}/api/users/${userId}/notifications`);
      if (res.status === 503) {
        // Notifications aren't migrated in on this database yet —
        // stay silent, same convention as PendingConsentsPanel.
        return;
      }
      if (!res.ok) return;
      const payload = await res.json();
      setNotifications(payload.notifications ?? []);
      setUnreadCount(payload.unread_count ?? 0);
    } catch {
      // Best-effort — a failed poll just means slightly stale badge count.
    }
  }

  useEffect(() => {
    if (!userId) return;
    refresh();
    const poll = setInterval(refresh, 20_000);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  async function markRead(notification: Notification) {
    if (notification.read_at) return;
    setNotifications((prev) =>
      prev.map((n) => (n.id === notification.id ? { ...n, read_at: new Date().toISOString() } : n))
    );
    setUnreadCount((prev) => Math.max(0, prev - 1));
    try {
      await authedFetch(`${API_URL}/api/users/${userId}/notifications/${notification.id}/read`, {
        method: "POST",
      });
    } catch {
      // The next poll (20s) will reconcile if this silently failed.
    }
  }

  async function markAllRead() {
    if (unreadCount === 0) return;
    setNotifications((prev) => prev.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })));
    setUnreadCount(0);
    try {
      await authedFetch(`${API_URL}/api/users/${userId}/notifications/read-all`, { method: "POST" });
    } catch {
      // Reconciled on next poll.
    }
  }

  const bellButtonStyle: CSSProperties = {
    position: "relative",
    width: "36px",
    height: "36px",
    borderRadius: "50%",
    border: "1px solid var(--rm-border)",
    background: "var(--rm-paper-raised)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    fontSize: "16px",
  };

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        type="button"
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
        onClick={() => setOpen((v) => !v)}
        style={bellButtonStyle}
      >
        🔔
        {unreadCount > 0 && (
          <span
            style={{
              position: "absolute",
              top: "-4px",
              right: "-4px",
              minWidth: "16px",
              height: "16px",
              padding: "0 3px",
              borderRadius: "8px",
              background: "var(--rm-signal)",
              color: "var(--rm-signal-ink)",
              fontSize: "10px",
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              lineHeight: 1,
            }}
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            right: 0,
            top: "44px",
            width: "320px",
            maxHeight: "420px",
            overflowY: "auto",
            background: "var(--rm-paper-raised)",
            border: "1px solid var(--rm-border)",
            borderRadius: "var(--rm-radius)",
            boxShadow: "0 8px 24px rgba(27, 31, 39, 0.16)",
            zIndex: 50,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 14px",
              borderBottom: "1px solid var(--rm-border)",
            }}
          >
            <span
              style={{
                fontFamily: "var(--rm-font-display)",
                fontSize: "13px",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                color: "var(--rm-ink)",
              }}
            >
              Notifications
            </span>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                style={{
                  border: "none",
                  background: "none",
                  color: "var(--rm-route-blue)",
                  fontSize: "12px",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                Mark all read
              </button>
            )}
          </div>

          {notifications.length === 0 ? (
            <div style={{ padding: "20px 14px", fontSize: "12px", color: "var(--rm-ink-soft)", textAlign: "center" }}>
              Nothing yet — group ride approvals and updates will show up here.
            </div>
          ) : (
            notifications.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => markRead(n)}
                style={{
                  display: "flex",
                  gap: "10px",
                  padding: "10px 14px",
                  textAlign: "left",
                  border: "none",
                  borderBottom: "1px solid var(--rm-border)",
                  background: n.read_at ? "transparent" : "var(--rm-alert-tint, rgba(242,183,5,0.08))",
                  cursor: "pointer",
                }}
              >
                <span style={{ fontSize: "16px", flexShrink: 0 }}>{KIND_ICON[n.kind]}</span>
                <span style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                  <span style={{ fontSize: "12px", fontWeight: n.read_at ? 500 : 700, color: "var(--rm-ink)" }}>
                    {n.title}
                  </span>
                  <span style={{ fontSize: "11px", color: "var(--rm-ink-soft)" }}>{n.body}</span>
                  <span style={{ fontSize: "10px", color: "var(--rm-ink-soft)" }}>{relativeTime(n.created_at, now)}</span>
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
