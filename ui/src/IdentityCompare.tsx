import { motion } from "framer-motion";

// The whole point in one component: owner's partyId is the SAME string
// before and after — only which participant hosts it changes. The two cards
// come from two independent sources, and the badge is a real comparison of
// the full strings, not a restatement:
// - Before: the owner's public party id as the owner-side key store recorded
//   it, snapshotted the moment Recover was clicked (App.tsx) — before
//   recovery writes anything back.
// - After: the party id recover() derived from the key it rebuilt out of the
//   custodians' shares, matched by fingerprint against a custodian's own
//   ledger view (agent/src/recoverIdentity.ts), parsed from its result.
// Both cards render the identical truncated string (same slice indices), so
// if the full strings genuinely match, the two panels are visually
// indistinguishable except for the node label — that's deliberate. 6+6
// fingerprint characters so the id fits on one line in the left column; the
// full id is in each card's tooltip, and the badge compares the full strings.
function shortPartyId(partyId: string): string {
  const [hint, fingerprint] = partyId.split("::");
  if (fingerprint === undefined) return partyId;
  return `${hint}::${fingerprint.slice(0, 6)}…${fingerprint.slice(-6)}`;
}

export interface IdentityCompareProps {
  beforePartyId: string;
  // null until a recovery succeeds and reports the identity it rebuilt.
  afterPartyId: string | null;
  recovered: boolean;
}

export function IdentityCompare({ beforePartyId, afterPartyId, recovered }: IdentityCompareProps) {
  // Only a successful recovery's own report counts as "after".
  const after = recovered ? afterPartyId : null;
  const reported = after !== null;
  const same = after !== null && after === beforePartyId;

  return (
    <div className="identity-compare">
      <div className="identity-card identity-before">
        <div className="identity-card-label">Before</div>
        <div className="identity-card-node">participant1</div>
        <code className="identity-card-id" title={beforePartyId}>
          {shortPartyId(beforePartyId)}
        </code>
      </div>

      <div className="identity-compare-arrow">
        {reported ? (
          <motion.span
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.3 }}
            className={same ? "identity-same-badge" : "identity-different-badge"}
          >
            {same ? "= same identity" : "≠ different identity"}
          </motion.span>
        ) : recovered ? (
          <span className="identity-different-badge">identity not reported</span>
        ) : (
          <span className="identity-compare-dash">→</span>
        )}
      </div>

      <div
        className={`identity-card identity-after ${same ? "identity-after-recovered" : reported ? "identity-after-different" : ""}`}
      >
        <div className="identity-card-label">After</div>
        <div className="identity-card-node">participant4</div>
        {after !== null ? (
          <motion.code
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4 }}
            className="identity-card-id"
            title={after}
          >
            {shortPartyId(after)}
          </motion.code>
        ) : (
          <code className="identity-card-id identity-card-id-placeholder">— awaiting recovery —</code>
        )}
      </div>
    </div>
  );
}
