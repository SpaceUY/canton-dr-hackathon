// Shared helpers for external parties: allocation, key persistence, and
// signing their own commands via the Interactive Submission Service.
// Confirmed against the real binary in spikes/external-party/ (see
// FINDINGS.md) before landing here — this is integration, not exploration.
import { createPrivateKey, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} failed: ${res.status} ${text}`);
  return text.length > 0 ? (JSON.parse(text) as T) : ({} as T);
}

export interface ExternalPartyIdentity {
  partyId: string;
  keyPath: string;
}

// Idempotent: if a key already exists at keyPath, reuses it (and the party
// it already allocated) instead of generating a new one — re-running seed
// must not orphan the previous identity.
export async function allocateExternalParty(
  participant: string,
  partyHint: string,
  synchronizerId: string,
  keyPath: string,
): Promise<ExternalPartyIdentity> {
  const partyIdPath = keyPath.replace(/\.der$/, ".party-id.txt");

  try {
    const existingKeyDer = await readFile(keyPath);
    const existingPartyId = (await readFile(partyIdPath, "utf8")).trim();
    createPrivateKey({ key: existingKeyDer, format: "der", type: "pkcs8" }); // sanity-check it parses
    return { partyId: existingPartyId, keyPath };
  } catch {
    // No existing key — allocate fresh.
  }

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });

  const gen = await request<{
    partyId: string;
    multiHash: string;
    publicKeyFingerprint: string;
    topologyTransactions: string[];
  }>(`${participant}/v2/parties/external/generate-topology`, {
    method: "POST",
    body: JSON.stringify({
      synchronizer: synchronizerId,
      partyHint,
      publicKey: {
        format: "CRYPTO_KEY_FORMAT_DER_X509_SUBJECT_PUBLIC_KEY_INFO",
        keyData: publicKeyDer.toString("base64"),
        keySpec: "SIGNING_KEY_SPEC_EC_CURVE25519",
      },
      otherConfirmingParticipantUids: [],
    }),
  });

  const multiHashSignature = cryptoSign(null, Buffer.from(gen.multiHash, "base64"), privateKey);

  await request(`${participant}/v2/parties/external/allocate`, {
    method: "POST",
    body: JSON.stringify({
      synchronizer: synchronizerId,
      onboardingTransactions: gen.topologyTransactions.map((t) => ({ transaction: t })),
      multiHashSignatures: [
        {
          format: "SIGNATURE_FORMAT_CONCAT",
          signature: multiHashSignature.toString("base64"),
          signedBy: gen.publicKeyFingerprint,
          signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519",
        },
      ],
    }),
  });

  await mkdir(dirname(keyPath), { recursive: true });
  await writeFile(keyPath, privateKey.export({ format: "der", type: "pkcs8" }));
  await writeFile(partyIdPath, gen.partyId);

  return { partyId: gen.partyId, keyPath };
}

// Submits a command with an external party as (one of) the actor(s), via
// prepare -> sign externally -> executeAndWait. Only supports a single
// external signer for now — this project's `owner` is always the sole actor
// of its own commands.
export async function submitAsExternalParty(
  participant: string,
  synchronizerId: string,
  actAsPartyId: string,
  keyPath: string,
  commands: Record<string, unknown>[],
  commandId: string,
): Promise<void> {
  const keyDer = await readFile(keyPath);
  const privateKey = createPrivateKey({ key: keyDer, format: "der", type: "pkcs8" });
  const fingerprint = actAsPartyId.split("::")[1];
  if (fingerprint === undefined) throw new Error(`unexpected partyId shape: ${actAsPartyId}`);

  const prepared = await request<{
    preparedTransaction: unknown;
    preparedTransactionHash: string;
    hashingSchemeVersion: string;
  }>(`${participant}/v2/interactive-submission/prepare`, {
    method: "POST",
    body: JSON.stringify({
      commandId,
      commands,
      actAs: [actAsPartyId],
      userId: "participant_admin",
      synchronizerId,
      packageIdSelectionPreference: [],
    }),
  });

  const signature = cryptoSign(null, Buffer.from(prepared.preparedTransactionHash, "base64"), privateKey);

  await request(`${participant}/v2/interactive-submission/executeAndWait`, {
    method: "POST",
    body: JSON.stringify({
      preparedTransaction: prepared.preparedTransaction,
      hashingSchemeVersion: prepared.hashingSchemeVersion,
      partySignatures: {
        signatures: [
          {
            party: actAsPartyId,
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
      submissionId: `${commandId}-submit`,
      userId: "participant_admin",
    }),
  });
}
