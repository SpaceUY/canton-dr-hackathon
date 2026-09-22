# canton-dr

Verifiable decentralized disaster recovery for Canton nodes.
Project for the Canton Network hackathon (AppsFactory).

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
they still hold their fragment, so a degraded backup gets detected and re-replicated
before disaster strikes.

On recovery, the reconstructed ACS is validated against the ACS commitments the network already
exchanges between counterparties: cryptographic proof that the state is correct, without
trusting whoever held the backup.

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
- **Identity recovery and state recovery are two separate layers.** This
  project covers state (ACS). The node's identity keys are a separate problem and are
  declared out of scope.

## Known limitations (state them, don't hide them)

- If fewer than k custodians remain available, there's no recovery. It's still just a backup.
- Without a prior backup, nothing gets reconstructed from scratch.
- After a disaster, the node's own commitment history is lost: verification requires
  asking the counterparty for the commitment it saved. It's not a local operation.
- The exact names of the commitment commands change between Canton 2.x and 3.x.
  Confirm the hackathon's version before committing to that part of the demo.

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
/infra       docker-compose, node configs
/docs        README, diagram, pitch
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

3 nodes. One loses its base. Recovers with 2 of 3 fragments. Validates against the commitment.
Shows that the custodian only ever saw ciphertext.

## References

- Repairing Participant Nodes: https://docs.digitalasset.com/operate/3.4/explanations/repairing.html
- Repair Nodes (Daml SDK 2.x): https://docs.daml.com/canton/usermanual/repairing.html
- Disaster Recovery (Splice): https://docs.sync.global/validator_operator/validator_disaster_recovery.html
- Console Commands: https://docs.daml.com/canton/reference/console.html
- Canton Network docs: https://docs.canton.network/
