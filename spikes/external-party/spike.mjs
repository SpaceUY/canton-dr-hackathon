// Spike: can a party survive its hosting participant's death, if its key
// lives outside Canton? Step 1 — just allocate an external party on
// participant2 via the public HTTP Ledger API (no console-only/private
// helpers), following Canton's own documented recipe
// (docs-open/.../party_replication.rst + the allocateExternalParty.rst.macro
// test snippet, Canton 3.5.x — matches this project's version).
//
// Deliberately isolated: uses participant2 (source) only, doesn't touch
// participant1/4 or the "owner"/custodian2/custodian3 parties the real demo
// depends on.
import { generateKeyPairSync, sign } from "node:crypto";
import { writeFileSync } from "node:fs";

const SYNCHRONIZER_ID = "da::122058807387a41263b402f465648ec22f6842a3923539b5df94ea424178d4236d08";
const SOURCE = "http://localhost:5023"; // participant2's HTTP Ledger API
const PARTY_HINT = "spike5"; // day 2: full loop test, ends with a fresh counterparty tx

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyDer = publicKey.export({ format: "der", type: "spki" });

// The whole point of an external party: this key must outlive whatever
// participant currently hosts it. Persisting it here, outside Canton
// entirely, is standing in for what would really be a KMS/Shamir-protected
// store (see docs/ROADMAP.md's Priority 1 note on the unified-Shamir idea).
writeFileSync(
  new URL("./spike-key.der", import.meta.url),
  privateKey.export({ format: "der", type: "pkcs8" }),
);

const generateBody = {
  synchronizer: SYNCHRONIZER_ID,
  partyHint: PARTY_HINT,
  publicKey: {
    format: "CRYPTO_KEY_FORMAT_DER_X509_SUBJECT_PUBLIC_KEY_INFO",
    keyData: publicKeyDer.toString("base64"),
    keySpec: "SIGNING_KEY_SPEC_EC_CURVE25519",
  },
  otherConfirmingParticipantUids: [],
};

const genRes = await fetch(`${SOURCE}/v2/parties/external/generate-topology`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(generateBody),
});
const genText = await genRes.text();
if (!genRes.ok) {
  console.error("GENERATE_TOPOLOGY_FAILED:", genRes.status, genText);
  process.exit(1);
}
const gen = JSON.parse(genText);
console.log("GENERATE_TOPOLOGY_OK: partyId=" + gen.partyId);

const multiHash = Buffer.from(gen.multiHash, "base64");
const signature = sign(null, multiHash, privateKey);

const allocateBody = {
  synchronizer: SYNCHRONIZER_ID,
  onboardingTransactions: gen.topologyTransactions.map((t) => ({ transaction: t })),
  multiHashSignatures: [
    {
      format: "SIGNATURE_FORMAT_CONCAT",
      signature: signature.toString("base64"),
      signedBy: gen.publicKeyFingerprint,
      signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519",
    },
  ],
};

const allocRes = await fetch(`${SOURCE}/v2/parties/external/allocate`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(allocateBody),
});
const allocText = await allocRes.text();
console.log("ALLOCATE_STATUS:", allocRes.status);
console.log(allocText);

if (allocRes.ok) {
  writeFileSync(new URL("./spike-party-id.txt", import.meta.url), gen.partyId);
  console.log("SPIKE_OK: external party allocated:", gen.partyId);
} else {
  console.log("SPIKE_FAILED");
  process.exit(1);
}
