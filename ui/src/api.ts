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

// Mirrors agent/src/recover.ts's RecoverEvent exactly — one event per real
// network round trip to a custodian, plus the three milestones. Nothing
// here is invented client-side; every event corresponds to something the
// backend actually did.
export type RecoverEvent =
  | { type: "custodian-query"; endpoint: string }
  | { type: "custodian-response"; endpoint: string; ok: boolean }
  | { type: "milestone"; step: RecoverStep };

export async function fetchRecoverProgress(): Promise<RecoverEvent[]> {
  const res = await fetch(`${API_URL}/recover-progress`);
  const body = (await res.json()) as { events?: RecoverEvent[] };
  if (!res.ok) return [];
  return body.events ?? [];
}
