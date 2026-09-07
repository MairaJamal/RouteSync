/* First-open login / signup gate for drivers and passengers. */
import { useState, FormEvent, CSSProperties } from "react";
import { Gender } from "../types";
import { UserRole } from "./LocationSearchForm";
import { signIn, signUp, AuthUserSession, IdDocumentType } from "./demoAuth";
import { isValidPakistaniCnic, isValidVehiclePlate } from "../vehicleDeclaration";

type Mode = "signin" | "signup";

export default function AuthScreen({
  onSuccess,
}: {
  onSuccess: (session: AuthUserSession) => void;
}) {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [gender, setGender] = useState<Gender>("female");
  const [role, setRole] = useState<UserRole>("LOOKING");
  const [cnic, setCnic] = useState("");
  const [idDocumentType, setIdDocumentType] = useState<IdDocumentType>("university_card");
  const [institutionName, setInstitutionName] = useState("");
  const [cardNumber, setCardNumber] = useState("");
  const [vehiclePlate, setVehiclePlate] = useState("");
  const [vehicleMakeModel, setVehicleMakeModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (mode === "signup") {
      if (!isValidPakistaniCnic(cnic)) {
        setError("Enter a valid CNIC (12345-1234567-1).");
        return;
      }
      if (institutionName.trim().length < 2) {
        setError(
          idDocumentType === "university_card"
            ? "Enter your university name."
            : "Enter your office / organization name."
        );
        return;
      }
      if (role === "OFFERING") {
        if (!isValidVehiclePlate(vehiclePlate)) {
          setError("Enter a valid vehicle plate (e.g. ICT-1234 or LEA-12-3456).");
          return;
        }
        if (vehicleMakeModel.trim().length < 2) {
          setError("Enter vehicle make and model (e.g. Toyota Corolla).");
          return;
        }
      }
    }

    setBusy(true);
    try {
      const session =
        mode === "signin"
          ? await signIn(email.trim(), password)
          : await signUp({
              email: email.trim(),
              password,
              displayName: displayName.trim(),
              phone: phone.trim(),
              gender,
              preferredRole: role,
              identity: {
                cnicNumber: cnic.trim(),
                idDocumentType,
                institutionName: institutionName.trim(),
                cardNumber: cardNumber.trim() || undefined,
              },
              vehicle:
                role === "OFFERING"
                  ? {
                      plate: vehiclePlate.trim(),
                      makeModel: vehicleMakeModel.trim(),
                    }
                  : undefined,
            });
      onSuccess(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const inputStyle: CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: "10px 12px",
    borderRadius: "8px",
    border: "1px solid var(--rm-border)",
    background: "var(--rm-paper)",
    color: "var(--rm-ink)",
    fontFamily: "var(--rm-font-body)",
    fontSize: "14px",
  };

  const labelStyle: CSSProperties = {
    fontSize: "11px",
    fontWeight: 600,
    color: "var(--rm-ink-soft)",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    marginBottom: "4px",
    display: "block",
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--rm-paper)",
        color: "var(--rm-ink)",
        fontFamily: "var(--rm-font-body)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px 16px",
      }}
    >
      <div style={{ width: "100%", maxWidth: "420px" }}>
        <div style={{ textAlign: "center", marginBottom: "28px" }}>
          <div
            style={{
              width: "48px",
              height: "48px",
              borderRadius: "12px",
              background: "var(--rm-signal)",
              color: "var(--rm-signal-ink)",
              fontFamily: "var(--rm-font-display)",
              fontWeight: 700,
              fontSize: "18px",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              marginBottom: "12px",
            }}
          >
            RS
          </div>
          <h1
            style={{
              margin: "0 0 6px",
              fontFamily: "var(--rm-font-display)",
              fontSize: "24px",
              fontWeight: 600,
            }}
          >
            RouteSync
          </h1>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--rm-ink-soft)" }}>
            Sign in to carpool as a driver or passenger
          </p>
        </div>

        <div
          style={{
            background: "var(--rm-paper-raised)",
            border: "1px solid var(--rm-border)",
            borderRadius: "var(--rm-radius)",
            padding: "20px",
          }}
        >
          <div style={{ display: "flex", gap: "6px", marginBottom: "18px" }}>
            {(
              [
                { id: "signin" as const, label: "Sign In" },
                { id: "signup" as const, label: "Sign Up" },
              ] as const
            ).map((tab) => {
              const active = mode === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    setMode(tab.id);
                    setError(null);
                  }}
                  style={{
                    flex: 1,
                    padding: "8px",
                    borderRadius: "8px",
                    border: active ? "1px solid var(--rm-signal)" : "1px solid var(--rm-border)",
                    background: active ? "var(--rm-signal)" : "transparent",
                    color: active ? "var(--rm-signal-ink)" : "var(--rm-ink)",
                    fontFamily: "var(--rm-font-display)",
                    fontSize: "12px",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {mode === "signup" && (
              <>
                <div>
                  <label style={labelStyle}>Full name</label>
                  <input
                    style={inputStyle}
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="e.g. Sara Ali"
                    required
                    autoComplete="name"
                  />
                </div>

                <div>
                  <label style={labelStyle}>I am signing up as</label>
                  <div style={{ display: "flex", gap: "6px" }}>
                    {(
                      [
                        { role: "OFFERING" as const, label: "Driver", sub: "Offering rides" },
                        { role: "LOOKING" as const, label: "Passenger", sub: "Looking for rides" },
                      ] as const
                    ).map((opt) => {
                      const selected = role === opt.role;
                      return (
                        <button
                          key={opt.role}
                          type="button"
                          onClick={() => setRole(opt.role)}
                          style={{
                            flex: 1,
                            padding: "10px 8px",
                            borderRadius: "8px",
                            border: selected
                              ? "1.5px solid var(--rm-signal)"
                              : "1px solid var(--rm-border)",
                            background: selected ? "rgba(242,183,5,0.12)" : "var(--rm-paper)",
                            cursor: "pointer",
                            textAlign: "left",
                          }}
                        >
                          <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--rm-ink)" }}>
                            {opt.label}
                          </div>
                          <div style={{ fontSize: "11px", color: "var(--rm-ink-soft)" }}>{opt.sub}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label style={labelStyle}>Gender</label>
                  <div style={{ display: "flex", gap: "6px" }}>
                    {(
                      [
                        { val: "female" as const, label: "Female" },
                        { val: "male" as const, label: "Male" },
                        { val: "non_binary" as const, label: "Non-binary" },
                      ] as const
                    ).map((opt) => {
                      const selected = gender === opt.val;
                      return (
                        <button
                          key={opt.val}
                          type="button"
                          onClick={() => setGender(opt.val)}
                          style={{
                            flex: 1,
                            padding: "8px",
                            borderRadius: "8px",
                            border: selected
                              ? "1.5px solid var(--rm-signal)"
                              : "1px solid var(--rm-border)",
                            background: selected ? "rgba(242,183,5,0.12)" : "var(--rm-paper)",
                            fontSize: "12px",
                            fontWeight: 600,
                            color: "var(--rm-ink)",
                            cursor: "pointer",
                          }}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label style={labelStyle}>Phone (optional)</label>
                  <input
                    style={inputStyle}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+92 300 1234567"
                    autoComplete="tel"
                  />
                </div>

                <div
                  style={{
                    marginTop: "4px",
                    paddingTop: "12px",
                    borderTop: "1px dashed var(--rm-border)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px",
                  }}
                >
                  <span style={{ ...labelStyle, marginBottom: 0 }}>Identity (required)</span>
                  <p style={{ margin: 0, fontSize: "12px", color: "var(--rm-ink-soft)", lineHeight: 1.4 }}>
                    CNIC and a university or office card — self-declared for trust. Only the last 4
                    digits of your CNIC are ever shown back.
                  </p>

                  <div>
                    <label style={labelStyle}>CNIC</label>
                    <input
                      style={inputStyle}
                      value={cnic}
                      onChange={(e) => setCnic(e.target.value)}
                      placeholder="12345-1234567-1"
                      required
                      inputMode="numeric"
                      autoComplete="off"
                    />
                  </div>

                  <div>
                    <label style={labelStyle}>ID type</label>
                    <div style={{ display: "flex", gap: "6px" }}>
                      {(
                        [
                          { val: "university_card" as const, label: "University card" },
                          { val: "office_card" as const, label: "Office card" },
                        ] as const
                      ).map((opt) => {
                        const selected = idDocumentType === opt.val;
                        return (
                          <button
                            key={opt.val}
                            type="button"
                            onClick={() => setIdDocumentType(opt.val)}
                            style={{
                              flex: 1,
                              padding: "8px",
                              borderRadius: "8px",
                              border: selected
                                ? "1.5px solid var(--rm-signal)"
                                : "1px solid var(--rm-border)",
                              background: selected ? "rgba(242,183,5,0.12)" : "var(--rm-paper)",
                              fontSize: "12px",
                              fontWeight: 600,
                              color: "var(--rm-ink)",
                              cursor: "pointer",
                            }}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <label style={labelStyle}>
                      {idDocumentType === "university_card" ? "University name" : "Office / organization"}
                    </label>
                    <input
                      style={inputStyle}
                      value={institutionName}
                      onChange={(e) => setInstitutionName(e.target.value)}
                      placeholder={
                        idDocumentType === "university_card"
                          ? "e.g. NUST, FAST, Quaid-i-Azam"
                          : "e.g. Jazz, SoftLabs, Ministry of IT"
                      }
                      required
                      autoComplete="organization"
                    />
                  </div>

                  <div>
                    <label style={labelStyle}>Card / ID number (optional)</label>
                    <input
                      style={inputStyle}
                      value={cardNumber}
                      onChange={(e) => setCardNumber(e.target.value)}
                      placeholder="Student or employee ID on the card"
                      autoComplete="off"
                    />
                  </div>
                </div>

                {role === "OFFERING" && (
                  <div
                    style={{
                      marginTop: "4px",
                      paddingTop: "12px",
                      borderTop: "1px dashed var(--rm-border)",
                      display: "flex",
                      flexDirection: "column",
                      gap: "10px",
                    }}
                  >
                    <span style={{ ...labelStyle, marginBottom: 0 }}>
                      Vehicle details (shown to passengers)
                    </span>
                    <p style={{ margin: 0, fontSize: "12px", color: "var(--rm-ink-soft)", lineHeight: 1.4 }}>
                      Plate and make/model help riders confirm they found the right car.
                    </p>
                    <div>
                      <label style={labelStyle}>Number plate</label>
                      <input
                        style={inputStyle}
                        value={vehiclePlate}
                        onChange={(e) => setVehiclePlate(e.target.value.toUpperCase())}
                        placeholder="ICT-1234 or LEA-12-3456"
                        required
                        autoComplete="off"
                      />
                    </div>
                    <div>
                      <label style={labelStyle}>Make &amp; model</label>
                      <input
                        style={inputStyle}
                        value={vehicleMakeModel}
                        onChange={(e) => setVehicleMakeModel(e.target.value)}
                        placeholder="e.g. Toyota Corolla 2018"
                        required
                        autoComplete="off"
                      />
                    </div>
                  </div>
                )}
              </>
            )}

            <div>
              <label style={labelStyle}>Email</label>
              <input
                style={inputStyle}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@university.edu.pk"
                required
                autoComplete="email"
              />
            </div>

            <div>
              <label style={labelStyle}>Password</label>
              <input
                style={inputStyle}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === "signup" ? "At least 6 characters" : "Your password"}
                required
                minLength={6}
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
              />
            </div>

            {error && (
              <div
                style={{
                  fontSize: "13px",
                  color: "var(--rm-danger)",
                  background: "var(--rm-alert-tint)",
                  borderRadius: "8px",
                  padding: "10px 12px",
                }}
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              style={{
                marginTop: "4px",
                padding: "12px",
                borderRadius: "8px",
                border: "none",
                background: "var(--rm-signal)",
                color: "var(--rm-signal-ink)",
                fontFamily: "var(--rm-font-display)",
                fontSize: "13px",
                fontWeight: 600,
                letterSpacing: "0.04em",
                cursor: busy ? "wait" : "pointer",
                opacity: busy ? 0.7 : 1,
              }}
            >
              {busy
                ? mode === "signin"
                  ? "SIGNING IN…"
                  : "CREATING ACCOUNT…"
                : mode === "signin"
                  ? "SIGN IN"
                  : "CREATE ACCOUNT"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
