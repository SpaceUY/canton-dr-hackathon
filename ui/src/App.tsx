import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchCiphertext,
  fetchParticipant1Alive,
  fetchPositions,
  fetchRecoverProgress,
  fetchStatus,
  triggerRecover,
  type CiphertextSample,
  type PositionView,
  type RecoverEvent,
  type StatusView,
} from "./api";
import { CustodianList } from "./CustodianList";
import { IdentityCompare } from "./IdentityCompare";
import { MetricsStrip } from "./MetricsStrip";
import { Positions } from "./Positions";
import { ProseExplainer } from "./ProseExplainer";
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
// shares; REHOST_OK: ...; RESTORE_OK: <path> imported into <target>". Y
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
    /^RECOVER_OK: reconstructed key from (\d+)\/\d+ shares; REHOST_OK: .+; RESTORE_OK: .+ imported into (\S+)$/.exec(
      raw,
    );
  if (match === null) return null;
  const [, used, target] = match;
  return `Reconstructed the key from ${used} of ${totalFragments} fragments and restored the state onto ${target}.`;
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
  const [recoverProgress, setRecoverProgress] = useState<RecoverEvent[]>([]);
  const [recoverStartedAt, setRecoverStartedAt] = useState<number | null>(null);
  const [recoverEndedAt, setRecoverEndedAt] = useState<number | null>(null);
  const progressPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    // whole thing. Poll immediately on start, and once more right after the
    // request settles, so the full event list is captured even when the
    // operation is nearly instant.
    void fetchRecoverProgress().then(setRecoverProgress);
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
  const failed = recoverOutcome?.kind === "error";

  return (
    <main className="app">
      <h1>
        SpaceDev <span className="h1-project">— canton-dr</span>
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
            </section>

            <section className="dashboard-right">
              <ProseExplainer />
              <Positions positions={positions} />
              <CustodianList custodians={status.custodians} />
            </section>
          </div>

          <IdentityCompare ownerPartyId={status.owner} recovered={succeeded} />

          <TechnicalDetails status={status} ciphertext={ciphertext} />
        </>
      )}
    </main>
  );
}
