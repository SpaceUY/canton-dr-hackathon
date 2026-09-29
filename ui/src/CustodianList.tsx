import { useEffect, useState } from "react";
import type { CustodianStatus, CustodianView } from "./api";

// Rows, not pills - always visible (replaces the old PreDisasterStrip and
// the collapsed custodian table), same real data either way: does this
// custodian have custody, and when did it last answer a challenge.
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

// Not "down" - /status reflects on-chain state, not live reachability, so
// claiming a custodian is unreachable from this data would be inventing a
// signal we don't have. "Pending" is the honest read of an open challenge.
const STATUS_LABEL: Record<CustodianStatus, string> = {
  ok: "Responded",
  "awaiting-response": "Pending",
  "no-custody-accepted": "Not onboarded",
  "no-challenge-yet": "No challenge yet",
};

const STATUS_COLOR: Record<CustodianStatus, string> = {
  ok: "#4ade80",
  "awaiting-response": "#fbbf24",
  "no-custody-accepted": "#71717a",
  "no-challenge-yet": "#71717a",
};

function shortParty(partyId: string): string {
  return partyId.split("::")[0] ?? partyId;
}

export interface CustodianListProps {
  custodians: CustodianView[];
}

export function CustodianList({ custodians }: CustodianListProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(id);
  }, []);

  if (custodians.length === 0) return null;

  return (
    <div className="custodian-list">
      {custodians.map((c) => (
        <div key={c.custodian} className="custodian-row">
          <span className="custodian-row-name">{shortParty(c.custodian)}</span>
          <span className="custodian-row-detail">
            {c.lastResponseAt !== null ? `last challenge ${timeAgo(c.lastResponseAt, now)}` : "no challenge yet"}
          </span>
          <span className="custodian-row-status" style={{ color: STATUS_COLOR[c.status] }}>
            {STATUS_LABEL[c.status]}
          </span>
        </div>
      ))}
    </div>
  );
}
