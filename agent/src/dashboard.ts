import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { counterpartyTx } from "./counterpartyTx.js";
import type { CustodianRef } from "./createPolicy.js";
import { queryActive, resolveParty, type ActiveContract } from "./ledger.js";
import { loadExternalPartyIdentity } from "./externalParty.js";
import { recover, type RecoverEvent } from "./recover.js";

// One demo operator, one recovery at a time — a single shared slot is
// enough. Reset at the start of every /recover call. Polled by the UI (see
// ui/src/RecoveryGraph.tsx) while a recovery is in flight, so the live demo
// shows each custodian responding (or not) and the three real milestones
// landing, instead of a single opaque spinner for the ~30-90s a real
// re-authorization + restore can take.
let recoverEvents: RecoverEvent[] = [];

// Same identity seed.ts allocated `owner` under — used to know WHO owner is
// (a local file read, no network, never affected by owner's own participant
// being down). WHERE to query for owner's contracts is a separate question —
// see statusCustodians below.
const OWNER_KEY_PATH = process.env.OWNER_KEY_PATH ?? "/canton/identity/owner.der";

export interface DashboardOptions {
  port: number;
  // /status queries via the custodians' own participants, not owner's — a
  // custodian is an observer on BackupPolicy regardless of whether owner's
  // own hosting participant is alive. Querying via owner's participant broke
  // /status permanently the moment participant1 died in testing: recovering
  // owner onto a new participant never made the dashboard look anywhere
  // else, so the error just stayed on screen for the rest of the demo.
  // Every custodian is queried (not just one) because Challenge/
  // CustodianAgreement/etc name only ONE specific custodian as observer
  // (see daml/BackupPolicy.daml) — a single custodian's view is missing the
  // others' rows entirely, not just stale. Fixed 2026-09-29, same
  // "don't trust owner's own participant to be alive" pattern as
  // recoverIdentityKey (agent/src/recoverIdentity.ts).
  statusCustodians: CustodianRef[];
  policyId: string;
  // The only recovery target/endpoints this dashboard will act on — set at
  // startup (see cli.ts's `dashboard` command), not trusted from the
  // request body. Without this, `/recover` would run whatever
  // targetParticipant/endpoints a POST body claims, on an unauthenticated
  // endpoint (see agent/src/restore.ts's script injection guard for the
  // other half of this: even a validated endpoint list doesn't help if the
  // target participant name itself isn't a safe identifier).
  recoverTarget: string;
  recoverEndpoints: string[];
  // Same node as recoverTarget, as its http-ledger-api host:port — used only
  // for the idempotency check in rehostParty.ts.
  recoverTargetLedgerApi: string;
  // Console name of a live, still-connected participant used to load the
  // signed re-hosting proposal during recovery (see rehostParty.ts) — fixed
  // at startup for the same reason recoverTarget/recoverEndpoints are.
  recoverLoaderParticipant: string;
  // The demo's closing step (POST /counterparty-tx) — which real local
  // party plays "the counterparty" and where it lives. Fixed at startup,
  // not trusted from the request body, same reasoning as recoverTarget
  // above: an unauthenticated endpoint must never take its actor identity
  // from the caller.
  counterpartyTxAs: string;
  counterpartyTxParticipant: string;
}

type CustodianStatus =
  | "no-custody-accepted"
  | "awaiting-response"
  | "ok"
  | "no-challenge-yet";

interface CustodianView {
  custodian: string;
  acceptedCustody: boolean;
  blobHash: string | null;
  openChallenges: number;
  lastResponseAt: string | null;
  status: CustodianStatus;
}

interface StatusView {
  policyId: string;
  owner: string;
  k: string;
  n: string;
  frequencyHours: string;
  custodians: CustodianView[];
  // RPO signal: the oldest blob.enc mtime across the real (non-self-copy)
  // custodians — the worst case, not the best one, since that's the
  // custodian a real recovery would actually be depending on if it were
  // the slowest to get refreshed. null only if no custodian could be
  // reached at all.
  lastDistributedAt: string | null;
}

interface PositionView {
  counterparty: string;
  amount: string;
  currency: string;
  label: string;
}

