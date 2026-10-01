# infra

Docker topology for local dev: 1 synchronizer (sequencer1 + mediator1) + 4
participants, each in its own container.

- `participant1` — the owner's node, the one that dies in the demo. H2 on a
  named volume (`participant1_data`), so destroying it means deleting the
  volume, not just stopping the container.
- `participant2` / `participant3` — the two custodians' nodes (in-memory).
- `participant4` — the recovery target. H2 on `participant4_data`
  (`repair.import_acs` refuses in-memory storage).
- `agent1/2/3` — custodian HTTP stores (`agent serve`); `agent1` is the
  owner's own copy. `dashboard` — the owner-facing API on `:4010`.
  `agent` — the one-shot CLI runner. All six agent-based services share one
  image (`canton-dr-agent:latest`).

Verified end to end against Canton `v3.5.18`. For the normal way to run
everything (`make demo-reset`) and the full command reference, see
[`../docs/README.md`](../docs/README.md). This file covers the topology itself
and keeps the build log of what was found along the way.

## Run it

The recommended path is `make build-dar && make rebuild && make demo-reset`
from the repo root. Below are the same pieces run by hand, grouped by the
build step that introduced them — useful to understand the primitives:

```sh
make build-dar && cd infra   # produces the DAR (fetches dpm if it isn't on PATH)

docker compose up -d synchronizer participant1 participant2 participant3 participant4
docker compose run --rm bootstrap   # connects the 4 participants, uploads the DAR
docker compose run --rm agent seed  # owner as an external party + 3 Positions + the demo Record

# plan step 3: backup participant1's "owner" party, restore into empty participant4
docker compose run --rm agent backup --source participant1 --party owner --out /canton/exports/owner_acs.gz
docker compose run --rm agent restore --target participant4 --in /canton/exports/owner_acs.gz

# plan step 4: same thing, encrypted and Shamir-split (k=2, n=3) across agent1/2/3
docker compose up -d agent1 agent2 agent3
docker compose run --rm agent distribute --source participant1 --party owner --policy-id demo \
  --endpoints http://agent1:4001,http://agent2:4002,http://agent3:4003 --k 2
# recovers with only 2 of the 3 endpoints — proves the threshold, not just the happy path
# (recover also re-hosts the owner's identity on the target, so it needs the
# target's Ledger API and a live node to load the signed topology transaction)
docker compose run --rm agent recover --target participant4 --target-ledger-api participant4:5043 \
  --loader-participant participant2 --policy-id demo \
  --endpoints http://agent2:4002,http://agent3:4003 --k 2 --identity-custodian participant2:5023:custodian2

# plan step 5: the on-ledger registry — run after distribute (accept-custody
# hashes the blob distribute already pushed into each agentN's custody volume)
docker compose run --rm agent create-policy --owner-participant participant1:5013 --owner owner \
  --custodian participant2:5023:custodian2 --custodian participant3:5033:custodian3 \
  --k 2 --n 3 --frequency-hours 1 --policy-id demo
docker compose run --rm agent accept-custody --as agent2 --participant participant2:5023 --custodian custodian2 \
  --owner-participant participant1:5013 --owner owner --policy-id demo
docker compose run --rm agent accept-custody --as agent3 --participant participant3:5033 --custodian custodian3 \
  --owner-participant participant1:5013 --owner owner --policy-id demo
docker compose run --rm agent challenge --owner-participant participant1:5013 --owner owner \
  --custodian-participant participant2:5023 --custodian custodian2 --policy-id demo --challenge-id ch-1
docker compose run --rm agent respond --as agent2 --participant participant2:5023 --custodian custodian2 \
  --policy-id demo --challenge-id ch-1
# periodic version of `challenge`, one round per custodian every --interval-seconds, runs until killed
docker compose run -d --name challenge-loop agent challenge-loop --owner-participant participant1:5013 --owner owner \
  --custodian participant2:5023:custodian2 --custodian participant3:5033:custodian3 \
  --policy-id demo --interval-seconds 3600

# plan step 6: same RecoveryRequest/RecoveryResponse pattern as challenge/respond,
# plus a real query against the counterparty's own ACS commitment records
docker compose run --rm agent request-recovery --owner-participant participant1:5013 --owner owner \
  --custodian-participant participant2:5023 --custodian custodian2 --policy-id demo --request-id req-1
docker compose run --rm agent respond-recovery --as agent2 --participant participant2:5023 --custodian custodian2 \
  --policy-id demo --request-id req-1
docker compose run --rm agent check-commitment --counterparty-participant participant2 --about-participant participant1

# plan step 7: dashboard API (own service, always up) + the UI (run separately, not in Docker)
docker compose up -d dashboard
cd ../ui && pnpm install && pnpm dev   # opens on http://localhost:5173, talks to :4010
```

