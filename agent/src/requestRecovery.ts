import { getSynchronizerId, queryActive, resolveParty } from "./ledger.js";
import { allocateExternalParty, submitAsExternalParty } from "./externalParty.js";

// Same identity seed.ts allocated `owner` under — see createPolicy.ts for why
// this replaces resolveParty/exerciseChoice for the owner side of things.
const OWNER_KEY_PATH = process.env.OWNER_KEY_PATH ?? "/canton/identity/owner.der";

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

  const ownerParticipantUrl = `http://${ownerParticipant}`;
  const synchronizerId = await getSynchronizerId(ownerParticipant);
  const owner = await allocateExternalParty(ownerParticipantUrl, ownerPartyHint, synchronizerId, OWNER_KEY_PATH);
  const custodian = await resolveParty(custodianParticipant, custodianPartyHint);

  // Idempotency: a client-side timeout doesn't mean the server didn't still
  // commit the command (see acceptCustody.ts for how this bit us in testing).
  // Check both — already answered (RecoveryRequest consumed) counts too.
  const [openRequests, responses] = await Promise.all([
    queryActive(ownerParticipant, owner.partyId, ":BackupPolicy:RecoveryRequest"),
    queryActive(ownerParticipant, owner.partyId, ":BackupPolicy:RecoveryResponse"),
  ]);
  const already = [...openRequests, ...responses].some(
    (r) => r.payload["policyId"] === policyId && r.payload["requestId"] === requestId,
  );
  if (already) {
    return `REQUEST_RECOVERY_OK: ${requestId} from ${custodian} for policy ${policyId} already exists — skipped`;
  }

  const policies = await queryActive(ownerParticipant, owner.partyId, ":BackupPolicy:BackupPolicy");
  const policy = policies.find((p) => p.payload["policyId"] === policyId);
  if (policy === undefined) {
    throw new Error(`no BackupPolicy with policyId '${policyId}' visible to ${owner.partyId} on ${ownerParticipant}`);
  }

  await submitAsExternalParty(
    ownerParticipantUrl,
    synchronizerId,
    owner.partyId,
    owner.keyPath,
    [
      {
        ExerciseCommand: {
          templateId: policy.templateId,
          contractId: policy.contractId,
          choice: "RequestRecovery",
          choiceArgument: { custodian, requestId },
        },
      },
    ],
    `request-recovery-${requestId}`,
  );

  return `REQUEST_RECOVERY_OK: requested ${requestId} from ${custodian} for policy ${policyId}`;
}
