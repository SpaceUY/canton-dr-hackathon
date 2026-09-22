import { exerciseChoice, queryActive, resolveParty } from "./ledger.js";

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

  const owner = await resolveParty(ownerParticipant, ownerPartyHint);
  const custodian = await resolveParty(custodianParticipant, custodianPartyHint);

  // Idempotency: a client-side timeout doesn't mean the server didn't still
  // commit the command (see acceptCustody.ts for how this bit us in testing).
  // Check both — already answered (Challenge consumed) counts too.
  const [openChallenges, responses] = await Promise.all([
    queryActive(ownerParticipant, owner, ":BackupPolicy:Challenge"),
    queryActive(ownerParticipant, owner, ":BackupPolicy:ChallengeResponse"),
  ]);
  const already = [...openChallenges, ...responses].some(
    (c) => c.payload["policyId"] === policyId && c.payload["challengeId"] === challengeId,
  );
  if (already) {
    return `CHALLENGE_OK: ${challengeId} to ${custodian} for policy ${policyId} already exists — skipped`;
  }

  const policies = await queryActive(ownerParticipant, owner, ":BackupPolicy:BackupPolicy");
  const policy = policies.find((p) => p.payload["policyId"] === policyId);
  if (policy === undefined) {
    throw new Error(`no BackupPolicy with policyId '${policyId}' visible to ${owner} on ${ownerParticipant}`);
  }

  await exerciseChoice(ownerParticipant, owner, policy.templateId, policy.contractId, "IssueChallenge", {
    custodian,
    challengeId,
  });

  return `CHALLENGE_OK: issued ${challengeId} to ${custodian} for policy ${policyId}`;
}