Ledger APIs are exposed on the host at `localhost:5011` (participant1),
`5021` (participant2), `5031` (participant3), `5041` (participant4). Admin
APIs at `+1` on each of those. Console/admin access from your machine: point
a remote Canton console at those ports (see `canton/bootstrap-remote.conf`
for the shape).

To destroy `participant1` for real (what the demo does) — its disk is a
volume, so stopping the container alone loses nothing — run `make destroy-node`
from the repo root. It also deletes the owner's private key file, which then
exists only as custodian-held Shamir shares.

`participant2`/`participant3` are in-memory: recreating their container
(`docker compose up -d --force-recreate participant2`) wipes them.

`participant4` uses a named volume (`participant4_data`) so it survives a
plain restart — that's the point, it's meant to hold the recovered state.
If you tear down and rebuild the whole topology from scratch, remove it too
(`docker volume rm infra_participant4_data`), or `participant4` will come up
remembering a synchronizer identity from a previous run and fail to
reconnect (the synchronizer itself is in-memory, so its identity is fresh
every time).

## Why these choices

- **No official Canton 3.x Docker image exists** (`digitalasset/canton-open-source`
  on Docker Hub stopped at the 2.x line). `Dockerfile` here builds one from the
  official OSS release tarball on GitHub (`digital-asset/canton` releases).
- **In-memory storage where possible, H2 where required.** `participant2/3`
  are in-memory (simpler, lighter). `participant4` must be H2 because
  `repair.import_acs` refuses in-memory storage. `participant1` moved to H2
  so the disaster is a deleted disk, not a restarted process — and so that
  restarting it during development stopped destroying its identity. Two
  nodes migrating an H2 schema at once overloaded the dev machine, so the
  rest stay in-memory.
- **One container per Canton node, not 1 process.** Canton supports running all nodes in a
  single JVM (see the upstream `01-simple-topology` example) but that doesn't
  match "3 independent custodians" for the demo — each participant needs its
  own failure domain.
- **`bootstrap` is a separate one-shot service**, not baked into
  `synchronizer`/participant startup, because bootstrapping requires all 4
  nodes to already be reachable (it connects to them as *remote* nodes over
  the network — see `canton/bootstrap-remote.conf`). Re-run it any time with
  `docker compose up bootstrap`.
- **`seed` (`agent/src/seed.ts`) uses the plain Ledger API JSON HTTP
  endpoint**, not Scala/Java codegen from the DAR (it replaced the original
  `canton/seed.sh`). No auth is configured on these nodes, so
  the built-in `participant_admin` user can act as any party without a
  separate user-creation step.
- **`agent` (the CLI runner) is a separate service from `agent1`/`agent2`/`agent3`
  (the custodian servers), not one service wearing both hats.** Tried that
  first — `docker compose run agent1 distribute ...` — and it broke:
  `run` starts a *second* container that shares the `agent1` DNS alias with
  the already-running `serve` instance, and Docker's embedded DNS resolved
  the self-push (owner distributing to itself, since n=3 includes it) to
  the alias-mate with no server listening → `ECONNREFUSED`. `agent` has no
  hostname and is never an endpoint, so it can't collide with anything.
