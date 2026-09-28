import { useEffect, useState } from "react";

// A real RTO number: startedAt/endedAt are wall-clock timestamps taken at
// the moment the actual Recover click fired and the actual request settled
// (see App.tsx's handleRecover) — not a simulated countdown.
export interface RecoveryTimerProps {
  startedAt: number | null;
  endedAt: number | null;
}

function formatElapsed(ms: number): string {
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toFixed(1);
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function RecoveryTimer({ startedAt, endedAt }: RecoveryTimerProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === null || endedAt !== null) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [startedAt, endedAt]);

  if (startedAt === null) return null;

  const elapsed = (endedAt ?? now) - startedAt;
  const frozen = endedAt !== null;

  return (
    <div className={`recovery-timer ${frozen ? "recovery-timer-frozen" : ""}`}>
      <span className="recovery-timer-label">{frozen ? "Recovery time" : "Recovering…"}</span>
      <span className="recovery-timer-value">{formatElapsed(elapsed)}</span>
    </div>
  );
}
