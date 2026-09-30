# canton-dr

Verifiable decentralized disaster recovery for Canton nodes.
Project for the Canton Network hackathon (AppsFactory).

**Live context lives in the sibling vault repo**, `../canton-dr-hackathon-vault` — a real Obsidian
vault as of 2026-09-25, not flat files. Start at its `Hub.md`. `Roadmap.md` (what to build now,
updated daily) sits at the vault root; design decisions live as ADRs (`Architecture/Decisions/`)
and BDRs (`Decisions/`) — this file keeps a condensed copy below so it stays self-sufficient, but
the vault is the source of truth; proven technical mechanisms live as POCs (`POCs/`, continued from
this repo's now-frozen `spikes/external-party/FINDINGS.md`). The vault's old flat `DECISIONS.md`/
`FINDINGS.md` are now redirect stubs — don't read them expecting current content. Check the vault
before assuming this file alone is current.

**The vault is internal — hackathon judges see only this repo.** Anything a reviewer needs
(design rationale, limitations, demo flow) must live in this repo, in English: `README.md`
(overview, what's real vs not, known limitations), `docs/DECISIONS.md` (ADR summaries),
`docs/README.md` (run guide and reference). When a decision or limitation changes in the vault,
update those too.

## The problem

Canton prioritizes strict privacy: each participant keeps its data's state
on its own local node, and the public network doesn't store that data in readable form.

If a local database gets corrupted and the backups are lost, the data can't be recovered.
And even with a backup, the operator has no way to know whether that backup is still
recoverable, nor to verify that the restored state is correct: they find out when
the network starts rejecting their transactions.

## The solution

The node encrypts its state, replicates the encrypted blob across several custodians (other
participants), and splits the encryption key into k-of-n fragments (Shamir Secret
Sharing). No custodian ever sees plaintext, and k fragments are needed to reconstruct
the key.

Canton is NOT used as storage, but as a coordination and audit layer: a Daml
contract registers the custodians and the policy, and periodically challenges them to prove
they still hold their fragment, so a degraded backup gets detected before disaster strikes.
(Today the challenge response is recorded but not verified, and nothing re-replicates
automatically — both are declared limitations in `README.md`.)

ACS commitments — the hashes counterparties already exchange about their shared state — show
that two independent nodes agree on that state (`agent check-commitment`, real `Match` results).
They are **not** part of the `recover` pipeline: the recovery target is a different participant
with no commitment history, and the command doesn't assert `Match`. Don't claim that the
recovered state is automatically validated against commitments.

**One-line idea:** the network doesn't store your data, it stores the proof that your data is
recoverable and correct.

## Design decisions (already made, don't re-litigate)

- **The Canton network is not storage.** The sequencer has traffic fees, pruning, and message
  size limits. The encrypted blobs travel outside it (direct HTTP between agents).
  The ledger only carries the registry, the policy, and the proofs.
- **What gets split with Shamir is the encryption key, not the base data.** The encrypted blob
  is replicated whole across custodians. Same security effect, much more efficient.
- **ACS commitments verify, they don't restore.** They're hashes. What returns the data
  are the custodians' blobs. This needs to be stated explicitly in the pitch.
- **~~Identity recovery and state recovery are two separate layers. This
  project covers state (ACS). The node's identity keys are a separate problem and are
  declared out of scope.~~ SUPERSEDED 2026-09-23.** That decision was made when the goal
  was to get a working vertical slice at all — it's done now, so the goal changed. Identity
  recovery is now in scope and is the top priority. **Confirmed against the real Canton
  3.5 binary on 2026-09-23**: killed a participant for real (`docker stop`, not simulated)
  and re-hosted its external party on a different, live participant using only a signature
  from the party's own externally-held key — the dead participant was never involved. This
  is a decision, not an open question — don't re-litigate it back to out-of-scope either.
  Integrated end to end in the real pipeline since 2026-09-28 (`agent/src/rehostParty.ts`,
  wired into `recover`); `spikes/external-party/` keeps the original spike scripts.
- **The identity key is protected by the same Shamir k-of-n scheme as the encryption
  key, as independent fragments.** One custodian network, two things it protects. Recovering
  the identity key must never depend on anything only readable with the identity already
  recovered — that circular dependency defeats the whole point.
- **Communication rule for the identity-recovery work**: the original "mechanism confirmed,
  integration in progress" wording was satisfied on 2026-09-28 (identity + state + a
  counterparty transacting, all in the real pipeline). Two precisions still apply: what's
  re-hosted is an **external party** onto a different participant (not the dead participant's
  own node identity), and until `recover` reconstructs the identity key from its Shamir shares
  (planned — today it reads the key file from the owner-side volume), don't claim the demo
  recovers the identity key from the custodians.

## Known limitations (state them, don't hide them)

- If fewer than k custodians remain available, there's no recovery. It's still just a backup.
- Without a prior backup, nothing gets reconstructed from scratch.
- After a disaster, the node's own commitment history is lost: verification requires
  asking the counterparty for the commitment it saved. It's not a local operation.
- The exact names of the commitment commands change between Canton 2.x and 3.x — confirmed
  for Canton 3.5.18 (see `infra/README.md`, step 6).
- The full, current list (custodian store unauthenticated, challenge not verified, no
  re-replication, no tolerance for a custodian outage with k=2 and two third-party custodians)
  lives in `README.md`'s "Known limitations" — keep the two in sync.

## Architecture

Three pieces:

1. **Daml model (on-ledger)** — `/daml`
   - `BackupPolicy`: owner, custodians, k, n, frequency
   - `CustodianAgreement`: each custodian accepts and records what it received
   - `Challenge` / `ChallengeResponse`: periodic challenge and its proof
   - `RecoveryRequest`: the owner asks for the data back, the custodians respond

2. **Per-node agent (off-ledger)** — `/agent`
   Exports the ACS, encrypts it, splits the key k-of-n, distributes the blob and fragments,
   responds to challenges, and on recovery gathers everything and reimports it. 80% of the code.

3. **Transport** — direct HTTP between agents for the blobs. Outside Canton.

```
/daml        contract model
/agent       the per-node service
/ui          the dashboard (Vite + React)
/infra       docker-compose, node configs
/docs        run guide (README.md), design decisions (DECISIONS.md), build checklist
/spikes      frozen proof-of-mechanism scripts (historical)
```

## Work plan

Look for a working vertical slice before going deeper.

0. Repo, Daml/Canton template, docker-compose with 3 participants + synchronizer.
1. Create some trivial Daml contract between the 3 nodes, to have real state to lose.
2. **Export ACS → import ACS into an empty node, by hand via console.** If this doesn't work,
   nothing else matters. Day one, no matter what.
3. Automate it from the agent, without encryption or shards: end-to-end backup and restore.
4. Encryption + Shamir k-of-n + distribution among custodians.
5. Daml registry model and periodic challenges.
6. Verification against counterparties' commitments.
7. Minimal UI: custodian status, latest challenges, recovery button.

Plan B if time runs short: stick to the monitoring core and *backup assurance*
(challenge contract + commitment check), without fragmentation. Same insight, a
fraction of the work, finishable.

## Demo (5 minutes)

`participant1` is destroyed (container + disk). The dashboard shows the custodian only ever held
ciphertext. Recover: the owner's identity is re-authorized on `participant4`, the key is rebuilt
from the 2 independent custodians' shares (the owner's own copy is skipped on purpose), the state
is imported. Close: a counterparty proposes a contract and the recovered owner signs it itself.
Beat-by-beat version with measured timings: `README.md`'s demo section.

The node that dies is always `participant1` — that's what the run guide's recovery flow
targets. Kill it from a terminal with a script, not from a dashboard button: the dashboard is
a hardened, unauthenticated-by-design HTTP endpoint (see the security fixes in
`agent/src/dashboard.ts`), and giving it the power to kill containers would undo that on
purpose. This same rule applies to any future "destroy node" demo enhancement.

`participant1` persists to disk (H2), by design, not memory — so the destruction step is
stop + remove the container, then `docker volume rm infra_participant1_data`, not just
`docker stop`. This is also more honest: a real disaster loses or corrupts the disk, it
doesn't just crash the process. See `docs/README.md` ("Running the demo end to end") for the exact command.

## References

- Repairing Participant Nodes: https://docs.digitalasset.com/operate/3.4/explanations/repairing.html
- Repair Nodes (Daml SDK 2.x): https://docs.daml.com/canton/usermanual/repairing.html
- Disaster Recovery (Splice): https://docs.sync.global/validator_operator/validator_disaster_recovery.html
- Console Commands: https://docs.daml.com/canton/reference/console.html
- Canton Network docs: https://docs.canton.network/
