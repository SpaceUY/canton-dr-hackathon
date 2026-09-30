// Give spike4 (an external party, no signing capability needed here since
// it's just an observer, not the signatory) real ACS state, so the next
// phase tests offline party replication for real — the spike so far only
// covered a party with nothing to move.
import { readFileSync } from "node:fs";

const SOURCE = "http://localhost:5023"; // participant2

async function request(url, init) {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} failed: ${res.status} ${text}`);
  return text.length > 0 ? JSON.parse(text) : {};
}

const PARTY_HINT = "spike5";
const spike4PartyId = readFileSync(new URL(`./${PARTY_HINT}-party-id.txt`, import.meta.url), "utf8").trim();

// custodian2 already exists locally on participant2 (real demo party) — use
// it as the signatory so we don't need external-signing for a plain Daml
// command, only for the topology change later.
const namespaceInfo = await request(`${SOURCE}/v2/parties/participant-id`);
const namespace = namespaceInfo.participantId.split("::")[1];
const found = await request(`${SOURCE}/v2/parties/party?parties=custodian2::${namespace}`);
const custodian2 = found.partyDetails[0]?.party;
if (custodian2 === undefined) throw new Error("custodian2 not found on participant2");

await request(`${SOURCE}/v2/commands/submit-and-wait`, {
  method: "POST",
  body: JSON.stringify({
    commands: [
      {
        CreateCommand: {
          templateId: "#canton-dr:Record:Record",
          createArguments: {
            owner: custodian2,
            custodians: [spike4PartyId],
            label: `${PARTY_HINT}-state`,
          },
        },
      },
    ],
    userId: "participant_admin",
    commandId: `spike-give-state-${Date.now()}`,
    actAs: [custodian2],
    readAs: [custodian2],
  }),
});

console.log("GIVE_STATE_OK: Record created, owner=" + custodian2 + " observer=" + spike4PartyId);
