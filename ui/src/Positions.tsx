import type { PositionView } from "./api";

// What a judge sees destroyed and recovered — real counterparties and
// signed amounts, not an abstract contract id. Positive amount: owed to
// owner. Negative: owner owes it. See daml/Position.daml.
function formatAmount(amount: string, currency: string): { text: string; owed: boolean } {
  const value = Number(amount);
  const owed = value >= 0;
  const formatted = Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return { text: `${owed ? "+" : "-"}${formatted} ${currency}`, owed };
}

export interface PositionsProps {
  positions: PositionView[];
}

export function Positions({ positions }: PositionsProps) {
  if (positions.length === 0) return null;

  const sorted = [...positions].sort((a, b) => a.label.localeCompare(b.label));

  return (
    <section className="positions">
      <h2>What's at stake</h2>
      <p className="hint">Real positions owner holds against these counterparties — this is what a lost backup loses.</p>
      <table>
        <thead>
          <tr>
            <th>Counterparty</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => {
            const { text, owed } = formatAmount(p.amount, p.currency);
            return (
              <tr key={p.label}>
                <td>{p.counterparty}</td>
                <td className={owed ? "position-owed" : "position-owing"}>{text}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
