// Thin wrapper over the plain Ledger JSON API (same approach and same
// `/v2/commands/submit-and-wait` endpoint as infra/canton/seed.sh, ported
// to TypeScript) — create/exercise/query. No auth configured on these
// nodes, so `participant_admin` can act as anyone.
//
// create/exercise return nothing: everything in this project is looked up
// afterwards by business key (policyId, challengeId) via queryActive, not
// by the Daml contract ID a submission would hand back.

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json" },
  });
  if (!res.ok) {
    throw new Error(`${init?.method ?? "GET"} ${url} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

// participant is host:port of its http-ledger-api, e.g. "participant1:5013".
export async function resolveParty(participant: string, hint: string): Promise<string> {
  const namespace = await participantNamespace(participant);
  const found = await request<{ partyDetails: { party: string }[] }>(
    `http://${participant}/v2/parties/party?parties=${hint}::${namespace}`,
  );
  const existing = found.partyDetails[0]?.party;
  if (existing !== undefined) return existing;

  const allocated = await request<{ partyDetails: { party: string } }>(`http://${participant}/v2/parties`, {
    method: "POST",
    body: JSON.stringify({ partyIdHint: hint, identityProviderId: "" }),
  });
  return allocated.partyDetails.party;
}

export async function getSynchronizerId(participant: string, alias = "da"): Promise<string> {
  const info = await request<{ connectedSynchronizers: { synchronizerAlias: string; synchronizerId: string }[] }>(
    `http://${participant}/v2/state/connected-synchronizers`,
  );
  const match = info.connectedSynchronizers.find((s) => s.synchronizerAlias === alias);
  if (match === undefined) throw new Error(`${participant} is not connected to synchronizer '${alias}'`);
  return match.synchronizerId;
}

async function participantNamespace(participant: string): Promise<string> {
  const info = await request<{ participantId: string }>(`http://${participant}/v2/parties/participant-id`);
  const namespace = info.participantId.split("::")[1];
  if (namespace === undefined) throw new Error(`unexpected participantId shape: ${info.participantId}`);
  return namespace;
}

export async function createContract(
  participant: string,
  actAs: string,
  templateId: string,
  createArguments: Record<string, unknown>,
): Promise<void> {
  await request(`http://${participant}/v2/commands/submit-and-wait`, {
    method: "POST",
    body: JSON.stringify({
      commands: [{ CreateCommand: { templateId, createArguments } }],
      userId: "participant_admin",
      commandId: `agent-create-${Date.now()}`,
      actAs: [actAs],
      readAs: [actAs],
    }),
  });
}

export async function exerciseChoice(
  participant: string,
  actAs: string,
  templateId: string,
  contractId: string,
  choice: string,
  choiceArgument: Record<string, unknown>,
): Promise<void> {
  await request(`http://${participant}/v2/commands/submit-and-wait`, {
    method: "POST",
    body: JSON.stringify({
      commands: [{ ExerciseCommand: { templateId, contractId, choice, choiceArgument } }],
      userId: "participant_admin",
      commandId: `agent-exercise-${Date.now()}`,
      actAs: [actAs],
      readAs: [actAs],
    }),
  });
}

export interface ActiveContract {
  contractId: string;
  templateId: string;
  payload: Record<string, unknown>;
}

// templateSuffix matches the end of templateId, e.g. ":BackupPolicy:Challenge".
export async function queryActive(
  participant: string,
  party: string,
  templateSuffix: string,
): Promise<ActiveContract[]> {
  const end = await request<{ offset: number }>(`http://${participant}/v2/state/ledger-end`);
  const rows = await request<
    {
      contractEntry?: {
        JsActiveContract?: {
          createdEvent?: { contractId: string; templateId: string; createArgument: Record<string, unknown> };
        };
      };
    }[]
  >(`http://${participant}/v2/state/active-contracts`, {
    method: "POST",
    body: JSON.stringify({
      filter: {
        filtersByParty: {
          [party]: {
            cumulative: [
              { identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } },
            ],
          },
        },
        verbose: true,
      },
      verbose: true,
      activeAtOffset: end.offset,
    }),
  });

  const contracts: ActiveContract[] = [];
  for (const row of rows) {
    const created = row.contractEntry?.JsActiveContract?.createdEvent;
    if (created !== undefined && created.templateId.endsWith(templateSuffix)) {
      contracts.push({
        contractId: created.contractId,
        templateId: created.templateId,
        payload: created.createArgument,
      });
    }
  }
  return contracts;
}
