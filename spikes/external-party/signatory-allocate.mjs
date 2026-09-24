// Everything so far had the external party as an OBSERVER on a contract
// signed by an ordinary local party. The real demo's `owner` needs to be
// the SIGNATORY/actor of its own commands (create-policy, distribute,
// request-recovery) — this tests whether that's even possible for an
// external party, via Canton's Interactive Submission Service
// (/v2/interactive-submission/prepare + executeAndWait), following the
// TypeScript reference in digital-asset/canton's
// community/app/src/pack/examples/14-multisync/src/interactive-submission.ts.
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";

const SYNCHRONIZER_ID = "da::12202a9282f9e82b5817757fa5da3a4fa9ee4fec3cc18c1247d880f3e2d70407c1a8";
const SOURCE = "http://localhost:5023"; // participant2's HTTP Ledger API
const PARTY_HINT = "signer1";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyDer = publicKey.export({ format: "der", type: "spki" });

writeFileSync(
  new URL(`./${PARTY_HINT}-key.der`, import.meta.url),
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

const { sign } = await import("node:crypto");
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
if (!allocRes.ok) {
  console.error("ALLOCATE_FAILED:", allocRes.status, allocText);
  process.exit(1);
}

writeFileSync(new URL(`./${PARTY_HINT}-party-id.txt`, import.meta.url), gen.partyId);
console.log("SIGNATORY_ALLOCATE_OK: partyId=" + gen.partyId + " fingerprint=" + gen.publicKeyFingerprint);