- **No volume shared between agents and participants.** (Agents do share
  the `agent_exports` volume among themselves, and the `agent` CLI runner
  mounts every custody volume read-only — a demo simplification, see the
  root README's limitations.) Confirmed for backup/restore (step 3) that the exported
  `.gz` travels over the admin API, not shared disk — ran it from a
  container with no volume in common with either participant. Confirmed
  again for distribute/recover (step 4): each custodian's blob+share sit
  in its own named volume (`agentN_custody`), reachable only by HTTP.
  `repair.export_acs`/`repair.import_acs` are console-only (no JSON API
  equivalent), so `agent`/`agent1-3` still need the full JVM + Canton
  distribution alongside Node to shell out to `bin/canton run`, not just an
  HTTP client.

## Resolved assumptions

- `/daml/daml.yaml`'s `override-components` + `$DAML_VERSION` pattern is
  confirmed working: `dpm build` (with `DAML_VERSION=3.5.2`) produces a DAR.
  Note the Daml SDK version track (damlc/daml-script, e.g. `3.5.2`) is
  **separate** from the Canton release track (e.g. `3.5.18`) — they don't
  need to match, only the Daml-LF target (`--target=2.1` in `build-options`)
  needs to be something the Canton version accepts.
- `dpm` doesn't need to be installed: `make build-dar` uses it (or `damlc`)
  from `PATH` if present, otherwise downloads it from
  https://github.com/digital-asset/dpm/releases into `daml/.dpm-cache/`.

## Build log

The sections below were written as each step of the original build plan
(`../docs/ROADMAP.md`) was done, and are kept as a record of what was found.
Where a later decision changed things, it is marked — the current design is
in `../docs/DECISIONS.md`.

## Step 2 findings (export/import ACS)

First validated by hand against the real binary (see `canton/recover-test.canton`),
then again through the real `../agent` CLI in docker-compose (plan step 3):
`participant.repair.export_acs` → `participant.repair.import_acs` does move a
party's contracts from one participant to another. Two hard constraints
found the hard way, not documented anywhere obvious:

- **The importing participant can't use `storage.type = memory`** —
  `import_acs` fails with `"is in memory which is not supported by repair.
  Use db persistence"`. It needs H2 (file, not `mem:`) or Postgres. This
  wasn't true in the docker-compose above and matters for plan step 3: the
  node that recovers will need persistent storage, not memory.
- **The importing participant must first disconnect from the synchronizer**
  (`participant.synchronizers.disconnect("da")`), or `import_acs` refuses
  with `"There are still synchronizers connected"`. Reconnect after with
  `reconnect_all()`.
- Both nodes, and whatever config runs the console script itself, need
  `canton.features.enable-repair-commands = true` and
  `enable-testing-commands = true` — these are gated behind feature flags.
- **`import_acs` is idempotent for a contract the target already has.**
  Ran a full regression pass (`agent restore` into `participant4`, then
  later `agent recover` for the same contract into the same already-populated
  `participant4`) — the second import neither failed nor duplicated the
  contract (confirmed by count). Useful in practice: a retried or
  overlapping recovery attempt isn't destructive.

What's proven and what isn't: the imported contract is immediately visible
and correct via the importing participant's own Ledger API (queried its ACS
directly, got back the exact `Record` with the right signatory/observers).
Submitting a command **as** the recovered party from the new participant
does *not* work out of the box (`NO_SYNCHRONIZER_ON_WHICH_ALL_SUBMITTERS_CAN_SUBMIT`)
— that party is still only authorized to submit from its original
participant. At the time, identity/hosting recovery was declared out of scope.
**Superseded 2026-09-23:** identity recovery is now in scope and wired into
`recover` via external-party re-hosting (`agent/src/rehostParty.ts`,
ADR-004/ADR-009 in `../docs/DECISIONS.md`). The original reasoning, kept for
the record: in the real scenario the recovering
node keeps its own identity/keys and re-imports its own lost data, so this
gap shouldn't come up in practice — it only showed up here because the test
used a *different* participant identity as the recovery target, to prove
the export/import mechanism without needing to fake an identity-preserving
restart.

## Step 4 findings (encryption + Shamir + distribution)

