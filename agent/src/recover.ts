import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { combine } from "shamir-secret-sharing";
import { decryptFile } from "./crypto.js";
import { loadExternalPartyIdentity } from "./externalParty.js";
import { rehostParty } from "./rehostParty.js";
import { restore } from "./restore.js";

// Same identity seed.ts allocated `owner` under. Loaded from disk, not
// looked up live — the whole point of recovery is that the original hosting
// participant may be dead, so a live allocateExternalParty fallback would be
// wrong even as a fallback.
const OWNER_KEY_PATH = process.env.OWNER_KEY_PATH ?? "/canton/identity/owner.der";

export interface RecoverOptions {
  targetParticipant: string;
  targetLedgerApi: string;
  loaderParticipant: string;
  policyId: string;
  endpoints: string[];
  threshold: number;
}

export async function recover(options: RecoverOptions): Promise<string> {
  const { targetParticipant, targetLedgerApi, loaderParticipant, policyId, endpoints, threshold } = options;
  if (endpoints.length < threshold) {
    throw new Error(`need at least ${threshold} endpoints, got ${endpoints.length}`);
  }

  const workDir = await mkdtemp(join(tmpdir(), "agent-recover-"));
  try {
    const owner = await loadExternalPartyIdentity(OWNER_KEY_PATH);
    const rehostLine = await rehostParty({
      partyId: owner.partyId,
      targetParticipant,
      targetLedgerApi,
      loaderParticipant,
      keyPath: owner.keyPath,
    });

    const blob = await fetchFirstAvailable(endpoints.map((e) => `${e}/custody/${policyId}/blob`));
    const encryptedPath = join(workDir, "acs.enc");
    await writeFile(encryptedPath, blob);

    const shares: Uint8Array[] = [];
    for (const endpoint of endpoints) {
      if (shares.length >= threshold) break;
      const share = await fetchOptional(`${endpoint}/custody/${policyId}/share`);
      if (share !== undefined) shares.push(share);
    }
    if (shares.length < threshold) {
      throw new Error(`only got ${shares.length}/${threshold} required shares`);
    }

    const key = await combine(shares);
    const acsPath = join(workDir, "acs.bin");
    await decryptFile(encryptedPath, acsPath, key);

    const restoreLine = await restore({ targetParticipant, inFile: acsPath });
    return `RECOVER_OK: reconstructed key from ${shares.length}/${endpoints.length} shares; ${rehostLine}; ${restoreLine}`;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function fetchFirstAvailable(urls: string[]): Promise<Buffer> {
  for (const url of urls) {
    const body = await fetchOptional(url);
    if (body !== undefined) return Buffer.from(body);
  }
  throw new Error(`no endpoint had the blob: ${urls.join(", ")}`);
}

async function fetchOptional(url: string): Promise<Uint8Array | undefined> {
  const res = await fetch(url);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
