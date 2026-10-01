import markSvg from "./assets/tessera-mark.svg?raw";

// Raw SVG import, not an <img>: the mark uses fill/stroke="currentColor" and
// is meant to inherit whatever text color it's placed in (header, README,
// favicon are separate static files) — an <img src> can't inherit page CSS
// color, inlining the markup can.
export function TesseraMark({ className }: { className?: string }) {
  return <span className={className} dangerouslySetInnerHTML={{ __html: markSvg }} />;
}
