// ─────────────────────────────────────────────────────────────
// Day 7: Verified profile badge — university email allowlist.
//
// Zero-cost verification: no third-party service. A user becomes
// verified when Supabase Auth has CONFIRMED their email (the existing
// email_confirmed_at) AND the email domain is on this list. Adding a
// domain = add one line below.
// ─────────────────────────────────────────────────────────────

/** Starter allowlist of Pakistani university / institution email
 *  domains. Easily extended — keep entries lowercase, no '@'. */
export const UNIVERSITY_EMAIL_DOMAINS: string[] = [
  "nust.edu.pk",        // National University of Sciences & Technology
  "qau.edu.pk",         // Quaid-i-Azam University
  "comsats.edu.pk",     // COMSATS University Islamabad
  "pieas.edu.pk",       // Pakistan Institute of Engineering & Applied Sciences
  "iub.edu.pk",         // Islamia University of Bahawalpur
  "pu.edu.pk",          // University of the Punjab
  "uetlahore.edu.pk",   // UET Lahore
  "lums.edu.pk",        // LUMS
  "fast.edu.pk",        // FAST-NUCES
  "giki.edu.pk",        // Ghulam Ishaq Khan Institute
  "uom.edu.pk",         // University of Malakand (pattern: many .edu.pk follow)
  "kust.edu.pk",        // Kohat University of Science & Technology
  "uetpeshawar.edu.pk", // UET Peshawar
  "uvas.edu.pk",        // University of Veterinary & Animal Sciences
  "fjwu.edu.pk",        // Fatima Jinnah Women University
  "air.edu.pk",         // Air University Islamabad
  "bahria.edu.pk",      // Bahria University
  "szabist.edu.pk",     // SZABIST
  "iba.edu.pk",         // Institute of Business Administration Karachi
  "kiu.edu.pk",         // Karakoram International University
];

/** Match an email against the allowlist. Returns the matched domain or
 *  null. Case-insensitive, tolerant of subdomains
 *  (student.cs.nust.edu.pk still counts as nust.edu.pk). */
export function matchVerifiedDomain(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return null;
  const domain = email.slice(at + 1).toLowerCase().trim();
  if (domain.length === 0) return null;

  for (const allowed of UNIVERSITY_EMAIL_DOMAINS) {
    if (domain === allowed || domain.endsWith(`.${allowed}`)) {
      return allowed;
    }
  }
  return null;
}
