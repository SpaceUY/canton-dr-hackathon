# Design decisions

A condensed, English record of the architecture decisions (ADRs) behind canton-dr, and the one
communication rule that governs how we describe it. The full, day-by-day versions live in the
team's internal notes; everything a reviewer needs to judge the design is here. File references
point at this repo.

Each entry: what we decided, why, and what it costs.

---

## ADR-001 — The Canton network is not storage

**Decision.** Encrypted backup blobs travel off-ledger, over direct HTTP between agents. The ledger
carries only the registry (`BackupPolicy`), custody receipts, challenges and recovery requests.

**Why.** The sequencer has traffic fees, pruning and message-size limits; it is not built to carry
whole ACS snapshots. Canton's value here is coordination and audit, not bytes.

**Consequence.** Blob transport is the agent's job (`agent/src/server.ts`, `distribute.ts`). Any
feature that tries to put a blob, or anything of comparable size, into a Daml contract is rejected
by default.

## ADR-002 — Shamir splits the encryption key, not the data

**Decision.** The ACS is encrypted once (AES-256-GCM, fresh 32-byte key and random 96-bit IV per
backup — `agent/src/crypto.ts`). The whole ciphertext is replicated to every custodian. Only the
32-byte key is split k-of-n with Shamir Secret Sharing, using the audited
[`shamir-secret-sharing`](https://github.com/privy-io/shamir-secret-sharing) library.

**Why.** It has the same confidentiality property as splitting the data (fewer than k shares
reveal nothing about the key), at a fraction of the cost. Replicating a blob is cheap; secret-sharing
a large dataset is not.

**Consequence.** Recovery needs any k key shares plus one copy of the blob, from any custodian.

## ADR-003 — ACS commitments verify; they don't restore

**Decision.** Canton's ACS commitments are hashes that counterparties exchange about their shared
state. We use them as evidence of correctness, never as a data source. The data comes back from the
custodians' blobs.

**Why.** "We verify against the network" can sound like "the network gives the data back". It
doesn't, and the pitch must say so.

**Technical note.** `lookup_sent_acs_commitments` with `None` as the time range does *not* mean "all
history". It collapses to a single-instant window (confirmed in Canton's
`GrpcParticipantInspectionService.validateSynchronizerTimeRange`). `agent/src/checkCommitment.ts`
passes an explicit `Epoch..now` range.

**Current scope (honest).** `check-commitment` shows real, independently computed, matching
commitments between live participants *before* a disaster. It is **not** part of the `recover`
pipeline. The recovery target is a different participant with no commitment history of its own, and
the command prints Canton's result without asserting `Match`. After a disaster, the lost node's own
commitment history is gone too, so verifying means asking the counterparty; it is not a local
operation.

## ADR-004 — Identity recovery via external parties is in scope

**Decision.** The original scope treated identity (keys) as out of scope. That was reversed on
2026-09-23: recovered state is useless if nothing can sign for its owner. The owner is a Canton
**external party**, whose signing key lives outside any participant. After a disaster, that party is
re-hosted on a *different, live* participant.

**Mechanism (confirmed against the real Canton 3.5 binary).**

1. Allocate the external party: `/v2/parties/external/generate-topology` + `/allocate`.
2. On the target participant, `party_to_participant_mappings.propose_delta`.
3. Sign the resulting topology hash with the party's own key.
4. Load the signed transaction through any live, connected node. The dead participant never
   takes part.
5. Move the state with `repair.export_acs` / `repair.import_acs` scoped to the party. Canton's
   specialised `parties.export_party_acs` / `import_party_acs` did not work in this environment.

**Precision.** What is re-hosted is an external party — not the dead participant's own node
identity, and not local parties it hosted.

**Consequence.** `agent/src/rehostParty.ts`, wired into `recover`. A counterparty with no special
handling can transact with the recovered party straight away.

## ADR-005 — The identity key uses the same Shamir scheme, as independent shares

**Decision.** The owner's private key (PKCS#8) is split k-of-n and sent to the same custodians under
a separate path (`identity-share`). It is never mixed with the data-key shares.

**Design rule.** Recovering the identity key must never depend on anything readable only with the
identity already recovered. `recover-identity` verifies the reconstructed key against what a
*custodian's* ledger view reports as `BackupPolicy.owner`, not against a caller-supplied party id.

**Status.** `distribute-identity` and `recover-identity` are implemented and were verified with a
genuinely deleted key file: rebuilt from 2 of 3 shares, then used to sign a real transaction.
**Not yet wired into `recover`**: today `recover` reads the owner key from the owner-side identity
volume. Wiring the Shamir reconstruction into `recover` is the next planned change.

## ADR-006 — participant1 persists to disk; the demo deletes the disk

**Decision.** `participant1` (the node that dies) uses H2 on a named volume
(`participant1_data`). The demo destroys it with
`docker stop -t 1` + `docker rm` + `docker volume rm infra_participant1_data`.

**Why.** A real disaster loses or corrupts the disk; it doesn't just stop the process. `-t 1` makes
the kill fast and consistent. A plain `docker stop` varied from 0.6 to 7.8 s, depending on the
JVM's graceful shutdown.

**Constraint found.** `repair.import_acs` refuses in-memory storage, so the recovery target
(`participant4`) is H2 too. `participant2/3` stay in-memory: migrating two H2 schemas at once
overloaded the dev machine.

