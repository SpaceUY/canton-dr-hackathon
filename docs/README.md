# canton-dr — run guide and reference

How to run, drive and troubleshoot the canton-dr environment. For what the project is, what's real
versus not, and its known limitations, start at the [root README](../README.md). For why it's built
this way, see [DECISIONS.md](DECISIONS.md). Everything here was verified against the real Canton
3.5.18 binary, including genuinely destroying a container and its volume.

## Prerequisites

- **Docker Desktop, with at least 10GB of memory allocated.** 5 Canton JVMs + 3 custodian agents +
  the dashboard came close to OOM-killing containers at Docker Desktop's default (7.65GB) during
  testing.
- **Node.js + pnpm** — for running the UI (and the agent's local typecheck/test). The agent itself
  runs in Docker.
- **`curl`** — `make build-dar` uses it to fetch `dpm` when it isn't installed.
- **Nothing else to install for the Daml model.** `make build-dar` (see Quick start below) builds it
  whether or not `dpm`/`damlc` are on `PATH` — if neither is, it downloads `dpm`'s own binary for
  your OS/arch straight from https://github.com/digital-asset/dpm/releases into `daml/.dpm-cache/`
  (gitignored, not installed system-wide) and builds with that. See `daml/build-dar.sh`. If you'd
  rather install `dpm` or `damlc` yourself and keep it on `PATH`, that's used instead automatically —
  no official Docker image exists for the Daml SDK to build in a container (same situation as Canton
  3.x images, see `infra/README.md`).

## Quick start (recommended)

One command rebuilds the whole environment from scratch into a verified, working pre-disaster
state — owner's node alive, policy active, custodians have accepted custody and answered a real
challenge, 3 real positions seeded:

```sh
make build-dar      # builds the DAR (downloads dpm if needed) - only needed once, or after changing daml/
make rebuild        # builds the agent image once
make demo-reset     # tears down, rebuilds, seeds, and verifies - takes a few minutes
```

`make demo-reset` ends with `agent verify-demo-state`, which **fails loudly, naming exactly what's
wrong**, if the result isn't genuinely a fresh pre-disaster state (e.g. `participant1` unreachable,
a custodian hasn't accepted custody, positions missing). If it succeeds, you're ready to run the
demo. If a step fails with a transient Canton or Docker error (this happens occasionally, especially
right after a burst of other `docker` activity — see Troubleshooting), just re-run `make demo-reset`;
every step in it is idempotent.

Then start the UI:

```sh
cd ui
pnpm install   # first time only
pnpm dev
```

Open the URL it prints (`http://localhost:5173`) — you'll see the live dashboard: a metrics strip,
the system map (participant1 shown genuinely alive, polled every 3s), real positions, real
custodian status, and a **Recover** button.

## Running the demo end to end

The beat-by-beat 5-minute version, with measured timings, is in the
[root README](../README.md#the-demo-about-5-minutes). Step by step, once `make demo-reset` has left
you in a clean pre-disaster state:

**1. Destroy the node for real** (not just `docker stop` — Canton's JVM does a graceful shutdown of
variable length; `-t 1` forces it fast and is more honest to what a real disaster does anyway):

```sh
cd infra
docker stop -t 1 infra-participant1-1 && docker rm infra-participant1-1 && docker volume rm infra_participant1_data
```

The UI's system map detects this on its own within a few seconds (`GET /participant1-status`
polling) — nothing to do on your side.

**2. Recover** — click the button in the UI, or run the equivalent directly:

```sh
docker compose run --rm agent recover --target participant4 --target-ledger-api participant4:5043 \
  --loader-participant participant2 --policy-id demo \
  --endpoints http://agent2:4002,http://agent3:4003 --k 2
```

This deliberately queries only `agent2`/`agent3` (the two real, independent custodians) — `agent1`
(the owner's own backup copy) is never touched, so the recovery genuinely depends on the 2-of-2
threshold among independent parties, not on the owner's own spare copy. Typical time: ~15s if the
party is already re-hosted (idempotent), ~40-100s for a genuinely fresh re-authorization, depending
on host load. Under sustained high host CPU, Canton itself can hit an internal 1-minute timeout
(`proposeAndAuthorize-wait-for-effective`); let the load settle (`docker stats`) and re-run — the
whole pipeline is idempotent.

**3. Close the loop** — prove a counterparty can transact with the recovered party, and that the
recovered party genuinely signs for itself. Click "Counterparty transacts with recovered owner" in
the dashboard UI (enabled once step 2 succeeds) — it drives the same real flow the CLI does: a
counterparty (`custodian2`) proposes a new contract naming the recovered owner as observer, then the
owner exercises the acceptance themselves, via Interactive Submission from wherever they're
currently hosted (`participant4`, post-recovery). The resulting contract's sole signatory is
genuinely the recovered owner — not just an observer named by someone else. From the CLI instead:

```sh
docker compose run --rm agent counterparty-tx --as custodian2 --participant participant2:5023 \
  --owner-participant participant4:5043 --label post-recovery-demo
```

## Manual step-by-step setup

`make demo-reset` runs all of this for you (see the `Makefile`) — reading it is a faster way to
understand the full sequence than the prose below, but here it is spelled out:

```sh
cd infra
docker compose up -d synchronizer participant1 participant2 participant3 participant4
# wait until all 5 report healthy (docker compose ps)
docker compose run --rm bootstrap   # connects the 4 participants, uploads the DAR
docker compose up -d agent1 agent2 agent3 dashboard

docker compose run --rm agent seed  # allocates owner as an external party, seeds 3 real Positions + the demo Record

docker compose run --rm agent create-policy --owner-participant participant1:5013 --owner owner \
  --custodian participant2:5023:custodian2 --custodian participant3:5033:custodian3 \
  --k 2 --n 3 --frequency-hours 1 --policy-id demo

docker compose run --rm agent distribute --source participant1 --party owner --policy-id demo \
  --endpoints http://agent1:4001,http://agent2:4002,http://agent3:4003 --k 2

docker compose run --rm agent accept-custody --as agent2 --participant participant2:5023 --custodian custodian2 \
  --owner-participant participant1:5013 --owner owner --policy-id demo
docker compose run --rm agent accept-custody --as agent3 --participant participant3:5033 --custodian custodian3 \
  --owner-participant participant1:5013 --owner owner --policy-id demo

docker compose run --rm agent distribute-identity --policy-id demo \
  --endpoints http://agent1:4001,http://agent2:4002,http://agent3:4003 --k 2

# optional, so custodians show "Responded" instead of "No challenge yet":
docker compose run --rm agent challenge --owner-participant participant1:5013 --owner owner \
  --custodian-participant participant2:5023 --custodian custodian2 --policy-id demo --challenge-id ch-1
docker compose run --rm agent respond --as agent2 --participant participant2:5023 --custodian custodian2 \
  --policy-id demo --challenge-id ch-1
# (repeat with custodian3/participant3:5033/agent3 for the second custodian)

docker compose run --rm agent verify-demo-state
```

Check it worked directly: `curl -s http://localhost:4010/status | python3 -m json.tool`.

## Command reference (`docker compose run --rm agent <command> ...`)

Everything below is `agent/src/cli.ts` — run from `infra/`. `agent1`/`agent2`/`agent3` are
long-running custodian servers (`serve`); never run commands *on* them (`docker compose run
agent1 ...`) — always use the separate, hostname-less `agent` service, even for commands whose
`--endpoints`/`--custodian` point at `agent1/2/3`. Running on `agent1/2/3` starts a second container
sharing that hostname, and Docker's embedded DNS can route the real agent's own self-requests into
that ephemeral, server-less container instead (`ECONNREFUSED`).

| Command | What it does |
|---|---|
| `seed` | Allocates `owner` as a real external party (its signing key never lives inside Canton), seeds 3 real `Position` contracts + the demo `Record`. Idempotent. |
| `create-policy --owner-participant <p> --owner <hint> --custodian <p:port:hint> [--custodian ...] --k <n> --n <n> --frequency-hours <h> --policy-id <id>` | Creates the on-ledger `BackupPolicy` registry naming the custodians and the k-of-n threshold. |
| `distribute --source <p> --party <hint> --policy-id <id> --endpoints <url,...> --k <n>` | Encrypts the ACS, Shamir-splits the encryption key, pushes the blob + a key share to each endpoint. |
| `distribute-identity --policy-id <id> --endpoints <url,...> --k <n> [--key-path <path>]` | Same idea, for the party's own identity key — split and distributed independently of the data key, no shared dependency between the two. |
| `accept-custody --as <name> --participant <p> --custodian <hint> --owner-participant <p> --owner <hint> --policy-id <id>` | A custodian records on-ledger that it received its blob+share (`--as` matches an `agentN`, reading straight from that agent's own custody volume). |
| `challenge --owner-participant <p> --owner <hint> --custodian-participant <p> --custodian <hint> --policy-id <id> --challenge-id <id>` | Owner issues a challenge asking a custodian to prove it still holds its fragment. |
| `respond --as <name> --participant <p> --custodian <hint> --policy-id <id> --challenge-id <id>` | The named custodian answers an open challenge with a real proof. |
| `challenge-loop --owner-participant <p> --owner <hint> --custodian <p:port:hint> [--custodian ...] --policy-id <id> --interval-seconds <n>` | Runs `challenge` on a timer against every listed custodian (long-running). |
| `recover --target <p> --target-ledger-api <host:port> --loader-participant <console> --policy-id <id> --endpoints <url,...> --k <n>` | The main event: re-authorizes the party's identity on `--target` (propose/sign/load a topology transaction via Interactive Submission), reconstructs the encryption key from k shares, decrypts and imports the ACS. An unreachable custodian is skipped and the next listed endpoint is tried; if fewer than k shares arrive, it fails with a clear message. Note: with the demo's endpoints (two custodians, k=2) there is no spare, so one custodian down means no recovery. |
| `recover-identity --policy-id <id> --endpoints <url,...> --k <n> --custodian-participant <p> --custodian <hint> [--key-path <path>]` | Rebuilds *only* the identity key from its own Shamir shares (a separate disaster: the key file itself was lost, not the whole node) — verifies the reconstructed key against a custodian's own ledger view before trusting it. |
| `counterparty-tx --as <custodian-hint> --participant <p> --owner-participant <host:port> [--label <text>]` | The closing proof: a counterparty proposes a contract naming the recovered `owner` as observer, then `owner` exercises the acceptance themselves via Interactive Submission from `--owner-participant` (wherever they're currently hosted) — the result's sole signatory is genuinely `owner`, not just an observer. |
| `request-recovery --owner-participant <p> --owner <hint> --custodian-participant <p> --custodian <hint> --policy-id <id> --request-id <id>` | Owner formally asks a custodian to hand back its share (on-ledger `RecoveryRequest`) — distinct from just calling `recover` directly. |
| `respond-recovery --as <name> --participant <p> --custodian <hint> --policy-id <id> --request-id <id>` | The named custodian answers an open `RecoveryRequest`. |
| `check-commitment --counterparty-participant <console> --about-participant <console>` | Shows the real ACS commitments two participants independently computed and matched — works on the pre-disaster topology at any time. Prints Canton's result; it does not assert `Match`, and it is not part of `recover` (see the root README's limitations). |
| `backup --source <p> --party <hint> --out <path>` / `restore --target <p> --in <path>` | Raw `repair.export_acs`/`import_acs`, scoped to one party — the low-level primitive `distribute`/`recover` build on. |
| `serve --port <port>` | Starts a custodian's own blob/share HTTP store (what `agent1/2/3` run). |
| `dashboard --port <port> --custodian <p:port:hint> [--custodian ...] --policy-id <id> --recover-target <p> --recover-target-ledger-api <host:port> --recover-endpoints <url,...> --recover-loader-participant <console> --counterparty-tx-as <custodian-hint> --counterparty-tx-participant <host:port>` | Starts the owner-facing read API + recovery trigger the UI talks to. `--counterparty-tx-*` fixes who plays "the counterparty" for `POST /counterparty-tx` — not trusted from the request body, same reasoning as `--recover-target`. |
| `verify-demo-state` | No args. Fails loudly, naming exactly what's wrong, unless the environment is genuinely a fresh pre-disaster state (owner alive+hosted on `participant1`, not yet on `participant4`, policy/custody/challenges/positions all real and current). |

## Dashboard HTTP API (`http://localhost:4010`, no auth — trusted local network only)

| Endpoint | Returns |
|---|---|
| `GET /status` | Policy id, k/n, each custodian's real on-chain status (custody accepted, open challenges, last response, derived status), and `lastDistributedAt` — the oldest `blob.enc` mtime across the real custodians (the RPO signal: how long ago the worst-case custodian was last refreshed). |
| `GET /positions` | The 3 real `Position` contracts (counterparty, signed amount, currency). |
| `GET /ciphertext` | Real encrypted bytes fetched live from an actual custodian's own volume. |
| `GET /participant1-status` | `{alive: boolean}` — real reachability check, not a scripted state. |
| `GET /recover-progress` | The current recovery's real event stream (rehost sub-steps, custodian query/response, the 3 milestones), reset at the start of every `POST /recover`. |
| `POST /recover` `{targetParticipant, endpoints, k}` | Triggers `recover()` for real; `targetParticipant`/`endpoints` are validated against the fixed values the dashboard was started with, not trusted blindly from the request body. |
| `POST /counterparty-tx` (no body) | Triggers the demo's closing proof: the fixed counterparty proposes a contract naming the recovered owner as observer, then the owner signs the acceptance themselves. Zero client-trusted input — actor and participant are fixed at dashboard startup, only the label varies (auto-generated). Returns the real proposal/record contract ids and party ids. |

## Makefile targets

- **`make build-dar`** — builds the Daml model into a DAR (`daml/build-dar.sh`), using `dpm`/`damlc`
  from `PATH` if present, otherwise downloading `dpm` into `daml/.dpm-cache/`. Run once after
  cloning, and after any change to `daml/*.daml` (bump `version` in `daml/daml.yaml` first).
- **`make rebuild`** — the one command to run after editing anything in `agent/src/`. All six
  agent-based docker-compose services (`agent`, `agent1/2/3`, `dashboard`, `seed`) share a single
  image tag, so this rebuilds all of them at once — there's no way for one to be stale while
  another is fresh.
- **`make demo-reset`** — see Quick Start above. Full environment reset to a verified pre-disaster
  state, in one command.

## Resetting between runs

`make demo-reset` already does a full `docker compose down -v` + rebuild — the simplest way to
start genuinely fresh. If you want to reset without re-seeding (e.g. after a `recover` you want to
undo), the state lives in named volumes: `participant1_data`, `participant4_data`,
`owner_identity`, `agent_exports`, `agent1_custody`, `agent2_custody`, `agent3_custody` (all in
`infra/docker-compose.yml`).

## Troubleshooting

- **A participant container exits with code 137**: OOM-killed. Raise Docker Desktop's memory limit
  (see Prerequisites).
- **`bootstrap` or `demo-reset` fails with a transient Canton internal error, or a container
  reports "unhealthy" right after several resets in a row**: this machine can show real CPU
  contention after repeated Docker/Canton activity — check `docker stats`, wait for load to settle,
  and just re-run; every step is idempotent. This is a real, observed failure mode (Canton itself
  logging "late processing" under sustained load, or an internal `proposeAndAuthorize` timeout), not
  something wrong with your setup.
- **Neither `dpm` nor `damlc` is on `PATH`**: `make build-dar` handles this itself (downloads `dpm`
  into `daml/.dpm-cache/`, see Prerequisites) — you shouldn't need to install anything by hand. If
  you've built before and change `daml/*.daml`, bump `version` in `daml/daml.yaml` first (Canton
  refuses to vet two different-content packages under the same name+version).
- **`docker compose run agent1 ...` (or `agent2`/`agent3`) hangs or gives `ECONNREFUSED`**: see the
  note at the top of the Command reference section — always use the separate `agent` service.
