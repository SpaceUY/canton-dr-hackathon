import { readFileSync } from "node:fs";
import { createPrivateKey, sign } from "node:crypto";

const SOURCE = "http://localhost:5023"; // participant2
const SYNCHRONIZER_ID = "da::12202a9282f9e82b5817757fa5da3a4fa9ee4fec3cc18c1247d880f3e2d70407c1a8";
const PARTY_HINT = "signer1";

async function request(url, init) {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} failed: ${res.status} ${text}`);
  return text.length > 0 ? JSON.parse(text) : {};
}

const signerPartyId = readFileSync(new URL(`./${PARTY_HINT}-party-id.txt`, import.meta.url), "utf8").trim();
const keyDer = readFileSync(new URL(`./${PARTY_HINT}-key.der`, import.meta.url));
const privateKey = createPrivateKey({ key: keyDer, format: "der", type: "pkcs8" });
const fingerprint = signerPartyId.split("::")[1];

// Prepare: signer1 itself is the actor (owner) of a brand-new Record.
const prepared = await request(`${SOURCE}/v2/interactive-submission/prepare`, {
  method: "POST",
  body: JSON.stringify({
    commandId: `signatory-test-${Date.now()}`,
    commands: [
      {
        CreateCommand: {
          templateId: "#canton-dr:Record:Record",
          createArguments: {
            owner: signerPartyId,
            custodians: [],
            label: "signer1-self-signed",
          },
        },
      },
    ],
    actAs: [signerPartyId],
    userId: "participant_admin",
    synchronizerId: SYNCHRONIZER_ID,
    packageIdSelectionPreference: [],
  }),
});

console.log("PREPARE_OK: hashingSchemeVersion=" + prepared.hashingSchemeVersion);

const hashBytes = Buffer.from(prepared.preparedTransactionHash, "base64");
const signature = sign(null, hashBytes, privateKey);

const execResult = await request(`${SOURCE}/v2/interactive-submission/executeAndWait`, {
  method: "POST",
  body: JSON.stringify({
    preparedTransaction: prepared.preparedTransaction,
    hashingSchemeVersion: prepared.hashingSchemeVersion,
    partySignatures: {
      signatures: [
        {
          party: signerPartyId,
          signatures: [
            {
              format: "SIGNATURE_FORMAT_RAW",
              signature: signature.toString("base64"),
              signedBy: fingerprint,
              signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519",
            },
          ],
        },
      ],
    },
    deduplicationPeriod: { Empty: {} },
    submissionId: `signatory-test-submit-${Date.now()}`,
    userId: "participant_admin",
  }),
});

console.log("EXECUTE_OK: " + JSON.stringify(execResult).slice(0, 200));
console.log("SIGNATORY_SUBMIT_OK: " + signerPartyId + " signed and created its own Record");
