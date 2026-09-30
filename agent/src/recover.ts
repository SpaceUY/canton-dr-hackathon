import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { combine } from "shamir-secret-sharing";
import { decryptFile } from "./crypto.js";
import { loadExternalPartyIdentity } from "./externalParty.js";
import { rehostParty, type RehostEvent } from "./rehostParty.js";
import { restore } from "./restore.js";

// Same identity seed.ts allocated `owner` under. Loaded from disk, not
// looked up live — the whole point of recovery is that the original hosting
// participant may be dead, so a live allocateExternalParty fallback would be
// wrong even as a fallback.
const OWNER_KEY_PATH = process.env.OWNER_KEY_PATH ?? "/canton/identity/owner.der";

// Real execution order, not the more intuitive-sounding "key first": identity
// is re-authorized before the encryption key is even touched, so the target
// has legitimate hosting rights before anything about the ACS happens.
export type RecoverStep = "identity-reauthorized" | "key-reconstructed" | "state-restored";

// Fine-grained enough to drive a live "which node is doing what" view, not
// just three coarse milestones — one event per real network round trip to a
// custodian, plus the three milestones above.
export type RecoverEvent =
  | { type: "custodian-query"; endpoint: string }
  | { type: "custodian-response"; endpoint: string; ok: boolean }
  | RehostEvent
  | { type: "milestone"; step: RecoverStep };

export interface RecoverOptions {
  targetParticipant: string;
  targetLedgerApi: string;
  loaderParticipant: string;
  policyId: string;
  endpoints: string[];
  threshold: number;
  onProgress?: (event: RecoverEvent) => void;
}

export async function recover(options: RecoverOptions): Promise<string> {
  const { targetParticipant, targetLedgerApi, loaderParticipant, policyId, endpoints, threshold, onProgress } =
    options;
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
      onProgress,
    });
    onProgress?.({ type: "milestone", step: "identity-reauthorized" });

    const blob = await fetchFirstAvailable(endpoints.map((e) => `${e}/custody/${policyId}/blob`));
    const encryptedPath = join(workDir, "acs.enc");
    await writeFile(encryptedPath, blob);

    const shares: Uint8Array[] = [];
    for (const endpoint of endpoints) {
      if (shares.length >= threshold) break;
      onProgress?.({ type: "custodian-query", endpoint });
      const share = await fetchOptional(`${endpoint}/custody/${policyId}/share`);
      onProgress?.({ type: "custodian-response", endpoint, ok: share !== undefined });
      if (share !== undefined) shares.push(share);
    }
    if (shares.length < threshold) {
      throw new Error(
        `only ${shares.length} of ${threshold} required custodians responded (${endpoints.length} tried) - ` +
          "not enough fragments to reconstruct the key",
      );
    }

    const key = await combine(shares);
    const acsPath = join(workDir, "acs.bin");
    await decryptFile(encryptedPath, acsPath, key);
    onProgress?.({ type: "milestone", step: "key-reconstructed" });

    const restoreLine = await restore({ targetParticipant, inFile: acsPath });
    onProgress?.({ type: "milestone", step: "state-restored" });
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
  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    return new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    // A custodian that's genuinely down (container stopped, network
    // partition) rejects here instead of responding with any HTTP status
    // at all - treated the same as a 404 ("no share here"), not a hard
    // failure. A real custodian hiccup must make recover() skip it and
    // try the next one, not crash the whole recovery over one endpoint -
    // reproduced live 2026-09-29 by killing a real custodian container
    // mid-recovery before this fix (an uncaught rejection here used to
    // take down the entire attempt instead of falling through).
    console.error(`custodian unreachable, skipping: ${url}`, err);
    return undefined;
  }
}
