# Roadmap — canton-dr (original build checklist)

> **Historical.** This is the checklist for the original 7-step plan, kept as a record of how the
> vertical slice was built and what was found at each step. It predates identity recovery, which
> became in scope on 2026-09-23 and is now wired into `recover`. For the current state (what's real,
> what isn't, known limitations) see the [root README](../README.md); for design rationale see
> [DECISIONS.md](DECISIONS.md).

Checklist for the vertical slice up to the demo, based on the "Work plan"
in `../CLAUDE.md`.

## 0. Repo + Daml/Canton template + docker-compose

- [x] Folder structure (`daml/`, `agent/`, `infra/`, `docs/`)
- [x] `infra/Dockerfile` + `infra/docker-compose.yml`: synchronizer + 3
      participants, each in its own container, verified
      end-to-end (bootstrap connects all 3 and pings)
- [x] `daml/daml.yaml` (trivial template, to prove the build/upload
      pipeline — the real business contract came in step 1)
- [x] Install `dpm` and confirm `dpm build` compiles `daml/` — confirmed
      (`DAML_VERSION=3.5.2 dpm build` produces the DAR); still need to put
      `dpm` on the machine's `PATH` permanently (see `../infra/README.md`)

## 1. Trivial Daml contract between the 3 nodes

- [x] Replace `Ping.daml` with `Record.daml` (owner + custodians), visible
      at once in the ACS of `participant1`/`participant2`/`participant3`
- [x] Upload the DAR to all 3 participants via `bootstrap.canton`
- [x] Create an active contract between nodes (`seed` service, see
      `../infra/canton/seed.sh`) — the script itself verifies the ACS of the
      3 participants via HTTP JSON API before reporting success; tested
      end-to-end from scratch and run 2 more times to confirm it
      reuses existing parties and contract instead of duplicating them

## 2. Export ACS → import ACS by hand via console — **critical, day 1** ✅ works

- [x] With the contract from step 1 active, export a participant's ACS
      via console — `participant.repair.export_acs(...)`, tested against the
      real binary (not the same mechanism as the `07-repair` example, which
      is about synchronizer migration, but the same command family)
- [x] Import it into an empty participant by hand via console —
      `participant.repair.import_acs(...)`, see `infra/canton/recover-test.canton`
      and "Step 2 findings" in `infra/README.md` for the two non-obvious
      requirements I found (persistent storage, not memory; disconnect from
      the synchronizer before importing)
- [x] Confirm the restored state allows normal operation — the imported
      contract is readable and correct via the Ledger API of the
      participant that received it (verified over HTTP). Submitting a
      transaction *as* the recovered party didn't work out of the box because
      I deliberately tested against a different participant identity — that's
      exactly the identity/hosting recovery that CLAUDE.md already
      declared out of scope, not a failure of the state mechanism
- [x] If this doesn't work: rethink the approach — wasn't needed, it worked

**Finding that changes step 3:** the recovering node needs database-backed
storage (H2 or Postgres), not memory — `import_acs` explicitly rejects it.
The current docker-compose (step 0) uses memory on all 3 participants; this
needs revisiting when automating backup/restore from the agent.

## 3. Automate end-to-end backup/restore from the agent ✅ works

- [x] Service skeleton in `/agent` (no encryption, no shards) — TypeScript/Node
      CLI (`agent/src/cli.ts`), invokes `bin/canton run` with a
      `.canton` script generated on the fly (the `repair.*` commands don't
      exist in the Ledger JSON API, only in the Scala console)
- [x] Backup: `agent backup --source participant1 --party owner --out <path>`
      — exports that party's ACS
- [x] Restore: `agent restore --target participant4 --in <path>` — it
      encapsulates the disconnect/import_acs/reconnect that step 2 found
      necessary, so whoever calls the command doesn't have to remember it
- [x] Run end-to-end with no manual intervention via docker-compose (new
      `participant4` service with H2 storage and `agent`, no volume
      shared with any participant — confirms the exported file travels
      over the admin API, not shared disk) and verified the recovered
      contract is readable on `participant4`

**Added to step 0's docker-compose (it didn't have this):** `participant4.conf`
(H2 storage, the only participant with its own persistent volume),
`features.conf` (the `enable-repair-commands`/`enable-testing-commands` flags
the repair commands need) and the `agent` service in
`infra/docker-compose.yml`.

**Own bugs that showed up while building the CLI** (fixed, see commit):
the entrypoint passed a literal `--` to the argument parser instead of
acting as a separator, and the `backup`/`restore` functions returned nothing
printable — Canton's script `println` stayed trapped inside, and a
"successful" run showed no confirmation at all.

