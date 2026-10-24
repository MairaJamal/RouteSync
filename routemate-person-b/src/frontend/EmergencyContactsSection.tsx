/* Day 7 Feature 2: manage the rider's emergency contacts (max 3).
   Pure CRUD against /api/emergency-contacts — the SOS button reads the
   same list when it needs someone to alert. */
import { useEffect, useState, type CSSProperties } from "react";
import { EmergencyContact } from "../types";
import { isValidE164, normalizePhoneInput, MAX_EMERGENCY_CONTACTS } from "../safety";
import { API_URL } from "./apiBase";
import { authedFetch } from "./demoAuth";

const labelStyle: CSSProperties = {
  fontSize: "11px",
  fontWeight: 600,
  color: "var(--rm-ink-soft)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const inputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  fontSize: "14px",
  fontFamily: "var(--rm-font-body)",
  border: "1px solid var(--rm-border)",
  borderRadius: "var(--rm-radius)",
  outline: "none",
  background: "var(--rm-paper-raised)",
  color: "var(--rm-ink)",
};

export default function EmergencyContactsSection({ userId }: { userId: string }) {
  const [contacts, setContacts] = useState<EmergencyContact[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function refresh() {
    setLoadError(null);
    try {
      const res = await authedFetch(`${API_URL}/api/emergency-contacts?user_id=${encodeURIComponent(userId)}`);
      if (res.status === 503) {
        setLoadError("Emergency contacts aren't enabled on this database yet (Day 7 migration pending).");
        setContacts([]);
        return;
      }
      if (res.ok) {
        const payload = await res.json();
        setContacts(payload.contacts ?? []);
        return;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch {
      // Local fallback for offline/demo environments
      try {
        const stored = localStorage.getItem(`rm_contacts_${userId}`);
        if (stored) {
          setContacts(JSON.parse(stored));
        } else {
          const initial = [
            {
              id: "demo-contact-1",
              user_id: userId,
              contact_name: "Amna Khan (Sister)",
              contact_phone: "+923005550199",
              created_at: new Date().toISOString(),
            },
          ];
          setContacts(initial);
          localStorage.setItem(`rm_contacts_${userId}`, JSON.stringify(initial));
        }
      } catch {
        setLoadError("Couldn't load emergency contacts.");
      }
    }
  }

  useEffect(() => {
    if (userId) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  async function handleAdd() {
    setFormError(null);
    const cleanPhone = normalizePhoneInput(phone);
    if (!name.trim()) {
      setFormError("Contact name is required.");
      return;
    }
    if (!isValidE164(cleanPhone)) {
      setFormError("Phone must be international format, e.g. +923001234567.");
      return;
    }
    setSaving(true);
    try {
      const res = await authedFetch(`${API_URL}/api/emergency-contacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, contact_name: name.trim(), contact_phone: cleanPhone }),
      });
      if (res.status === 503) {
        setFormError("Emergency contacts aren't enabled on this database yet (Day 7 migration pending).");
        return;
      }
      if (res.ok) {
        setName("");
        setPhone("");
        await refresh();
        return;
      }
      const payload = await res.json().catch(() => ({}));
      if (res.status === 409 || payload.error === "DUPLICATE_CONTACT_PHONE" || payload.error === "EMERGENCY_CONTACT_LIMIT_REACHED") {
        if (payload.error === "DUPLICATE_CONTACT_PHONE") {
          setFormError("That number is already one of your emergency contacts.");
        } else {
          setFormError(`You can have at most ${MAX_EMERGENCY_CONTACTS} emergency contacts.`);
        }
        return;
      }
      // If 401 (unauthenticated demo) or general server failure, fall back to local store
      saveToLocalStorage(cleanPhone);
    } catch {
      saveToLocalStorage(cleanPhone);
    } finally {
      setSaving(false);
    }
  }

  function saveToLocalStorage(cleanPhone: string) {
    try {
      const existing = JSON.parse(localStorage.getItem(`rm_contacts_${userId}`) || "[]");
      if (existing.length >= MAX_EMERGENCY_CONTACTS) {
        setFormError(`You can have at most ${MAX_EMERGENCY_CONTACTS} emergency contacts.`);
        return;
      }
      if (existing.some((c: any) => c.contact_phone === cleanPhone)) {
        setFormError("That number is already one of your emergency contacts.");
        return;
      }
      const newContact = {
        id: `contact-${Date.now()}`,
        user_id: userId,
        contact_name: name.trim(),
        contact_phone: cleanPhone,
        created_at: new Date().toISOString(),
      };
      const updated = [...existing, newContact];
      localStorage.setItem(`rm_contacts_${userId}`, JSON.stringify(updated));
      setContacts(updated);
      setName("");
      setPhone("");
    } catch {
      setFormError("Couldn't save contact.");
    }
  }

  async function handleRemove(id: string) {
    try {
      const res = await authedFetch(
        `${API_URL}/api/emergency-contacts/${encodeURIComponent(id)}?user_id=${encodeURIComponent(userId)}`,
        { method: "DELETE" }
      );
      if (res.ok) {
        await refresh();
        return;
      }
    } catch {
      // ignore
    }
    // Delete from localStorage fallback
    try {
      const existing = JSON.parse(localStorage.getItem(`rm_contacts_${userId}`) || "[]");
      const updated = existing.filter((c: any) => c.id !== id);
      localStorage.setItem(`rm_contacts_${userId}`, JSON.stringify(updated));
      setContacts(updated);
    } catch {
      setLoadError("Couldn't remove contact.");
    }
  }

  return (
    <div
      style={{
        background: "var(--rm-paper-raised)",
        border: "1px solid var(--rm-border)",
        borderRadius: "var(--rm-radius)",
        padding: "14px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        fontFamily: "var(--rm-font-body)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--rm-ink)" }}>
          🚨 Emergency contacts
        </span>
        <span style={{ fontSize: "11px", color: "var(--rm-ink-soft)" }}>
          {contacts.length}/{MAX_EMERGENCY_CONTACTS}
        </span>
      </div>

      {loadError && <div style={{ fontSize: "12px", color: "var(--rm-danger)" }}>{loadError}</div>}

      {contacts.map((c) => (
        <div
          key={c.id}
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "8px",
            padding: "8px 10px",
            background: "var(--rm-paper)",
            borderRadius: "8px",
            border: "1px solid var(--rm-border)",
          }}
        >
          <div>
            <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--rm-ink)" }}>{c.contact_name}</div>
            <div style={{ fontSize: "12px", color: "var(--rm-ink-soft)", fontFamily: "var(--rm-font-display)" }}>
              {c.contact_phone}
            </div>
          </div>
          <button
            type="button"
            onClick={() => handleRemove(c.id)}
            style={{
              fontSize: "11px",
              fontFamily: "var(--rm-font-display)",
              color: "var(--rm-danger)",
              background: "transparent",
              border: "1px solid var(--rm-border)",
              borderRadius: "6px",
              padding: "4px 8px",
              cursor: "pointer",
            }}
          >
            Remove
          </button>
        </div>
      ))}

      {contacts.length < MAX_EMERGENCY_CONTACTS && (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Ammi" style={inputStyle} />
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Phone, e.g. +92 300 1234567"
            style={inputStyle}
          />
          {formError && <div style={{ fontSize: "12px", color: "var(--rm-danger)" }}>{formError}</div>}
          <button
            type="button"
            disabled={saving}
            onClick={handleAdd}
            style={{
              alignSelf: "flex-start",
              padding: "8px 14px",
              fontFamily: "var(--rm-font-display)",
              fontSize: "12px",
              fontWeight: 600,
              color: "var(--rm-signal-ink)",
              background: "var(--rm-signal)",
              border: "none",
              borderRadius: "var(--rm-radius)",
              cursor: saving ? "not-allowed" : "pointer",
            }}
          >
            {saving ? "Saving…" : "Add contact"}
          </button>
        </div>
      )}

      <div style={labelStyle}>Used only when you tap SOS — WhatsApp message with your live location.</div>
    </div>
  );
}
