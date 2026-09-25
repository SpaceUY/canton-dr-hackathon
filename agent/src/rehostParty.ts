import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafeIdentifier, runCantonScript } from "./canton.js";
import { signTopologyHash } from "./externalParty.js";
import { isPartyHostedLocally } from "./ledger.js";

export interface RehostPartyOptions {
  partyId: string;
  targetParticipant: string; // console name, e.g. "participant4"
  targetLedgerApi: string; // same node's http-ledger-api host:port, e.g. "participant4:5043" — used only for the idempotency check
  loaderParticipant: string; // any other live, connected console, e.g. "participant2"
  keyPath: string;
  synchronizerAlias?: string;
}

// Authorizes `targetParticipant` to host an already-existing external party
// that isn't hosted there yet — the mechanism proven in
// spikes/external-party/ (stepA/stepB there, POC - External Party ACS State
// Migration in the vault). Must run before restore()'s repair.import_acs:
// import_acs only replays contract data, it doesn't grant hosting rights for
// a party the target doesn't already know about — without this step the
// target has no business accepting that party's contracts at all.
export async function rehostParty(options: RehostPartyOptions): Promise<string> {
  const { partyId, targetParticipant, targetLedgerApi, loaderParticipant, keyPath } = options;
  const synchronizerAlias = options.synchronizerAlias ?? "da";
  assertSafeIdentifier(targetParticipant, "targetParticipant");
  assertSafeIdentifier(loaderParticipant, "loaderParticipant");

  // Idempotency: propose_delta's requiresPartyToBeOnboarded=true asserts the
  // party ISN'T already hosted on the target — re-running this against an
  // already-completed rehost isn't just a harmless no-op, it breaks loudly.
  if (await isPartyHostedLocally(targetLedgerApi, partyId)) {
    return `REHOST_OK: ${partyId} already hosted on ${targetParticipant} — skipped`;
  }

  const workDir = await mkdtemp(join(tmpdir(), "agent-rehost-"));
  try {
    const proposalPath = join(workDir, "proposal.bin");

    // propose_delta needs the target still connected — it reads its own
    // live topology store to build the proposal (TOPOLOGY_STORE_NOT_FOUND
    // otherwise, see FINDINGS.md). Only disconnect (and force manualConnect
    // so nothing reconnects out from under us before the signed transaction
    // is loaded elsewhere) AFTER proposing — see
    // spikes/external-party/stepA-authorize-spike5.canton for the proven order.
    const proposeScript = `
import com.digitalasset.canton.topology.transaction.ParticipantPermission
import java.nio.file.{Files, Paths}

val partyId = PartyId.tryFromProtoPrimitive("${partyId}")
val target = ${targetParticipant}
val synchronizerId = target.synchronizers.id_of("${synchronizerAlias}")

val proposal = target.topology.party_to_participant_mappings.propose_delta(
  party = partyId,
  adds = Seq((target.id, ParticipantPermission.Observation)),
  store = synchronizerId,
  requiresPartyToBeOnboarded = true,
)
val hashBytes = proposal.hash.hash.getCryptographicEvidence.toByteArray
println(s"REHOST_PROPOSAL_HASH_B64:\${java.util.Base64.getEncoder.encodeToString(hashBytes)}")

Files.write(Paths.get("${proposalPath}"), proposal.toByteString.toByteArray)

target.synchronizers.disconnect("${synchronizerAlias}")
target.synchronizers.modify("${synchronizerAlias}", _.copy(manualConnect = true))
println("REHOST_PROPOSE_OK")
`.trim();

    const proposeStdout = await runCantonScript(proposeScript);
    const hashLine = proposeStdout.split("\n").find((l) => l.includes("REHOST_PROPOSAL_HASH_B64:"));
    if (hashLine === undefined) {
      throw new Error(`rehost propose step did not confirm success:\n${proposeStdout}`);
    }
    const hashB64 = hashLine.split(":")[1];
    if (hashB64 === undefined) throw new Error(`could not parse proposal hash from: ${hashLine}`);

    const { signatureB64, fingerprint } = await signTopologyHash(hashB64, keyPath, partyId);

    // Loaded via a different, still-connected console — `target` disconnected
    // itself above, and a disconnected participant has no live view of its
    // own topology store to load a transaction into (see FINDINGS.md,
    // TOPOLOGY_STORE_NOT_FOUND). Reverting manualConnect here too, so this
    // step doesn't leave a permanent side effect on the target beyond the
    // disaster-recovery window itself.
    const loadScript = `
import com.digitalasset.canton.topology.transaction.SignedTopologyTransaction
import com.digitalasset.canton.crypto.{Signature, SignatureFormat, SigningAlgorithmSpec, Fingerprint}
import java.nio.file.{Files, Paths}

val loader = ${loaderParticipant}
val target = ${targetParticipant}
val synchronizerId = loader.synchronizers.id_of("${synchronizerAlias}")

val bytes = Files.readAllBytes(Paths.get("${proposalPath}"))
val proposal = SignedTopologyTransaction
  .fromTrustedByteArray(com.digitalasset.canton.version.ProtocolVersionValidation.NoValidation, bytes)
  .fold(err => sys.error(s"deserialize failed: $err"), identity)

val sigBytes = com.google.protobuf.ByteString.copyFrom(
  java.util.Base64.getDecoder.decode("${signatureB64}")
)
val partySignature = Signature.fromExternalSigning(
  format = SignatureFormat.Concat,
  signature = sigBytes,
  signedBy = Fingerprint.tryFromString("${fingerprint}"),
  signingAlgorithmSpec = SigningAlgorithmSpec.Ed25519,
)
loader.topology.transactions.load(
  transactions = Seq(proposal.addSingleSignature(partySignature)),
  store = synchronizerId,
)

target.synchronizers.modify("${synchronizerAlias}", _.copy(manualConnect = false))
println("REHOST_LOAD_OK")
`.trim();

    const loadStdout = await runCantonScript(loadScript);
    if (!loadStdout.includes("REHOST_LOAD_OK")) {
      throw new Error(`rehost load step did not confirm success:\n${loadStdout}`);
    }

    return `REHOST_OK: ${partyId} authorized to host on ${targetParticipant} (loaded via ${loaderParticipant})`;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
