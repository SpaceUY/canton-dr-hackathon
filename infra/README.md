# infra

Docker topology for local dev: 1 synchronizer (sequencer1 + mediator1) + 4
participants, each in its own container. `participant1/2/3` are the demo's 3
nodes (in-memory storage); `participant4` is the recovery target and needs
database-backed storage — see "Step 2 findings" below.

Verified end to end against Canton `v3.5.18` (real binary run locally, then
the same config run through `docker compose`): all 5 Canton nodes start
healthy, `bootstrap` connects all 4 participants to the `da` synchronizer,
pings between them and uploads the Daml model, `seed` allocates one party
per participant and creates a `Record` contract (see `../daml/Record.daml`)
visible in `participant1/2/3`'s ACS, `agent backup`/`agent restore` move
that contract's state from `participant1` into empty `participant4`, and
`agent distribute`/`agent recover` do the same thing encrypted and
Shamir-split across `agent1`/`agent2`/`agent3` (k=2, n=3) — reconstructed
and restored using only 2 of the 3 shares.

## Run it

Needs `dpm` installed first (not on `PATH` yet on this machine — see
"Resolved assumptions" below for the download link).

```sh
cd daml && DAML_VERSION=3.5.2 dpm build && cd ../infra   # produces the DAR

docker compose up -d synchronizer participant1 participant2 participant3 participant4
docker compose up bootstrap   # connects the 4 participants, uploads the DAR
docker compose up seed        # allocates parties, creates + verifies a Record on 1/2/3

# plan step 3: backup participant1's "owner" party, restore into empty participant4
docker compose run --rm agent backup --source participant1 --party owner --out /canton/exports/owner_acs.gz
docker compose run --rm agent restore --target participant4 --in /canton/exports/owner_acs.gz

# plan step 4: same thing, encrypted and Shamir-split (k=2, n=3) across agent1/2/3
docker compose up -d agent1 agent2 agent3
docker compose run --rm agent distribute --source participant1 --party owner --policy-id demo \
  --endpoints http://agent1:4001,http://agent2:4002,http://agent3:4003 --k 2
# recovers with only 2 of the 3 endpoints — proves the threshold, not just the happy path
docker compose run --rm agent recover --target participant4 --policy-id demo \
  --endpoints http://agent2:4002,http://agent3:4003 --k 2
```

Ledger APIs are exposed on the host at `localhost:5011` (participant1),
`5021` (participant2), `5031` (participant3), `5041` (participant4). Admin
APIs at `+1` on each of those. Console/admin access from your machine: point
a remote Canton console at those ports (see `canton/bootstrap-remote.conf`
for the shape).

To simulate participant1/2/3 losing its base (storage is in-memory), just
recreate its container:

```sh
docker compose up -d --force-recreate participant2
```

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
- **In-memory storage everywhere**, not H2/Postgres. It's simpler, and for the
  "a participant loses its base" scenario in the demo, deleting a container
  *is* the disaster — no need to also manage a volume/DB file just to corrupt it.
  If the project later needs partial/selective corruption (delete only some
  state, not all), switch that participant to `storage.type = h2` with a file
  path on a named volume.
- **4 containers, not 1 process.** Canton supports running all nodes in a
  single JVM (see the upstream `01-simple-topology` example) but that doesn't
  match "3 independent custodians" for the demo — each participant needs its
  own failure domain.
- **`bootstrap` is a separate one-shot service**, not baked into
  `synchronizer`/participant startup, because bootstrapping requires all 4
  nodes to already be reachable (it connects to them as *remote* nodes over
  the network — see `canton/bootstrap-remote.conf`). Re-run it any time with
  `docker compose up bootstrap`.
- **`seed` uses the plain Ledger API JSON HTTP endpoint (curl + jq)**, not
  Scala/Java codegen from the DAR. No auth is configured on these nodes, so
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
- **No volume shared between `agent`/`agent1`/`agent2`/`agent3` or any
  participant.** Confirmed for backup/restore (step 3) that the exported
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
- `dpm` isn't on `PATH` yet on this machine — it was only downloaded to a
  scratch dir to validate the build. Install it properly before the next
  session: https://github.com/digital-asset/dpm/releases
  (`dpm-<version>-darwin-arm64.tar.gz` for this Mac).

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

What's proven and what isn't: the imported contract is immediately visible
and correct via the importing participant's own Ledger API (queried its ACS
directly, got back the exact `Record` with the right signatory/observers).
Submitting a command **as** the recovered party from the new participant
does *not* work out of the box (`NO_SYNCHRONIZER_ON_WHICH_ALL_SUBMITTERS_CAN_SUBMIT`)
— that party is still only authorized to submit from its original
participant. This lines up exactly with `../CLAUDE.md`'s own scope boundary:
state recovery (this) and identity/hosting recovery (separate, declared
out of scope) are different problems. In the real scenario the recovering
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

## References

- Canton releases: https://github.com/digital-asset/canton/releases
- Example configs this is based on: `community/app/src/pack/examples/01-simple-topology`
  and `02-multiple-sequencers-and-mediators` in the `digital-asset/canton` repo
- `07-repair` example in the same repo — a synchronizer-migration scenario,
  not the same as plan step 2, but same command family
