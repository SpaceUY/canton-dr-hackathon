import { createPrivateKey, createPublicKey } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { combine } from "shamir-secret-sharing";
import { computeKeyFingerprint } from "./externalParty.js";
import { queryActive, resolveParty } from "./ledger.js";

export interface RecoverIdentityOptions {
  keyPath: string;
  policyId: string;
  endpoints: string[];
  threshold: number;
  // Any custodian's own participant + hint — used only to discover owner's
  // real partyId from its own view of BackupPolicy (custodians are
  // observers on it). Never the owner's own participant: the whole point of
  // this command is that owner's identity may be gone from everywhere else,
  // not just its original participant.
  custodianParticipant: string;
  custodianPartyHint: string;
}

// Reconstructs the owner's external-party signing key purely from
// custodian-held Shamir fragments (agent/src/distributeIdentity.ts) and
// writes it back to keyPath/party-id.txt — self-healing an identity whose
// local key file was itself lost, not just its hosting participant. Verifies
// the reconstruction against the party id a custodian's own ledger view
// reports for the policy (never trusts a caller-supplied partyId, and never
// needs the owner's own participant to be alive): recovering the identity
// key must not depend on anything only readable with the identity already
// recovered (ADR-005 in the vault) — this is what keeps that promise.
export async function recoverIdentityKey(options: RecoverIdentityOptions): Promise<string> {
  const { keyPath, policyId, endpoints, threshold, custodianParticipant, custodianPartyHint } = options;
  if (endpoints.length < threshold) {
    throw new Error(`need at least ${threshold} endpoints, got ${endpoints.length}`);
  }

  const shares: Uint8Array[] = [];
  for (const endpoint of endpoints) {
    if (shares.length >= threshold) break;
    const share = await fetchOptional(`${endpoint}/custody/${policyId}/identity-share`);
    if (share !== undefined) shares.push(share);
  }
  if (shares.length < threshold) {
    throw new Error(`only got ${shares.length}/${threshold} required identity-key shares`);
  }

  const keyDer = Buffer.from(await combine(shares));
  const privateKey = createPrivateKey({ key: keyDer, format: "der", type: "pkcs8" });
  const actualFingerprint = computeKeyFingerprint(createPublicKey(privateKey));

  // Matched by fingerprint, not just by policyId: this project's demo
  // environment genuinely accumulates more than one BackupPolicy sharing the
  // same policyId across re-seeds/re-tests (a stale one from before the
  // external-party migration, in one real case — see ADR-007 in the vault).
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
  const match = candidates.find((p) => (p.payload["owner"] as string).split("::")[1] === actualFingerprint);
  if (match === undefined) {
    throw new Error(
      `reconstructed key (fingerprint ${actualFingerprint}) doesn't match any of the ${candidates.length} ` +
        `BackupPolicy candidate(s) with policyId '${policyId}' visible to ${custodian} — the identity-key ` +
        `shares may not all belong to the same key, or the real policy isn't visible to this custodian`,
    );
  }
  const partyId = match.payload["owner"] as string;

  await mkdir(dirname(keyPath), { recursive: true });
  await writeFile(keyPath, keyDer);
  await writeFile(keyPath.replace(/\.der$/, ".party-id.txt"), partyId);

  return `RECOVER_IDENTITY_OK: reconstructed ${partyId} from ${shares.length}/${endpoints.length} identity-key shares, verified against ${custodian}'s BackupPolicy, wrote ${keyPath}`;
}

async function fetchOptional(url: string): Promise<Uint8Array | undefined> {
  const res = await fetch(url);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
