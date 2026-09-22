import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { queryActive, resolveParty, type ActiveContract } from "./ledger.js";
import { recover } from "./recover.js";

export interface DashboardOptions {
  port: number;
  ownerParticipant: string;
  ownerPartyHint: string;
  policyId: string;
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
}

// Owner-facing read/status API + the recovery trigger for the UI (plan
// step 7). Separate from `serve` (the custodian-side blob/share storage
// server that runs on agent1/2/3) — this is a different concern, run once
// from wherever the owner's agent is.
export function startDashboard(options: DashboardOptions): void {
  const { port, ownerParticipant, ownerPartyHint, policyId } = options;

  const server = createServer((req, res) => {
    void handle(req, res, ownerParticipant, ownerPartyHint, policyId);
  });

  server.listen(port, () => {
    console.log(`dashboard listening on :${port} for policy ${policyId}`);
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ownerParticipant: string,
  ownerPartyHint: string,
  policyId: string,
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
      const status = await getStatus(ownerParticipant, ownerPartyHint, policyId);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(status));
      return;
    }

    if (req.method === "POST" && req.url === "/recover") {
      const body = JSON.parse((await readBody(req)).toString() || "{}") as {
        targetParticipant?: string;
        endpoints?: string[];
        k?: number;
      };
      if (body.targetParticipant === undefined || body.endpoints === undefined || body.k === undefined) {
        res.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({ error: "expected { targetParticipant, endpoints, k }" }),
        );
        return;
      }
      const result = await recover({
        targetParticipant: body.targetParticipant,
        policyId,
        endpoints: body.endpoints,
        threshold: body.k,
      });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result }));
      return;
    }

    res.writeHead(404).end();
  } catch (err) {
    res
      .writeHead(500, { "content-type": "application/json" })
      .end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function getStatus(
  ownerParticipant: string,
  ownerPartyHint: string,
  policyId: string,
): Promise<StatusView> {
  const owner = await resolveParty(ownerParticipant, ownerPartyHint);

  const policies = await queryActive(ownerParticipant, owner, ":BackupPolicy:BackupPolicy");
  const policy = policies.find((p) => p.payload["policyId"] === policyId);
  if (policy === undefined) {
    throw new Error(`no BackupPolicy with policyId '${policyId}' visible to ${owner} on ${ownerParticipant}`);
  }
  const custodians = policy.payload["custodians"] as string[];

  const [agreements, challenges, responses] = await Promise.all([
    queryActive(ownerParticipant, owner, ":BackupPolicy:CustodianAgreement"),
    queryActive(ownerParticipant, owner, ":BackupPolicy:Challenge"),
    queryActive(ownerParticipant, owner, ":BackupPolicy:ChallengeResponse"),
  ]);

  const forCustodian = (contracts: ActiveContract[], custodian: string): ActiveContract[] =>
    contracts.filter((c) => c.payload["policyId"] === policyId && c.payload["custodian"] === custodian);

  const custodianViews: CustodianView[] = custodians.map((custodian) => {
    const agreement = forCustodian(agreements, custodian)[0];
    const openChallenges = forCustodian(challenges, custodian);
    const custResponses = forCustodian(responses, custodian);
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
  };
}
