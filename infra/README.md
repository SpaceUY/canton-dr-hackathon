# infra

Docker topology for local dev: 1 synchronizer (sequencer1 + mediator1) + 3
participants, each in its own container, all storage in-memory.

Verified end to end against Canton `v3.5.18` (real binary run locally, then
the same config run through `docker compose`): the 4 nodes start healthy and
`bootstrap` connects all 3 participants to the `da` synchronizer and pings
between them.

## Run it

```sh
cd infra
docker compose up -d synchronizer participant1 participant2 participant3
docker compose up bootstrap   # connects the 3 participants, pings, exits
```

Ledger APIs are exposed on the host at `localhost:5011` (participant1),
`5021` (participant2), `5031` (participant3). Admin APIs at `+1` on each of
those. Console/admin access from your machine: point a remote Canton console
at those ports (see `canton/bootstrap-remote.conf` for the shape).

To simulate a participant losing its base (storage is in-memory), just
recreate its container:

```sh
docker compose up -d --force-recreate participant2
```

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

## Open assumption — not yet verified

`/daml/daml.yaml` uses the `override-components` + `$DAML_VERSION` pattern
from the bundled example projects in the `v3.5.18` release tarball (Canton
3.5 removed the old `daml` assistant / `sdk-version` field in favor of `dpm`,
the Digital Asset Package Manager). I could not run `dpm build` to confirm
this compiles — `dpm` isn't installed on this machine. First thing to check
once it's set up: `dpm build` from `/daml`.

## References

- Canton releases: https://github.com/digital-asset/canton/releases
- Example configs this is based on: `community/app/src/pack/examples/01-simple-topology`
  and `02-multiple-sequencers-and-mediators` in the `digital-asset/canton` repo
- `07-repair` example in the same repo — relevant for plan step 2 (export/import ACS)
