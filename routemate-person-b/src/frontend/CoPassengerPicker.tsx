/* Flexible Ride-Pooling Capacity Picker — how many co-riders the user will share with. */

export interface CoPassengerOption {
  label: string;
  sublabel: string;
  icon: string;
  value: number; // 1 = up to 1, 3 = up to 3, -1 = no limit
}

export const CO_PASSENGER_OPTIONS: CoPassengerOption[] = [
  { label: "Up to 1 other", sublabel: "Max 1 co-rider", icon: "👥", value: 1 },
  { label: "Up to 3 others", sublabel: "Standard pool", icon: "👨‍👩‍👧‍👦", value: 3 },
  { label: "No limit", sublabel: "Full pool open", icon: "♾️", value: -1 },
];

interface CoPassengerPickerProps {
  value: number; // max_co_passengers
  onChange: (value: number) => void;
  /** Section question. Defaults to the passenger phrasing; drivers get
   *  "How many passengers are you willing to take?" from the search form. */
  question?: string;
}

export default function CoPassengerPicker({ value, onChange, question }: CoPassengerPickerProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontFamily: "var(--rm-font-body)" }}>
      <label
        style={{
          fontSize: "11px",
          fontWeight: 600,
          color: "var(--rm-ink-soft)",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        {question ?? "How many people are you okay sharing with?"}
      </label>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
          gap: "8px",
        }}
      >
        {CO_PASSENGER_OPTIONS.map((opt) => {
          const isSelected = value === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                gap: "4px",
                padding: "10px 12px",
                background: isSelected ? "var(--rm-paper-raised)" : "var(--rm-paper)",
                border: `1.5px solid ${isSelected ? "var(--rm-signal)" : "var(--rm-border)"}`,
                borderRadius: "var(--rm-radius)",
                cursor: "pointer",
                textAlign: "left",
                boxShadow: isSelected ? "0 2px 8px rgba(242,183,5,0.2)" : "none",
                transition: "all 0.15s ease",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "6px", width: "100%" }}>
                <span style={{ fontSize: "14px" }}>{opt.icon}</span>
                <span
                  style={{
                    fontSize: "12px",
                    fontWeight: 600,
                    fontFamily: "var(--rm-font-display)",
                    color: "var(--rm-ink)",
                  }}
                >
                  {opt.label}
                </span>
              </div>
              <span style={{ fontSize: "10px", color: "var(--rm-ink-soft)" }}>{opt.sublabel}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
