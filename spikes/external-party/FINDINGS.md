# External party / identity recovery — findings log

Written as things are found, not reconstructed at the end. Canton 3.5.x throughout (matches this
project's version). Source references are to the public `digital-asset/canton` GitHub repo unless
noted.

## 2026-09-23

**`lookup_sent_acs_commitments` with `None` as the time range does not mean "all history".**
Confirmed by reading `GrpcParticipantInspectionService.validateSynchronizerTimeRange`: a missing
time range collapses to a single-instant window at the participant's own last-computed-and-sent
timestamp, not a wide search. Canton's own integration tests always pass an explicit
`Some(TimeRange(...))`. Fix: pass `Some(TimeRange(CantonTimestamp.Epoch, CantonTimestamp.now()))`.
(This is the finding that almost got lost in chat — now it's here and in `agent/src/checkCommitment.ts`'s
own comment and `docs/ROADMAP.md`.)

**External party identity survives real participant death.** `docker stop` on the real container
(not simulated), then re-hosted on a live participant using only a signature from the party's own
externally-held Ed25519 key — the dead participant never participates. Mechanism:
`/v2/parties/external/generate-topology` + `/v2/parties/external/allocate` (HTTP JSON API, same
family the project already uses) to allocate; `party_to_participant_mappings.propose_delta` on the
target (must be called by a node that can sign for itself — see next finding) to authorize; sign
the resulting hash externally; load the signed transaction via any live, connected node.

**`propose_delta` auto-signs with whichever console calls it — you cannot reconstruct an identical
proposal from a different node.** Calling it from an unrelated participant fails with
`TOPOLOGY_NO_APPROPRIATE_SIGNING_KEY_IN_STORE` (it can't sign for authorizations it doesn't hold).
Calling it from a *disconnected* participant fails with `TOPOLOGY_STORE_NOT_FOUND` (no live view of
its own topology store). Fix, since this project's architecture is one script per command (no
persistent console session, see `agent/src/canton.ts`): serialize the actual
`SignedTopologyTransaction` to bytes right after creating it (`proposal.toByteString`) and
deserialize it later (`SignedTopologyTransaction.fromTrustedByteArray(ProtocolVersionValidation.NoValidation,
bytes)`) instead of trying to regenerate it. `propose_delta` itself *is* otherwise deterministic —
calling it twice with identical inputs on the *same*, still-connected node gives byte-identical
hashes (verified 3 separate container invocations).

**Canton's own `parties.export_party_acs` (the purpose-built command for this) does not work in
this environment.** Always fails with `EFFECTIVE_PARTY_TO_PARTICIPANT_MAPPING_NOT_FOUND: The
stream has not been completed in 2 minutes`, regardless of `beginOffsetExclusive` (tried 184, 1,
and letting real wall-clock time pass ~8 min total) and regardless of the synchronizer's
`reconciliationInterval` (tried both default and forced to 10 years, matching a workaround Canton's
own test tutorial uses for this exact area — see `docs-open/.../party_replication.rst`'s
`simple_party_replication` snippet and its comment "Remove reconciliationInterval when ACS
commitments consider the onboarding flag", `#27707`). Root cause not identified. **Workaround that
does work**: use `repair.export_acs`/`import_acs` (the same commands this project's own
`agent/src/backup.ts`/`restore.ts` already use) filtered to the external party's `PartyId`, instead
of the specialized replication API. Worked on the first try both times it was used
(`spike4`→`participant5`, `spike5`→`participant5`).

## 2026-09-24

**A counterparty with zero special knowledge can transact with a recovered external party
immediately.** After `spike5` was re-hosted (with real prior state) onto a fresh participant, an
ordinary *local* party (`custodian2`) submitted a brand-new `Record` create command naming `spike5`
as observer via the plain JSON Ledger API — no re-onboarding step, no different code path. Both the
recovered contract and the new one show up as active for `spike5` on the new participant. This
closes the full success criterion (identity + state + continued operability), not just identity
survival.

**Open question going into the "external party as *signatory*, not just observer" spike**: every
test so far had the external party as an *observer* on a contract signed by an ordinary local
party — never as the actor submitting its own command. The real demo's `owner` party is the actor
for `create-policy`/`distribute`/`request-recovery`, so this is the next real unknown, not the
migration itself. See Canton's `community/app/src/pack/examples/08-interactive-submission/` for the
reference flow (prepare → sign externally → execute) — to be confirmed against the real binary
before assuming it works.
