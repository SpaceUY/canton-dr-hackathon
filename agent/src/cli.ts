import { acceptCustody } from "./acceptCustody.js";
import { backup } from "./backup.js";
import { checkCommitment } from "./checkCommitment.js";
import { issueChallenge } from "./challenge.js";
import { challengeLoop } from "./challengeLoop.js";
import { counterpartyTx } from "./counterpartyTx.js";
import { createPolicy, type CustodianRef } from "./createPolicy.js";
import { startDashboard } from "./dashboard.js";
import { distribute } from "./distribute.js";
import { distributeIdentityKey } from "./distributeIdentity.js";
import { recover } from "./recover.js";
import { recoverIdentityKey } from "./recoverIdentity.js";
import { requestRecovery } from "./requestRecovery.js";
import { respond } from "./respond.js";
import { respondRecovery } from "./respondRecovery.js";
import { restore } from "./restore.js";
import { seed } from "./seed.js";
import { startServer } from "./server.js";
import { verifyDemoState } from "./verifyDemoState.js";

function usage(): never {
  console.error(
    "Usage:\n" +
      "  backup         --source <participant> --party <hint> --out <path>\n" +
      "  restore        --target <participant> --in <path>\n" +
      "  serve          --port <port>\n" +
      "  distribute     --source <participant> --party <hint> --policy-id <id> --endpoints <url,url,...> --k <n>\n" +
      "  distribute-identity --policy-id <id> --endpoints <url,url,...> --k <n> [--key-path <path>]\n" +
      "  recover        --target <participant> --target-ledger-api <host:port> --loader-participant <console> " +
      "--policy-id <id> --endpoints <url,url,...> --k <n> --identity-custodian <participant:port:hint>\n" +
      "  recover-identity --policy-id <id> --endpoints <url,url,...> --k <n> --custodian-participant <p> " +
      "--custodian <hint> [--key-path <path>]\n" +
      "  counterparty-tx --as <custodian-hint> --participant <p> --owner-participant <host:port> [--label <text>]\n" +
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
      "  verify-demo-state (no args — fails loudly if the environment isn't a genuine pre-disaster state)\n" +
      "  check-commitment --counterparty-participant <console-name> --about-participant <console-name>\n" +
      "  dashboard        --port <port> --custodian <participant:port:hint> [--custodian ...] --policy-id <id> " +
      "--recover-target <participant> --recover-target-ledger-api <host:port> --recover-endpoints <url,url,...> " +
      "--recover-loader-participant <console> --counterparty-tx-as <custodian-hint> " +
      "--counterparty-tx-participant <host:port>",
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

function optionalFlag(args: string[], name: string, defaultValue: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx === -1 ? defaultValue : (args[idx + 1] ?? defaultValue);
}

const OWNER_KEY_PATH = process.env.OWNER_KEY_PATH ?? "/canton/identity/owner.der";

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
function custodianRefsFlag(args: string[], name = "custodian"): CustodianRef[] {
  return multiFlag(args, name).map((raw) => {
    const parts = raw.split(":");
    const partyHint = parts.pop();
    const participant = parts.join(":");
    if (partyHint === undefined || participant === "") usage();
    return { participant, partyHint };
  });
}

function singleCustodianRefFlag(args: string[], name: string): CustodianRef {
  const refs = custodianRefsFlag(args, name);
  if (refs.length !== 1) usage();
  return refs[0] as CustodianRef;
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
        targetLedgerApi: flag(rest, "target-ledger-api"),
        loaderParticipant: flag(rest, "loader-participant"),
        policyId: flag(rest, "policy-id"),
        endpoints: endpointsFlag(rest),
        threshold: thresholdFlag(rest),
        identityCustodian: singleCustodianRefFlag(rest, "identity-custodian"),
      }),
    );
    return;
  }

  if (command === "distribute-identity") {
    console.log(
      await distributeIdentityKey({
        keyPath: optionalFlag(rest, "key-path", OWNER_KEY_PATH),
        policyId: flag(rest, "policy-id"),
        endpoints: endpointsFlag(rest),
        threshold: thresholdFlag(rest),
      }),
    );
    return;
  }

  if (command === "counterparty-tx") {
    const result = await counterpartyTx({
      as: flag(rest, "as"),
      participant: flag(rest, "participant"),
      ownerParticipant: flag(rest, "owner-participant"),
      label: optionalFlag(rest, "label", "post-recovery-demo"),
    });
    console.log(
      `COUNTERPARTY_TX_OK: ${result.proposer} proposed, ${result.owner} accepted as sole signatory ` +
        `(label '${result.label}') — Record ${result.recordContractId} active on ${result.ownerParticipant}`,
    );
    return;
  }

  if (command === "recover-identity") {
    const { line } = await recoverIdentityKey({
      keyPath: optionalFlag(rest, "key-path", OWNER_KEY_PATH),
      policyId: flag(rest, "policy-id"),
      endpoints: endpointsFlag(rest),
      threshold: thresholdFlag(rest),
      custodianParticipant: flag(rest, "custodian-participant"),
      custodianPartyHint: flag(rest, "custodian"),
    });
    console.log(line);
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

  if (command === "verify-demo-state") {
    console.log(await verifyDemoState());
    return;
  }

  if (command === "dashboard") {
    startDashboard({
      port: intFlag(rest, "port"),
      statusCustodians: custodianRefsFlag(rest),
      policyId: flag(rest, "policy-id"),
      recoverTarget: flag(rest, "recover-target"),
      recoverEndpoints: endpointsFlag(rest, "recover-endpoints"),
      recoverTargetLedgerApi: flag(rest, "recover-target-ledger-api"),
      recoverLoaderParticipant: flag(rest, "recover-loader-participant"),
      counterpartyTxAs: flag(rest, "counterparty-tx-as"),
      counterpartyTxParticipant: flag(rest, "counterparty-tx-participant"),
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
