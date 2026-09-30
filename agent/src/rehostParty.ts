import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafeIdentifier, runCantonScript } from "./canton.js";
import { signTopologyHash } from "./externalParty.js";
import { isPartyHostedLocally } from "./ledger.js";

// Real sub-phases of re-authorizing identity on the target, each reported
// when it actually happens - not one opaque await covering all of them.
// A single "identity re-authorized" milestone at the end left the UI's
// recovery graph looking dead for the ~55s this whole thing can take
// (live-tested 2026-09-29): four distinct things advancing beats one
// frozen bar, even if any one of them is still slow on its own.
export type RehostSubStep =
  | "checking-idempotency"
  | "already-hosted"
  | "proposing"
  | "proposed"
  | "signing"
  | "signed"
  | "loading"
  | "loaded"
  | "verifying"
  | "verified";

export interface RehostEvent {
  type: "rehost-substep";
  step: RehostSubStep;
  detail?: string;
}

export interface RehostPartyOptions {
  partyId: string;
  targetParticipant: string; // console name, e.g. "participant4"
  targetLedgerApi: string; // same node's http-ledger-api host:port, e.g. "participant4:5043" — used only for the idempotency check
  loaderParticipant: string; // any other live, connected console, e.g. "participant2"
  keyPath: string;
  synchronizerAlias?: string;
  onProgress?: (event: RehostEvent) => void;
}

