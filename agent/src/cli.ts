import { backup } from "./backup.js";
import { restore } from "./restore.js";

function usage(): never {
  console.error(
    "Usage:\n" +
      "  backup  --source <participant> --party <hint> --out <path>\n" +
      "  restore --target <participant> --in <path>",
  );
  process.exit(1);
}

function flag(args: string[], name: string): string {
  const idx = args.indexOf(`--${name}`);
  const value = idx === -1 ? undefined : args[idx + 1];
  if (value === undefined) usage();
  return value;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "backup") {
    console.log(
      await backup({
        sourceParticipant: flag(rest, "source"),
        partyHint: flag(rest, "party"),
        outFile: flag(rest, "out"),
      }),
    );
    return;
  }

  if (command === "restore") {
    console.log(
      await restore({
        targetParticipant: flag(rest, "target"),
        inFile: flag(rest, "in"),
      }),
    );
    return;
  }

  usage();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