// Owner-facing read/status API + the recovery trigger for the UI (plan
// step 7). Separate from `serve` (the custodian-side blob/share storage
// server that runs on agent1/2/3) — this is a different concern, run once
// from wherever the owner's agent is.
export function startDashboard(options: DashboardOptions): void {
  const {
    port,
    statusCustodians,
    policyId,
    recoverTarget,
    recoverEndpoints,
    recoverTargetLedgerApi,
    recoverLoaderParticipant,
    counterpartyTxAs,
    counterpartyTxParticipant,
  } = options;

  const server = createServer((req, res) => {
    void handle(
      req,
      res,
      statusCustodians,
      policyId,
      recoverTarget,
      recoverEndpoints,
      recoverTargetLedgerApi,
      recoverLoaderParticipant,
      counterpartyTxAs,
      counterpartyTxParticipant,
    );
  });

  server.listen(port, () => {
    console.log(`dashboard listening on :${port} for policy ${policyId}`);
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  statusCustodians: CustodianRef[],
  policyId: string,
  recoverTarget: string,
  recoverEndpoints: string[],
  recoverTargetLedgerApi: string,
  recoverLoaderParticipant: string,
  counterpartyTxAs: string,
  counterpartyTxParticipant: string,
): Promise<void> {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  try {
    if (req.method === "GET" && req.url === "/status") {
      const status = await getStatus(statusCustodians, policyId, recoverEndpoints);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(status));
      return;
    }

    if (req.method === "GET" && req.url === "/positions") {
      const positions = await getPositions(statusCustodians);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ positions }));
      return;
    }

    if (req.method === "GET" && req.url === "/ciphertext") {
      const ciphertext = await getCiphertextSample(recoverEndpoints, policyId);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(ciphertext));
      return;
    }

    if (req.method === "GET" && req.url === "/participant1-status") {
      const alive = await isParticipant1Alive();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ alive }));
      return;
    }

    if (req.method === "GET" && req.url === "/recover-progress") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ events: recoverEvents }));
      return;
    }

    if (req.method === "POST" && req.url === "/recover") {
      const body = JSON.parse((await readBody(req)).toString() || "{}") as {
        targetParticipant?: string;
        endpoints?: string[];
        k?: number;
      };

      const validationError = validateRecoverRequest(body, recoverTarget, recoverEndpoints);
      if (validationError !== undefined) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: validationError }));
        return;
      }

      recoverEvents = [];
      const result = await recover({
        targetParticipant: body.targetParticipant as string,
        targetLedgerApi: recoverTargetLedgerApi,
        loaderParticipant: recoverLoaderParticipant,
        policyId,
        endpoints: body.endpoints as string[],
        threshold: body.k as number,
        onProgress: (event) => {
          recoverEvents = [...recoverEvents, event];
        },
      });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result }));
      return;
    }

    if (req.method === "POST" && req.url === "/counterparty-tx") {
      // Zero client-trusted input: actor, participant and target are all
      // fixed at dashboard startup (see counterpartyTxAs/counterpartyTxParticipant
      // above) — only the label varies, and it's generated here, never
      // taken from the request body, so two clicks can never collide.
      const label = `post-recovery-demo-${Date.now()}`;
      const result = await counterpartyTx({
        as: counterpartyTxAs,
        participant: counterpartyTxParticipant,
        ownerParticipant: recoverTargetLedgerApi,
        label,
      });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
      return;
    }

    res.writeHead(404).end();
  } catch (err) {
    console.error("dashboard request failed:", err);
    // Not a generic "internal error": this backend has no auth and no
    // adversarial clients (a trusted demo network, see server.ts's own
    // comment) - the actual message (e.g. "only 1 of 2 required
    // custodians responded") is exactly what a presenter needs to see on
    // screen instead of a dead end, not a leaked internal detail worth
    // hiding.
    const message = err instanceof Error ? err.message : "internal error";
    res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: message }));
  }
}

