import { getSynchronizerId, queryActive, resolveParty } from "./ledger.js";
import { allocateExternalParty, submitAsExternalParty } from "./externalParty.js";

// Same identity seed.ts allocated `owner` under — see createPolicy.ts for why
// this replaces resolveParty/exerciseChoice for the owner side of things.
const OWNER_KEY_PATH = process.env.OWNER_KEY_PATH ?? "/canton/identity/owner.der";

export interface ChallengeOptions {
  ownerParticipant: string;
  ownerPartyHint: string;
  custodianParticipant: string;
  custodianPartyHint: string;
  policyId: string;
  challengeId: string;
}

export async function issueChallenge(options: ChallengeOptions): Promise<string> {
  const { ownerParticipant, ownerPartyHint, custodianParticipant, custodianPartyHint, policyId, challengeId } =
    options;

  const ownerParticipantUrl = `http://${ownerParticipant}`;
  const synchronizerId = await getSynchronizerId(ownerParticipant);
  const owner = await allocateExternalParty(ownerParticipantUrl, ownerPartyHint, synchronizerId, OWNER_KEY_PATH);
  const custodian = await resolveParty(custodianParticipant, custodianPartyHint);

  // Idempotency: a client-side timeout doesn't mean the server didn't still
  // commit the command (see acceptCustody.ts for how this bit us in testing).
  // Check both — already answered (Challenge consumed) counts too.
  const [openChallenges, responses] = await Promise.all([
    queryActive(ownerParticipant, owner.partyId, ":BackupPolicy:Challenge"),
    queryActive(ownerParticipant, owner.partyId, ":BackupPolicy:ChallengeResponse"),
  ]);
  const already = [...openChallenges, ...responses].some(
    (c) => c.payload["policyId"] === policyId && c.payload["challengeId"] === challengeId,
  );
  if (already) {
    return `CHALLENGE_OK: ${challengeId} to ${custodian} for policy ${policyId} already exists — skipped`;
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
          choice: "IssueChallenge",
          choiceArgument: { custodian, challengeId },
        },
      },
    ],
    `challenge-${challengeId}`,
  );

  return `CHALLENGE_OK: issued ${challengeId} to ${custodian} for policy ${policyId}`;
}
