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
  // ownerParticipant/ownerPartyHint are accepted (cli.ts's --owner-participant/
  // --owner flags stay valid for demo scripts that already pass them) but
  // unused: this function queries BackupPolicy via the custodian's own
  // participant (custodian is an observer on it), never via owner's. A
  // previous version resolved `owner` here anyway and never used it — dead
  // code that silently did a resolveParty(ownerParticipant, ownerPartyHint)
  // lookup, which resolves via participant+hint, not the real external
  // identity (see ADR-007/ADR-008 in the vault for why that's dangerous:
  // it can return an unrelated stale local party of the same name). Removed
  // rather than left as a landmine for a future edit to accidentally wire up.
  const { as, participant, custodianPartyHint, policyId } = options;

  const custodian = await resolveParty(participant, custodianPartyHint);

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
