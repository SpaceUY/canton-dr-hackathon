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
