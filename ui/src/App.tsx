import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  fetchCiphertext,
  fetchPositions,
  fetchRecoverProgress,
  fetchStatus,
  triggerRecover,
  type CiphertextSample,
  type CustodianStatus,
  type PositionView,
  type RecoverEvent,
  type StatusView,
} from "./api";
import { CiphertextPanel } from "./CiphertextPanel";
import { IdentityCompare } from "./IdentityCompare";
import { Positions } from "./Positions";
import { PreDisasterStrip } from "./PreDisasterStrip";
import { RecoveryGraph } from "./RecoveryGraph";
import { RecoveryTimer } from "./RecoveryTimer";

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

const STATUS_LABEL: Record<CustodianStatus, string> = {
  "no-custody-accepted": "Custody not accepted",
  "awaiting-response": "Awaiting response",
  ok: "OK",
  "no-challenge-yet": "No challenge yet",
};

function shortHash(hash: string): string {
  return `${hash.slice(0, 12)}…`;
}

// recover.ts's own return shape: "RECOVER_OK: reconstructed key from X/Y
// shares; REHOST_OK: ...; RESTORE_OK: <path> imported into <target>". Y
// there is endpoints.length — how many custodians this particular recovery
// attempt queried (this demo deliberately queries only 2 of the 3, skipping
// the owner's own share, to prove the threshold — see RECOVER_ENDPOINTS
// above), not the scheme's real total. Use the policy's own `n` for the
// human summary instead, so it doesn't contradict the "2 of 3" already shown
// above the button. The REHOST_OK segment (added when identity recovery
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
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [recovering, setRecovering] = useState(false);
  const [recoverOutcome, setRecoverOutcome] = useState<RecoverOutcome | null>(null);
  const [recoverProgress, setRecoverProgress] = useState<RecoverEvent[]>([]);
  const [recoverStartedAt, setRecoverStartedAt] = useState<number | null>(null);
  const [recoverEndedAt, setRecoverEndedAt] = useState<number | null>(null);
  // Collapsed automatically once a recovery starts, so the graph is the only
  // thing competing for attention — reopen it manually afterward if you want
  // to check the policy/custodian details again.
  const [detailsOpen, setDetailsOpen] = useState(true);
  const progressPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    setDetailsOpen(false);
    setRecoverStartedAt(Date.now());
    setRecoverEndedAt(null);
    // Real progress from the backend (agent/src/recover.ts calls onProgress
    // as each step actually lands), not a client-side timer guessing at
    // durations — a real re-authorization + restore can take anywhere from
    // a few seconds to well over a minute. But it can ALSO finish in well
    // under one polling interval (e.g. re-hosting an already-hosted party is
    // near-instant) — if the POST /recover promise resolves before the
    // first scheduled poll ever fires, recoverProgress stays empty for the
    // whole thing and the graph shows nothing but the identity edge (which
    // animates off `recovering` alone, not a real event). Poll immediately
    // on start, and once more right after the request settles, so the full
    // event list is captured even when the operation is nearly instant.
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

  return (
    <main className="app">
      <h1>canton-dr</h1>

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
          <PreDisasterStrip custodians={status.custodians} />

          <button
            type="button"
            className="details-toggle"
            onClick={() => setDetailsOpen((v) => !v)}
            aria-expanded={detailsOpen}
          >
            <span className={`chevron ${detailsOpen ? "chevron-open" : ""}`}>▸</span>
            Policy &amp; custodians
          </button>

          <AnimatePresence initial={false}>
            {detailsOpen && (
              <motion.div
                key="details"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.25, ease: "easeInOut" }}
                style={{ overflow: "hidden" }}
              >
                <section>
                  <p>
                    Policy <code>{status.policyId}</code> — owner <code>{status.owner}</code>
                  </p>
                  <p>
                    k={status.k} n={status.n} frequency={status.frequencyHours}h
                  </p>
                  <p className="hint">
                    n includes the owner's own fragment — it isn't listed below since the owner doesn't
                    challenge itself.
                  </p>
                </section>

                <section>
                  <h2>Custodians</h2>
                  <table>
                    <thead>
                      <tr>
                        <th>Custodian</th>
                        <th>Custody accepted</th>
                        <th>Blob hash</th>
                        <th>Open challenges</th>
                        <th>Last response</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {status.custodians.map((c) => (
                        <tr key={c.custodian} className={`status-${c.status}`}>
                          <td>{c.custodian}</td>
                          <td>{c.acceptedCustody ? "yes" : "no"}</td>
                          <td>
                            {c.blobHash !== null ? (
                              <code title={c.blobHash}>{shortHash(c.blobHash)}</code>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td>{c.openChallenges}</td>
                          <td>{c.lastResponseAt ?? "—"}</td>
                          <td>{STATUS_LABEL[c.status]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>

                <Positions positions={positions} />
                <CiphertextPanel ciphertext={ciphertext} positions={positions} />
              </motion.div>
            )}
          </AnimatePresence>

          <section className="recovery-hero">
            <IdentityCompare ownerPartyId={status.owner} recovered={recoverOutcome?.kind === "success"} />
            <p>
              Restores <code>{status.owner}</code>'s state onto <code>{RECOVER_TARGET}</code> using{" "}
              {RECOVER_K} of {status.n} fragments.
            </p>
            <button className="recover-button" onClick={() => void handleRecover()} disabled={recovering}>
              {recovering ? "Recovering…" : "Recover"}
            </button>
            <RecoveryTimer startedAt={recoverStartedAt} endedAt={recoverEndedAt} />
            {(recovering || recoverProgress.length > 0) && (
              <div style={{ marginTop: "1.5rem" }}>
                <RecoveryGraph
                  events={recoverProgress}
                  recovering={recovering}
                  succeeded={recoverOutcome?.kind === "success"}
                  failed={recoverOutcome?.kind === "error"}
                />
              </div>
            )}
            {recoverOutcome !== null && (
              <div className={`recover-outcome recover-${recoverOutcome.kind}`}>
                <p>
                  {recoverOutcome.kind === "success" ? "✅ " : "❌ "}
                  {recoverOutcome.summary}
                </p>
                {recoverOutcome.summary !== recoverOutcome.raw && (
                  <pre className="recover-raw">{recoverOutcome.raw}</pre>
                )}
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