- **AES-256-GCM** (Node's built-in `node:crypto`) for the blob, **Shamir
  k=2/n=3** for the encryption key via `shamir-secret-sharing` (Privy,
  audited, zero-dep). n=3 includes the owner itself as a self-custodian —
  see the design note in `docs/ROADMAP.md` step 4 — so `distribute` pushes
  the full ciphertext blob and one share to *every* endpoint, including
  the owner's own agent.
- **`shamir-secret-sharing`'s argument validation is `secret.constructor
  !== Uint8Array` (exact, not `instanceof`).** A Node `Buffer` — what
  `crypto.randomBytes()` and `fs.readFile()` return — fails that check even
  though `Buffer` is a `Uint8Array` subclass. `crypto.ts` explicitly
  converts (`new Uint8Array(key)`) before handing anything to `split`.
- **Node's global `fetch()` doesn't accept a `Buffer` as `body`** either
  (type error at compile time, not runtime) — same fix, wrap in
  `new Uint8Array(...)` first.
- Verified the custodians actually only ever hold ciphertext: inspected
  `agent2`'s stored `blob.enc` directly (`docker run --rm -v
  infra_agent2_custody:/data alpine ...`) — high-entropy bytes, no
  recognizable structure, matches the "custodian never sees plaintext"
  claim in `../CLAUDE.md`'s demo script.
- **This dev machine is right at the edge of OOM with the full topology
  up** (5 Canton JVMs + 3 agent servers ≈ 6+ GB against a 7.65 GB Docker
  Desktop VM) — lost `participant3` and `participant4` to OOM kills during
  testing. Not a code bug, but raise Docker Desktop's memory limit before
  demo day or the recovery mid-demo risks taking out an unrelated
  container.

## Step 5 findings (BackupPolicy registry + challenges)

- **`custodians` on `BackupPolicy` lists only the 2 external custodians,
  not the owner** — even though n=3 includes the owner as a shareholder
  (step 4). Challenging yourself for proof of possession is meaningless,
  so the registry only tracks the relationship that actually needs
  policing.
- **Nothing secret ever reaches the ledger.** `CustodianAgreement` carries
  a SHA-256 hash of the encrypted blob (both custodians recorded the exact
  same hash in testing — expected, since `distribute` sends every endpoint
  the identical ciphertext). `ChallengeResponse` carries
  `HMAC-SHA256(share, challengeId)`, computed by `agent respond` from the
  share sitting in that custodian's own custody volume — the share itself
  never leaves the container, on-chain or off.
- **`accept-custody`/`respond` read straight out of another service's
  volume** (`agentN_custody`, mounted read-only into the generic `agent`
  runner at `/canton/custody/agentN`) rather than going over HTTP to that
  agent's own server. Deliberate: it sidesteps the DNS-alias collision from
  step 4 entirely, since it's a local file read, not a self-request.
- **`challenge-loop` is a plain interval loop in the agent process, not a
  Daml Trigger.** A real Trigger would fire off-ledger even if no agent
  happened to be running the loop at the right moment, but wiring up the
  Triggers runtime was a lot of extra machinery for what a demo needs —
  revisit if this becomes more than a hackathon prototype.
- Verified the full cycle end to end: `create-policy` → `distribute` →
  `accept-custody` (both custodians) → `challenge` → `respond`, then
  confirmed on-ledger that the `Challenge` was consumed (archived) and
  only the `ChallengeResponse` remained — and separately ran
  `challenge-loop` long enough to see multiple rounds fire against both
  custodians without dying.
- **Found during a full regression pass, not while building the feature:**
  `create-policy`, `accept-custody`, `challenge`, and `request-recovery` were
  not idempotent — a client-side timeout (a real `503` under memory
  pressure, not hypothetical) doesn't mean the server didn't still commit
  the command. Retrying `accept-custody` after one duplicated the
  `CustodianAgreement` (confirmed by count: 3 active contracts, `custodian2`
  appearing twice). All four now check for an existing matching contract
  first and skip instead of blindly creating.

## Step 6 findings (RecoveryRequest/RecoveryResponse + real ACS commitments)

- **The console command names from `../CLAUDE.md`'s open question are
  confirmed for Canton 3.5.18**: `participant.commitments.lookup_sent_acs_commitments`,
  `lookup_received_acs_commitments`, `open_commitment`,
  `get_intervals_behind_for_counter_participants`. None are in the JSON
  Ledger API — `agent/src/checkCommitment.ts` shells out to the console like
  `backup`/`restore`/`distribute`/`recover` already do.
- **The parameter names from bytecode (`javap`) were wrong** — Java
  bytecode doesn't preserve Scala named-parameter names, so
  `timeRanges = ...`, `states = ...` etc. (guessed from decompiled method
  signatures) failed with `unknown parameter name`. Fixed by calling
  positionally instead — only the *order* and *types* from bytecode were
  trustworthy, not the names.
- **`SynchronizerTimeRange` needed an explicit import** — unlike
  `PositiveInt`, `StaticSynchronizerParameters`, etc. used elsewhere in this
  project's `.canton` scripts, it's not in the console's default scope.
- **`lookup_sent_acs_commitments` returned `Map()` in every test run at
  first, including with zero filters, well past the default 1-minute
  reconciliation interval.** Originally read as "needs more elapsed real
  time" — that guess was wrong, and left uninvestigated further at the
  time. The real cause, confirmed by reading Canton's own source
  (`community/participant/.../GrpcParticipantInspectionService.scala`,
  `validateSynchronizerTimeRange`, from the public `digital-asset/canton`
  GitHub repo): the script passed `None` for the time range, and `None`
  does **not** mean "all history" — it collapses to a single-instant window
  at the participant's own last-computed-and-sent timestamp, which only by
  luck lines up with a commitment for one specific counterparty. Canton's
  own integration tests (`AcsCommitmentToolingIntegrationTest.scala`)
  always pass an explicit `Some(TimeRange(...))`, never `None`. Fixed by
  passing `Some(TimeRange(CantonTimestamp.Epoch, CantonTimestamp.now()))`.
  Re-verified live against the running stack, 3 times, for both custodian
  pairs: 14 historical commitment periods came back, each with a real
  SHA-256 hash independently computed by both participants and a `Match`
  state.
- **What this proves and what it still doesn't:** this is real cryptographic
  proof that two independent participant nodes agree on a hash of the state
  they share — not just confirmation that the command surface exists.
  It does **not** close the recovery loop end-to-end: comparing a
  commitment hash against a freshly recomputed one after a disaster only
  proves something when the *same* participant identity is recovering (the
  commitment history is tied to that identity). This project's recovery
  target (`participant4`) is a deliberate stand-in with a fresh identity —
  see step 2's findings — so there is no prior commitment history of its
  own to compare against yet.

## Step 7 findings (dashboard + ui/)

- **`dashboard` is its own persistent service**, not folded into `serve`
  (which runs on `agent1`/`agent2`/`agent3` for the custodian side) or into
  the `agent` CLI runner. It's a third, distinct concern — an owner-facing
  read API plus the recovery trigger — with its own port (`4010`) and no
  reason to share a process with either of the other two.
- **`ui/` is a plain Vite + React + TypeScript app, deliberately without
  Redux Toolkit / RTK Query / Tailwind** — a single-screen dashboard over a
  handful of polled endpoints doesn't need a state management library or a
  design system. (It later gained React Flow + Framer Motion for the live
  system map.)
- **Not containerized.** `dashboard` runs in `docker compose` like
  everything else; `ui/` runs as an ordinary local `pnpm dev` process
  pointed at `http://localhost:4010` (`VITE_API_URL` to override). The
  Vite dev server already handles hot reload and CORS is wide open on
  `dashboard` (`access-control-allow-origin: *`) — containerizing a
  frontend dev server buys nothing here.
- Verified end to end: seeded a policy where one custodian accepted
  custody and got a challenge (shows "Awaiting response") and the other
  never accepted (shows "No challenge yet") — confirmed via `curl
  /status` that both states come through correctly — then called `POST
  /recover` directly (what the UI's "Recover" button does) and confirmed
  by querying `participant4`'s ACS afterward that the state landed
  correctly.
- **Real bug, found by an actual person clicking the button, not by any
  automated check:** `RECOVER_ENDPOINTS` in `ui/src/App.tsx` was
  `["http://localhost:4002", "http://localhost:4003"]`. Those endpoints
  are used by the `dashboard` *container*'s `/recover` handler (it calls
  the agents directly, server-side) — not by the browser — so from inside
  that container `localhost` means the `dashboard` container itself, which
  has nothing listening on 4002/4003. The button failed with a generic
  `{"error":"fetch failed"}` and no other clue. `curl`-testing the same
  endpoint directly from the host didn't catch this, because a curl call
  from the host naturally used the correct `agent2`/`agent3` hostnames —
  the bug only existed in the one place (the UI's own hardcoded constant)
  that got the perspective wrong. Fixed to `["http://agent2:4002",
  "http://agent3:4003"]`. This is also why "verify in a browser" isn't
  optional/nice-to-have for this project: the CLI, curl, and the UI don't
  all exercise the same code path from the same origin.

## References

- Canton releases: https://github.com/digital-asset/canton/releases
- Example configs this is based on: `community/app/src/pack/examples/01-simple-topology`
  and `02-multiple-sequencers-and-mediators` in the `digital-asset/canton` repo
- `07-repair` example in the same repo — a synchronizer-migration scenario,
  not the same as plan step 2, but same command family
