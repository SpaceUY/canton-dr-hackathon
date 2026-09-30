import { backup } from "./backup.js";
import { encryptFile } from "./crypto.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { split } from "shamir-secret-sharing";

export interface DistributeOptions {
  sourceParticipant: string;
  partyHint: string;
  policyId: string;
  // Ordered — endpoints[i] gets shares[i]. Every endpoint (including the
  // owner's own, if self-custody) gets the full encrypted blob too.
  endpoints: string[];
  threshold: number;
}

export async function distribute(options: DistributeOptions): Promise<string> {
  const { sourceParticipant, partyHint, policyId, endpoints, threshold } = options;
  if (endpoints.length < threshold) {
    throw new Error(`need at least ${threshold} endpoints, got ${endpoints.length}`);
  }

  const workDir = await mkdtemp(join(tmpdir(), "agent-distribute-"));
  try {
    const acsPath = join(workDir, "acs.bin");
    const encryptedPath = join(workDir, "acs.enc");

    await backup({ sourceParticipant, partyHint, outFile: acsPath });
    const key = await encryptFile(acsPath, encryptedPath);
    const shares = await split(key, endpoints.length, threshold);
    const blob = await readFile(encryptedPath);

    await Promise.all(
      endpoints.map(async (endpoint, i) => {
        const share = shares[i];
        if (share === undefined) throw new Error(`missing share for endpoint ${endpoint}`);
        await putBinary(`${endpoint}/custody/${policyId}/blob`, blob);
        await putBinary(`${endpoint}/custody/${policyId}/share`, Buffer.from(share));
      }),
    );

    return `DISTRIBUTE_OK: policy ${policyId} sent to ${endpoints.length} custodians (k=${threshold})`;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function putBinary(url: string, body: Uint8Array): Promise<void> {
  const res = await fetch(url, { method: "PUT", body: new Uint8Array(body) });
  if (!res.ok) {
    throw new Error(`PUT ${url} failed: ${res.status} ${await res.text()}`);
  }
}
