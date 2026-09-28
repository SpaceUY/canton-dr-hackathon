// Shared helpers for external parties: allocation, key persistence, and
// signing their own commands via the Interactive Submission Service.
// Confirmed against the real binary in spikes/external-party/ (see
// FINDINGS.md) before landing here — this is integration, not exploration.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

async function keyFileExists(keyPath: string): Promise<boolean> {
  try {
    await access(keyPath);
    return true;
  } catch {
    return false;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} failed: ${res.status} ${text}`);
  return text.length > 0 ? (JSON.parse(text) as T) : ({} as T);
}

// Canton's own fingerprint algorithm for a signing public key: SHA-256 of
// (4-byte big-endian HashPurpose.PublicKeyFingerprint=12) + (the raw 32-byte
// Ed25519 point, NOT the DER/SPKI wrapper), prefixed with the 2-byte
// multihash tag Canton uses for all its hashes (0x12 0x20 = sha2-256, 32
// bytes). Verified against what `/v2/parties/external/generate-topology`
// itself reports for a freshly generated key before trusting this — a first
// attempt that hashed the full DER SPKI bytes instead of just the raw key
// silently computed a plausible-looking but wrong fingerprint.
function computeKeyFingerprint(publicKey: KeyObject): string {
  const derSpki = publicKey.export({ format: "der", type: "spki" });
  const rawKey = derSpki.subarray(derSpki.length - 32);
  const purposeBytes = Buffer.alloc(4);
  purposeBytes.writeUInt32BE(12, 0);
  const digest = createHash("sha256").update(Buffer.concat([purposeBytes, rawKey])).digest();
  return Buffer.concat([Buffer.from([0x12, 0x20]), digest]).toString("hex");
}

// Fails loudly, before any signature is produced, if the local private key
// doesn't cryptographically match the party ID it's about to sign for. This
// exists because of a real incident: a stale, hand-copied partyId in ad hoc
// debug scripts caused a valid signature to be produced for the wrong party
// (mathematically correct, semantically wrong) — reproducible only as
// "Invalid signature" server-side, hours of debugging to trace back. This
// check catches that class of mistake at the source, deterministically and
// instantly, instead of relying on a topology-rejection message to notice.
function assertKeyMatchesParty(privateKey: KeyObject, partyId: string, context: string): void {
  const expectedFingerprint = partyId.split("::")[1];
  if (expectedFingerprint === undefined) {
    throw new Error(`${context}: unexpected partyId shape '${partyId}' (expected 'hint::fingerprint')`);
  }
  const actualFingerprint = computeKeyFingerprint(createPublicKey(privateKey));
  if (actualFingerprint !== expectedFingerprint) {
    throw new Error(
      `${context}: IDENTITY MISMATCH — refusing to sign.\n` +
        `  party '${partyId}' expects fingerprint ${expectedFingerprint}\n` +
        `  the local key actually computes to    ${actualFingerprint}\n` +
        `The key file and the party ID have diverged from each other (stale identity files, wrong ` +
        `environment, or a corrupted volume). Do not proceed — signing now would produce a valid-looking ` +
        `signature for the wrong identity.`,
    );
  }
}

export interface ExternalPartyIdentity {
  partyId: string;
  keyPath: string;
}

// Loads an already-allocated external party's identity purely from local
// files — no network call, no allocate-fresh fallback. Use this (not
// allocateExternalParty) wherever the original hosting participant might be
// dead, e.g. identity recovery: falling through to allocateExternalParty's
// live-allocation path there would be wrong even as a fallback, since it'd
// require a participant that may no longer exist.
export async function loadExternalPartyIdentity(keyPath: string): Promise<ExternalPartyIdentity> {
  const partyIdPath = keyPath.replace(/\.der$/, ".party-id.txt");
  const existingKeyDer = await readFile(keyPath);
  const existingPartyId = (await readFile(partyIdPath, "utf8")).trim();
  const privateKey = createPrivateKey({ key: existingKeyDer, format: "der", type: "pkcs8" });
  assertKeyMatchesParty(privateKey, existingPartyId, `loadExternalPartyIdentity(${keyPath})`);
  return { partyId: existingPartyId, keyPath };
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
  // Only a genuinely missing key file falls through to "allocate fresh" — a
  // key file that exists but fails to parse or doesn't match its recorded
  // party ID must fail loudly here, not be silently papered over by minting
  // a brand new identity (see assertKeyMatchesParty's own comment for why).
  if (await keyFileExists(keyPath)) {
    return await loadExternalPartyIdentity(keyPath);
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
  await writeFile(keyPath.replace(/\.der$/, ".party-id.txt"), gen.partyId);

  return { partyId: gen.partyId, keyPath };
}

export interface TopologySignature {
  signatureB64: string;
  fingerprint: string;
}

// Signs a topology-transaction hash — e.g. a party_to_participant_mappings
// re-hosting proposal, used to authorize a new participant to host an
// already-existing external party during identity recovery. Confirmed
// against the real binary in spikes/external-party/ before landing here.
//
// Topology transactions use SIGNATURE_FORMAT_CONCAT — NOT the
// SIGNATURE_FORMAT_RAW submitAsExternalParty uses below for regular Daml
// transactions. Mixing these two up is the single easiest way to get this
// wrong (see FINDINGS/POCs) — hence a distinct, differently-named function
// rather than a shared one with a format flag.
export async function signTopologyHash(
  hashB64: string,
  keyPath: string,
  partyId: string,
): Promise<TopologySignature> {
  const keyDer = await readFile(keyPath);
  const privateKey = createPrivateKey({ key: keyDer, format: "der", type: "pkcs8" });
  assertKeyMatchesParty(privateKey, partyId, `signTopologyHash(${keyPath})`);
  const fingerprint = partyId.split("::")[1];
  if (fingerprint === undefined) throw new Error(`unexpected partyId shape: ${partyId}`);
  const signature = cryptoSign(null, Buffer.from(hashB64, "base64"), privateKey);
  return { signatureB64: signature.toString("base64"), fingerprint };
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
  assertKeyMatchesParty(privateKey, actAsPartyId, `submitAsExternalParty(${keyPath})`);
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