// Authorizes `targetParticipant` to host an already-existing external party
// that isn't hosted there yet — the mechanism proven in
// spikes/external-party/ (stepA/stepB there, POC - External Party ACS State
// Migration in the vault). Must run before restore()'s repair.import_acs:
// import_acs only replays contract data, it doesn't grant hosting rights for
// a party the target doesn't already know about — without this step the
// target has no business accepting that party's contracts at all.
export async function rehostParty(options: RehostPartyOptions): Promise<string> {
  const { partyId, targetParticipant, targetLedgerApi, loaderParticipant, keyPath, onProgress } = options;
  const synchronizerAlias = options.synchronizerAlias ?? "da";
  assertSafeIdentifier(targetParticipant, "targetParticipant");
  assertSafeIdentifier(loaderParticipant, "loaderParticipant");

  onProgress?.({ type: "rehost-substep", step: "checking-idempotency" });

  // Idempotency: propose_delta's requiresPartyToBeOnboarded=true asserts the
  // party ISN'T already hosted on the target — re-running this against an
  // already-completed rehost isn't just a harmless no-op, it breaks loudly.
  if (await isPartyHostedLocally(targetLedgerApi, partyId)) {
    onProgress?.({ type: "rehost-substep", step: "already-hosted" });
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
  // Confirmation, not Observation: recovery must restore the party's
  // ability to ACT (initiate its own commands from the target), not just
  // receive/observe what others send it. Confirmed the hard way: with
  // Observation, the counterparty-transacts proof still passed (that only
  // needs owner to be an observer), but owner itself could never submit its
  // own commands from the recovered node.
  // Not Submission: canConfirm is true for both Confirmation and Submission
  // (TopologyMapping.scala) - Submission additionally lets the PARTICIPANT
  // sign on the party's behalf, meaningless for an external party that
  // always signs client-side. participant1, the original undamaged host,
  // already grants only Confirmation for this party - matching it is the
  // least-privilege, fidelity-preserving choice.
  adds = Seq((target.id, ParticipantPermission.Confirmation)),
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

    onProgress?.({ type: "rehost-substep", step: "proposing", detail: `proposing on ${targetParticipant}` });
    const proposeStdout = await runCantonScript(proposeScript);
    const hashLine = proposeStdout.split("\n").find((l) => l.includes("REHOST_PROPOSAL_HASH_B64:"));
    if (hashLine === undefined) {
      throw new Error(`rehost propose step did not confirm success:\n${proposeStdout}`);
    }
    const hashB64 = hashLine.split(":")[1];
    if (hashB64 === undefined) throw new Error(`could not parse proposal hash from: ${hashLine}`);
    onProgress?.({ type: "rehost-substep", step: "proposed" });

    onProgress?.({ type: "rehost-substep", step: "signing", detail: "signing with owner's external key" });
    const { signatureB64, fingerprint } = await signTopologyHash(hashB64, keyPath, partyId);
    onProgress?.({ type: "rehost-substep", step: "signed" });

    // Load + verify (reconnect target, clear onboarding) in ONE script, not
    // two: each runCantonScript call pays for a fresh JVM console startup,
    // which live-tested added enough real wall-clock time to push a full
    // recovery close to 2 minutes for no narrative benefit — the "loaded"
    // and "verifying"/"verified" events below still fire as their own real
    // steps, just without a second JVM spin-up between them. `loader` (a
    // different, still-connected console) does the load — `target`
    // disconnected itself above, and a disconnected participant has no live
    // view of its own topology store to load a transaction into (see
    // FINDINGS.md, TOPOLOGY_STORE_NOT_FOUND) — but the SAME script can still
    // reference `target` directly afterward for the reconnect + onboarding
    // check, since both are just remote admin-API handles, not a
    // stateful session tied to one script invocation.
    const loadAndVerifyScript = `
import com.digitalasset.canton.topology.transaction.SignedTopologyTransaction
import com.digitalasset.canton.crypto.{Signature, SignatureFormat, SigningAlgorithmSpec, Fingerprint}
import java.nio.file.{Files, Paths}

val partyId = PartyId.tryFromProtoPrimitive("${partyId}")
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
println("REHOST_LOAD_OK")

target.synchronizers.modify("${synchronizerAlias}", _.copy(manualConnect = false))

// Wait for target to actually be back online before touching it further -
// modify(manualConnect=false) alone doesn't guarantee it reconnects within
// this same script invocation.
var reconnectAttempts = 0
while (!target.synchronizers.is_connected("${synchronizerAlias}") && reconnectAttempts < 20) {
  target.synchronizers.reconnect("${synchronizerAlias}")
  Thread.sleep(1000)
  reconnectAttempts += 1
}

// Without this, owner stays able to RECEIVE commands on target but can
// never SUBMIT its own (PARTY_CURRENTLY_ONBOARDING) - reproduced live
// against a fresh environment: rehostParty's hosting succeeds, but the
// very next real command owner submits from target fails outright.
// beginOffsetExclusive=1L (not the current ledger end) - using the
// current end hung for 54s against this node's own gRPC deadline instead
// of resolving, presumably searching from the wrong direction to find
// the party's activation transaction.
// Fire-and-forget, NOT retried in a loop here: Canton's own doc says this
// call "records the clearance operation as pending, ensuring it can
// automatically resume" on its own in the background - a synchronous
// retry loop here blocks the whole recovery, live-tested at +50s of dead
// time. Canton finishes the job on its own shortly after.
val clearSynchronizerId = target.synchronizers.id_of("${synchronizerAlias}")
val onboardingStatus = target.parties.clear_party_onboarding_flag(partyId, clearSynchronizerId, 1L, None)
println(s"REHOST_ONBOARDING_STATUS: $onboardingStatus")
println("REHOST_VERIFY_OK")
`.trim();

    onProgress?.({ type: "rehost-substep", step: "loading", detail: `loading the signed transaction via ${loaderParticipant}` });
    const loadStdout = await runCantonScript(loadAndVerifyScript);
    if (!loadStdout.includes("REHOST_LOAD_OK") || !loadStdout.includes("REHOST_VERIFY_OK")) {
      throw new Error(`rehost load/verify step did not confirm success:\n${loadStdout}`);
    }
    onProgress?.({ type: "rehost-substep", step: "loaded" });

    onProgress?.({ type: "rehost-substep", step: "verifying", detail: `reconnecting ${targetParticipant} and checking submission readiness` });
    const onboardingPending = loadStdout.includes("FlagSet");
    onProgress?.({
      type: "rehost-substep",
      step: "verified",
      detail: onboardingPending
        ? "submission rights still finalizing in the background"
        : "ready to submit its own commands",
    });

    return `REHOST_OK: ${partyId} authorized to host on ${targetParticipant} (loaded via ${loaderParticipant})`;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
