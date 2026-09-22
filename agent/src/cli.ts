import { backup } from "./backup.js";
import { distribute } from "./distribute.js";
import { recover } from "./recover.js";
import { restore } from "./restore.js";
import { startServer } from "./server.js";

function usage(): never {
  console.error(
    "Usage:\n" +
      "  backup     --source <participant> --party <hint> --out <path>\n" +
      "  restore    --target <participant> --in <path>\n" +
      "  serve      --port <port>\n" +
      "  distribute --source <participant> --party <hint> --policy-id <id> --endpoints <url,url,...> --k <n>\n" +
      "  recover    --target <participant> --policy-id <id> --endpoints <url,url,...> --k <n>",
  );
  process.exit(1);
}

function flag(args: string[], name: string): string {
  const idx = args.indexOf(`--${name}`);
  const value = idx === -1 ? undefined : args[idx + 1];
  if (value === undefined) usage();
  return value;
}

function endpointsFlag(args: string[]): string[] {
  return flag(args, "endpoints")
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
}

function thresholdFlag(args: string[]): number {
  const n = Number.parseInt(flag(args, "k"), 10);
  if (Number.isNaN(n)) usage();
  return n;
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

  if (command === "serve") {
    const port = Number.parseInt(flag(rest, "port"), 10);
    if (Number.isNaN(port)) usage();
    startServer(port);
    return;
  }

  if (command === "distribute") {
    console.log(
      await distribute({
        sourceParticipant: flag(rest, "source"),
        partyHint: flag(rest, "party"),
        policyId: flag(rest, "policy-id"),
        endpoints: endpointsFlag(rest),
        threshold: thresholdFlag(rest),
      }),
    );
    return;
  }

  if (command === "recover") {
    console.log(
      await recover({
        targetParticipant: flag(rest, "target"),
        policyId: flag(rest, "policy-id"),
        endpoints: endpointsFlag(rest),
        threshold: thresholdFlag(rest),
      }),
    );
    return;
  }

  usage();
}

main().catch((err: unknown) => {
  // `fetch`'s own errors (e.g. "fetch failed") hide the real reason in
  // `.cause` — printing just `.message` is close to useless for those.
  if (err instanceof Error) {
    console.error(err.message);
    if (err.cause !== undefined) console.error("cause:", err.cause);
  } else {
    console.error(err);
  }
  process.exit(1);
});
