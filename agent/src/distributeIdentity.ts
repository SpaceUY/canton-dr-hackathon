import { readFile } from "node:fs/promises";
import { split } from "shamir-secret-sharing";

export interface DistributeIdentityOptions {
  keyPath: string;
  policyId: string;
  // Ordered — endpoints[i] gets shares[i]. Same custodian network the data
  // key already uses (ADR-005 in the vault: one network, two independent
  // sets of fragments), stored under a distinct path (identity-share, not
  // share) so the two secrets never mix on the wire or on disk.
  endpoints: string[];
  threshold: number;
}

// Splits the owner's external-party signing key itself into k-of-n
// fragments, same scheme as the data-encryption key (agent/src/distribute.ts).
// The raw PKCS8 DER bytes are split directly — shamir-secret-sharing has no
// fixed max secret length, so there's no need to extract just the 32-byte
// seed first.
export async function distributeIdentityKey(options: DistributeIdentityOptions): Promise<string> {
  const { keyPath, policyId, endpoints, threshold } = options;
  if (endpoints.length < threshold) {
    throw new Error(`need at least ${threshold} endpoints, got ${endpoints.length}`);
  }

  const keyDer = await readFile(keyPath);
  const shares = await split(new Uint8Array(keyDer), endpoints.length, threshold);

  await Promise.all(
    endpoints.map(async (endpoint, i) => {
      const share = shares[i];
      if (share === undefined) throw new Error(`missing identity-key share for endpoint ${endpoint}`);
      await putBinary(`${endpoint}/custody/${policyId}/identity-share`, Buffer.from(share));
    }),
  );

  return `DISTRIBUTE_IDENTITY_OK: identity key split into ${endpoints.length} shares (k=${threshold}), sent to custodians`;
}

async function putBinary(url: string, body: Uint8Array): Promise<void> {
  const res = await fetch(url, { method: "PUT", body: new Uint8Array(body) });
  if (!res.ok) {
    throw new Error(`PUT ${url} failed: ${res.status} ${await res.text()}`);
  }
}
