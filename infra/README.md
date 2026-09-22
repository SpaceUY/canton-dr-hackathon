# infra

Docker topology for local dev: 1 synchronizer (sequencer1 + mediator1) + 4
participants, each in its own container. `participant1/2/3` are the demo's 3
nodes (in-memory storage); `participant4` is the recovery target and needs
database-backed storage — see "Step 2 findings" below.

Verified end to end against Canton `v3.5.18` (real binary run locally, then
the same config run through `docker compose`): all 5 nodes start healthy,
`bootstrap` connects all 4 participants to the `da` synchronizer, pings
between them and uploads the Daml model, `seed` allocates one party per
participant and creates a `Record` contract (see `../daml/Record.daml`)
visible in `participant1/2/3`'s ACS, and `agent backup`/`agent restore`
(the real `../agent` CLI, not a hand-written script) moves that contract's
state from `participant1` into empty `participant4`.

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
- **`agent` (plain `../agent`, no shared volume with any participant).**
  Confirmed the exported `.gz` travels over the admin API, not shared disk —
  ran the export/import from a container with no volume in common with
  either participant and the file only ever existed in the agent's own
  volume. `repair.export_acs`/`repair.import_acs` are console-only (no JSON
  API equivalent), so the agent still shells out to `bin/canton run` with a
  generated `.canton` script — it needs the full JVM + Canton distribution
  in its image alongside Node, not just an HTTP client.

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

## References

- Canton releases: https://github.com/digital-asset/canton/releases
- Example configs this is based on: `community/app/src/pack/examples/01-simple-topology`
  and `02-multiple-sequencers-and-mediators` in the `digital-asset/canton` repo
- `07-repair` example in the same repo — a synchronizer-migration scenario,
  not the same as plan step 2, but same command family
