// The real test: after spike5 was recovered onto participant5, can a
// counterparty (custodian2, an ordinary local party, no special knowledge
// of the recovery) submit a BRAND NEW transaction naming spike5 - not just
// read the recovered contract, but create a fresh one - with no
// re-onboarding step on custodian2's side?
const SOURCE = "http://localhost:5023"; // participant2, where custodian2 lives

async function request(url, init) {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} failed: ${res.status} ${text}`);
  return text.length > 0 ? JSON.parse(text) : {};
}

const spike5PartyId = "spike5::122038c67f8e6e084656fa56114bbff5654db68901ba92153cc29ff1d4858788c235";

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
            custodians: [spike5PartyId],
            label: "spike5-post-recovery",
          },
        },
      },
    ],
    userId: "participant_admin",
    commandId: `post-recovery-tx-${Date.now()}`,
    actAs: [custodian2],
    readAs: [custodian2],
  }),
});

console.log("POST_RECOVERY_TX_OK: fresh Record created naming spike5 after its recovery");
