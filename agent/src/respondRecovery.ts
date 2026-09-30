import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { exerciseChoice, queryActive, resolveParty } from "./ledger.js";

const DATA_DIR = process.env.CUSTODY_DATA_DIR ?? "/canton/custody";

export interface RespondRecoveryOptions {
  as: string; // which mounted custody dir to read the blob from, e.g. "agent2"
  participant: string; // this custodian's own participant, host:port
  custodianPartyHint: string;
  policyId: string;
  requestId: string;
}

// Recomputes the same SHA-256 hash accept-custody recorded, so a mismatch
// here (a different blobHash than the CustodianAgreement) would mean the
// custodian's stored blob changed since custody began.
export async function respondRecovery(options: RespondRecoveryOptions): Promise<string> {
  const { as, participant, custodianPartyHint, policyId, requestId } = options;

  const custodian = await resolveParty(participant, custodianPartyHint);
  const blob = await readFile(join(DATA_DIR, as, policyId, "blob.enc"));
  const blobHash = createHash("sha256").update(blob).digest("hex");

  const requests = await queryActive(participant, custodian, ":BackupPolicy:RecoveryRequest");
  const open = requests.find(
    (r) => r.payload["policyId"] === policyId && r.payload["requestId"] === requestId,
  );
  if (open === undefined) {
    throw new Error(
      `no open RecoveryRequest '${requestId}' for policy ${policyId} visible to ${custodian} on ${participant}`,
    );
  }

  await exerciseChoice(participant, custodian, open.templateId, open.contractId, "RespondRecovery", {
    blobHash,
  });

  return `RESPOND_RECOVERY_OK: ${custodian} answered ${requestId} with blobHash ${blobHash.slice(0, 16)}...`;
}
