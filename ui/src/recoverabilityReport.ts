import type { PositionView, StatusView } from "./api";

// A standalone HTML document, not a React component - it's meant to be
// opened in its own tab and printed/saved as PDF (Cmd/Ctrl+P), so it needs
// to render correctly with zero dependency on the app's own bundle or
// running dev server. Built entirely from data the dashboard already
// reports (StatusView, PositionView) - nothing invented for this document
// that isn't also on screen elsewhere.
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

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

export function buildRecoverabilityReportHtml(status: StatusView, positions: PositionView[]): string {
  const now = Date.now();
  const generatedAt = new Date(now).toISOString();
  const k = Number(status.k);
  const n = Number(status.n);

  // Only the independent custodians are ever queried by a real recovery
  // (see ADR-012 in docs/DECISIONS.md) - the owner's own backup fragment (the
  // difference between n and this list's length) is deliberately never
  // used, so it can't count toward "verified" either. A custodian counts
  // as verified only if it answered its last challenge AND has nothing
  // open right now - matches CustodianStatus "ok" exactly, not merely
  // "accepted custody once".
  const verifiedCount = status.custodians.filter((c) => c.status === "ok").length;
  const independentTotal = status.custodians.length;
  const required = Math.min(k, independentTotal);
  const recoverable = verifiedCount >= required;

  const custodianRows = status.custodians
    .map(
      (c) => `
        <tr>
          <td>${escapeHtml(c.custodian.split("::")[0] ?? c.custodian)}</td>
          <td>${c.acceptedCustody ? "Yes" : "No"}</td>
          <td>${c.lastResponseAt !== null ? escapeHtml(timeAgo(c.lastResponseAt, now)) : "—"}</td>
          <td>${c.status === "ok" ? "Verified" : escapeHtml(c.status)}</td>
        </tr>`,
    )
    .join("");

  const positionRows = positions
    .map(
      (p) => `
        <tr>
          <td>${escapeHtml(p.counterparty)}</td>
          <td>${Number(p.amount) >= 0 ? "+" : "-"}${Math.abs(Number(p.amount)).toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })} ${escapeHtml(p.currency)}</td>
        </tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Tessera Recoverability Report</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: Georgia, "Times New Roman", serif;
    color: #1a1a1a;
    max-width: 720px;
    margin: 2.5rem auto;
    padding: 0 1.5rem;
    line-height: 1.5;
  }
  h1 { font-size: 1.3rem; margin-bottom: 0.1rem; }
  .subtitle { color: #555; font-size: 0.95rem; margin-bottom: 1.5rem; }
  .verdict {
    border: 2px solid #1a1a1a;
    border-radius: 6px;
    padding: 1rem 1.25rem;
    margin-bottom: 1.75rem;
  }
  .badge {
    display: inline-block;
    font-family: Arial, sans-serif;
    font-weight: 700;
    font-size: 1.2rem;
    letter-spacing: 0.04em;
    padding: 0.3rem 0.9rem;
    border-radius: 4px;
  }
  .badge-ok { background: #d4edda; color: #14532d; border: 1px solid #14532d; }
  .badge-fail { background: #fbd5d5; color: #7f1d1d; border: 1px solid #7f1d1d; }
  .verdict-detail { margin-top: 0.6rem; font-size: 0.95rem; }
  .verdict-note { margin-top: 0.4rem; font-size: 0.85rem; color: #444; }
  h2 {
    font-size: 1.05rem;
    border-bottom: 1px solid #999;
    padding-bottom: 0.2rem;
    margin-top: 1.75rem;
  }
  table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; font-size: 0.9rem; }
  th, td { text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid #ddd; }
  th { color: #555; font-weight: 600; }
  .limitations li { margin-bottom: 0.5rem; }
  footer { margin-top: 2.5rem; font-size: 0.8rem; color: #666; border-top: 1px solid #ccc; padding-top: 0.6rem; }
  .print-hint { text-align: center; color: #666; font-size: 0.85rem; margin-bottom: 1.5rem; }
  @media print {
    .print-hint { display: none; }
    body { margin: 0; max-width: none; }
  }
</style>
</head>
<body>
  <p class="print-hint">Press Cmd/Ctrl+P to print or save as PDF.</p>

  <h1>Tessera — Recoverability Report</h1>
  <div class="subtitle">Policy: ${escapeHtml(status.policyId)} &middot; Owner: ${escapeHtml(status.owner)}</div>

  <div class="verdict">
    <span class="badge ${recoverable ? "badge-ok" : "badge-fail"}">${recoverable ? "RECOVERABLE" : "NOT RECOVERABLE"}</span>
    <div class="verdict-detail">
      Verified custodians: ${verifiedCount} of ${required} required
      (${independentTotal} independent custodian${independentTotal === 1 ? "" : "s"} total; threshold is k=${k} of n=${n}
      total fragments — one of the ${n} is the owner's own backup copy, which a real recovery never uses).
    </div>
    <div class="verdict-note">
      A custodian counts as verified only if it answered its most recent challenge and has none open right now —
      accepting custody once, without a later verified response, does not count.
    </div>
    <div class="verdict-detail">As of: ${escapeHtml(generatedAt)}</div>
  </div>

  <h2>Policy</h2>
  <table>
    <tr><th>Policy ID</th><td>${escapeHtml(status.policyId)}</td></tr>
    <tr><th>Threshold</th><td>${k} of ${n} fragments</td></tr>
    <tr><th>Owner</th><td>${escapeHtml(status.owner)}</td></tr>
  </table>

  <h2>Custodians</h2>
  <table>
    <thead>
      <tr><th>Custodian</th><th>Custody accepted</th><th>Last verified response</th><th>Status</th></tr>
    </thead>
    <tbody>${custodianRows}</tbody>
  </table>

  <h2>Positions protected</h2>
  <table>
    <thead><tr><th>Counterparty</th><th>Amount</th></tr></thead>
    <tbody>${positionRows}</tbody>
  </table>

  <h2>What this report does not cover</h2>
  <ul class="limitations">
    <li>This report certifies that, as of the timestamp above, at least the required number of custodians answered
    a real challenge proving they still hold their fragment. It does not certify anything about the archived
    commitment history beyond the most recently verified period.</li>
    <li>It does not cover the window between the last successful backup distribution and any disaster that
    happens afterward — if the node's state changed after the last distribution and before data loss, that
    change is not protected by this scheme.</li>
    <li>If the number of verified custodians falls below the threshold, there is no recovery — this is not a
    degraded mode, it is the complete absence of recovery.</li>
  </ul>

  <footer>Generated ${escapeHtml(generatedAt)} from live data (Tessera dashboard /status, /positions).</footer>
</body>
</html>`;
}
