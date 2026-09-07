/* Changed: Added a primary role toggle (offering a ride vs. looking for one)
   that adapts the vehicle/safety sections to the chosen role, Islamabad /
   Rawalpindi service-area validation with inline out-of-region errors, and
   graceful geocoding-failure messaging — on top of the interactive map
   pinning, departure time selector and flexible window options. */
import { useEffect, useRef, useState } from "react";
import { searchPlaces, PlaceSuggestion, isWithinServiceArea, SERVICE_AREA_LABEL } from "./places";
import { LocationPoint, Gender, GenderPreference } from "../types";
import InteractiveMapPicker from "./InteractiveMapPicker";
import CoPassengerPicker, { CO_PASSENGER_OPTIONS } from "./CoPassengerPicker";
import { isValidVehiclePlate } from "../vehicleDeclaration";
import type { ParsedTripDraft } from "./NaturalLanguageTripInput";


interface FieldState {
  query: string;
  suggestions: PlaceSuggestion[];
  open: boolean;
  loading: boolean;
  selected: LocationPoint | null;
  /** Set when the geocoding service itself failed (network error) —
   *  surfaced inline instead of failing silently. */
  geocodeError: string | null;
}

const emptyField: FieldState = {
  query: "",
  suggestions: [],
  open: false,
  loading: false,
  selected: null,
  geocodeError: null,
};

function SectorChip({ code }: { code: string }) {
  return (
    <span
      style={{
        fontFamily: "var(--rm-font-display)",
        fontSize: "11px",
        fontWeight: 600,
        letterSpacing: "0.02em",
        color: "var(--rm-ink)",
        background: "var(--rm-paper)",
        border: "1px solid var(--rm-border)",
        borderRadius: "4px",
        padding: "1px 6px",
      }}
    >
      {code}
    </span>
  );
}

