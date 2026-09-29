import { useEffect, useState } from "react";
import type { CustodianView, PositionView } from "./api";
import { RecoveryTimer, type RecoveryTimerProps } from "./RecoveryTimer";

function timeAgo(iso: string, now: number): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <div className="metric-value">{value}</div>
      <div className="metric-label">{label}</div>
    </div>
  );
}

export interface MetricsStripProps {
  k: string;
  n: string;
  custodians: CustodianView[];
  positions: PositionView[];
  timer: RecoveryTimerProps;
}

export function MetricsStrip({ k, n, custodians, positions, timer }: MetricsStripProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(id);
  }, []);

  const healthy = custodians.filter((c) => c.status === "ok").length;
  const lastResponses = custodians
    .map((c) => c.lastResponseAt)
    .filter((t): t is string => t !== null)
    .sort()
    .reverse();
  const lastChallenge = lastResponses[0];

  return (
    <div className="metrics-strip">
      <Metric label="Threshold" value={`${k} of ${n}`} />
      <Metric label="Custodians healthy" value={`${healthy}/${custodians.length}`} />
      <Metric label="Last challenge" value={lastChallenge !== undefined ? `${timeAgo(lastChallenge, now)} ago` : "—"} />
      <Metric label="Positions protected" value={String(positions.length)} />
      {timer.startedAt === null ? (
        <Metric label="Recovery time" value="—" />
      ) : (
        <div className="metric metric-timer">
          <RecoveryTimer startedAt={timer.startedAt} endedAt={timer.endedAt} />
        </div>
      )}
    </div>
  );
}
