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

// Real positions to lose, not an abstract "Record" — what a judge sees
// destroyed and recovered is a counterparty name and a signed amount, not a
// contract id. See daml/Position.daml.
const POSITIONS: { label: string; counterparty: string; amount: string; currency: string }[] = [
  { label: "position-1", counterparty: "Northwind Trading", amount: "125000.00", currency: "EUR" },
  { label: "position-2", counterparty: "Meridian Capital", amount: "-48250.50", currency: "USD" },
  { label: "position-3", counterparty: "Solvay Chemicals", amount: "76900.00", currency: "USD" },
];

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

  const existingPositions = await queryActive("participant1:5013", owner.partyId, ":Position:Position");
  const seededLabels = new Set(existingPositions.map((c) => c.payload["label"]));
  const missing = POSITIONS.filter((p) => !seededLabels.has(p.label));

  if (missing.length > 0) {
    await submitAsExternalParty(
      participant1,
      synchronizerId,
      owner.partyId,
      owner.keyPath,
      missing.map((p) => ({
        CreateCommand: {
          templateId: "#canton-dr:Position:Position",
          createArguments: {
            owner: owner.partyId,
            custodians: [custodian2, custodian3],
            counterparty: p.counterparty,
            amount: p.amount,
            currency: p.currency,
            label: p.label,
          },
        },
      })),
      "seed-positions-1",
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

    let allPositionsSeen = false;
    for (let attempt = 0; attempt < 20 && !allPositionsSeen; attempt++) {
      const contracts = await queryActive(participant, party, ":Position:Position");
      const labels = new Set(contracts.map((c) => c.payload["label"]));
      allPositionsSeen = POSITIONS.every((p) => labels.has(p.label));
      if (!allPositionsSeen) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!allPositionsSeen) {
      throw new Error(`VERIFICATION FAILED: not all ${POSITIONS.length} Positions visible to ${party} on ${participant}`);
    }
  }

  return (
    `owner=${owner.partyId}\n` +
    `custodian2=${custodian2}\n` +
    `custodian3=${custodian3}\n` +
    `SEED_OK: Record + ${POSITIONS.length} Positions verified in the ACS of all 3 participants (owner + 2 custodians)`
  );
}
