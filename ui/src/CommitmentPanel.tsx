import type { CommitmentState, CommitmentWatchView } from "./api";

// The closing verification, built for a wait of anything from ~40s to a
// couple of reconciliation intervals: every intermediate state reads as
// what it is (waiting is neutral, never styled like a failure), so the
// screen is honest whenever the presenter looks at it.
// - no period yet / NotCompared: waiting - one side's hash hasn't arrived
// - Mismatch: periods in disagreement - shown as such, never hidden
// - Match: the counterparty's independently computed hash equals the
//   recovered node's

type PairVerdict = "starting" | "waiting-period" | "waiting-recovered" | "mismatch" | "match";

const NODE_LABEL: Record<string, string> = {
  participant2: "Custodian 2's node",
  participant3: "Custodian 3's node",
};

function verdictOf(periods: { state: CommitmentState }[], started: boolean): PairVerdict {
  if (periods.some((p) => p.state === "Mismatch")) return "mismatch";
  if (periods.some((p) => p.state === "Match")) return "match";
  if (periods.length > 0) return "waiting-recovered";
  return started ? "waiting-period" : "starting";
}

const VERDICT_TEXT: Record<PairVerdict, string> = {
  starting: "Connecting to the counterparty's node…",
  "waiting-period": "Waiting for the first comparison period to close",
  "waiting-recovered": "Waiting for the recovered node's commitment",
  mismatch: "Periods in disagreement",
  match: "Match — same hash, computed independently",
};

export function CommitmentPanel({ view }: { view: CommitmentWatchView | null }) {
  if (view === null || view.status === "idle") return null;

  const started = view.updatedAt !== null;
  const verdicts = view.pairs.map((pair) => ({ pair, verdict: verdictOf(pair.periods, started) }));
  const allMatch = verdicts.length > 0 && verdicts.every((v) => v.verdict === "match");
  const anyMismatch = verdicts.some((v) => v.verdict === "mismatch");
  const overall = allMatch ? "match" : anyMismatch ? "mismatch" : "waiting";
  const interval = view.reconciliationInterval ?? "1m";

  return (
    <div className={`commitment-panel commitment-${overall}`}>
      <div className="commitment-head">
        <span className="commitment-title">Counterparty verification</span>
        <span className={`commitment-badge commitment-badge-${overall}`}>
          {overall === "match"
            ? "✓ State verified by counterparties"
            : overall === "mismatch"
              ? "✕ Disagreement"
              : "Comparing…"}
        </span>
      </div>
      <p className="commitment-explainer">
        Each custodian's node and the recovered node hash the state they share — independently. Canton
        compares the two hashes once per reconciliation interval ({interval}).
      </p>
      <ul className="commitment-pairs">
        {verdicts.map(({ pair, verdict }) => {
          const mismatches = pair.periods.filter((p) => p.state === "Mismatch").length;
          const matches = pair.periods.filter((p) => p.state === "Match").length;
          const detail =
            verdict === "mismatch"
              ? `${mismatches} period${mismatches === 1 ? "" : "s"}`
              : verdict === "match"
                ? `${matches} period${matches === 1 ? "" : "s"}`
                : null;
          return (
            <li key={pair.counterparty} className={`commitment-pair commitment-pair-${verdict}`}>
              <span className="commitment-pair-name">
                {NODE_LABEL[pair.counterparty] ?? pair.counterparty} ↔ {view.about ?? "recovered node"}
              </span>
              <span className="commitment-pair-state">
                {VERDICT_TEXT[verdict]}
                {detail !== null && <span className="commitment-pair-detail"> · {detail}</span>}
              </span>
            </li>
          );
        })}
      </ul>
      {view.status === "timeout" && !allMatch && (
        <p className="commitment-note">No verdict after 10 minutes — check with `agent check-commitment`.</p>
      )}
      {view.status === "error" && <p className="commitment-note">{view.error}</p>}
    </div>
  );
}
