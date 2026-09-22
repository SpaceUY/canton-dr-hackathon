import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { exerciseChoice, queryActive, resolveParty } from "./ledger.js";

const DATA_DIR = process.env.CUSTODY_DATA_DIR ?? "/canton/custody";

export interface AcceptCustodyOptions {
  as: string; // which mounted custody dir to read the blob from, e.g. "agent2"
  participant: string; // this custodian's own participant, host:port
  custodianPartyHint: string;
  ownerParticipant: string;
  ownerPartyHint: string;
  policyId: string;
}

export async function acceptCustody(options: AcceptCustodyOptions): Promise<string> {
  const { as, participant, custodianPartyHint, ownerParticipant, ownerPartyHint, policyId } = options;

  const custodian = await resolveParty(participant, custodianPartyHint);
  const owner = await resolveParty(ownerParticipant, ownerPartyHint);

  const blob = await readFile(join(DATA_DIR, as, policyId, "blob.enc"));
  const blobHash = createHash("sha256").update(blob).digest("hex");

  // Idempotency check: a client-side timeout (a slow node under memory
  // pressure returned one once, in testing) doesn't mean the server didn't
  // still commit the command — retrying blindly duplicated the
  // CustodianAgreement. If one's already there, this is a safe no-op.
  const existing = await queryActive(participant, custodian, ":BackupPolicy:CustodianAgreement");
  const already = existing.find((a) => a.payload["policyId"] === policyId);
  if (already !== undefined) {
    return `ACCEPT_CUSTODY_OK: ${custodian} already recorded custody for policy ${policyId} (blobHash ${String(already.payload["blobHash"]).slice(0, 16)}...) — skipped`;
  }

  const policies = await queryActive(participant, custodian, ":BackupPolicy:BackupPolicy");
  const policy = policies.find((p) => p.payload["policyId"] === policyId);
  if (policy === undefined) {
    throw new Error(`no BackupPolicy with policyId '${policyId}' visible to ${custodian} on ${participant}`);
  }

  await exerciseChoice(participant, custodian, policy.templateId, policy.contractId, "AcceptCustody", {
    custodian,
    blobHash,
  });

  return `ACCEPT_CUSTODY_OK: ${custodian} recorded blobHash ${blobHash.slice(0, 16)}... for policy ${policyId}`;
}
