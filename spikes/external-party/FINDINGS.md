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

**Switching both `participant1` and `participant2` from memory to H2 file storage at the same time
overloaded this dev machine.** Both migrating their H2 schema for the first time simultaneously
caused persistent `DB_CONNECTION_LOST` timeouts (`slick-participant1-2 - Connection is not
available, request timed out after ~7-9s`), and `bootstrap` never completed even after 11+ minutes
(normally ~20s). Docker itself still reported both containers "healthy" the whole time — the
container-level healthcheck doesn't catch this. Fix: only switch the participant that actually
needs to survive repeated kills during dev (`participant1`, since it's the one the demo script
kills) to H2; leave `participant2` on memory. One node migrating H2 for the first time is fine;
two at once, on this machine, is not.

**RESOLVED same day: an external party CAN be signatory of its own Daml command, not just an
observer.** Confirmed against the real binary on the first attempt. Mechanism: the Interactive
Submission Service, `/v2/interactive-submission/prepare` + `/v2/interactive-submission/executeAndWait`
on the plain JSON Ledger API (same family the project already uses — no gRPC/protobuf tooling
needed, contrary to what the only in-repo Python example uses
(`community/app/src/pack/examples/08-interactive-submission/`). Found a clean TypeScript reference
instead: `community/app/src/pack/examples/14-multisync/src/interactive-submission.ts` +
`signing.ts`. Flow:
1. `POST /v2/interactive-submission/prepare` with the normal `CreateCommand`/`actAs` (the external
   party as `actAs`, exactly like a real command) plus `synchronizerId` — returns
   `preparedTransactionHash` (base64) and `preparedTransaction`.
2. Sign `preparedTransactionHash` with the party's private key —
   `crypto.sign(null, hashBytes, privateKey)`, same Ed25519 pattern as topology signing, but
   **`format: "SIGNATURE_FORMAT_RAW"` here, not `"SIGNATURE_FORMAT_CONCAT"`** (topology
   transactions use `CONCAT`; regular Daml transactions use `RAW` — easy to get wrong by copying
   the topology-signing code verbatim).
3. `POST /v2/interactive-submission/executeAndWait` with the prepared transaction plus
   `partySignatures: { signatures: [{ party, signatures: [...] }] }`.

Verified: the resulting contract's `signatories` field is genuinely the external party (not a
stand-in local party), confirmed by direct query, not just "no error was thrown." This closes the
last real unknown for migrating `owner` — everything `create-policy`/`distribute`/`request-recovery`
need (submitting a command *as* `owner`) works for an external party the same way it works for a
local one, just with one extra prepare/sign/execute round trip instead of one HTTP call. Code:
`spikes/external-party/signatory-allocate.mjs` + `signatory-submit.mjs`.
