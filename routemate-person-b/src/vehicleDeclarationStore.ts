/**
 * Local persistence for self-attested vehicle declarations.
 * Provides resilient fallback when the Postgres table hasn't been migrated yet,
 * mirroring the pattern in identityStore.ts and chatStore.ts.
 */
import fs from "fs";
import path from "path";

export interface StoredVehicleDeclaration {
  userId: string;
  vehiclePlate: string;
  vehicleMakeModel: string | null;
  cnicLast4: string;
  declaredAt: string;
}

const STORE_DIR = path.join(process.cwd(), ".data");
const STORE_PATH = path.join(STORE_DIR, "vehicle-declarations.json");

const declarationsByUserId = new Map<string, StoredVehicleDeclaration>();

function persist() {
  try {
    if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
    const payload = [...declarationsByUserId.values()];
    fs.writeFileSync(STORE_PATH, JSON.stringify(payload), "utf8");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[vehicleDeclarationStore] persist failed:", err instanceof Error ? err.message : err);
  }
}

function hydrate() {
  try {
    if (!fs.existsSync(STORE_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) as StoredVehicleDeclaration[];
    declarationsByUserId.clear();
    for (const d of raw ?? []) {
      if (d.userId) declarationsByUserId.set(d.userId, d);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[vehicleDeclarationStore] hydrate failed:", err instanceof Error ? err.message : err);
  }
}

hydrate();

export function getStoredVehicleDeclaration(userId: string): StoredVehicleDeclaration | null {
  return declarationsByUserId.get(userId) ?? null;
}

export function upsertStoredVehicleDeclaration(decl: StoredVehicleDeclaration): void {
  declarationsByUserId.set(decl.userId, decl);
  persist();
}
