import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafeIdentifier } from "./canton.js";

const CANTON_BIN = process.env.CANTON_BIN ?? "/canton/bin/canton";
const REMOTE_CONFIG =
  process.env.CANTON_REMOTE_CONFIG ??
  "/canton/user-config/bootstrap-remote.conf,/canton/user-config/features.conf";

// Canton's own per-period comparison result for a pair of participants.
// NotCompared = one side's commitment for the period hasn't arrived yet
// (normally the recovered node, still catching up) - waiting, not failure.
export type CommitmentState = "Match" | "Mismatch" | "NotCompared";

export interface CommitmentPeriodView {
  periodEnd: string;
  state: CommitmentState;
}

export interface CommitmentPairView {
  counterparty: string;
  // Only periods that ended after the recovery started - earlier history
  // (if any) says nothing about the recovered state.
  periods: CommitmentPeriodView[];
}

export interface CommitmentWatchView {
  status: "idle" | "watching" | "done" | "timeout" | "error";
  about: string | null;
  reconciliationInterval: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  pairs: CommitmentPairView[];
  error: string | null;
}

const MAX_WATCH_MS = 10 * 60 * 1000;

// After a recovery, watches the ACS commitments each counterparty
// participant independently computes and exchanges with the recovered one -
// Canton's own check that both sides hash their shared state the same way.
// One long-lived console process polling every 2s, not one `canton run` per
// check: each JVM start costs ~20s, which would make the screen lag a whole
// reconciliation interval behind reality. Read-only.
export class CommitmentWatch {
  private view: CommitmentWatchView = emptyView();
  private proc: ChildProcess | null = null;
  private scriptPath: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  current(): CommitmentWatchView {
    return this.view;
  }

  async start(options: { counterparties: string[]; about: string; since: Date }): Promise<void> {
    const { counterparties, about, since } = options;
    for (const c of counterparties) assertSafeIdentifier(c, "counterparty");
    assertSafeIdentifier(about, "about");
    this.stop();

    this.view = {
      status: "watching",
      about,
      reconciliationInterval: null,
      startedAt: new Date().toISOString(),
      updatedAt: null,
      pairs: counterparties.map((counterparty) => ({ counterparty, periods: [] })),
      error: null,
    };

    const scriptPath = join(tmpdir(), `agent-commitments-${randomUUID()}.canton`);
    await writeFile(scriptPath, pollScript(counterparties, about), "utf8");
    this.scriptPath = scriptPath;

    const proc = spawn(CANTON_BIN, ["run", scriptPath, "-c", REMOTE_CONFIG, "--no-tty"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc = proc;

    let buffered = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) this.onLine(line, since);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    proc.on("close", (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (this.view.status === "watching") {
        this.view = {
          ...this.view,
          status: "error",
          error: `commitment watcher exited early (code ${code}): ${stderr.split("\n").slice(-3).join(" ")}`,
        };
      }
      this.cleanup();
    });

    this.timer = setTimeout(() => {
      if (this.view.status === "watching") this.view = { ...this.view, status: "timeout" };
      this.stop();
    }, MAX_WATCH_MS);
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const proc = this.proc;
    this.proc = null;
    proc?.kill();
    this.cleanup();
  }

  private cleanup(): void {
    if (this.scriptPath !== null) void unlink(this.scriptPath).catch(() => {});
    this.scriptPath = null;
  }

  private onLine(line: string, since: Date): void {
    const interval = /^CMT_INTERVAL (.+)$/.exec(line);
    if (interval) {
      this.view = { ...this.view, reconciliationInterval: interval[1]?.trim() ?? null };
      return;
    }
    const poll = /^CMT_POLL (\w+) (.*)$/.exec(line);
    if (!poll) return;
    const [, counterparty, body] = poll;
    if (counterparty === undefined || body === undefined) return;
    const periods = parsePeriods(body).filter((p) => new Date(p.periodEnd) > since);
    this.view = {
      ...this.view,
      updatedAt: new Date().toISOString(),
      pairs: this.view.pairs.map((pair) => (pair.counterparty === counterparty ? { counterparty, periods } : pair)),
    };
    // Done once every counterparty has at least one matching period and
    // none in disagreement. A Mismatch keeps the watch running (until the
    // timeout) so later periods stay visible instead of freezing on it.
    const allMatched = this.view.pairs.every(
      (pair) => pair.periods.some((p) => p.state === "Match") && !pair.periods.some((p) => p.state === "Mismatch"),
    );
    if (allMatched) {
      this.view = { ...this.view, status: "done" };
      this.stop();
    }
  }
}

function emptyView(): CommitmentWatchView {
  return {
    status: "idle",
    about: null,
    reconciliationInterval: null,
    startedAt: null,
    updatedAt: null,
    pairs: [],
    error: null,
  };
}

// The console prints lookup_sent_acs_commitments results as e.g.
// "SentAcsCmt(CommitmentPeriod(fromExclusive = ..., toInclusive = 2026-10-01T14:52:00Z),PAR::participant4::...,Some(...),Some(...),Match)".
function parsePeriods(body: string): CommitmentPeriodView[] {
  const out: CommitmentPeriodView[] = [];
  const re = /CommitmentPeriod\(fromExclusive = [^,]+, toInclusive = ([^)]+)\),.*?,(Match|Mismatch|NotCompared)\)/g;
  for (const m of body.matchAll(re)) {
    const [, periodEnd, state] = m;
    if (periodEnd !== undefined && state !== undefined) out.push({ periodEnd, state: state as CommitmentState });
  }
  return out;
}

// ASCII only (see canton.ts's runCantonScript). No scala.util imports: the
// console's embedded compiler can't load them (TASTy reader error).
function pollScript(counterparties: string[], about: string): string {
  const polls = counterparties
    .map(
      (c) => `
  val ${c}Text = try {
    ${c}.commitments.lookup_sent_acs_commitments(
      Seq(SynchronizerTimeRange(syncId, Some(TimeRange(CantonTimestamp.Epoch, CantonTimestamp.now())))),
      Seq(${about}.id),
      Seq.empty,
      true,
    ).toString.replace("\\n", " ")
  } catch { case e: Throwable => "ERROR " + e.getMessage }
  println("CMT_POLL ${c} " + ${c}Text)`,
    )
    .join("\n");
  const first = counterparties[0] ?? about;
  return `
import com.digitalasset.canton.admin.api.client.commands.ParticipantAdminCommands.Inspection.{SynchronizerTimeRange, TimeRange}
import com.digitalasset.canton.data.CantonTimestamp

val syncId = ${first}.synchronizers.id_of("da")
val interval = try {
  ${first}.topology.synchronizer_parameters.get_dynamic_synchronizer_parameters(syncId).reconciliationInterval.toString
} catch { case e: Throwable => "unknown" }
println("CMT_INTERVAL " + interval)
while (true) {
${polls}
  Thread.sleep(2000)
}
`.trim();
}
