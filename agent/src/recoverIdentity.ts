import { createPrivateKey, createPublicKey } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { combine } from "shamir-secret-sharing";
import { collectShares, type CustodianEvent } from "./custodyFetch.js";
import { computeKeyFingerprint } from "./externalParty.js";
import { queryActive, resolveParty } from "./ledger.js";

export interface ReconstructIdentityOptions {
  policyId: string;
  endpoints: string[];
  threshold: number;
  // Any custodian's own participant + hint — used only to discover owner's
  // real partyId from its own view of BackupPolicy (custodians are
  // observers on it). Never the owner's own participant: the whole point of
  // this is that owner's identity may be gone from everywhere else, not
  // just its original participant.
  custodianParticipant: string;
  custodianPartyHint: string;
  onProgress?: (event: CustodianEvent) => void;
}

export interface ReconstructedIdentity {
  partyId: string;
  keyDer: Buffer;
  fingerprint: string;
  sharesUsed: number;
  verifiedBy: string;
}

// Reconstructs the owner's external-party signing key purely from
// custodian-held Shamir fragments (agent/src/distributeIdentity.ts), in
// memory, and verifies it against the party id a custodian's own ledger view
// reports for the policy — never a caller-supplied partyId, and never
// anything that needs the owner's own participant to be alive: recovering
// the identity key must not depend on anything only readable with the
// identity already recovered (ADR-005 in docs/DECISIONS.md) — this is what
// keeps that promise. Read-only: writes nothing anywhere, touches no
// topology, so a failure here leaves nothing half done.
export async function reconstructIdentityKey(options: ReconstructIdentityOptions): Promise<ReconstructedIdentity> {
  const { policyId, endpoints, threshold, custodianParticipant, custodianPartyHint, onProgress } = options;
  if (endpoints.length < threshold) {
    throw new Error(`need at least ${threshold} endpoints, got ${endpoints.length}`);
  }

  const shares = await collectShares({ endpoints, policyId, secret: "identity", threshold, onProgress });
  if (shares.length < threshold) {
    throw new Error(
      `only ${shares.length} of ${threshold} required custodians returned an identity-key fragment ` +
        `(${endpoints.length} tried) - not enough to rebuild the owner's identity key`,
    );
  }

  const keyDer = Buffer.from(await combine(shares));
  const privateKey = createPrivateKey({ key: keyDer, format: "der", type: "pkcs8" });
  const fingerprint = computeKeyFingerprint(createPublicKey(privateKey));

  // Matched by fingerprint, not just by policyId: this project's demo
  // environment genuinely accumulates more than one BackupPolicy sharing the
  // same policyId across re-seeds/re-tests (a stale one from before the
  // external-party migration, in one real case — see ADR-007 in docs/DECISIONS.md).
  // Picking policies[0] blindly reproduced that exact class of bug in this
  // very function during testing; matching against the key's own computed
  // fingerprint instead means an unrelated stale candidate is never picked
  // by accident, no matter how many share the same policyId.
  const custodian = await resolveParty(custodianParticipant, custodianPartyHint);
  const policies = await queryActive(custodianParticipant, custodian, ":BackupPolicy:BackupPolicy");
  const candidates = policies.filter((p) => p.payload["policyId"] === policyId);
  if (candidates.length === 0) {
    throw new Error(`no BackupPolicy with policyId '${policyId}' visible to ${custodian} on ${custodianParticipant}`);
  }
  const match = candidates.find((p) => (p.payload["owner"] as string).split("::")[1] === fingerprint);
  if (match === undefined) {
    throw new Error(
      `reconstructed key (fingerprint ${fingerprint}) doesn't match any of the ${candidates.length} ` +
        `BackupPolicy candidate(s) with policyId '${policyId}' visible to ${custodian} — the identity-key ` +
        `shares may not all belong to the same key, or the real policy isn't visible to this custodian`,
    );
  }

  return {
    partyId: match.payload["owner"] as string,
    keyDer,
    fingerprint,
    sharesUsed: shares.length,
    verifiedBy: custodian,
  };
}

export interface RecoverIdentityOptions extends ReconstructIdentityOptions {
  keyPath: string;
}

// reconstructIdentityKey, then writes the verified key back to
// keyPath/party-id.txt — self-healing an identity whose local key file was
// lost along with its node, so the owner can keep signing afterwards (the
// closing counterparty-tx, the CLI fallbacks). Refuses to overwrite a key
// file that holds a *different* key (ADR-007: never let a local key and the
// recovered identity silently diverge).
export async function recoverIdentityKey(options: RecoverIdentityOptions): Promise<{ partyId: string; line: string }> {
  const { keyPath } = options;
  const identity = await reconstructIdentityKey(options);

  const existing = await readExistingKey(keyPath);
  if (existing !== undefined) {
    let existingFingerprint: string;
    try {
      existingFingerprint = computeKeyFingerprint(
        createPublicKey(createPrivateKey({ key: existing, format: "der", type: "pkcs8" })),
      );
    } catch (err) {
      throw new Error(
        `refusing to overwrite ${keyPath}: it exists but isn't a readable PKCS8 key ` +
          `(${err instanceof Error ? err.message : String(err)}) — inspect it by hand before recovering`,
      );
    }
    if (existingFingerprint !== identity.fingerprint) {
      throw new Error(
        `refusing to overwrite ${keyPath}: it holds a different key (fingerprint ${existingFingerprint}) than the ` +
          `one reconstructed from the custodians' shares (${identity.fingerprint}, verified as ${identity.partyId})`,
      );
    }
  }

  await mkdir(dirname(keyPath), { recursive: true });
  await writeFile(keyPath, identity.keyDer, { mode: 0o600 });
  await writeFile(keyPath.replace(/\.der$/, ".party-id.txt"), identity.partyId);

  return {
    partyId: identity.partyId,
    line:
      `RECOVER_IDENTITY_OK: reconstructed ${identity.partyId} from ${identity.sharesUsed}/${options.endpoints.length} ` +
      `identity-key shares, verified against ${identity.verifiedBy}'s BackupPolicy, wrote ${keyPath}`,
  };
}

async function readExistingKey(keyPath: string): Promise<Buffer | undefined> {
  try {
    return await readFile(keyPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}
