const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4010";

export type CustodianStatus = "no-custody-accepted" | "awaiting-response" | "ok" | "no-challenge-yet";

export interface CustodianView {
  custodian: string;
  acceptedCustody: boolean;
  blobHash: string | null;
  openChallenges: number;
  lastResponseAt: string | null;
  status: CustodianStatus;
}

export interface StatusView {
  policyId: string;
  owner: string;
  k: string;
  n: string;
  frequencyHours: string;
  custodians: CustodianView[];
  lastDistributedAt: string | null;
}

export async function fetchParticipant1Alive(): Promise<boolean> {
  const res = await fetch(`${API_URL}/participant1-status`);
  if (!res.ok) return false;
  const body = (await res.json()) as { alive?: boolean };
  return body.alive ?? false;
}

export async function fetchStatus(): Promise<StatusView> {
  const res = await fetch(`${API_URL}/status`);
  const body = (await res.json()) as StatusView & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `GET /status failed: ${res.status}`);
  return body;
}

export interface PositionView {
  counterparty: string;
  amount: string;
  currency: string;
  label: string;
}

export async function fetchPositions(): Promise<PositionView[]> {
  const res = await fetch(`${API_URL}/positions`);
  const body = (await res.json()) as { positions?: PositionView[] };
  if (!res.ok) return [];
  return body.positions ?? [];
}

export interface CiphertextSample {
  custodianEndpoint: string;
  policyId: string;
  byteLength: number;
  hexPreview: string;
}

export async function fetchCiphertext(): Promise<CiphertextSample | null> {
  const res = await fetch(`${API_URL}/ciphertext`);
  if (!res.ok) return null;
  return (await res.json()) as CiphertextSample;
}

export interface RecoverRequest {
  targetParticipant: string;
  endpoints: string[];
  k: number;
}

export async function triggerRecover(req: RecoverRequest): Promise<string> {
  const res = await fetch(`${API_URL}/recover`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  const body = (await res.json()) as { result?: string; error?: string };
  if (!res.ok) throw new Error(body.error ?? `POST /recover failed: ${res.status}`);
  return body.result ?? "";
}

// Real execution order (see agent/src/recover.ts) — identity is
// re-authorized before the encryption key is even touched, not "key first"
// as the narration might suggest.
export type RecoverStep = "identity-reauthorized" | "key-reconstructed" | "state-restored";

// Mirrors agent/src/rehostParty.ts's RehostSubStep exactly — real phases of
// re-authorizing identity on the target (propose/sign/load/verify), each
// reported when it actually happens. Added 2026-09-29: a single milestone
// at the end of this whole phase left the recovery graph looking dead for
// most of a real recovery's wall-clock time.
export type RehostSubStep =
  | "checking-idempotency"
  | "already-hosted"
  | "proposing"
  | "proposed"
  | "signing"
  | "signed"
  | "loading"
  | "loaded"
  | "verifying"
  | "verified";

// Mirrors agent/src/recover.ts's RecoverEvent exactly — one event per real
// network round trip to a custodian, one per real identity-reauthorization
// sub-phase, plus the three milestones. Nothing here is invented
// client-side; every event corresponds to something the backend actually
// did.
export type RecoverEvent =
  | { type: "custodian-query"; endpoint: string }
  | { type: "custodian-response"; endpoint: string; ok: boolean }
  | { type: "rehost-substep"; step: RehostSubStep; detail?: string }
  | { type: "milestone"; step: RecoverStep };

export async function fetchRecoverProgress(): Promise<RecoverEvent[]> {
  const res = await fetch(`${API_URL}/recover-progress`);
  const body = (await res.json()) as { events?: RecoverEvent[] };
  if (!res.ok) return [];
  return body.events ?? [];
}

// The demo's closing step: a real counterparty proposes a Record naming the
// (possibly just-recovered) owner as observer, and the owner then signs the
// acceptance themselves — the returned ids/parties are real ledger data,
// not derived client-side.
export interface CounterpartyTxResult {
  proposalContractId: string;
  recordContractId: string;
  proposer: string;
  owner: string;
  label: string;
  ownerParticipant: string;
}

export async function triggerCounterpartyTx(): Promise<CounterpartyTxResult> {
  const res = await fetch(`${API_URL}/counterparty-tx`, { method: "POST" });
  const body = (await res.json()) as CounterpartyTxResult & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `POST /counterparty-tx failed: ${res.status}`);
  return body;
}
