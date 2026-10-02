// Scale test helper - NOT part of the demo path (code freeze: nothing in
// agent/ changes). Runs inside the shared agent image on the compose network.
//
//   node scale-load.mjs load <N>
//     custodian2 (a local party on participant2) creates N RecordProposal
//     contracts naming owner as observer, so they land in owner's ACS - what
//     export_acs backs up - and in custodian2's too. Batched (a local party
//     can submit many commands at once). Using custodian2 on purpose: recover
//     verifies the identity key by reading custodian2's ledger through the
//     JSON API, which used to refuse more than 200 contracts per query
//     (JSON_API_MAXIMUM_LIST_ELEMENTS_NUMBER_REACHED, now raised in
//     infra/canton/participant*.conf) - so this also tests that fix.
//
//   node scale-load.mjs count <console-participant>
//     Counts ALL of owner's active contracts on that participant through the
//     Canton console (no 200-element limit there). Prints ACS_COUNT=<n>.
import { spawn } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";

const OWNER_ID_PATH = "/canton/identity/owner.party-id.txt";
const BATCH = 50;
const CANTON_BIN = process.env.CANTON_BIN ?? "/canton/bin/canton";
const REMOTE_CONFIG = "/canton/user-config/bootstrap-remote.conf,/canton/user-config/features.conf";

async function req(url, body) {
  const res = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function resolveOrAllocate(participant, hint) {
  const info = await req(`http://${participant}/v2/parties/participant-id`);
  const ns = info.participantId.split("::")[1];
  const found = await req(`http://${participant}/v2/parties/party?parties=${hint}::${ns}`);
  const existing = found.partyDetails[0]?.party;
  if (existing) return existing;
  const allocated = await req(`http://${participant}/v2/parties`, { partyIdHint: hint, identityProviderId: "" });
  return allocated.partyDetails.party;
}

function consoleCount(participant, owner) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(participant)) throw new Error("bad participant name");
  if (!/^[A-Za-z0-9_:-]+$/.test(owner)) throw new Error("bad owner id");
  const script = [
    "import com.digitalasset.canton.config.RequireTypes.PositiveInt",
    "import com.digitalasset.canton.topology.PartyId",
    `val owner = PartyId.tryFromProtoPrimitive("${owner}")`,
    `val n = ${participant}.ledger_api.state.acs.of_party(owner, limit = PositiveInt.tryCreate(1000000)).size`,
    'println("ACS_COUNT=" + n)',
  ].join("\n");
  const path = `/tmp/scale-count-${Date.now()}.canton`;
  return writeFile(path, script, "utf8").then(
    () =>
      new Promise((resolve, reject) => {
        const proc = spawn(CANTON_BIN, ["run", path, "-c", REMOTE_CONFIG, "--no-tty"], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "", err = "";
        proc.stdout.on("data", (c) => (out += c));
        proc.stderr.on("data", (c) => (err += c));
        proc.on("close", (code) => {
          unlink(path).catch(() => {});
          const m = out.match(/ACS_COUNT=(\d+)/);
          if (code === 0 && m) resolve(Number(m[1]));
          else reject(new Error(`canton count failed (code ${code})\n${out}\n${err}`));
        });
      }),
  );
}

const [mode, arg] = process.argv.slice(2);
const owner = (await readFile(OWNER_ID_PATH, "utf8")).trim();

if (mode === "load") {
  const n = Number(arg);
  if (!Number.isInteger(n) || n <= 0) throw new Error("usage: load <N>");
  const proposer = await resolveOrAllocate("participant2:5023", "custodian2");
  const t0 = Date.now();
  for (let i = 0; i < n; i += BATCH) {
    const commands = [];
    for (let j = i; j < Math.min(n, i + BATCH); j++) {
      commands.push({ CreateCommand: { templateId: "#canton-dr:Record:RecordProposal", createArguments: { proposer, owner, label: `scale-${String(j).padStart(5, "0")}` } } });
    }
    await req("http://participant2:5023/v2/commands/submit-and-wait", {
      commands, userId: "participant_admin", commandId: `scale-${Date.now()}-${i}`, actAs: [proposer], readAs: [proposer],
    });
    process.stdout.write(`\rcreated ${Math.min(n, i + BATCH)}/${n}`);
  }
  console.log(`\nLOAD_OK: ${n} contracts in ${((Date.now() - t0) / 1000).toFixed(1)}s (proposer ${proposer})`);
} else if (mode === "count") {
  console.log(`ACS_COUNT=${await consoleCount(arg, owner)} (owner's active contracts on ${arg})`);
} else {
  throw new Error("usage: load <N> | count <console-participant>");
}
