import { assertSafeIdentifier, runCantonScript } from "./canton.js";

export interface RestoreOptions {
  targetParticipant: string;
  inFile: string;
  synchronizerAlias?: string;
}

// Imports an exported ACS file into `targetParticipant`. Per plan step 2's
// findings: the target must already use database-backed storage (H2 or
// Postgres, not memory), and must be disconnected from the synchronizer
// during the import — both preconditions this function enforces/handles,
// not something the caller has to remember. Returns the confirmation line
// so the caller can surface it (Canton's own `println` output never reaches
// the CLI's stdout otherwise).
export async function restore(options: RestoreOptions): Promise<string> {
  const { targetParticipant, inFile } = options;
  assertSafeIdentifier(targetParticipant, "targetParticipant");
  const synchronizerAlias = options.synchronizerAlias ?? "da";

  const script = `
val target = ${targetParticipant}
val synchronizerId = target.synchronizers.id_of("${synchronizerAlias}")

target.synchronizers.disconnect("${synchronizerAlias}")
target.repair.import_acs(
  synchronizerId = synchronizerId,
  importFilePath = "${inFile}",
)
target.synchronizers.reconnect_all()
println(s"RESTORE_OK: ${inFile} imported into ${targetParticipant}")
`.trim();

  const stdout = await runCantonScript(script);
  const line = stdout.split("\n").find((l) => l.includes("RESTORE_OK"));
  if (line === undefined) {
    throw new Error(`restore did not confirm success:\n${stdout}`);
  }
  return line;
}
