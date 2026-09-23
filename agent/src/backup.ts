import { assertSafeIdentifier, runCantonScript } from "./canton.js";

export interface BackupOptions {
  sourceParticipant: string;
  partyHint: string;
  outFile: string;
}

// Exports one party's ACS from `sourceParticipant` to `outFile`. Per plan
// step 2's findings, this doesn't touch the source participant's own
// filesystem — the bytes come back over the admin API, so `outFile` is
// local to wherever this agent runs. Returns the confirmation line so the
// caller can surface it (Canton's own `println` output never reaches the
// CLI's stdout otherwise).
export async function backup(options: BackupOptions): Promise<string> {
  const { sourceParticipant, partyHint, outFile } = options;
  assertSafeIdentifier(sourceParticipant, "sourceParticipant");

  const script = `
val source = ${sourceParticipant}
val partyId = source.parties.list(filterParty = "${partyHint}").headOption
  .getOrElse(sys.error("party '${partyHint}' not found on ${sourceParticipant}"))
  .party
val endOffset = source.ledger_api.state.end()

source.repair.export_acs(
  parties = Set(partyId),
  ledgerOffset = endOffset,
  exportFilePath = "${outFile}",
)
println(s"BACKUP_OK: $partyId as of offset $endOffset -> ${outFile}")
`.trim();

  const stdout = await runCantonScript(script);
  const line = stdout.split("\n").find((l) => l.includes("BACKUP_OK"));
  if (line === undefined) {
    throw new Error(`backup did not confirm success:\n${stdout}`);
  }
  return line;
}
