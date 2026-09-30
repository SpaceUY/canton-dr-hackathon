# canton-dr — Run guide

Step-by-step guide to bring up the whole stack locally and run the demo.
For *why* things are built this way, see `../infra/README.md` (one
"Step N findings" section per plan step) and `../CLAUDE.md` (the original
problem/solution/scope). For what's done and what's left, see
`ROADMAP.md`.

## Prerequisites

- **Docker Desktop, with at least 10GB of memory allocated.** 5 Canton
  JVMs + 3 agents + the dashboard came close to OOM-killing containers at
  Docker Desktop's default (7.65GB) during testing — see step 4's findings
  in `../infra/README.md`.
- **Node.js + pnpm** — for building the Daml model and running the UI.
- **`dpm`** (Digital Asset Package Manager) — not on `PATH` by default.
  Download from https://github.com/digital-asset/dpm/releases
  (`dpm-<version>-darwin-arm64.tar.gz` for Apple Silicon Macs).

## 1. Build the Daml model

```sh
cd daml
DAML_VERSION=3.5.2 dpm build
```

Produces `.daml/dist/canton-dr-0.1.0.dar` — `bootstrap` (next step) finds
it automatically, no need to reference the filename anywhere.

## 2. Start the Canton topology

```sh
cd infra
docker compose up -d synchronizer participant1 participant2 participant3 participant4
```

Wait until all 5 report healthy (`docker compose ps`, or watch
`docker compose logs -f`), then:

```sh
docker compose up bootstrap   # connects the 4 participants, uploads the DAR
docker compose up seed        # creates the demo Record contract on 1/2/3
```

Both are one-shot containers — they run once and exit 0 on success. If
either fails, re-run it; both are idempotent.

## 3. Start the agents and the dashboard

```sh
docker compose up -d agent1 agent2 agent3 dashboard
```

- `agent1`/`agent2`/`agent3`: one HTTP server per node, storing/returning
  encrypted blobs and key shares (the custodian side of backup/recovery).
- `dashboard`: the owner-facing API the UI talks to (port `4010`).

## 4. Seed a backup policy

This creates the on-ledger registry, distributes the encrypted backup to
the 3 custodians, and has 2 of them accept custody — so the dashboard and
the demo have something real to show.

```sh
docker compose run --rm agent create-policy --owner-participant participant1:5013 --owner owner \
  --custodian participant2:5023:custodian2 --custodian participant3:5033:custodian3 \
  --k 2 --n 3 --frequency-hours 1 --policy-id demo

docker compose run --rm agent distribute --source participant1 --party owner --policy-id demo \
  --endpoints http://agent1:4001,http://agent2:4002,http://agent3:4003 --k 2

docker compose run --rm agent accept-custody --as agent2 --participant participant2:5023 --custodian custodian2 \
  --owner-participant participant1:5013 --owner owner --policy-id demo

docker compose run --rm agent accept-custody --as agent3 --participant participant3:5033 --custodian custodian3 \
  --owner-participant participant1:5013 --owner owner --policy-id demo
```

Optional, to see a custodian in "Awaiting response" instead of "No
challenge yet":

```sh
docker compose run --rm agent challenge --owner-participant participant1:5013 --owner owner \
  --custodian-participant participant2:5023 --custodian custodian2 --policy-id demo --challenge-id ch-1
```

Check it worked:

```sh
curl -s http://localhost:4010/status | python3 -m json.tool
```

## 5. Run the UI

```sh
cd ui
pnpm install   # first time only
pnpm dev
```

Open the URL it prints (`http://localhost:5173`). You should see the
policy (`k=2 n=3 frequency=1h`), a table with both custodians and their
status, and a "Recover" button.

## 6. Run the recovery demo

The story: participant1 (the owner) loses its base; recovery uses 2 of the
3 key shares to decrypt the backup and restore the state onto an empty
node. Concretely, the empty node is `participant4` — a stand-in kept
separate from participant1/2/3 on purpose, so the demo doesn't need to
solve node identity recovery too (a deliberately separate, out-of-scope
problem — see `../CLAUDE.md`).

Click **Recover** in the UI, or the same thing from the command line:

```sh
docker compose run --rm agent recover --target participant4 --policy-id demo \
  --endpoints http://agent2:4002,http://agent3:4003 --k 2
```

