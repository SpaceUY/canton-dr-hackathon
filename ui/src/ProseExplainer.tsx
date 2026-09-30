// Fixed prose, not data-driven - these three sentences describe the
// mechanism itself (true regardless of current state), not a live number.
// The point: a judge reading the screen understands the project without
// anyone explaining it out loud.
const SENTENCES = [
  "No single custodian can read anything on its own: reconstructing the key needs 2 of 3 fragments.",
  "Identity is re-authorized with a key that never lived inside Canton.",
  "A custodian holds encrypted bytes — never the real position they represent.",
];

export function ProseExplainer() {
  return (
    <ul className="prose-explainer">
      {SENTENCES.map((s) => (
        <li key={s}>{s}</li>
      ))}
    </ul>
  );
}
