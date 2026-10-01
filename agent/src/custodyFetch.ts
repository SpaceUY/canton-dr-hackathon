// Which of the two independent secrets a custodian round trip is for — the
// data-encryption key's share (`share`) or the owner's identity key's share
// (`identity-share`). Same custodians, never mixed (ADR-005 in
// docs/DECISIONS.md); the UI uses this to tell the two recovery stages apart.
export type CustodySecret = "identity" | "data";

// One event per real network round trip to a custodian.
export type CustodianEvent =
  | { type: "custodian-query"; endpoint: string; secret: CustodySecret }
  | { type: "custodian-response"; endpoint: string; ok: boolean; secret: CustodySecret };

// Fetches one custody object, treating "not there" and "custodian
// unreachable" the same way: undefined, so the caller skips it and tries the
// next custodian instead of crashing the whole recovery over one endpoint.
// A custodian that's genuinely down (container stopped, network partition)
// makes fetch() itself reject rather than respond with any HTTP status -
// reproduced live 2026-09-29 by killing a real custodian container
// mid-recovery, when an uncaught rejection here used to take down the entire
// attempt instead of falling through.
export async function fetchOptional(url: string): Promise<Uint8Array | undefined> {
  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    return new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    console.error(`custodian unreachable, skipping: ${url}`, err);
    return undefined;
  }
}

// Collects up to `threshold` shares of one secret, one custodian at a time in
// the given order, reporting each round trip as it happens.
export async function collectShares(options: {
  endpoints: string[];
  policyId: string;
  secret: CustodySecret;
  threshold: number;
  onProgress?: (event: CustodianEvent) => void;
}): Promise<Uint8Array[]> {
  const { endpoints, policyId, secret, threshold, onProgress } = options;
  const path = secret === "identity" ? "identity-share" : "share";
  const shares: Uint8Array[] = [];
  for (const endpoint of endpoints) {
    if (shares.length >= threshold) break;
    onProgress?.({ type: "custodian-query", endpoint, secret });
    const share = await fetchOptional(`${endpoint}/custody/${policyId}/${path}`);
    onProgress?.({ type: "custodian-response", endpoint, ok: share !== undefined, secret });
    if (share !== undefined) shares.push(share);
  }
  return shares;
}
