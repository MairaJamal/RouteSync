/* Day 12: self-attested vehicle details for car/bike owners. This is
 * deliberately NOT document verification — no photo upload, no admin
 * review, nobody checks the CNIC against any government database.
 * It exists so a rider bringing a car/bike can put an identifiable
 * plate number on record, and a matched passenger can visually
 * confirm the car that shows up is the right one. The full CNIC is
 * write-only from this component's point of view: it's typed once,
 * sent, and never displayed back — only its last 4 digits ever come
 * back from the API, matching the backend's handling in
 * vehicleDeclaration.ts / apiHandler.ts. */
import { useEffect, useState, type CSSProperties } from "react";
import { isValidPakistaniCnic, isValidVehiclePlate, normalizeCnic, normalizeVehiclePlate } from "../vehicleDeclaration";
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

interface SavedDeclaration {
  vehicle_plate: string;
  vehicle_make_model?: string | null;
  cnic_last4: string;
  declared_at: string;
}

export default function VehicleDeclarationSection({ userId }: { userId: string }) {
  const [saved, setSaved] = useState<SavedDeclaration | null>(null);
  const [editing, setEditing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cnic, setCnic] = useState("");
  const [plate, setPlate] = useState("");
  const [makeModel, setMakeModel] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function refresh() {
    setLoadError(null);
    try {
      const res = await authedFetch(`${API_URL}/api/users/${userId}/vehicle-declaration`);
      if (res.status === 503) {
        setLoadError("Vehicle details aren't enabled on this database yet (migration pending).");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      setSaved(payload.declared ? payload : null);
    } catch {
      setLoadError("Couldn't load your vehicle details.");
    }
  }

  useEffect(() => {
    if (userId) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  async function handleSave() {
    setFormError(null);
    const hasNewCnic = cnic.trim().length > 0;
    if (hasNewCnic && !isValidPakistaniCnic(cnic)) {
      setFormError("Enter your CNIC in the format 12345-1234567-1.");
      return;
    }
    if (!saved && !hasNewCnic) {
      setFormError("Enter your CNIC (same one from signup) in the format 12345-1234567-1.");
      return;
    }
    if (!isValidVehiclePlate(plate)) {
      setFormError("Enter a plate number with at least one letter and one digit, e.g. ISB-1234.");
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, string> = {
        vehicle_plate: normalizeVehiclePlate(plate),
        vehicle_make_model: makeModel.trim() || "",
      };
      if (hasNewCnic) body.cnic_number = normalizeCnic(cnic);
      const res = await authedFetch(`${API_URL}/api/users/${userId}/vehicle-declaration`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 503) {
        setFormError("Vehicle details aren't enabled on this database yet (migration pending).");
        return;
      }
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(
          payload?.error === "INVALID_CNIC"
            ? "CNIC missing or invalid — use the one from signup (12345-1234567-1)."
            : payload?.error === "INVALID_VEHICLE_PLATE"
            ? "That plate format isn't valid."
            : "Couldn't save your vehicle details — please try again."
        );
        return;
      }
      setCnic("");
      setEditing(false);
      await refresh();
    } catch {
      setFormError("Couldn't save your vehicle details — please try again.");
    } finally {
      setSaving(false);
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
        <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--rm-ink)" }}>🪪 Vehicle details</span>
      </div>

      <span style={{ fontSize: "11px", color: "var(--rm-ink-soft)" }}>
        Self-declared — RouteSync doesn't verify this against any document or database. It just gives a
        matched rider a plate number to check against the car that shows up.
      </span>

      {loadError && <span style={{ fontSize: "12px", color: "var(--rm-danger)" }}>{loadError}</span>}

      {saved && !editing ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <span style={{ fontSize: "13px", color: "var(--rm-ink)" }}>
            Plate <strong>{saved.vehicle_plate}</strong>
            {saved.vehicle_make_model ? ` · ${saved.vehicle_make_model}` : ""}
          </span>
          <span style={{ fontSize: "11px", color: "var(--rm-ink-soft)" }}>
            CNIC on file ending in {saved.cnic_last4} · declared {new Date(saved.declared_at).toLocaleDateString()}
          </span>
          <button
            type="button"
            onClick={() => setEditing(true)}
            style={{
              alignSelf: "flex-start",
              marginTop: "4px",
              padding: "6px 10px",
              fontFamily: "var(--rm-font-display)",
              fontSize: "11px",
              fontWeight: 600,
              color: "var(--rm-ink)",
              background: "transparent",
              border: "1px solid var(--rm-border)",
              borderRadius: "6px",
              cursor: "pointer",
            }}
          >
            Update
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <div>
            <label style={labelStyle}>CNIC</label>
            <input
              type="text"
              placeholder="12345-1234567-1"
              value={cnic}
              onChange={(e) => setCnic(e.target.value)}
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Vehicle plate</label>
            <input
              type="text"
              placeholder="ISB-1234"
              value={plate}
              onChange={(e) => setPlate(e.target.value)}
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Make/model (optional)</label>
            <input
              type="text"
              placeholder="Suzuki Cultus, white"
              value={makeModel}
              onChange={(e) => setMakeModel(e.target.value)}
              style={inputStyle}
            />
          </div>
          {formError && <span style={{ fontSize: "12px", color: "var(--rm-danger)" }}>{formError}</span>}
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              style={{
                flex: 1,
                padding: "10px 12px",
                fontFamily: "var(--rm-font-display)",
                fontSize: "12px",
                fontWeight: 600,
                color: "var(--rm-signal-ink)",
                background: "var(--rm-signal)",
                border: "none",
                borderRadius: "8px",
                cursor: saving ? "wait" : "pointer",
              }}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            {saved && (
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setFormError(null);
                }}
                style={{
                  flex: 1,
                  padding: "10px 12px",
                  fontFamily: "var(--rm-font-display)",
                  fontSize: "12px",
                  fontWeight: 600,
                  color: "var(--rm-ink)",
                  background: "transparent",
                  border: "1px solid var(--rm-border)",
                  borderRadius: "8px",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
