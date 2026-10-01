import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchCiphertext,
  fetchCommitments,
  fetchParticipant1Alive,
  fetchPositions,
  fetchRecoverProgress,
  fetchStatus,
  triggerCounterpartyTx,
  triggerRecover,
  type CiphertextSample,
  type CommitmentWatchView,
  type CounterpartyTxResult,
  type PositionView,
  type RecoverEvent,
  type StatusView,
} from "./api";
import { CommitmentPanel } from "./CommitmentPanel";
import { CustodianList } from "./CustodianList";
import { IdentityCompare } from "./IdentityCompare";
import { MetricsStrip } from "./MetricsStrip";
import { Positions } from "./Positions";
import { ProseExplainer } from "./ProseExplainer";
import { buildRecoverabilityReportHtml } from "./recoverabilityReport";
import { RecoveryGraph } from "./RecoveryGraph";
import { StageRail } from "./StageRail";
import { TechnicalDetails } from "./TechnicalDetails";
import { usePacedEvents } from "./usePacedEvents";

// Hardcoded to this project's own demo topology (see infra/docker-compose.yml)
// — a minimal UI, not a general-purpose admin tool.
//
// These endpoints are used by the `dashboard` container itself (its
// POST /recover handler calls the agents directly) — not by the browser —
// so they must be Docker-internal hostnames (agent2/agent3), not
// localhost. localhost from inside a container means that container
// itself, which is exactly why this was "fetch failed" the first time.
const RECOVER_TARGET = "participant4";
const RECOVER_ENDPOINTS = ["http://agent2:4002", "http://agent3:4003"];
const RECOVER_K = 2;

// recover.ts's own return shape: "RECOVER_OK: reconstructed key from X/Y
// shares; RECOVER_IDENTITY_OK: reconstructed <party> from I/Y identity-key
// shares, ...; REHOST_OK: ...; RESTORE_OK: <path> imported into <target>". Y
// there is endpoints.length — how many custodians this particular recovery
// attempt queried (this demo deliberately queries only 2 of the 3, skipping
// the owner's own share, to prove the threshold — see RECOVER_ENDPOINTS
// above), not the scheme's real total. Use the policy's own `n` for the
// human summary instead, so it doesn't contradict the "2 of 3" already shown
// in the metrics strip. The REHOST_OK segment (added when identity recovery
// landed) isn't surfaced separately here — its content (re-hosted vs.
// already-hosted) doesn't change what the user needs to know, just that it
// happened; skip over it rather than parse its two variants. Best-effort —
// if the raw format ever changes, the raw string is still shown below, so
// nothing is lost, only the summary.
function parseRecoverResult(raw: string, totalFragments: string): string | null {
  const match =
    /^RECOVER_OK: reconstructed key from (\d+)\/\d+ shares; RECOVER_IDENTITY_OK: reconstructed \S+ from (\d+)\/\d+ identity-key shares[^;]*; REHOST_OK: .+; RESTORE_OK: .+ imported into (\S+)$/.exec(
      raw,
    );
  if (match === null) return null;
  const [, used, identityUsed, target] = match;
  return (
    `Rebuilt the owner's identity key from ${identityUsed} of ${totalFragments} fragments and the data key ` +
    `from ${used} of ${totalFragments}, and restored the state onto ${target}.`
  );
}

// The party id recover() derived from the identity key it rebuilt out of the
// custodians' shares (agent/src/recoverIdentity.ts: matched by fingerprint
// against a custodian's own ledger view) — the "after" side of the identity
// comparison. null if the result doesn't carry it, which the comparison
// shows as "identity not reported" rather than assuming a match.
function parseRecoveredPartyId(raw: string): string | null {
  const match = /RECOVER_IDENTITY_OK: reconstructed (\S+) from /.exec(raw);
  return match?.[1] ?? null;
}

