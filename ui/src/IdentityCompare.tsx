import { motion } from "framer-motion";

// The whole point in one component: owner's partyId is the SAME string
// before and after — only which participant hosts it changes. Both cards
// render the identical truncated string (same slice indices), so if the
// full strings genuinely match, the two panels are visually indistinguishable
// except for the node label — that's deliberate, it's the proof.
function shortPartyId(partyId: string): string {
  const [hint, fingerprint] = partyId.split("::");
  if (fingerprint === undefined) return partyId;
  return `${hint}::${fingerprint.slice(0, 8)}…${fingerprint.slice(-8)}`;
}

export interface IdentityCompareProps {
  ownerPartyId: string;
  recovered: boolean;
}

export function IdentityCompare({ ownerPartyId, recovered }: IdentityCompareProps) {
  const short = shortPartyId(ownerPartyId);

  return (
    <div className="identity-compare">
      <div className="identity-card identity-before">
        <div className="identity-card-label">Before</div>
        <div className="identity-card-node">participant1</div>
        <code className="identity-card-id" title={ownerPartyId}>
          {short}
        </code>
      </div>

      <div className="identity-compare-arrow">
        {recovered ? (
          <motion.span
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.3 }}
            className="identity-same-badge"
          >
            = same identity
          </motion.span>
        ) : (
          <span className="identity-compare-dash">→</span>
        )}
      </div>

      <div className={`identity-card identity-after ${recovered ? "identity-after-recovered" : ""}`}>
        <div className="identity-card-label">After</div>
        <div className="identity-card-node">participant4</div>
        {recovered ? (
          <motion.code
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4 }}
            className="identity-card-id"
            title={ownerPartyId}
          >
            {short}
          </motion.code>
        ) : (
          <code className="identity-card-id identity-card-id-placeholder">— awaiting recovery —</code>
        )}
      </div>
    </div>
  );
}
