import { acceptCustody } from "./acceptCustody.js";
import { backup } from "./backup.js";
import { checkCommitment } from "./checkCommitment.js";
import { issueChallenge } from "./challenge.js";
import { challengeLoop } from "./challengeLoop.js";
import { createPolicy, type CustodianRef } from "./createPolicy.js";
import { startDashboard } from "./dashboard.js";
import { distribute } from "./distribute.js";
import { recover } from "./recover.js";
import { requestRecovery } from "./requestRecovery.js";
import { respond } from "./respond.js";
import { respondRecovery } from "./respondRecovery.js";
import { restore } from "./restore.js";
import { seed } from "./seed.js";
import { startServer } from "./server.js";

function usage(): never {
  console.error(
    "Usage:\n" +
      "  backup         --source <participant> --party <hint> --out <path>\n" +
      "  restore        --target <participant> --in <path>\n" +
      "  serve          --port <port>\n" +
      "  distribute     --source <participant> --party <hint> --policy-id <id> --endpoints <url,url,...> --k <n>\n" +
      "  recover        --target <participant> --policy-id <id> --endpoints <url,url,...> --k <n>\n" +
      "  create-policy  --owner-participant <p> --owner <hint> --custodian <participant:port:hint> [--custodian ...] " +
      "--k <n> --n <n> --frequency-hours <h> --policy-id <id>\n" +
      "  accept-custody --as <name> --participant <p> --custodian <hint> --owner-participant <p> --owner <hint> --policy-id <id>\n" +
      "  challenge      --owner-participant <p> --owner <hint> --custodian-participant <p> --custodian <hint> " +
      "--policy-id <id> --challenge-id <id>\n" +
      "  respond        --as <name> --participant <p> --custodian <hint> --policy-id <id> --challenge-id <id>\n" +
      "  challenge-loop --owner-participant <p> --owner <hint> --custodian <participant:port:hint> [--custodian ...] " +
      "--policy-id <id> --interval-seconds <n>\n" +
      "  request-recovery --owner-participant <p> --owner <hint> --custodian-participant <p> --custodian <hint> " +
      "--policy-id <id> --request-id <id>\n" +
      "  respond-recovery --as <name> --participant <p> --custodian <hint> --policy-id <id> --request-id <id>\n" +
      "  seed             (no args — allocates owner as an external party, seeds the demo Record)\n" +
      "  check-commitment --counterparty-participant <console-name> --about-participant <console-name>\n" +
      "  dashboard        --port <port> --owner-participant <p> --owner <hint> --policy-id <id> " +
      "--recover-target <participant> --recover-endpoints <url,url,...>",
  );
  process.exit(1);
}

function flag(args: string[], name: string): string {
  const idx = args.indexOf(`--${name}`);
  const value = idx === -1 ? undefined : args[idx + 1];
  if (value === undefined) usage();
  return value;
}

function multiFlag(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}`) {
      const value = args[i + 1];
      if (value === undefined) usage();
      values.push(value);
    }
  }
  if (values.length === 0) usage();
  return values;
}

function endpointsFlag(args: string[], name = "endpoints"): string[] {
  return flag(args, name)
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
}

function thresholdFlag(args: string[]): number {
  const n = Number.parseInt(flag(args, "k"), 10);
  if (Number.isNaN(n)) usage();
  return n;
}

function intFlag(args: string[], name: string): number {
  const n = Number.parseInt(flag(args, name), 10);
  if (Number.isNaN(n)) usage();
  return n;
}

// "participant:port:partyHint" -> { participant: "participant:port", partyHint }
function custodianRefsFlag(args: string[]): CustodianRef[] {
  return multiFlag(args, "custodian").map((raw) => {
    const parts = raw.split(":");
    const partyHint = parts.pop();
    const participant = parts.join(":");
    if (partyHint === undefined || participant === "") usage();
    return { participant, partyHint };
  });
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
    startServer(intFlag(rest, "port"));
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

  if (command === "create-policy") {
    console.log(
      await createPolicy({
        ownerParticipant: flag(rest, "owner-participant"),
        ownerPartyHint: flag(rest, "owner"),
        custodians: custodianRefsFlag(rest),
        k: intFlag(rest, "k"),
        n: intFlag(rest, "n"),
        frequencyHours: intFlag(rest, "frequency-hours"),
        policyId: flag(rest, "policy-id"),
      }),
    );
    return;
  }

  if (command === "accept-custody") {
    console.log(
      await acceptCustody({
        as: flag(rest, "as"),
        participant: flag(rest, "participant"),
        custodianPartyHint: flag(rest, "custodian"),
        ownerParticipant: flag(rest, "owner-participant"),
        ownerPartyHint: flag(rest, "owner"),
        policyId: flag(rest, "policy-id"),
      }),
    );
    return;
  }

  if (command === "challenge") {
    console.log(
      await issueChallenge({
        ownerParticipant: flag(rest, "owner-participant"),
        ownerPartyHint: flag(rest, "owner"),
        custodianParticipant: flag(rest, "custodian-participant"),
        custodianPartyHint: flag(rest, "custodian"),
        policyId: flag(rest, "policy-id"),
        challengeId: flag(rest, "challenge-id"),
      }),
    );
    return;
  }

  if (command === "respond") {
    console.log(
      await respond({
        as: flag(rest, "as"),
        participant: flag(rest, "participant"),
        custodianPartyHint: flag(rest, "custodian"),
        policyId: flag(rest, "policy-id"),
        challengeId: flag(rest, "challenge-id"),
      }),
    );
    return;
  }

  if (command === "challenge-loop") {
    await challengeLoop({
      ownerParticipant: flag(rest, "owner-participant"),
      ownerPartyHint: flag(rest, "owner"),
      custodians: custodianRefsFlag(rest),
      policyId: flag(rest, "policy-id"),
      intervalSeconds: intFlag(rest, "interval-seconds"),
    });
    return;
  }

  if (command === "request-recovery") {
    console.log(
      await requestRecovery({
        ownerParticipant: flag(rest, "owner-participant"),
        ownerPartyHint: flag(rest, "owner"),
        custodianParticipant: flag(rest, "custodian-participant"),
        custodianPartyHint: flag(rest, "custodian"),
        policyId: flag(rest, "policy-id"),
        requestId: flag(rest, "request-id"),
      }),
    );
    return;
  }

  if (command === "respond-recovery") {
    console.log(
      await respondRecovery({
        as: flag(rest, "as"),
        participant: flag(rest, "participant"),
        custodianPartyHint: flag(rest, "custodian"),
        policyId: flag(rest, "policy-id"),
        requestId: flag(rest, "request-id"),
      }),
    );
    return;
  }

  if (command === "check-commitment") {
    console.log(
      await checkCommitment({
        counterpartyParticipant: flag(rest, "counterparty-participant"),
        aboutParticipant: flag(rest, "about-participant"),
      }),
    );
    return;
  }

  if (command === "seed") {
    console.log(await seed());
    return;
  }

  if (command === "dashboard") {
    startDashboard({
      port: intFlag(rest, "port"),
      ownerParticipant: flag(rest, "owner-participant"),
      ownerPartyHint: flag(rest, "owner"),
      policyId: flag(rest, "policy-id"),
      recoverTarget: flag(rest, "recover-target"),
      recoverEndpoints: endpointsFlag(rest, "recover-endpoints"),
    });
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