Note this uses only `agent2` and `agent3` — `agent1` (the owner's own
share) is deliberately left out, so the recovery genuinely depends on the
2-of-3 threshold rather than the happy path where every share is available.

Verify the recovered contract directly. `activeAtOffset: 0` means "at the
very start of the ledger" (empty) — fetch the real ledger end first:

```sh
OWNER="<owner-party-id>"   # from the dashboard's /status response
END=$(curl -s http://localhost:5043/v2/state/ledger-end -H "Content-Type: application/json" | jq -r .offset)
curl -s http://localhost:5043/v2/state/active-contracts \
  -H "Content-Type: application/json" \
  --data-raw '{"filter":{"filtersByParty":{"'"$OWNER"'":{"cumulative":[{"identifierFilter":{"WildcardFilter":{"value":{"includeCreatedEventBlob":false}}}}]}},"verbose":true},"verbose":true,"activeAtOffset":'"$END"'}' \
  | jq -c '.[].contractEntry.JsActiveContract.createdEvent | {templateId}'
```

To prove the custodian never saw plaintext, show the raw stored blob:

```sh
docker run --rm -v infra_agent2_custody:/data alpine sh -c "xxd /data/demo/blob.enc | head -5"
```

## 7. Show the cryptographic proof (ACS commitments)

This is the other half of the pitch's one-liner: proof the shared state is
correct, independent of the backup. Ask a custodian what it independently
computed and matched about its shared state with the owner:

```sh
docker compose run --rm agent check-commitment --counterparty-participant participant2 --about-participant participant1
```

The output lists real, historical commitment periods (one per minute), each
with the SHA-256 hash `participant1` and `participant2` computed
*independently* and its match state — `Match` means both sides agree on the
shared state without either trusting the other, or the backup. This works
for any custodian pair (swap in `participant3`) and needs no prior setup
beyond the policy from step 4 — the topology has been computing these in
the background the whole time.

Note this only verifies the *pre-disaster* state — the recovery target
(`participant4`) is a stand-in with a fresh identity (step 6, deliberately
out of scope), so it has no commitment history of its own yet to check
against.

## Resetting between runs

`participant4` and the 3 agents keep state in named Docker volumes, so a
plain restart resumes where you left off (useful — `recover` is
idempotent, re-running it doesn't duplicate anything). To start completely
fresh:

```sh
docker compose down
docker volume rm infra_participant4_data infra_agent1_custody infra_agent2_custody infra_agent3_custody infra_agent_exports
```

then repeat from step 2. Skipping the volume cleanup after a full
`docker compose down` is the most common failure mode here: `participant4`
comes back remembering a synchronizer identity from the previous run (the
synchronizer itself is in-memory, so it gets a new one every time) and
fails to reconnect. If you see `Connection is not on expected sequencer`
in `bootstrap`'s logs, this is why — remove the volumes and start over.

## Troubleshooting

- **A participant container exits with code 137**: OOM-killed. Raise
  Docker Desktop's memory limit (see Prerequisites). Restarting just that
  one participant (`docker compose up -d <service>`) is *not* enough by
  itself: `participant1/2/3` use in-memory storage, so the restarted one
  comes back with a brand new identity, and any already-created contract
  that named its *old* identity as a party (a `BackupPolicy`'s custodian,
  for instance) becomes permanently invisible to the new one —
  `accept-custody` and similar will fail with `no BackupPolicy ... visible
  to <party>`. After restarting the affected participant, re-run
  `docker compose up bootstrap` then `docker compose up seed` so it
  properly rejoins, and re-create anything (like the demo policy) that
  referenced its old identity. If in doubt, do the full reset below
  instead of restarting a single participant.
- **`docker compose run agent1 ...` (or `agent2`/`agent3`) hangs or gives
  `ECONNREFUSED`**: don't run commands on `agent1/2/3` — they're the
  persistent custodian servers. Always use the separate `agent` service
  for commands (`docker compose run --rm agent ...`), even when the
  command's endpoints point at `agent1/2/3`.
- **`bootstrap` or `seed` seem to re-run every time you bring up something
  else**: only `agent1`/`agent2`/`agent3`/`dashboard` used to depend on
  `seed` completing — that dependency was removed because it caused
  exactly this. If it's happening again, check `depends_on` in
  `infra/docker-compose.yml`.
