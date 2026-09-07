// ─────────────────────────────────────────────────────────────
// Day 12: self-attested vehicle details. IMPORTANT — this is NOT
// document verification. Nobody checks that the CNIC or plate a
// rider enters actually belongs to them; there's no license photo,
// no admin review, no authority lookup. All this does is: (a) give a
// rider bringing a car/bike a way to put an identifiable plate number
// on record, so a passenger can visually confirm "is this the car
// that was supposed to pick me up", and (b) require a CNIC be entered
// at all, which raises the bar above a throwaway account slightly —
// but "raises the bar slightly" is not "verified." UI copy anywhere
// this surfaces must say "self-declared", never "verified driver."
//
// CNIC (Pakistan's national ID number) is sensitive PII. The rule
// enforced everywhere this is used: the full number is written once
// and NEVER read back, not even to its own owner, not even over an
// authenticated request. Only the last 4 digits ever leave storage,
// and only to the owner themselves — a matched rider sees just the
// plate number and a boolean, nothing derived from the CNIC at all.
// ─────────────────────────────────────────────────────────────

/** Standard Pakistani CNIC format: 5 digits - 7 digits - 1 digit. */
const CNIC_REGEX = /^\d{5}-\d{7}-\d{1}$/;

export function normalizeCnic(input: string): string {
  return input.trim();
}

export function isValidPakistaniCnic(input: string): boolean {
  return typeof input === "string" && CNIC_REGEX.test(normalizeCnic(input));
}

/** The only representation of a CNIC that should ever leave storage —
 *  everywhere else in the app, "the CNIC" means these 4 characters. */
export function maskCnicToLast4(cnic: string): string {
  const digitsOnly = cnic.replace(/[^0-9]/g, "");
  return digitsOnly.slice(-4);
}

/** Pakistani plates vary a lot by province/format (e.g. "ISB-1234",
 *  "LEA-20-1234", "AJK-4567"), so this stays permissive on purpose —
 *  it's a plausibility check, not a real plate-registry lookup.
 *  Requires at least one letter and one digit so someone can't submit
 *  four dashes and call it a plate. */
export function normalizeVehiclePlate(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, "-");
}

export function isValidVehiclePlate(input: string): boolean {
  if (typeof input !== "string") return false;
  const plate = normalizeVehiclePlate(input);
  return /^[A-Z0-9-]{3,15}$/.test(plate) && /[0-9]/.test(plate) && /[A-Z]/.test(plate);
}
