import type { CiphertextSample, StatusView } from "./api";

// "The technical jury wants it; nobody else needs it on screen." Full
// party ids, policy id, blob hashes, and the raw ciphertext hex all move
// here from what used to be always-visible panels - same real data, just
// not competing for attention with the graph and the stage rail.
function formatHex(hex: string): string {
  const bytes = hex.match(/.{1,2}/g) ?? [];
  const rows: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    rows.push(bytes.slice(i, i + 16).join(" "));
  }
  return rows.join("\n");
}

export interface TechnicalDetailsProps {
  status: StatusView;
  ciphertext: CiphertextSample | null;
}

export function TechnicalDetails({ status, ciphertext }: TechnicalDetailsProps) {
  return (
    <details className="technical-details">
      <summary>View ids, hashes and raw ciphertext</summary>
      <div className="technical-details-body">
        <dl>
          <dt>Policy</dt>
          <dd>
            <code>{status.policyId}</code>
          </dd>
          <dt>Owner</dt>
          <dd>
            <code>{status.owner}</code>
          </dd>
          {status.custodians.map((c) => (
            <div key={c.custodian}>
              <dt>{c.custodian.split("::")[0]}</dt>
              <dd>
                <code>{c.custodian}</code>
                {c.blobHash !== null && (
                  <>
                    {" "}
                    — blob <code>{c.blobHash}</code>
                  </>
                )}
              </dd>
            </div>
          ))}
        </dl>
        {ciphertext !== null && (
          <>
            <p className="hint">
              {ciphertext.byteLength} bytes at {ciphertext.custodianEndpoint.replace("http://", "")} — first 256
              shown, fetched live from its own custody volume
            </p>
            <pre className="ciphertext-hex">{formatHex(ciphertext.hexPreview)}</pre>
          </>
        )}
      </div>
    </details>
  );
}