function LocationField({
  label,
  placeholder,
  accentColor,
  value,
  onChange,
  onOpenMap,
  error,
}: {
  label: string;
  placeholder: string;
  accentColor: string;
  value: FieldState;
  onChange: (next: FieldState) => void;
  onOpenMap?: () => void;
  /** Inline validation error for the SELECTED point (e.g. out-of-region) —
   *  rendered under the input so search can be blocked with a clear reason. */
  error?: string | null;
}) {
  const abortRef = useRef<AbortController | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        onChange({ ...value, open: false });
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  async function handleInput(text: string) {
    onChange({ ...value, query: text, selected: null, open: true, loading: text.trim().length >= 2, geocodeError: null });

    abortRef.current?.abort();
    if (text.trim().length < 2) {
      onChange({ ...value, query: text, suggestions: [], selected: null, open: false, loading: false, geocodeError: null });
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const results = await searchPlaces(text, controller.signal);
      onChange({ query: text, suggestions: results, open: true, loading: false, selected: null, geocodeError: null });
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        // Geocoding failed (network/service) — say so instead of silently
        // showing an empty dropdown, so the user knows to retry.
        onChange({
          query: text,
          suggestions: [],
          open: true,
          loading: false,
          selected: null,
          geocodeError: "Couldn't reach the address search service — check your connection and try again.",
        });
      }
    }
  }

  function selectSuggestion(s: PlaceSuggestion) {
    onChange({ query: s.label, suggestions: [], open: false, loading: false, selected: s.point, geocodeError: null });
  }

  return (
    <div ref={wrapRef} style={{ position: "relative", fontFamily: "var(--rm-font-body)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            fontSize: "12px",
            fontWeight: 600,
            color: "var(--rm-ink-soft)",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          <span
            style={{
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              background: accentColor,
              display: "inline-block",
            }}
          />
          {label}
        </label>

        {onOpenMap && (
          <button
            type="button"
            onClick={onOpenMap}
            style={{
              fontSize: "11px",
              fontFamily: "var(--rm-font-display)",
              color: "var(--rm-route-blue)",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: 0,
              textDecoration: "underline",
            }}
          >
            🗺️ Pick on map
          </button>
        )}
      </div>

      <input
        value={value.query}
        placeholder={placeholder}
        onChange={(e) => handleInput(e.target.value)}
        onFocus={() => onChange({ ...value, open: value.suggestions.length > 0 })}
        style={{
          width: "100%",
          boxSizing: "border-box",
          padding: "12px 14px",
          fontSize: "15px",
          fontFamily: "var(--rm-font-body)",
          color: "var(--rm-ink)",
          background: "var(--rm-paper-raised)",
          border: `1.5px solid ${value.selected ? accentColor : "var(--rm-border)"}`,
          borderRadius: "var(--rm-radius)",
          outline: "none",
        }}
      />

      {/* Inline validation for the selected point — most importantly the
          out-of-region error, which must block search with a clear reason. */}
      {error && (
        <div
          role="alert"
          style={{
            marginTop: "6px",
            fontSize: "12px",
            lineHeight: "1.45",
            color: "var(--rm-danger)",
            background: "var(--rm-paper-raised)",
            border: "1px solid var(--rm-danger)",
            borderRadius: "6px",
            padding: "8px 10px",
          }}
        >
          ⚠️ {error}
        </div>
      )}
      {value.geocodeError && !value.loading && (
        <div role="alert" style={{ marginTop: "6px", fontSize: "12px", color: "var(--rm-danger)", lineHeight: "1.45" }}>
          ⚠️ {value.geocodeError}
        </div>
      )}

      {value.open && (value.loading || value.suggestions.length > 0) && (
        <div
          style={{
            position: "absolute",
            zIndex: 20,
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            background: "var(--rm-paper-raised)",
            border: "1px solid var(--rm-border)",
            borderRadius: "var(--rm-radius)",
            boxShadow: "0 8px 24px rgba(27,31,39,0.12)",
            overflow: "hidden",
          }}
        >
          {value.loading && (
            <div style={{ padding: "12px 14px", fontSize: "13px", color: "var(--rm-ink-soft)" }}>Searching…</div>
          )}
          {!value.loading &&
            value.suggestions.map((s, i) => (
              <button
                key={i}
                onClick={() => selectSuggestion(s)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "10px",
                  width: "100%",
                  textAlign: "left",
                  padding: "10px 14px",
                  background: "transparent",
                  border: "none",
                  borderBottom: i < value.suggestions.length - 1 ? "1px solid var(--rm-border)" : "none",
                  cursor: "pointer",
                  fontSize: "14px",
                  color: "var(--rm-ink)",
                }}
                onMouseDown={(e) => e.preventDefault()}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.label}</span>
                {s.sectorCode && <SectorChip code={s.sectorCode} />}
              </button>
            ))}
          {!value.loading && value.suggestions.length === 0 && (
            <div style={{ padding: "12px 14px", fontSize: "13px", color: "var(--rm-ink-soft)" }}>
              No addresses found within {SERVICE_AREA_LABEL} — try another name or pick on the map.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export type UserRole = "OFFERING" | "LOOKING";

export interface TripSearchValue {
  /** Primary role — offering a seat (driver/host) or looking for a ride
   *  (passenger). Drives which options the form shows below and how the
   *  match pipeline treats this request's vehicle declaration. */
  userRole: UserRole;
  origin: LocationPoint;
  destination: LocationPoint;
  departureTime: string;
  flexibilityMinutes: number;
  maxCoPassengers: number;
  // Day 7 Safety & Trust
  genderPreference: GenderPreference;
  /** Passenger-only safety option — never sent when userRole is OFFERING
   *  (a driver doesn't need protection from themselves as the driver). */
  requireDriverGenderMatch: boolean;
  verifiedOnly: boolean;
  // Mode A (OFFERING) sends "car" | "bike" — the vehicle this driver is
  // offering seats in. Mode B (LOOKING) sends "none" (join a registered
  // driver's car/bike) or "ride_hailing" (split a Yango/inDrive cab, where
  // nobody owns the vehicle — see resolveVehicleRoles in matchPipeline.ts).
  vehicleType: "none" | "car" | "bike" | "ride_hailing";
  /** Only meaningful when vehicleType === "ride_hailing" — the total
   *  fare (PKR) already quoted by the ride-hailing app. */
  rideHailingFarePkr?: number;
  /** OFFERING only — total physical seats the driver can offer. */
  seatsAvailable?: number;
  /** OFFERING only — self-declared vehicle details for passenger transparency.
   *  CNIC is collected at signup; optional here if the driver wants to re-confirm. */
  vehicleDeclaration?: {
    cnic?: string;
    plate: string;
    makeModel: string;
  };
}

export default function LocationSearchForm({
  onSubmit,
  defaultMaxCoPassengers = 3,
  currentUserGender,
  initialUserRole = "LOOKING",
  draft,
}: {
  onSubmit: (value: TripSearchValue) => void;
  defaultMaxCoPassengers?: number;
  currentUserGender?: Gender;
  /** Prefill from signup (driver vs passenger). */
  initialUserRole?: UserRole;
  draft?: ParsedTripDraft | null;
}) {
  const [pickup, setPickup] = useState<FieldState>(emptyField);
  const [dropoff, setDropoff] = useState<FieldState>(emptyField);
  const [userRole, setUserRole] = useState<UserRole>(initialUserRole);
  const [departureTime, setDepartureTime] = useState<string>(() => {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  });
  const [flexibilityMinutes, setFlexibilityMinutes] = useState<number>(60);
  const [maxCoPassengers, setMaxCoPassengers] = useState<number>(defaultMaxCoPassengers);
  const [genderPreference, setGenderPreference] = useState<GenderPreference>("any");
  const [requireDriverGenderMatch, setRequireDriverGenderMatch] = useState<boolean>(false);
  const [verifiedOnly, setVerifiedOnly] = useState<boolean>(false);
  const [vehicleType, setVehicleType] = useState<"none" | "car" | "bike" | "ride_hailing">(
    initialUserRole === "OFFERING" ? "car" : "none"
  );
  const [rideHailingFareInput, setRideHailingFareInput] = useState<string>("");
  // OFFERING-only — seat count picked with the 1/2/3/4+ buttons (bikes
  // always carry exactly one passenger, handled at submit time).
  const [seatsAvailable, setSeatsAvailable] = useState<number>(2);
  const [vehiclePlate, setVehiclePlate] = useState("");
  const [vehicleMakeModel, setVehicleMakeModel] = useState("");
  const [showMap, setShowMap] = useState<boolean>(false);
  const [mapTargetMode, setMapTargetMode] = useState<"pickup" | "dropoff">("pickup");

  useEffect(() => {
    if (!draft) return;
    if (draft.origin) {
      setPickup({
        query: draft.origin.address_label,
        suggestions: [],
        open: false,
        loading: false,
        selected: draft.origin,
        geocodeError: null,
      });
    }
    if (draft.destination) {
      setDropoff({
        query: draft.destination.address_label,
        suggestions: [],
        open: false,
        loading: false,
        selected: draft.destination,
        geocodeError: null,
      });
    }
    if (draft.requested_departure_at) {
      try {
        const d = new Date(draft.requested_departure_at);
        if (!isNaN(d.getTime())) {
          setDepartureTime(
            `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
          );
        }
      } catch {
        /* ignore */
      }
    }
    if (draft.window_minutes) {
      setFlexibilityMinutes(draft.window_minutes);
    }
    if (draft.preference) {
      setGenderPreference(draft.preference);
    }
    if (draft.require_driver_gender_match !== undefined) {
      setRequireDriverGenderMatch(draft.require_driver_gender_match);
    }
  }, [draft]);

  const rideHailingFarePkr = Number(rideHailingFareInput);
  const rideHailingFareValid = rideHailingFareInput.trim() !== "" && rideHailingFarePkr > 0;

  // ── Service-area validation ─────────────────────────────────────
  // Both endpoints must sit inside the Islamabad / Rawalpindi operational
  // boundary before a search may run; a violation renders an inline field
  // error and keeps the submit button disabled.
  const pickupOutOfRegion =
    !!pickup.selected && !isWithinServiceArea(pickup.selected.lat, pickup.selected.lng);
  const dropoffOutOfRegion =
    !!dropoff.selected && !isWithinServiceArea(dropoff.selected.lat, dropoff.selected.lng);
  const OUT_OF_REGION_MESSAGE = `Out of Region: RouteSync is currently only available within ${SERVICE_AREA_LABEL}.`;

  // Seat count is button-driven (1/2/3/4+), so it always holds a valid
  // value — no extra validation is needed for submission.
  const offeringVehicleOk =
    userRole !== "OFFERING" ||
    (isValidVehiclePlate(vehiclePlate) && vehicleMakeModel.trim().length >= 2);

  const canSubmit =
    !!pickup.selected &&
    !!dropoff.selected &&
    !pickupOutOfRegion &&
    !dropoffOutOfRegion &&
    (vehicleType !== "ride_hailing" || rideHailingFareValid) &&
    offeringVehicleOk;

  /** Switching roles resets every option that belongs to the other mode:
   *  the "require female driver" filter and the cab-split fare are
   *  passenger-only concepts, drivers always start on their own car, and
   *  passengers always start on join-a-driver. */
  function handleRoleChange(role: UserRole) {
    setUserRole(role);
    if (role === "OFFERING") {
      setRequireDriverGenderMatch(false);
      setRideHailingFareInput("");
      setVehicleType("car");
    } else {
      setVehicleType("none");
    }
  }

  function handleMapSelect(mode: "pickup" | "dropoff", s: PlaceSuggestion) {
    const next: FieldState = {
      query: s.label,
      suggestions: [],
      open: false,
      loading: false,
      selected: s.point,
      geocodeError: null,
    };
    if (mode === "pickup") {
      setPickup(next);
    } else {
      setDropoff(next);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "16px",
        padding: "20px",
        background: "var(--rm-paper)",
        borderRadius: "calc(var(--rm-radius) + 4px)",
        border: "1px solid var(--rm-border)",
      }}
    >
      {/* Primary Role Toggle — offering a seat vs. looking for one. Every
          section below adapts to this choice so the two flows never mix. */}
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <label
          style={{
            fontSize: "11px",
            fontWeight: 600,
            color: "var(--rm-ink-soft)",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          I am…
        </label>
        <div style={{ display: "flex", gap: "8px" }}>
          {(
            [
              { role: "OFFERING", icon: "🚗", label: "Offering a Ride", sub: "Driver / Host" },
              { role: "LOOKING", icon: "🔍", label: "Looking for a Ride", sub: "Passenger" },
            ] as { role: UserRole; icon: string; label: string; sub: string }[]
          ).map((opt) => {
            const selected = userRole === opt.role;
            return (
              <button
                key={opt.role}
                type="button"
                aria-pressed={selected}
                onClick={() => handleRoleChange(opt.role)}
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: "3px",
                  padding: "10px 12px",
                  fontFamily: "var(--rm-font-display)",
                  fontSize: "12px",
                  fontWeight: 600,
                  textAlign: "left",
                  color: selected ? "var(--rm-signal-ink)" : "var(--rm-ink-soft)",
                  background: selected ? "var(--rm-signal)" : "var(--rm-paper-raised)",
                  border: `1.5px solid ${selected ? "var(--rm-signal)" : "var(--rm-border)"}`,
                  borderRadius: "6px",
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                }}
              >
                <span>
                  {opt.icon} {opt.label}
                </span>
                <span style={{ fontSize: "10px", fontWeight: 500, opacity: 0.85 }}>{opt.sub}</span>
              </button>
            );
          })}
        </div>
      </div>

      <LocationField
        label="Pickup"
        placeholder="e.g. F-10 Markaz"
        accentColor="var(--rm-route-blue)"
        value={pickup}
        onChange={setPickup}
        error={pickupOutOfRegion ? OUT_OF_REGION_MESSAGE : null}
        onOpenMap={() => {
          setMapTargetMode("pickup");
          setShowMap(true);
        }}
      />
      <LocationField
        label="Drop-off"
        placeholder="e.g. NUST Gate 1"
        accentColor="var(--rm-route-purple)"
        value={dropoff}
        onChange={setDropoff}
        error={dropoffOutOfRegion ? OUT_OF_REGION_MESSAGE : null}
        onOpenMap={() => {
          setMapTargetMode("dropoff");
          setShowMap(true);
        }}
      />

      {/* Interactive Map Collapsible Picker */}
      {showMap && (
        <InteractiveMapPicker
          activeMode={mapTargetMode}
          pickupPoint={pickup.selected}
          dropoffPoint={dropoff.selected}
          onSelectPoint={handleMapSelect}
          onClose={() => setShowMap(false)}
        />
      )}

      {/* Co-passenger sharing prefs — passengers only. Drivers already
          pick capacity via Available Seats below. */}
      {userRole === "LOOKING" && (
        <div style={{ paddingTop: "4px", borderTop: "1px dashed var(--rm-border)" }}>
          <CoPassengerPicker value={maxCoPassengers} onChange={setMaxCoPassengers} />
        </div>
      )}

      {/* Day 7: Safety & Trust preferences */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "10px",
          paddingTop: "4px",
          borderTop: "1px dashed var(--rm-border)",
        }}
      >
        <label
          style={{
            fontSize: "11px",
            fontWeight: 600,
            color: "var(--rm-ink-soft)",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          {userRole === "OFFERING"
            ? "Who are you comfortable taking in your vehicle?"
            : "Who are you comfortable sharing with?"}
        </label>
        <div style={{ display: "flex", gap: "6px" }}>
          {(
            [
              { label: "Anyone", val: "any" },
              { label: "Women only", val: "female_only" },
              { label: "Men only", val: "male_only" },
            ] as { label: string; val: GenderPreference }[]
          ).map((opt) => {
            const selected = genderPreference === opt.val;
            return (
              <button
                key={opt.val}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  setGenderPreference(opt.val);
                  if (opt.val !== "female_only") setRequireDriverGenderMatch(false);
                }}
                style={{
                  flex: 1,
                  padding: "10px 6px",
                  fontSize: "11px",
                  fontFamily: "var(--rm-font-display)",
                  fontWeight: 600,
                  color: selected
                    ? opt.val === "female_only"
                      ? "var(--rm-paper-raised)"
                      : "var(--rm-signal-ink)"
                    : "var(--rm-ink-soft)",
                  background: selected
                    ? opt.val === "female_only"
                      ? "var(--rm-women-only)"
                      : "var(--rm-signal)"
                    : "var(--rm-paper-raised)",
                  border: `1px solid ${
                    selected
                      ? opt.val === "female_only"
                        ? "var(--rm-women-only)"
                        : "var(--rm-signal)"
                      : "var(--rm-border)"
                  }`,
                  borderRadius: "6px",
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                }}
              >
                {opt.val === "female_only" ? "♀ " : ""}
                {opt.label}
              </button>
            );
          })}
        </div>

        {/* Extra safety option: passenger-only, and only meaningful for
            women choosing women-only. Drivers never see it — they ARE the
            ride owner, so the question doesn't apply to them. */}
        {userRole === "LOOKING" && genderPreference === "female_only" && currentUserGender === "female" && (
          <label
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "8px",
              fontSize: "12px",
              color: "var(--rm-ink)",
              background: "var(--rm-women-only-tint)",
              border: "1px solid var(--rm-women-only)",
              borderRadius: "8px",
              padding: "10px 12px",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={requireDriverGenderMatch}
              onChange={(e) => setRequireDriverGenderMatch(e.target.checked)}
              style={{ marginTop: "1px" }}
            />
            <span>
              Also require the ride owner / driver to be female
              <span style={{ display: "block", fontSize: "11px", color: "var(--rm-ink-soft)" }}>
                Filters out rides owned by men, even with female co-passengers.
              </span>
            </span>
          </label>
        )}

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            fontSize: "12px",
            color: "var(--rm-ink)",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={verifiedOnly}
            onChange={(e) => setVerifiedOnly(e.target.checked)}
          />
          <span>
            Show <span style={{ color: "var(--rm-verified)", fontWeight: 600 }}>✓ Verified</span> university students only
          </span>
        </label>

        {/* Mode A (OFFERING): the driver describes the vehicle they're
            offering — type and seat capacity. Mode B (LOOKING): pick
            between joining a registered vehicle owner or splitting a
            ride-hailing cab. The two modes never show each other's
            controls. */}
        {userRole === "OFFERING" ? (
          <div>
            <span
              style={{
                display: "block",
                fontSize: "12px",
                color: "var(--rm-ink)",
                marginBottom: "6px",
              }}
            >
              Vehicle Type
            </span>
            <div style={{ display: "flex", gap: "6px" }}>
              {(
                [
                  { value: "car", label: "🚗 Car" },
                  { value: "bike", label: "🏍️ Bike" },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setVehicleType(opt.value)}
                  aria-pressed={vehicleType === opt.value}
                  style={{
                    flex: 1,
                    padding: "8px 10px",
                    borderRadius: "6px",
                    border: `1px solid ${vehicleType === opt.value ? "var(--rm-accent)" : "var(--rm-border)"}`,
                    background: vehicleType === opt.value ? "var(--rm-accent)" : "transparent",
                    color: "var(--rm-ink)",
                    fontFamily: "var(--rm-font-body)",
                    fontSize: "12px",
                    fontWeight: vehicleType === opt.value ? 600 : 400,
                    cursor: "pointer",
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {vehicleType === "bike" ? (
              <span style={{ display: "block", fontSize: "11px", color: "var(--rm-ink-soft)", marginTop: "6px" }}>
                Bikes carry exactly one passenger.
              </span>
            ) : (
              <div style={{ marginTop: "10px" }}>
                <span
                  style={{
                    display: "block",
                    fontSize: "12px",
                    color: "var(--rm-ink)",
                    marginBottom: "6px",
                  }}
                >
                  Available Seats
                </span>
                <div style={{ display: "flex", gap: "6px" }}>
                  {(
                    [
                      { value: 1, label: "1 Seat" },
                      { value: 2, label: "2 Seats" },
                      { value: 3, label: "3 Seats" },
                      { value: 4, label: "4+ Seats" },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setSeatsAvailable(opt.value)}
                      aria-pressed={seatsAvailable === opt.value}
                      style={{
                        flex: 1,
                        padding: "8px 4px",
                        borderRadius: "6px",
                        border: `1px solid ${seatsAvailable === opt.value ? "var(--rm-accent)" : "var(--rm-border)"}`,
                        background: seatsAvailable === opt.value ? "var(--rm-accent)" : "transparent",
                        color: "var(--rm-ink)",
                        fontFamily: "var(--rm-font-body)",
                        fontSize: "12px",
                        fontWeight: seatsAvailable === opt.value ? 600 : 400,
                        cursor: "pointer",
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div
              style={{
                marginTop: "12px",
                paddingTop: "12px",
                borderTop: "1px dashed var(--rm-border)",
                display: "flex",
                flexDirection: "column",
                gap: "10px",
              }}
            >
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: 600,
                  color: "var(--rm-ink-soft)",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                }}
              >
                Vehicle details (shown to passengers)
              </span>
              <p style={{ margin: 0, fontSize: "12px", color: "var(--rm-ink-soft)", lineHeight: 1.4 }}>
                Plate and make/model are shown to passengers. Your CNIC from signup is reused
                privately and never shown on match cards.
              </p>
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: "12px",
                    color: "var(--rm-ink)",
                    marginBottom: "4px",
                  }}
                >
                  Plate number
                </label>
                <input
                  value={vehiclePlate}
                  onChange={(e) => setVehiclePlate(e.target.value.toUpperCase())}
                  placeholder="e.g. ISB-1234"
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "10px 12px",
                    borderRadius: "8px",
                    border: "1px solid var(--rm-border)",
                    background: "var(--rm-paper-raised)",
                    color: "var(--rm-ink)",
                    fontFamily: "var(--rm-font-body)",
                    fontSize: "14px",
                  }}
                />
              </div>
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: "12px",
                    color: "var(--rm-ink)",
                    marginBottom: "4px",
                  }}
                >
                  Make / model
                </label>
                <input
                  value={vehicleMakeModel}
                  onChange={(e) => setVehicleMakeModel(e.target.value)}
                  placeholder="e.g. Toyota Vitz white"
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "10px 12px",
                    borderRadius: "8px",
                    border: "1px solid var(--rm-border)",
                    background: "var(--rm-paper-raised)",
                    color: "var(--rm-ink)",
                    fontFamily: "var(--rm-font-body)",
                    fontSize: "14px",
                  }}
                />
              </div>
            </div>
          </div>
        ) : (
          <div>
            <span
              style={{
                display: "block",
                fontSize: "12px",
                color: "var(--rm-ink)",
                marginBottom: "6px",
              }}
            >
              How do you want to ride?
            </span>
            <div style={{ display: "flex", gap: "6px" }}>
              {(
                [
                  {
                    value: "join_driver",
                    label: "Join a Driver's Car/Bike",
                    sub: "Match with registered vehicle owners",
                  },
                  {
                    value: "split_cab",
                    label: "Split a Yango/inDrive Cab",
                    sub: "Enter your fare quote — split by km each person rides",
                  },
                ] as const
              ).map((opt) => {
                const active =
                  opt.value === "join_driver" ? vehicleType === "none" : vehicleType === "ride_hailing";
                return (
                  <button
                    key={opt.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setVehicleType(opt.value === "join_driver" ? "none" : "ride_hailing")}
                    style={{
                      flex: 1,
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      gap: "3px",
                      padding: "10px 12px",
                      borderRadius: "6px",
                      border: `1.5px solid ${active ? "var(--rm-accent)" : "var(--rm-border)"}`,
                      background: active ? "var(--rm-accent)" : "transparent",
                      color: "var(--rm-ink)",
                      fontFamily: "var(--rm-font-body)",
                      fontSize: "12px",
                      fontWeight: active ? 600 : 400,
                      textAlign: "left",
                      cursor: "pointer",
                    }}
                  >
                    <span>
                      {opt.value === "join_driver" ? "🚗" : "🚕"} {opt.label}
                    </span>
                    <span style={{ fontSize: "10px", fontWeight: 500, opacity: 0.85 }}>{opt.sub}</span>
                  </button>
                );
              })}
            </div>
            {vehicleType === "ride_hailing" && (
              <div style={{ marginTop: "8px" }}>
                <span style={{ display: "block", fontSize: "11px", color: "var(--rm-ink-soft)", marginBottom: "4px" }}>
                  Enter the total fare Yango/inDrive/Careem quoted for this trip. RouteSync divides it
                  by how many km each person rides (longer ride → larger share). You still settle up
                  outside the app.
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <span style={{ fontSize: "13px", color: "var(--rm-ink-soft)" }}>Rs</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={1}
                    step={1}
                    placeholder="e.g. 900"
                    value={rideHailingFareInput}
                    onChange={(e) => setRideHailingFareInput(e.target.value)}
                    style={{
                      flex: 1,
                      padding: "8px 10px",
                      fontSize: "13px",
                      fontFamily: "var(--rm-font-display)",
                      color: "var(--rm-ink)",
                      background: "var(--rm-paper-raised)",
                      border: `1px solid ${
                        rideHailingFareInput.trim() !== "" && !rideHailingFareValid
                          ? "var(--rm-danger)"
                          : "var(--rm-border)"
                      }`,
                      borderRadius: "6px",
                      outline: "none",
                    }}
                  />
                </div>
                {rideHailingFareInput.trim() !== "" && !rideHailingFareValid && (
                  <span style={{ display: "block", fontSize: "11px", color: "var(--rm-danger)", marginTop: "4px" }}>
                    Enter the fare the ride-hailing app quoted you (must be more than 0).
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Departure Time & Time Window Section */}
      <div
        style={{
          display: "flex",
          gap: "12px",
          flexWrap: "wrap",
          paddingTop: "4px",
          borderTop: "1px dashed var(--rm-border)",
        }}
      >
        {/* Time Input */}
        <div style={{ flex: "1 1 140px" }}>
          <label
            style={{
              display: "block",
              fontSize: "11px",
              fontWeight: 600,
              color: "var(--rm-ink-soft)",
              marginBottom: "6px",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            Departure Time
          </label>
          <input
            type="time"
            value={departureTime}
            onChange={(e) => setDepartureTime(e.target.value)}
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "10px 12px",
              fontSize: "14px",
              fontFamily: "var(--rm-font-display)",
              color: "var(--rm-ink)",
              background: "var(--rm-paper-raised)",
              border: "1px solid var(--rm-border)",
              borderRadius: "var(--rm-radius)",
              outline: "none",
            }}
          />
        </div>

        {/* Flexibility Selector */}
        <div style={{ flex: "1 1 180px" }}>
          <label
            style={{
              display: "block",
              fontSize: "11px",
              fontWeight: 600,
              color: "var(--rm-ink-soft)",
              marginBottom: "6px",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            Flexible Time Window
          </label>
          <div style={{ display: "flex", gap: "6px" }}>
            {[
              { label: "Exact", val: 0 },
              { label: "±15m", val: 15 },
              { label: "±30m", val: 30 },
              { label: "±45m", val: 45 },
              { label: "±60m", val: 60 },
            ].map((opt) => (
              <button
                key={opt.val}
                type="button"
                onClick={() => setFlexibilityMinutes(opt.val)}
                style={{
                  flex: 1,
                  padding: "10px 4px",
                  fontSize: "11px",
                  fontFamily: "var(--rm-font-display)",
                  fontWeight: 600,
                  color: flexibilityMinutes === opt.val ? "var(--rm-signal-ink)" : "var(--rm-ink-soft)",
                  background: flexibilityMinutes === opt.val ? "var(--rm-signal)" : "var(--rm-paper-raised)",
                  border: `1px solid ${flexibilityMinutes === opt.val ? "var(--rm-signal)" : "var(--rm-border)"}`,
                  borderRadius: "6px",
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <button
        disabled={!canSubmit}
        onClick={() =>
          canSubmit &&
          onSubmit({
            userRole,
            origin: pickup.selected!,
            destination: dropoff.selected!,
            departureTime,
            flexibilityMinutes,
            maxCoPassengers,
            genderPreference,
            // "Require female driver" is a passenger-side filter; drivers
            // offering their own vehicle never see or send it.
            requireDriverGenderMatch: userRole === "LOOKING" ? requireDriverGenderMatch : false,
            verifiedOnly,
            vehicleType,
            rideHailingFarePkr: vehicleType === "ride_hailing" ? rideHailingFarePkr : undefined,
            // OFFERING-only: bikes always offer exactly one seat.
            seatsAvailable: userRole === "OFFERING" ? (vehicleType === "bike" ? 1 : seatsAvailable) : undefined,
            vehicleDeclaration:
              userRole === "OFFERING"
                ? {
                    plate: vehiclePlate.trim(),
                    makeModel: vehicleMakeModel.trim(),
                  }
                : undefined,
          })
        }
        style={{
          marginTop: "4px",
          padding: "13px 16px",
          fontFamily: "var(--rm-font-display)",
          fontWeight: 600,
          fontSize: "13px",
          letterSpacing: "0.03em",
          textTransform: "uppercase",
          color: "var(--rm-signal-ink)",
          background: canSubmit ? "var(--rm-signal)" : "var(--rm-border)",
          border: "none",
          borderRadius: "var(--rm-radius)",
          cursor: canSubmit ? "pointer" : "not-allowed",
          transition: "background 0.15s ease",
        }}
      >
        {userRole === "OFFERING" ? "POST A RIDE" : "FIND A RIDE MATCH"}
      </button>
    </div>
  );
}

