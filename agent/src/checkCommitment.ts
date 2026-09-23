import { assertSafeIdentifier, runCantonScript } from "./canton.js";

export interface CheckCommitmentOptions {
  // console name of the counterparty whose records we're asking, e.g. "participant2"
  counterpartyParticipant: string;
  // console name of the other side of the pair, e.g. "participant1" (the original owner)
  aboutParticipant: string;
  synchronizerAlias?: string;
}

// Plan step 6: ACS commitments verify, they don't restore (CLAUDE.md). This
// asks a counterparty for what *it* independently recorded about its shared
// state with `aboutParticipant` — real Canton data, not something derived
// from the backup itself, so it can't be spoofed by whoever held the blob.
//
// Earlier version passed `None` as the time range and got `Map()` back
// every time, which read as "needs more elapsed real time". That guess was
// wrong: per Canton's own source (GrpcParticipantInspectionService.
// validateSynchronizerTimeRange), a synchronizer entry with no `TimeRange`
// collapses to a single-instant window at the participant's global
// last-computed-and-sent timestamp — not "all history" — so it only hits by
// luck if that exact instant includes a commitment for this specific
// counterparty. Passing an explicit wide range (epoch to now) fixes it:
// this returns every historical commitment period for the pair, each with
// the real SHA-256 hash both sides computed independently and its match
// state (Match/Mismatch/NotCompared) — the actual cryptographic proof, not
// just confirmation the command surface exists.
//
// This does not compare either result against a freshly recomputed
// commitment from a recovered node: that comparison only means something
// for the *same* participant identity recovering (see docs/ROADMAP.md step
// 6) — this project's recovery target is a stand-in with a fresh identity,
// which by definition has no commitment history to compare against. What
// this proves is that two independent, real participant nodes computed and
// exchanged matching cryptographic commitments over the shared state.
export async function checkCommitment(options: CheckCommitmentOptions): Promise<string> {
  const { counterpartyParticipant, aboutParticipant, synchronizerAlias } = options;
  assertSafeIdentifier(counterpartyParticipant, "counterpartyParticipant");
  assertSafeIdentifier(aboutParticipant, "aboutParticipant");
  const alias = synchronizerAlias ?? "da";

  const script = `
import com.digitalasset.canton.admin.api.client.commands.ParticipantAdminCommands.Inspection.{SynchronizerTimeRange, TimeRange}
import com.digitalasset.canton.data.CantonTimestamp

val target = ${counterpartyParticipant}
val synchronizerId = target.synchronizers.id_of("${alias}")
val counterpartyId = ${aboutParticipant}.id

val behind = target.commitments.get_intervals_behind_for_counter_participants(
  Seq(counterpartyId),
  Seq(synchronizerId),
  None,
)

val sent = target.commitments.lookup_sent_acs_commitments(
  Seq(SynchronizerTimeRange(synchronizerId, Some(TimeRange(CantonTimestamp.Epoch, CantonTimestamp.now())))),
  Seq(counterpartyId),
  Seq.empty,
  true,
)

println(s"COMMITMENT_OK: intervalsBehind=$behind sentCommitments=$sent")
`.trim();

  const stdout = await runCantonScript(script);
  const line = stdout.split("\n").find((l) => l.includes("COMMITMENT_OK"));
  if (line === undefined) {
    throw new Error(`commitment lookup did not confirm success:\n${stdout}`);
  }
  return line;
}
