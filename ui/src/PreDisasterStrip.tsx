import { useEffect, useState } from "react";
import type { CustodianStatus, CustodianView } from "./api";

// The demo otherwise starts at the disaster and never shows the working
// product beforehand — this strip is real status.custodians data (the same
// the collapsed accordion below shows in full), just always visible, so a
// judge sees "this was healthy" before "this got destroyed".
function timeAgo(iso: string, now: number): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

const DOT_COLOR: Record<CustodianStatus, string> = {
  ok: "#4ade80",
  "awaiting-response": "#fbbf24",
  "no-custody-accepted": "#71717a",
  "no-challenge-yet": "#71717a",
};

export interface PreDisasterStripProps {
  custodians: CustodianView[];
}

export function PreDisasterStrip({ custodians }: PreDisasterStripProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(id);
  }, []);

  if (custodians.length === 0) return null;

  return (
    <div className="pre-disaster-strip">
      {custodians.map((c) => (
        <div key={c.custodian} className="pre-disaster-pill">
          <span className="pre-disaster-dot" style={{ background: DOT_COLOR[c.status] }} />
          <span className="pre-disaster-name">{c.custodian.split("::")[0]}</span>
          <span className="pre-disaster-detail">
            {c.lastResponseAt !== null ? `last challenge OK ${timeAgo(c.lastResponseAt, now)}` : "no challenge yet"}
          </span>
        </div>
      ))}
    </div>
  );
}