## 4. Encryption + Shamir k-of-n + distribution among custodians ✅ works

Scheme: **k=2, n=3 including the owner** as one of the 3 shareholders
(no need for a 4th custodian node) — so when the owner is the one that
loses its base, it still recovers with the 2 fragments held by the
external custodians.

- [x] Encrypt the state blob before storing/sending it — AES-256-GCM
      (`agent/src/crypto.ts`, `node:crypto`)
- [x] Split the encryption key into k-of-n fragments (Shamir) —
      `shamir-secret-sharing` (Privy's audited TS library, zero deps)
- [x] Distribute the encrypted blob + fragments among custodians (direct HTTP,
      outside Canton) — `agent distribute`, pushes to all 3 endpoints
      (including the owner itself) via PUT
- [x] Reconstruct the key from k of n fragments and decrypt on recovery —
      `agent recover`, explicitly tested with only 2 of the 3 endpoints
      (skipping the owner's) so it doesn't only validate the happy path

Each node now has its own agent (`agent1`/`agent2`/`agent3` in
`docker-compose.yml`) running `agent serve` — an HTTP server that
receives and stores blob+fragment, and returns them for recovery. The CLI
for firing commands (`backup`/`restore`/`distribute`/`recover`) is still
the separate `agent` service — see the DNS bug below.

**Verified the custodian never sees the plaintext:** inspected the
file stored in `agent2`'s volume directly — it's high-entropy bytes,
with no recognizable structure.

**Bugs found while building this** (all fixed, see commit):
- `shamir-secret-sharing` strictly validates `secret.constructor !== Uint8Array`
  — a Node `Buffer` (what `crypto.randomBytes` and `fs.readFile` return) is
  a `Uint8Array` subclass but fails that check. Had to convert
  explicitly with `new Uint8Array(...)`.
- Node's global `fetch()` also doesn't accept a `Buffer` as `body` (a
  compile-time type error) — same fix.
- **The costliest bug:** at first I had `agent1`/`agent2`/`agent3`
  also run the CLI commands (`docker compose run agent1
  distribute ...`), but that creates a *second* container that shares the
  "agent1" network alias with the already-running `serve` server — Docker's
  embedded DNS resolved the owner's self-push to the
  server-less container, giving `ECONNREFUSED`. Split the role:
  `agent1/2/3` only serve HTTP, the `agent` service (no hostname) runs the commands.
- The dev machine is right at the memory limit with the 5 Canton JVMs
  + the 3 agents up at once (~6GB against a 7.65GB limit
  in Docker Desktop) — `participant3` and `participant4` got OOM-killed
  during testing. Not a code bug, but the Docker Desktop memory limit
  needs raising before demo day.

## 5. Daml registry model and periodic challenges ✅ works

- [x] `BackupPolicy`: owner, custodians, k, n, frequency — `daml/BackupPolicy.daml`.
      `custodians` lists only the 2 external ones (n=3 includes the owner per
      step 4's decision, but nobody challenges themselves)
- [x] `CustodianAgreement`: each custodian accepts and records what it
      received — a SHA-256 hash of the encrypted blob, never the blob or the share
- [x] `Challenge` / `ChallengeResponse`: periodic challenge and its proof —
      the proof is `HMAC-SHA256(share, challengeId)`, computed by
      `agent respond` with the local share, which never leaves the custodian
- [x] Job/trigger that fires challenges according to the policy's frequency —
      `agent challenge-loop` (a plain loop in the agent, not a full Daml
      Trigger — overkill for what a demo needs)

New commands: `agent create-policy`, `agent accept-custody`,
`agent challenge`, `agent respond`, `agent challenge-loop` — see
"Run it" and "Step 5 findings" in `infra/README.md`.

Tested end-to-end against real Docker: `create-policy` → `distribute` →
`accept-custody` (both custodians, same blobHash since they receive the
same ciphertext) → `challenge` → `respond`, and confirmed via API that the
`Challenge` was archived (not left orphaned) and only the
`ChallengeResponse` survives. `challenge-loop` run separately and confirmed
to fire repeated rounds against both custodians without dying.

## 6. Verification against counterparties' commitments ✅ works (scope adjusted, see below)

- [x] Confirm the commitment command names for the hackathon's
      Canton version — confirmed via bytecode and tested against the
      real binary: `commitments.lookup_sent_acs_commitments`,
      `lookup_received_acs_commitments`, `open_commitment`,
      `get_intervals_behind_for_counter_participants`
- [x] `RecoveryRequest`: the owner asks for the data back, the custodians
      respond — same pattern as `Challenge`/`ChallengeResponse` in
      `daml/BackupPolicy.daml`, commands `agent request-recovery` /
      `agent respond-recovery`
- [x] Validate the reconstructed ACS against the commitments — **scope
      deliberately adjusted, but the mechanism itself is now proven, not
      just reachable**: `agent check-commitment` returns 14 real historical
      commitment periods with SHA-256 hashes independently computed by both
      participants, all `Match` (see the finding below) — genuine
      cryptographic proof of a correct shared state. What's still adjusted:
      comparing against the *specific recovered* state only means something
      when the SAME participant identity is recovering, and `participant4`
      is a stand-in with a fresh identity on purpose (see step 2's
      findings), so there's nothing of its own yet to check post-recovery —
      exactly as the original CLAUDE.md already declared

**Bug found and fixed, not just "needs more time":** `lookup_sent_acs_commitments`
returned an empty `Map()` in every test run, even with no filters and well
past the 1-minute reconciliation interval — first read as "a closed
commitment period needs more elapsed real time than a short test window
gives it". That reading was wrong. Read straight from Canton's own source
(`GrpcParticipantInspectionService.validateSynchronizerTimeRange`, confirmed
against the real `digital-asset/canton` GitHub repo): passing `None` for
the time range doesn't mean "all history" — it collapses to a single-instant
window at the participant's global last-computed-and-sent timestamp, which
only by luck lines up with a commitment for one specific counterparty.
Passing an explicit wide range (`CantonTimestamp.Epoch` to `now()`) fixes
it: `check-commitment` now returns every historical commitment period for
the pair, each with a real SHA-256 hash both sides computed independently
and its match state. Verified live against the real stack, 3 times, for
both custodian pairs (`participant1↔participant2` and `participant1↔participant3`):
14 periods, all `Match`. This is the actual cryptographic proof — two
independent nodes agreeing on a hash of shared state, not just confirmation
that the command surface exists. See "Step 6 findings" in
`infra/README.md` for the full detail (includes two more own bugs: the
parameter names I pulled from the bytecode were wrong —
`javap` doesn't preserve Scala named-parameter names, had to
call positionally instead — and `SynchronizerTimeRange` needed an
explicit import).

**Finding from the full regression test, not from this step specifically:**
`create-policy`, `accept-custody`, `challenge`, and `request-recovery` weren't
idempotent — a client-side timeout (a real 503 under memory
pressure, not hypothetical) doesn't mean the server didn't still process
the command. Retrying `accept-custody` after one left a duplicated
`CustodianAgreement`. All four commands now check whether the
contract already exists before creating it.

## 7. Minimal UI ✅ works, verified in a real browser

- [x] Custodian status (active / degraded) — table with status
      derived from `CustodianAgreement`/`Challenge`/`ChallengeResponse`
- [x] Latest challenges and their results — open challenges + last
      response per custodian
- [x] Recovery button — calls `POST /recover` on the new `dashboard`
      service, which reuses the same `recover()` from step 4

New: `agent/src/dashboard.ts` (`dashboard` service in docker-compose,
port 4010) + `ui/` (React + Vite + TypeScript, without Redux/RTK Query/Tailwind
— see "Step 7 findings" in `infra/README.md` for why).

**Real bug, found by clicking the button, not by curl or typecheck:**
`RECOVER_ENDPOINTS` in `ui/src/App.tsx` used `localhost:4002`/`localhost:4003`.
Those endpoints are consumed by the `dashboard` *container*'s `/recover`
handler server-side, not by the browser — inside that container,
`localhost` means the `dashboard` container itself, which isn't listening
on those ports. Failed with an unhelpful `{"error":"fetch failed"}` and no
other clue. curl-testing the same endpoint from the host didn't catch it,
because curl from the host naturally used the correct `agent2`/`agent3`
hostnames. Fixed to `agent2`/`agent3`. This is exactly why the "browser
visual check" this step's docs used to flag as pending mattered: the CLI,
curl, and the UI don't all exercise the same code path from the same
origin, so nothing except a real click was going to surface this one.

## Demo (5 minutes)

- [x] Script — final version closes with a counterparty transacting with the
      recovered party instead of "validates against the commitment" (the
      commitment check isn't part of recovery; see the root README's
      limitations). Beat-by-beat in the root README.
- [x] Timed rehearsal — full run 2026-09-30, 2:58 of technical time
      (destroy → recover → close)

## Plan B (if time runs short)

- [ ] Cut down to *backup assurance*: only steps 0–3 + 5–6 (challenges +
      commitment verification), no Shamir fragmentation (skip step 4)
