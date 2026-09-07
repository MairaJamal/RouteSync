/**
 * Identity profile store (CNIC + uni/office card). Persisted to disk so
 * restarts keep signup data. Full CNIC is write-only — only last-4 is ever
 * returned to clients.
 */
import fs from "fs";
import path from "path";
import { maskCnicToLast4 } from "./vehicleDeclaration";

export type IdDocumentType = "university_card" | "office_card";

export interface IdentityProfile {
  userId: string;
  cnicNumber: string;
  idDocumentType: IdDocumentType;
  institutionName: string;
  cardNumber: string;
  updatedAt: string;
}

const STORE_DIR = path.join(process.cwd(), ".data");
const STORE_PATH = path.join(STORE_DIR, "identity-profiles.json");

const byUserId = new Map<string, IdentityProfile>();

function persist() {
  try {
    if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify([...byUserId.values()]), "utf8");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[identityStore] persist failed:", err instanceof Error ? err.message : err);
  }
}

function hydrate() {
  try {
    if (!fs.existsSync(STORE_PATH)) return;
    const rows = JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) as IdentityProfile[];
    byUserId.clear();
    for (const row of rows ?? []) {
      if (row?.userId) byUserId.set(row.userId, row);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[identityStore] hydrate failed:", err instanceof Error ? err.message : err);
  }
}

hydrate();

export function upsertIdentityProfile(input: {
  userId: string;
  cnicNumber: string;
  idDocumentType: IdDocumentType;
  institutionName: string;
  cardNumber?: string;
}): IdentityProfile {
  const profile: IdentityProfile = {
    userId: input.userId,
    cnicNumber: input.cnicNumber.trim(),
    idDocumentType: input.idDocumentType,
    institutionName: input.institutionName.trim(),
    cardNumber: (input.cardNumber ?? "").trim(),
    updatedAt: new Date().toISOString(),
  };
  byUserId.set(input.userId, profile);
  persist();
  return profile;
}

export function getIdentityProfile(userId: string): IdentityProfile | null {
  return byUserId.get(userId) ?? null;
}

export function getIdentityProfilePublic(userId: string) {
  const p = byUserId.get(userId);
  if (!p) return null;
  return {
    has_cnic: true,
    cnic_last4: maskCnicToLast4(p.cnicNumber),
    id_document_type: p.idDocumentType,
    institution_name: p.institutionName,
    card_number: p.cardNumber || null,
    updated_at: p.updatedAt,
  };
}

export function getStoredCnic(userId: string): string | null {
  return byUserId.get(userId)?.cnicNumber ?? null;
}
