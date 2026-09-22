import { useCallback, useEffect, useState } from "react";
import { fetchStatus, triggerRecover, type CustodianStatus, type StatusView } from "./api";

// Hardcoded to this project's own demo topology (see infra/docker-compose.yml)
// — a minimal UI, not a general-purpose admin tool.
const RECOVER_TARGET = "participant4";
const RECOVER_ENDPOINTS = ["http://localhost:4002", "http://localhost:4003"];
const RECOVER_K = 2;

const STATUS_LABEL: Record<CustodianStatus, string> = {
  "no-custody-accepted": "Custody not accepted",
  "awaiting-response": "Awaiting response",
  ok: "OK",
  "no-challenge-yet": "No challenge yet",
};

export function App() {
  const [status, setStatus] = useState<StatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [recoverResult, setRecoverResult] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchStatus()
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  const handleRecover = async () => {
    setRecovering(true);
    setRecoverResult(null);
    try {
      const result = await triggerRecover({
        targetParticipant: RECOVER_TARGET,
        endpoints: RECOVER_ENDPOINTS,
        k: RECOVER_K,
      });
      setRecoverResult(result);
    } catch (err) {
      setRecoverResult(err instanceof Error ? err.message : String(err));
    } finally {
      setRecovering(false);
    }
  };

  return (
    <main className="app">
      <h1>canton-dr</h1>

      {error !== null && <p className="error">{error}</p>}

      {status !== null && (
        <>
          <section>
            <p>
              Policy <code>{status.policyId}</code> — owner <code>{status.owner}</code>
            </p>
            <p>
              k={status.k} n={status.n} frequency={status.frequencyHours}h
            </p>
          </section>

          <section>
            <h2>Custodians</h2>
            <table>
              <thead>
                <tr>
                  <th>Custodian</th>
                  <th>Custody accepted</th>
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
                    <td>{c.openChallenges}</td>
                    <td>{c.lastResponseAt ?? "—"}</td>
                    <td>{STATUS_LABEL[c.status]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <h2>Recovery</h2>
            <p>
              Restores <code>{status.owner}</code>'s state onto <code>{RECOVER_TARGET}</code> using{" "}
              {RECOVER_K} of {status.custodians.length} fragments.
            </p>
            <button onClick={() => void handleRecover()} disabled={recovering}>
              {recovering ? "Recovering..." : "Recover"}
            </button>
            {recoverResult !== null && <pre className="recover-result">{recoverResult}</pre>}
          </section>
        </>
      )}
    </main>
  );
}
