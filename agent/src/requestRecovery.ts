import { exerciseChoice, queryActive, resolveParty } from "./ledger.js";

export interface RequestRecoveryOptions {
  ownerParticipant: string;
  ownerPartyHint: string;
  custodianParticipant: string;
  custodianPartyHint: string;
  policyId: string;
  requestId: string;
}

export async function requestRecovery(options: RequestRecoveryOptions): Promise<string> {
  const { ownerParticipant, ownerPartyHint, custodianParticipant, custodianPartyHint, policyId, requestId } =
    options;

  const owner = await resolveParty(ownerParticipant, ownerPartyHint);
  const custodian = await resolveParty(custodianParticipant, custodianPartyHint);

  // Idempotency: a client-side timeout doesn't mean the server didn't still
  // commit the command (see acceptCustody.ts for how this bit us in testing).
  // Check both — already answered (RecoveryRequest consumed) counts too.
  const [openRequests, responses] = await Promise.all([
    queryActive(ownerParticipant, owner, ":BackupPolicy:RecoveryRequest"),
    queryActive(ownerParticipant, owner, ":BackupPolicy:RecoveryResponse"),
  ]);
  const already = [...openRequests, ...responses].some(
    (r) => r.payload["policyId"] === policyId && r.payload["requestId"] === requestId,
  );
  if (already) {
    return `REQUEST_RECOVERY_OK: ${requestId} from ${custodian} for policy ${policyId} already exists — skipped`;
  }

  const policies = await queryActive(ownerParticipant, owner, ":BackupPolicy:BackupPolicy");
  const policy = policies.find((p) => p.payload["policyId"] === policyId);
  if (policy === undefined) {
    throw new Error(`no BackupPolicy with policyId '${policyId}' visible to ${owner} on ${ownerParticipant}`);
  }

  await exerciseChoice(ownerParticipant, owner, policy.templateId, policy.contractId, "RequestRecovery", {
    custodian,
    requestId,
  });

  return `REQUEST_RECOVERY_OK: requested ${requestId} from ${custodian} for policy ${policyId}`;
}
