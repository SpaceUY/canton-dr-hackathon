import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { combine } from "shamir-secret-sharing";
import type { CustodianRef } from "./createPolicy.js";
import { decryptFile } from "./crypto.js";
import { collectShares, fetchOptional, type CustodianEvent } from "./custodyFetch.js";
import { recoverIdentityKey } from "./recoverIdentity.js";
import { rehostParty, type RehostEvent } from "./rehostParty.js";
import { restore } from "./restore.js";

// Where the owner's key store lives on the recovering side. recover() never
// READS a key from here — it rebuilds the key from the custodians' identity
// shares every time and only writes the verified result back, so the owner
// can keep signing afterwards (see recoverIdentityKey).
const OWNER_KEY_PATH = process.env.OWNER_KEY_PATH ?? "/canton/identity/owner.der";

// Real execution order: the identity key comes back from the custodians
// first (read-only — a failure here leaves nothing half done), then the
// target is authorized to host the party, and only then is the data key
// touched, so the target has legitimate hosting rights before anything
// about the ACS happens.
export type RecoverStep =
  | "identity-key-reconstructed"
  | "identity-reauthorized"
  | "key-reconstructed"
  | "state-restored";

// Fine-grained enough to drive a live "which node is doing what" view, not
// just coarse milestones — one event per real network round trip to a
// custodian (tagged with which secret it was for), the rehost sub-steps,
// plus the four milestones above.
export type RecoverEvent = CustodianEvent | RehostEvent | { type: "milestone"; step: RecoverStep };

export interface RecoverOptions {
  targetParticipant: string;
  targetLedgerApi: string;
  loaderParticipant: string;
  policyId: string;
  endpoints: string[];
  threshold: number;
  // The custodian whose own ledger view the rebuilt identity key is checked
  // against (its BackupPolicy.owner) — never the owner's own participant.
  identityCustodian: CustodianRef;
  onProgress?: (event: RecoverEvent) => void;
}

export async function recover(options: RecoverOptions): Promise<string> {
  const {
    targetParticipant,
    targetLedgerApi,
    loaderParticipant,
    policyId,
    endpoints,
    threshold,
    identityCustodian,
    onProgress,
  } = options;
  if (endpoints.length < threshold) {
    throw new Error(`need at least ${threshold} endpoints, got ${endpoints.length}`);
  }

  const workDir = await mkdtemp(join(tmpdir(), "agent-recover-"));
  try {
    const identity = await recoverIdentityKey({
      keyPath: OWNER_KEY_PATH,
      policyId,
      endpoints,
      threshold,
      custodianParticipant: identityCustodian.participant,
      custodianPartyHint: identityCustodian.partyHint,
      onProgress,
    });
    onProgress?.({ type: "milestone", step: "identity-key-reconstructed" });

    const rehostLine = await rehostParty({
      partyId: identity.partyId,
      targetParticipant,
      targetLedgerApi,
      loaderParticipant,
      keyPath: OWNER_KEY_PATH,
      onProgress,
    });
    onProgress?.({ type: "milestone", step: "identity-reauthorized" });

    const blob = await fetchFirstAvailable(endpoints.map((e) => `${e}/custody/${policyId}/blob`));
    const encryptedPath = join(workDir, "acs.enc");
    await writeFile(encryptedPath, blob);

    const shares = await collectShares({ endpoints, policyId, secret: "data", threshold, onProgress });
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
    return (
      `RECOVER_OK: reconstructed key from ${shares.length}/${endpoints.length} shares; ` +
      `${identity.line}; ${rehostLine}; ${restoreLine}`
    );
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
