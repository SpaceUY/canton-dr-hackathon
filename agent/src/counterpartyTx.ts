import { loadExternalPartyIdentity, submitAsExternalParty } from "./externalParty.js";
import { createContract, getSynchronizerId, queryActive, resolveParty, type ActiveContract } from "./ledger.js";

export interface CounterpartyTxOptions {
  as: string; // custodian party hint acting as itself, e.g. "custodian2"
  participant: string; // that custodian's own http-ledger-api host:port
  ownerParticipant: string; // owner's CURRENT hosting participant's http-ledger-api host:port — may be the original one, or the recovery target post-disaster
  label: string;
}

export interface CounterpartyTxResult {
  proposalContractId: string;
  recordContractId: string;
  proposer: string;
  owner: string;
  label: string;
  ownerParticipant: string;
}

// The demo's closing proof: a real counterparty (an ordinary local party,
// zero special handling) proposes a new contract naming the owner as
// observer, then the owner — not the counterparty, not this script acting
// on the owner's behalf — exercises AcceptRecord themselves, signed via
// Interactive Submission from wherever they're currently hosted. The
// resulting Record's sole signatory is genuinely `owner`: this is what
// proves the recovered party authored a brand-new commitment post-recovery,
// not merely that the ledger recognizes them as an observer (see
// daml/Record.daml's own comment on RecordProposal for why this replaced a
// single one-sided create).
export async function counterpartyTx(options: CounterpartyTxOptions): Promise<CounterpartyTxResult> {
  const { as, participant, ownerParticipant, label } = options;
  const custodian = await resolveParty(participant, as);
  const ownerIdentity = await loadExternalPartyIdentity(process.env.OWNER_KEY_PATH ?? "/canton/identity/owner.der");
  const owner = ownerIdentity.partyId;

  await createContract(participant, custodian, "#canton-dr:Record:RecordProposal", {
    proposer: custodian,
    owner,
    label,
  });

  // Polled from the OWNER's own participant, not the proposer's: a contract
  // is visible to participant (the creator) the instant it commits, but
  // ownerParticipant only sees it once the synchronizer has propagated it
  // there — real, but not instantaneous. Exercising against a contract id
  // ownerParticipant hasn't ingested yet fails with CONTRACT_NOT_FOUND —
  // reproduced live against the real binary before this fix.
  const proposal = await pollForActiveContract(ownerParticipant, owner, ":Record:RecordProposal", label, owner);

  const synchronizerId = await getSynchronizerId(ownerParticipant);
  await submitAsExternalParty(
    `http://${ownerParticipant}`,
    synchronizerId,
    owner,
    ownerIdentity.keyPath,
    [
      {
        ExerciseCommand: {
          templateId: proposal.templateId,
          contractId: proposal.contractId,
          choice: "AcceptRecord",
          choiceArgument: {},
        },
      },
    ],
    `counterparty-tx-accept-${label}-${Date.now()}`,
  );

  const records = await queryActive(ownerParticipant, owner, ":Record:Record");
  const recordMatches = records.filter((r) => r.payload["label"] === label && r.payload["owner"] === owner);
  const record = recordMatches[recordMatches.length - 1];
  if (record === undefined) {
    throw new Error(`Record with label '${label}' not found on ${ownerParticipant} right after accepting the proposal`);
  }

  return {
    proposalContractId: proposal.contractId,
    recordContractId: record.contractId,
    proposer: custodian,
    owner,
    label,
    ownerParticipant,
  };
}

async function pollForActiveContract(
  participant: string,
  party: string,
  templateSuffix: string,
  label: string,
  owner: string,
): Promise<ActiveContract> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const contracts = await queryActive(participant, party, templateSuffix);
    const matches = contracts.filter((c) => c.payload["label"] === label && c.payload["owner"] === owner);
    const match = matches[matches.length - 1];
    if (match !== undefined) return match;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `no active contract matching template '${templateSuffix}' label '${label}' ever became visible to ${party} ` +
      `on ${participant} (waited 10s)`,
  );
}
