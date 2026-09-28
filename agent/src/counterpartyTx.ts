import { loadExternalPartyIdentity } from "./externalParty.js";
import { createContract, resolveParty } from "./ledger.js";

export interface CounterpartyTxOptions {
  as: string; // custodian party hint acting as itself, e.g. "custodian2"
  participant: string; // that custodian's own http-ledger-api host:port
  label: string;
}

// The demo's closing proof: an ordinary local party, with zero special
// handling, submits a brand-new command naming the (possibly just-
// recovered) external owner as observer — no re-onboarding step on its
// side. Resolves owner's identity from the local key file (this assumes
// normal operation, not a disaster scenario — for that, see
// agent/src/recoverIdentity.ts instead) so the demo never needs owner's
// 60+ character party id typed or pasted live.
export async function counterpartyTx(options: CounterpartyTxOptions): Promise<string> {
  const { as, participant, label } = options;
  const custodian = await resolveParty(participant, as);
  const owner = (await loadExternalPartyIdentity(process.env.OWNER_KEY_PATH ?? "/canton/identity/owner.der"))
    .partyId;

  await createContract(participant, custodian, "#canton-dr:Record:Record", {
    owner: custodian,
    custodians: [owner],
    label,
  });

  return `COUNTERPARTY_TX_OK: ${custodian} created a new Record naming ${owner} as observer (label '${label}')`;
}
