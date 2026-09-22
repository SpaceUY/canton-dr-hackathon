import { createContract, queryActive, resolveParty } from "./ledger.js";

export interface CustodianRef {
  participant: string; // host:port of its http-ledger-api
  partyHint: string;
}

export interface CreatePolicyOptions {
  ownerParticipant: string;
  ownerPartyHint: string;
  custodians: CustodianRef[];
  k: number;
  n: number;
  frequencyHours: number;
  policyId: string;
}

export async function createPolicy(options: CreatePolicyOptions): Promise<string> {
  const { ownerParticipant, ownerPartyHint, custodians, k, n, frequencyHours, policyId } = options;

  const owner = await resolveParty(ownerParticipant, ownerPartyHint);
  const custodianParties = await Promise.all(
    custodians.map((c) => resolveParty(c.participant, c.partyHint)),
  );

  // Idempotency: a client-side timeout doesn't mean the server didn't still
  // commit the command (see acceptCustody.ts for how this bit us in testing).
  const existing = await queryActive(ownerParticipant, owner, ":BackupPolicy:BackupPolicy");
  if (existing.some((p) => p.payload["policyId"] === policyId)) {
    return `CREATE_POLICY_OK: ${policyId} already exists — skipped`;
  }

  await createContract(ownerParticipant, owner, "#canton-dr:BackupPolicy:BackupPolicy", {
    owner,
    custodians: custodianParties,
    k: String(k),
    n: String(n),
    frequencyHours: String(frequencyHours),
    policyId,
  });

  return `CREATE_POLICY_OK: ${policyId} (owner=${owner}, k=${k}, n=${n}, custodians=${custodianParties.length})`;
}
