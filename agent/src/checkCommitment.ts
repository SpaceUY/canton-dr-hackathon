import { runCantonScript } from "./canton.js";

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
// Two commands, because testing this exposed a real gap between them:
// `get_intervals_behind_for_counter_participants` reliably returns real
// data (confirms the pair is tracked and how caught-up it is), but
// `lookup_sent_acs_commitments` came back empty in every test run here even
// well past the default 1-minute reconciliation interval — a closed
// commitment period apparently needs more elapsed real time than a short
// test window gives it. Reporting both rather than hiding the empty one.
//
// This does not compare either result against a freshly recomputed
// commitment from a recovered node: that comparison only means something
// for the *same* participant identity recovering (see docs/ROADMAP.md step
// 6) — this project's recovery target is a stand-in with a fresh identity,
// which by definition has no commitment history to compare against. What
// this proves is that the real command surface exists and returns real
// data for an active pair.
export async function checkCommitment(options: CheckCommitmentOptions): Promise<string> {
  const { counterpartyParticipant, aboutParticipant, synchronizerAlias } = options;
  const alias = synchronizerAlias ?? "da";

  const script = `
import com.digitalasset.canton.admin.api.client.commands.ParticipantAdminCommands.Inspection.SynchronizerTimeRange

val target = ${counterpartyParticipant}
val synchronizerId = target.synchronizers.id_of("${alias}")
val counterpartyId = ${aboutParticipant}.id

val behind = target.commitments.get_intervals_behind_for_counter_participants(
  Seq(counterpartyId),
  Seq(synchronizerId),
  None,
)

val sent = target.commitments.lookup_sent_acs_commitments(
  Seq(SynchronizerTimeRange(synchronizerId, None)),
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
