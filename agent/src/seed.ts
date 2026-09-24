// Replaces infra/canton/seed.sh's job now that `owner` is an external
// party: bash+curl could allocate a local party and let participant1 sign
// on its behalf, but an external party must sign its own transactions
// (Interactive Submission), which needs real crypto — hence TypeScript,
// not bash. custodian2/custodian3 stay local parties, unchanged.
//
// Idempotent, like the original: safe to re-run against an already-seeded
// topology.
import { getSynchronizerId, queryActive, resolveParty } from "./ledger.js";
import { allocateExternalParty, submitAsExternalParty } from "./externalParty.js";

const OWNER_KEY_PATH = process.env.OWNER_KEY_PATH ?? "/canton/identity/owner.der";

export async function seed(): Promise<string> {
  const participant1 = "http://participant1:5013";
  const synchronizerId = await getSynchronizerId("participant1:5013");

  const owner = await allocateExternalParty(participant1, "owner", synchronizerId, OWNER_KEY_PATH);
  const custodian2 = await resolveParty("participant2:5023", "custodian2");
  const custodian3 = await resolveParty("participant3:5033", "custodian3");

  const existing = await queryActive("participant1:5013", owner.partyId, ":Record:Record");
  const alreadySeeded = existing.some((c) => c.payload["label"] === "seed");

  if (!alreadySeeded) {
    await submitAsExternalParty(
      participant1,
      synchronizerId,
      owner.partyId,
      owner.keyPath,
      [
        {
          CreateCommand: {
            templateId: "#canton-dr:Record:Record",
            createArguments: {
              owner: owner.partyId,
              custodians: [custodian2, custodian3],
              label: "seed",
            },
          },
        },
      ],
      "seed-record-1",
    );
  }

  // Custodians index the transaction into their own ACS asynchronously —
  // poll like the original bash script did.
  for (const [participant, party] of [
    ["participant2:5023", custodian2],
    ["participant3:5033", custodian3],
  ] as const) {
    let seen = false;
    for (let attempt = 0; attempt < 20 && !seen; attempt++) {
      const contracts = await queryActive(participant, party, ":Record:Record");
      seen = contracts.some((c) => c.payload["label"] === "seed");
      if (!seen) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!seen) {
      throw new Error(`VERIFICATION FAILED: no Record with label 'seed' visible to ${party} on ${participant}`);
    }
  }

  return (
    `owner=${owner.partyId}\n` +
    `custodian2=${custodian2}\n` +
    `custodian3=${custodian3}\n` +
    `SEED_OK: Record verified in the ACS of all 3 participants (owner + 2 custodians)`
  );
}
