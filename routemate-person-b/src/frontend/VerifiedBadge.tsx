/* Day 7 Feature 3: the verified badge. Shown wherever a rider's identity
   appears (match cards, chat drawer header, profile chip). Renders
   nothing for unverified users — absence of a badge is the signal. */

export default function VerifiedBadge({
  domain,
  compact = false,
}: {
  domain?: string | null;
  compact?: boolean;
}) {
  return (
    <span
      title={
        domain
          ? `University email verified (${domain})`
          : "University email verified"
      }
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        fontFamily: "var(--rm-font-display)",
        fontSize: compact ? "10px" : "11px",
        fontWeight: 600,
        color: "var(--rm-verified)",
        background: "var(--rm-verified-tint)",
        border: "1px solid var(--rm-verified)",
        borderRadius: "999px",
        padding: compact ? "1px 6px" : "2px 8px",
        whiteSpace: "nowrap",
        verticalAlign: "middle",
      }}
    >
      ✓ Verified{!compact && domain ? ` · ${domain}` : ""}
    </span>
  );
}