// Every field here is attacker-controlled (this endpoint has no auth) — none
// of it is trusted just because it round-trips through JSON.parse. Returns
// an error message, or undefined if the request is valid.
function validateRecoverRequest(
  body: { targetParticipant?: string; endpoints?: string[]; k?: number },
  recoverTarget: string,
  recoverEndpoints: string[],
): string | undefined {
  if (typeof body.targetParticipant !== "string" || body.targetParticipant !== recoverTarget) {
    return `targetParticipant must be '${recoverTarget}'`;
  }
  if (!Array.isArray(body.endpoints) || body.endpoints.length === 0) {
    return "endpoints must be a non-empty array of strings";
  }
  if (!body.endpoints.every((e) => typeof e === "string" && recoverEndpoints.includes(e))) {
    return `every endpoint must be one of: ${recoverEndpoints.join(", ")}`;
  }
  if (typeof body.k !== "number" || !Number.isInteger(body.k) || body.k <= 0) {
    return "k must be a positive integer";
  }
  return undefined;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// What a judge sees destroyed and recovered — real counterparties and
// signed amounts (daml/Position.daml), not the abstract seed Record.
// Queried via a custodian's own participant, same "never trust owner's own
// participant to be alive" rule as getStatus below — Position is an
// observer contract for every custodian equally, so the first one is
// enough (no per-custodian filtering needed, unlike Challenge/etc).
// Real reachability, not a hardcoded "dead from the start" — the UI's map
// (ui/src/RecoveryGraph.tsx) is meant to be honest before the disaster too
// (that's the whole point of retiring the separate pre-disaster strip in
// favor of one always-visible map). The presenter kills participant1 from a
// terminal, never from the UI (ADR-006) — this is how the screen finds out.
async function isParticipant1Alive(): Promise<boolean> {
  try {
    const res = await fetch("http://participant1:5013/v2/parties/participant-id");
    return res.ok;
  } catch {
    return false;
  }
}

async function getPositions(statusCustodians: CustodianRef[]): Promise<PositionView[]> {
  if (statusCustodians.length === 0) throw new Error("no custodians configured for position queries");
  const first = statusCustodians[0];
  if (first === undefined) throw new Error("no custodians configured for position queries");
  const party = await resolveParty(first.participant, first.partyHint);
  const contracts = await queryActive(first.participant, party, ":Position:Position");
  return contracts.map((c) => ({
    counterparty: String(c.payload["counterparty"]),
    amount: String(c.payload["amount"]),
    currency: String(c.payload["currency"]),
    label: String(c.payload["label"]),
  }));
}

interface CiphertextSample {
  custodianEndpoint: string;
  policyId: string;
  byteLength: number;
  hexPreview: string;
}

// The custodian's own view — real bytes fetched from its actual custody
// store (agent/src/server.ts's GET /custody/:policyId/blob), the same file
// distributeBlob() wrote and recover() reads back. Not a terminal `xxd` of
// the same file — the UI panel shown alongside real Positions, proving the
// custodian never held plaintext.
async function getCiphertextSample(recoverEndpoints: string[], policyId: string): Promise<CiphertextSample> {
  // recoverEndpoints[0] is agent1 — owner's OWN self-custody backup copy,
  // not a custodian (see RecoveryGraph.tsx's labeling). The demo's point is
  // that a real, independent CUSTODIAN never saw plaintext, so pick the
  // first genuine custodian server instead — falling back to index 0 only
  // if this dashboard is somehow configured with a single endpoint.
  const endpoint = recoverEndpoints[1] ?? recoverEndpoints[0];
  if (endpoint === undefined) throw new Error("no custodian endpoints configured");
  const res = await fetch(`${endpoint}/custody/${policyId}/blob`);
  if (!res.ok) throw new Error(`GET ${endpoint}/custody/${policyId}/blob failed: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  return {
    custodianEndpoint: endpoint,
    policyId,
    byteLength: bytes.length,
    hexPreview: bytes.subarray(0, 256).toString("hex"),
  };
}

// recoverEndpoints[0] is agent1 — owner's own self-custody copy, never used
// by a real recovery (see getCiphertextSample's own comment) — so it's
// excluded here too: what matters for RPO is how stale the custodians an
// actual recovery would depend on are, not the owner's own spare.
async function getBackupFreshness(recoverEndpoints: string[], policyId: string): Promise<string | null> {
  const custodianEndpoints = recoverEndpoints.slice(1);
  const mtimes: number[] = [];
  for (const endpoint of custodianEndpoints) {
    try {
      const res = await fetch(`${endpoint}/custody/${policyId}/blob/meta`);
      if (!res.ok) continue;
      const body = (await res.json()) as { blobMtime?: string };
      if (body.blobMtime !== undefined) mtimes.push(new Date(body.blobMtime).getTime());
    } catch {
      // Unreachable custodian: skip it for this metric, same "don't let one
      // dead endpoint take down the whole read" rule as the rest of the
      // dashboard's status queries.
    }
  }
  if (mtimes.length === 0) return null;
  return new Date(Math.min(...mtimes)).toISOString();
}

async function getStatus(
  statusCustodians: CustodianRef[],
  policyId: string,
  recoverEndpoints: string[],
): Promise<StatusView> {
  const owner = (await loadExternalPartyIdentity(OWNER_KEY_PATH)).partyId;
  if (statusCustodians.length === 0) throw new Error("no custodians configured for status queries");

  const resolved = await Promise.all(
    statusCustodians.map(async (c) => ({
      participant: c.participant,
      party: await resolveParty(c.participant, c.partyHint),
    })),
  );

  // BackupPolicy is visible to every custodian (observer custodians, the
  // full list) — asking the first one is enough to learn the policy itself.
  // Matched by owner id too, not just policyId: this project's demo
  // environment genuinely accumulates more than one BackupPolicy sharing the
  // same policyId across re-seeds/re-tests (see ADR-007 in the vault) —
  // picking the first query match reproduced that exact bug here during
  // testing.
  const first = resolved[0];
  if (first === undefined) throw new Error("no custodians configured for status queries");
  const policies = await queryActive(first.participant, first.party, ":BackupPolicy:BackupPolicy");
  const policy = policies.find((p) => p.payload["policyId"] === policyId && p.payload["owner"] === owner);
  if (policy === undefined) {
    throw new Error(
      `no BackupPolicy with policyId '${policyId}' and owner '${owner}' visible to ${first.party} on ${first.participant}`,
    );
  }

  // Challenge/CustodianAgreement/ChallengeResponse each name only ONE
  // specific custodian as observer (daml/BackupPolicy.daml) — custodian2's
  // own view never includes custodian3's records, so every custodian must
  // be queried via its own participant and merged, not just one of them.
  const perCustodian = await Promise.all(
    resolved.map(async ({ participant, party }) => {
      const [agreements, challenges, responses] = await Promise.all([
        queryActive(participant, party, ":BackupPolicy:CustodianAgreement"),
        queryActive(participant, party, ":BackupPolicy:Challenge"),
        queryActive(participant, party, ":BackupPolicy:ChallengeResponse"),
      ]);
      return { custodian: party, agreements, challenges, responses };
    }),
  );

  const forThisCustodian = (contracts: ActiveContract[], custodian: string): ActiveContract[] =>
    contracts.filter((c) => c.payload["policyId"] === policyId && c.payload["custodian"] === custodian);

  const custodianViews: CustodianView[] = perCustodian.map(({ custodian, agreements, challenges, responses }) => {
    const agreement = forThisCustodian(agreements, custodian)[0];
    const openChallenges = forThisCustodian(challenges, custodian);
    const custResponses = forThisCustodian(responses, custodian);
    const lastResponse = [...custResponses].sort((a, b) =>
      String(b.payload["respondedAt"]).localeCompare(String(a.payload["respondedAt"])),
    )[0];

    let status: CustodianStatus;
    if (agreement === undefined) status = "no-custody-accepted";
    else if (openChallenges.length > 0) status = "awaiting-response";
    else if (lastResponse !== undefined) status = "ok";
    else status = "no-challenge-yet";

    return {
      custodian,
      acceptedCustody: agreement !== undefined,
      blobHash: (agreement?.payload["blobHash"] as string | undefined) ?? null,
      openChallenges: openChallenges.length,
      lastResponseAt: (lastResponse?.payload["respondedAt"] as string | undefined) ?? null,
      status,
    };
  });

  return {
    policyId,
    owner,
    k: String(policy.payload["k"]),
    n: String(policy.payload["n"]),
    frequencyHours: String(policy.payload["frequencyHours"]),
    custodians: custodianViews,
    lastDistributedAt: await getBackupFreshness(recoverEndpoints, policyId),
  };
}
