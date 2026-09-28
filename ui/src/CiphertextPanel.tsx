import type { CiphertextSample, PositionView } from "./api";

// Puts the custodian's actual view next to the owner's — same proof as
// running `xxd` on the custodian's volume in the terminal, but on screen:
// real Position data on one side, the real encrypted bytes a custodian
// fetched from its own custody store on the other. Nothing invented — the
// hex comes from GET /ciphertext (agent/src/dashboard.ts), which reads the
// same file distributeBlob() wrote and recover() reads back from.
function formatHex(hex: string): string {
  const bytes = hex.match(/.{1,2}/g) ?? [];
  const rows: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    rows.push(bytes.slice(i, i + 16).join(" "));
  }
  return rows.join("\n");
}

export interface CiphertextPanelProps {
  ciphertext: CiphertextSample | null;
  positions: PositionView[];
}

export function CiphertextPanel({ ciphertext, positions }: CiphertextPanelProps) {
  if (ciphertext === null) return null;

  return (
    <section className="ciphertext-panel">
      <h2>What each side actually sees</h2>
      <div className="ciphertext-compare">
        <div className="ciphertext-card">
          <div className="identity-card-label">Owner</div>
          <p className="hint">Real positions, as created</p>
          <ul className="ciphertext-plaintext-list">
            {positions.slice(0, 3).map((p) => (
              <li key={p.label}>
                {p.counterparty}: {p.amount} {p.currency}
              </li>
            ))}
          </ul>
        </div>
        <div className="ciphertext-card">
          <div className="identity-card-label">Custodian ({ciphertext.custodianEndpoint.replace("http://", "")})</div>
          <p className="hint">
            {ciphertext.byteLength} bytes stored — first 256 shown, fetched live from its own custody volume
          </p>
          <pre className="ciphertext-hex">{formatHex(ciphertext.hexPreview)}</pre>
        </div>
      </div>
    </section>
  );
}