// Canton's own error strings can run to hundreds of characters of nested
// JSON (correlationId, traceId, context...) — useful detail, but not as the
// only thing on screen. Cut at the first brace/newline so the visible line
// stays short; the full string is still available (see the "Full error"
// details below it), nothing is lost, just not shown twice.
function summarizeError(message: string): string {
  const cut = message.search(/[{\n]/);
  const short = cut === -1 ? message : message.slice(0, cut).trim();
  return short.length > 0 ? short : message.slice(0, 140);
}

interface RecoverOutcome {
  kind: "success" | "error";
  summary: string;
  raw: string;
}

export function App() {
  const [status, setStatus] = useState<StatusView | null>(null);
  const [positions, setPositions] = useState<PositionView[]>([]);
  const [ciphertext, setCiphertext] = useState<CiphertextSample | null>(null);
  const [participant1Alive, setParticipant1Alive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [recovering, setRecovering] = useState(false);
  const [recoverOutcome, setRecoverOutcome] = useState<RecoverOutcome | null>(null);
  // The owner's party id as known BEFORE recovery (the public id file that
  // survived the disaster, via /status), frozen at the moment Recover is
  // clicked: recovery writes the verified id back to that same file, so
  // reading /status afterwards would make "before" equal "after" by
  // construction instead of by comparison.
  const [ownerBeforeRecovery, setOwnerBeforeRecovery] = useState<string | null>(null);
  // Canton's ACS-commitment comparison between each custodian's node and the
  // recovered one, watched by the dashboard after a successful recovery.
  const [commitments, setCommitments] = useState<CommitmentWatchView | null>(null);
  const [recoverProgress, setRecoverProgress] = useState<RecoverEvent[]>([]);
  const [recoverStartedAt, setRecoverStartedAt] = useState<number | null>(null);
  const [recoverEndedAt, setRecoverEndedAt] = useState<number | null>(null);
  const progressPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [counterpartyTxRunning, setCounterpartyTxRunning] = useState(false);
  const [counterpartyTxResult, setCounterpartyTxResult] = useState<CounterpartyTxResult | null>(null);
  const [counterpartyTxError, setCounterpartyTxError] = useState<string | null>(null);

  const { revealed, finished } = usePacedEvents(recoverProgress);

  const load = useCallback(() => {
    fetchStatus()
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    void fetchPositions().then(setPositions);
    void fetchCiphertext().then(setCiphertext);
  }, []);

  // Real reachability, polled independently of /status (which queries via
  // custodians on purpose and would never notice participant1 dying) - this
  // is what lets the map be honest before the disaster, not just during it.
  useEffect(() => {
    const check = () => void fetchParticipant1Alive().then(setParticipant1Alive);
    check();
    const id = setInterval(check, 3000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    return () => {
      if (progressPollRef.current !== null) clearInterval(progressPollRef.current);
    };
  }, []);

  const handleRecover = async () => {
    if (status === null) return;
    setOwnerBeforeRecovery(status.owner);
    setCommitments(null);
    setRecovering(true);
    setRecoverOutcome(null);
    setRecoverProgress([]);
    setRecoverStartedAt(Date.now());
    setRecoverEndedAt(null);
    // Real progress from the backend (agent/src/recover.ts calls onProgress
    // as each step actually lands), not a client-side timer guessing at
    // durations — a real re-authorization + restore can take anywhere from
    // a few seconds to well over a minute. But it can ALSO finish in well
    // under one polling interval (e.g. re-hosting an already-hosted party is
    // near-instant) — if the POST /recover promise resolves before the
    // first scheduled poll ever fires, recoverProgress stays empty for the
    // whole thing. Poll shortly after start, and once more right after the
    // request settles, so the full event list is captured even when the
    // operation is nearly instant. "Shortly", not immediately: the server
    // only resets its event list once it has read this POST, and an
    // immediate poll on a retry would show the failed attempt's events
    // (e.g. "Custodian 3 unreachable") as if they belonged to this one.
    setTimeout(() => void fetchRecoverProgress().then(setRecoverProgress), 250);
    progressPollRef.current = setInterval(() => {
      void fetchRecoverProgress().then(setRecoverProgress);
    }, 400);
    try {
      const result = await triggerRecover({
        targetParticipant: RECOVER_TARGET,
        endpoints: RECOVER_ENDPOINTS,
        k: RECOVER_K,
      });
      setRecoverProgress(await fetchRecoverProgress());
      setRecoverOutcome({ kind: "success", summary: parseRecoverResult(result, status.n) ?? result, raw: result });
    } catch (err) {
      setRecoverProgress(await fetchRecoverProgress().catch(() => []));
      const message = err instanceof Error ? err.message : String(err);
      setRecoverOutcome({ kind: "error", summary: message, raw: message });
    } finally {
      if (progressPollRef.current !== null) clearInterval(progressPollRef.current);
      progressPollRef.current = null;
      setRecovering(false);
      setRecoverEndedAt(Date.now());
    }
  };

  const succeeded = recoverOutcome?.kind === "success";

  // Polled only after a successful recovery, and only until the watch
  // settles (done/timeout/error) - the verdict can take anywhere from ~40s
  // to a couple of reconciliation intervals, and the panel shows every
  // intermediate state as it is.
  const commitmentsSettled = commitments !== null && commitments.status !== "watching" && commitments.status !== "idle";
  useEffect(() => {
    if (!succeeded || commitmentsSettled) return;
    const load = () => void fetchCommitments().then(setCommitments).catch(() => {});
    load();
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, [succeeded, commitmentsSettled]);
  const recoveredPartyId = succeeded && recoverOutcome !== null ? parseRecoveredPartyId(recoverOutcome.raw) : null;
  const failed = recoverOutcome?.kind === "error";

  // Opened as a Blob URL in a new tab, not downloaded directly — a jury
  // member reads it there and prints/saves as PDF (Cmd/Ctrl+P) themselves;
  // no backend endpoint, it's built entirely from data already on screen.
  // The demo's closing step, run from the dashboard instead of a terminal —
  // real command, real ledger data back (agent/src/counterpartyTx.ts): a
  // real counterparty proposes a contract naming the (possibly just-
  // recovered) owner as observer, and the owner then signs the acceptance
  // themselves, becoming the new Record's sole signatory.
  const handleCounterpartyTx = async () => {
    setCounterpartyTxRunning(true);
    setCounterpartyTxResult(null);
    setCounterpartyTxError(null);
    try {
      setCounterpartyTxResult(await triggerCounterpartyTx());
    } catch (err) {
      setCounterpartyTxError(err instanceof Error ? err.message : String(err));
    } finally {
      setCounterpartyTxRunning(false);
    }
  };

  const handleDownloadReport = () => {
    if (status === null) return;
    const html = buildRecoverabilityReportHtml(status, positions);
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    window.open(url, "_blank");
  };

  return (
    <main className="app">
      <h1>
        Tessera <span className="h1-credit">by SpaceDev</span>
      </h1>

      {loading && status === null && <p className="loading">Loading…</p>}

      {error !== null && (
        <p className="error">
          {error}{" "}
          <button className="retry-button" onClick={load}>
            Retry
          </button>
        </p>
      )}

      {status !== null && (
        <>
          <MetricsStrip
            k={status.k}
            n={status.n}
            custodians={status.custodians}
            positions={positions}
            timer={{ startedAt: recoverStartedAt, endedAt: recoverEndedAt }}
            lastDistributedAt={status.lastDistributedAt}
          />

          <div className="dashboard-columns">
            <section className="dashboard-left">
              <button className="recover-button" onClick={() => void handleRecover()} disabled={recovering}>
                {recovering ? "Recovering…" : "Recover"}
              </button>

              <RecoveryGraph
                revealed={revealed}
                finished={finished}
                recovering={recovering}
                succeeded={succeeded}
                failed={failed}
                participant1Alive={participant1Alive}
              />

              <StageRail revealed={revealed} finished={finished} failed={failed} />

              {recoverOutcome !== null && (
                <div className={`recover-outcome recover-${recoverOutcome.kind}`}>
                  <p>
                    {recoverOutcome.kind === "success" ? "✅ " : "❌ "}
                    {recoverOutcome.summary}
                  </p>
                  {recoverOutcome.summary !== recoverOutcome.raw && (
                    <details className="recover-raw-details">
                      <summary>Raw result</summary>
                      <pre className="recover-raw">{recoverOutcome.raw}</pre>
                    </details>
                  )}
                </div>
              )}

              <IdentityCompare
                beforePartyId={ownerBeforeRecovery ?? status.owner}
                afterPartyId={recoveredPartyId}
                recovered={succeeded}
              />
            </section>

            <section className="dashboard-right">
              <ProseExplainer />
              <Positions positions={positions} />
              <CustodianList custodians={status.custodians} />
              <button className="report-button" onClick={handleDownloadReport}>
                Download recoverability report
              </button>

              <div className="counterparty-tx-block">
                <button
                  className="counterparty-tx-button"
                  onClick={() => void handleCounterpartyTx()}
                  disabled={counterpartyTxRunning || !succeeded}
                  title={succeeded ? undefined : "Available after a successful recovery"}
                >
                  {counterpartyTxRunning ? "Transacting…" : "Counterparty transacts with recovered owner"}
                </button>

                {counterpartyTxResult !== null && (
                  <div className="counterparty-tx-outcome counterparty-tx-success">
                    <p>
                      Contract <code>{counterpartyTxResult.recordContractId}</code> is active on{" "}
                      {counterpartyTxResult.ownerParticipant}. {counterpartyTxResult.proposer.split("::")[0]}{" "}
                      proposed it; {counterpartyTxResult.owner.split("::")[0]} signed the acceptance themselves and
                      is its sole signatory.
                    </p>
                  </div>
                )}
                {counterpartyTxError !== null && (
                  <div className="counterparty-tx-outcome counterparty-tx-error">
                    <p>{summarizeError(counterpartyTxError)}</p>
                    {counterpartyTxError.length > 140 && (
                      <details className="counterparty-tx-error-details">
                        <summary>Full error</summary>
                        <pre className="counterparty-tx-error-raw">{counterpartyTxError}</pre>
                      </details>
                    )}
                  </div>
                )}
              </div>

              <CommitmentPanel view={commitments} />
            </section>
          </div>

          <TechnicalDetails status={status} ciphertext={ciphertext} />
        </>
      )}
    </main>
  );
}
