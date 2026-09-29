import { loadExternalPartyIdentity } from "./externalParty.js";
import { isPartyHostedLocally } from "./ledger.js";

const OWNER_KEY_PATH = process.env.OWNER_KEY_PATH ?? "/canton/identity/owner.der";
const DASHBOARD_URL = process.env.DASHBOARD_URL ?? "http://dashboard:4010";
const EXPECTED_POLICY_ID = "demo";
const EXPECTED_K = "2";
const EXPECTED_N = "3";
const EXPECTED_CUSTODIANS = 2;
const EXPECTED_POSITIONS = 3;

interface CustodianView {
  custodian: string;
  acceptedCustody: boolean;
  status: string;
}

interface StatusView {
  policyId: string;
  k: string;
  n: string;
  custodians: CustodianView[];
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return (await res.json()) as T;
}

async function isReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

// Fails loudly (throws, naming exactly what's wrong) rather than silently
// leaving the operator to discover a missing step by hand on demo day - the
// whole point of `make demo-reset` calling this last. Checks pre-disaster
// invariants (owner hosted on participant1, NOT yet on participant4) plus
// everything the demo's own screens read from: policy, custodians, positions.
export async function verifyDemoState(): Promise<string> {
  const lines: string[] = [];

  const owner = await loadExternalPartyIdentity(OWNER_KEY_PATH);
  lines.push(`owner: ${owner.partyId}`);

  const p1Alive = await isReachable("http://participant1:5013/v2/parties/participant-id");
  if (!p1Alive) {
    throw new Error(
      "VERIFY_FAILED: participant1 is not reachable - a pre-disaster state requires it alive and reachable",
    );
  }
  const hostedOnP1 = await isPartyHostedLocally("participant1:5013", owner.partyId);
  if (!hostedOnP1) {
    throw new Error(`VERIFY_FAILED: owner is not hosted on participant1 (found ${owner.partyId})`);
  }
  lines.push("participant1: alive, hosting owner - OK");

  const hostedOnP4 = await isPartyHostedLocally("participant4:5043", owner.partyId);
  if (hostedOnP4) {
    throw new Error(
      "VERIFY_FAILED: owner is already hosted on participant4 - this is not a pre-disaster state, " +
        "recovery already happened in this environment",
    );
  }
  lines.push("participant4: not hosting owner - OK (genuine pre-disaster state)");

  const status = await fetchJson<StatusView>(`${DASHBOARD_URL}/status`);
  if (status.policyId !== EXPECTED_POLICY_ID) {
    throw new Error(`VERIFY_FAILED: policyId is '${status.policyId}', expected '${EXPECTED_POLICY_ID}'`);
  }
  if (status.k !== EXPECTED_K || status.n !== EXPECTED_N) {
    throw new Error(`VERIFY_FAILED: k/n are ${status.k}/${status.n}, expected ${EXPECTED_K}/${EXPECTED_N}`);
  }
  if (status.custodians.length !== EXPECTED_CUSTODIANS) {
    throw new Error(
      `VERIFY_FAILED: expected ${EXPECTED_CUSTODIANS} custodians in status, got ${status.custodians.length}`,
    );
  }
  for (const c of status.custodians) {
    if (!c.acceptedCustody) {
      throw new Error(`VERIFY_FAILED: custodian ${c.custodian} has not accepted custody`);
    }
    if (c.status !== "ok") {
      throw new Error(
        `VERIFY_FAILED: custodian ${c.custodian} status is '${c.status}', expected 'ok' ` +
          "(challenge/response cycle missing or not yet indexed)",
      );
    }
  }
  lines.push(`policy: k=${status.k} n=${status.n}, both custodians accepted custody and last challenge OK`);

  const positionsResp = await fetchJson<{ positions?: unknown[] }>(`${DASHBOARD_URL}/positions`);
  const positions = positionsResp.positions ?? [];
  if (positions.length !== EXPECTED_POSITIONS) {
    throw new Error(`VERIFY_FAILED: expected ${EXPECTED_POSITIONS} positions, got ${positions.length}`);
  }
  lines.push(`positions: ${positions.length} verified`);

  const ciphertextOk = await isReachable(`${DASHBOARD_URL}/ciphertext`);
  if (!ciphertextOk) {
    throw new Error("VERIFY_FAILED: GET /ciphertext failed - custodian's own blob is not readable");
  }
  lines.push("ciphertext: readable from a real custodian - OK");

  return `VERIFY_DEMO_STATE_OK\n${lines.join("\n")}`;
}
