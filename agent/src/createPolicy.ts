import { getSynchronizerId, queryActive, resolveParty } from "./ledger.js";
import { allocateExternalParty, submitAsExternalParty } from "./externalParty.js";

// Same identity seed.ts allocated `owner` under — reusing it here (rather
// than resolveParty) is required now that `owner` is an external party:
// only its own key can sign its commands, the participant can't sign on
// its behalf anymore.
const OWNER_KEY_PATH = process.env.OWNER_KEY_PATH ?? "/canton/identity/owner.der";

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

  const ownerParticipantUrl = `http://${ownerParticipant}`;
  const synchronizerId = await getSynchronizerId(ownerParticipant);
  const owner = await allocateExternalParty(ownerParticipantUrl, ownerPartyHint, synchronizerId, OWNER_KEY_PATH);
  const custodianParties = await Promise.all(
    custodians.map((c) => resolveParty(c.participant, c.partyHint)),
  );

  // Idempotency: a client-side timeout doesn't mean the server didn't still
  // commit the command (see acceptCustody.ts for how this bit us in testing).
  const existing = await queryActive(ownerParticipant, owner.partyId, ":BackupPolicy:BackupPolicy");
  if (existing.some((p) => p.payload["policyId"] === policyId)) {
    return `CREATE_POLICY_OK: ${policyId} already exists — skipped`;
  }

  await submitAsExternalParty(
    ownerParticipantUrl,
    synchronizerId,
    owner.partyId,
    owner.keyPath,
    [
      {
        CreateCommand: {
          templateId: "#canton-dr:BackupPolicy:BackupPolicy",
          createArguments: {
            owner: owner.partyId,
            custodians: custodianParties,
            k: String(k),
            n: String(n),
            frequencyHours: String(frequencyHours),
            policyId,
          },
        },
      },
    ],
    `create-policy-${policyId}`,
  );

  return `CREATE_POLICY_OK: ${policyId} (owner=${owner.partyId}, k=${k}, n=${n}, custodians=${custodianParties.length})`;
}