**Rule.** Nodes are killed from a terminal, never from the dashboard. The dashboard is an
unauthenticated local endpoint and must not gain the power to kill containers.

## ADR-007 — Fail loudly on identity-key mismatch

**Decision.** Every operation that signs as an external party first recomputes the Canton
fingerprint of the local key and compares it with the one in the party id. It does this locally,
with no network call. On mismatch it fails with an explicit error. It never signs anyway, and never
silently allocates a fresh identity.

**Why.** A stale Docker image once signed with a leftover local party that happened to have the same
name. The signatures were valid, but for the wrong party. A related bug is also fixed: allocation
treated any key-loading error as "no key yet".

**Consequence.** `assertKeyMatchesParty` in `agent/src/externalParty.ts` is called on load and at
both signing points. The fingerprint is SHA-256 with purpose 12 over the raw 32-byte Ed25519 key,
not over the DER. It was validated against a known oracle before we trusted it. The same
"first result, unchecked" pattern was found and fixed in four places.

## ADR-008 — One shared image for every agent-based service

**Decision.** `agent`, `agent1/2/3`, `dashboard` and `seed` all declare
`image: canton-dr-agent:latest`, and `make rebuild` rebuilds and recreates them together.

**Why.** Rebuilding one service silently left the others on old code, twice.

## ADR-009 — The recovered party gets Confirmation, not Observation

**Decision.** `rehostParty.ts` grants `ParticipantPermission.Confirmation`.

**Why.**
- `Observation` cannot confirm, so the recovered owner could not submit its own commands.
- `Submission` would also let the participant sign on the party's behalf. An external party signs
  client-side, so that extra privilege is pointless.
- `Confirmation` is exactly what the original host granted.

**Also.** A freshly re-hosted party carries an onboarding flag. While it is set, the owner can
receive commands but not submit them, and submissions fail with `PARTY_CURRENTLY_ONBOARDING`.
`rehostParty.ts` asks Canton to clear the flag without waiting for it (it takes up to about a
minute), and `submitAsExternalParty` retries on that specific error.

## ADR-010 — One command rebuilds the pre-disaster state

**Decision.** `make demo-reset` tears everything down, then runs, in order:

1. bootstrap
2. seed
3. create-policy
4. distribute
5. accept-custody ×2
6. distribute-identity
7. challenge/respond ×2

It ends with `agent verify-demo-state`, which fails and names the exact problem unless the
environment really is pre-disaster. That means:
- the owner is live on `participant1` and not yet on `participant4`;
- custody is accepted;
- the challenges are answered;
- the positions are present;
- the ciphertext is readable.

**Why.** Fourteen manual commands in the right order is too fragile for demo day. `resolveParty`
also now honours Canton's own `retryInfo` on `REQUEST_ALREADY_IN_FLIGHT`.

## ADR-011 — Product dashboard layout

**Decision.** The layout is a fixed two-column dashboard with a metrics strip across the top:
- **Metrics strip:** threshold, healthy custodians, last challenge, protected positions, backup
  freshness (RPO) and a live recovery timer (RTO).
- **Left column:** the system map, the Recover button, a three-stage rail and the before/after
  identity panel.
- **Right column:** a short explainer, the real positions and the custodian list.

Raw ids, hashes and ciphertext hex sit in a collapsed footer.

**Honesty rules.**
- The map shows `participant1` alive or dead from a real reachability probe
  (`GET /participant1-status`), not from a script.
- Progress comes from real backend events (`GET /recover-progress`): the nine identity sub-steps,
  each custodian query and response, and three milestones. There is no invented timer.
- RPO is the real mtime of the stalest custodian's blob.

## ADR-012 — Skip unreachable custodians; no fourth custodian

**Decision.** `recover` treats an unreachable custodian as a soft failure. It skips it, tries the
next listed endpoint, and fails with a clear message if fewer than k shares arrive. We did **not**
add a fourth, independent custodian.

**Why.**
- A fourth node (another JVM) would make the host's measured CPU contention worse, and that
  contention had already caused a real Canton-internal timeout.
- Timing a live custodian kill inside a roughly 40-second recovery window would replace a
  rehearsed flow with an untested one.

**Consequence (declared).** The demo queries only the two third-party custodians, with k = 2. The
owner's own backup copy (`agent1`) is skipped on purpose. So there is **no tolerance for a custodian
outage** in this configuration: skipping works, but there is nothing to skip to.

## ADR-013 — The recovered owner signs the closing contract itself

**Decision.** The closing proof uses propose/accept.
1. A counterparty (`custodian2`) creates a `RecordProposal` naming the recovered owner.
2. The owner exercises `AcceptRecord` itself, via Interactive Submission from the participant now
   hosting it.
3. The resulting `Record`'s only signatory is the owner.

**Why.** If the owner were only an observer, "the node is operating again" would not hold up.
Observing is not operating.

**Bug found on the way.** Exercising the choice from `participant4` right after creating the
proposal on `participant2` hit `CONTRACT_NOT_FOUND`: the proposal had not reached `participant4`
through the synchronizer yet. The fix waits until the owner's own participant sees the proposal.

---

## Communication rule — state limitations, don't oversell

Known limitations are stated up front in the pitch and the README, not hidden. A technical jury will
ask anyway, and it is better to say them first. See the [Known limitations](../README.md#known-limitations) section.
Specifically:
- ACS commitments verify, they don't restore.
- What is re-hosted is an external party.
- Anything not yet wired into the demo path is described as such.
