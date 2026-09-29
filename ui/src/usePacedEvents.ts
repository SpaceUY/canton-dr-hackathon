import { useEffect, useState } from "react";
import type { RecoverEvent } from "./api";

// Shared by RecoveryGraph and StageRail so both read the exact same reveal
// position - two independent timers would drift, showing the graph one
// step ahead of (or behind) the stage rail for the same real event.
//
// Every event here genuinely happened - but the backend can report several
// in one poll tick (or all of them, if a step was already-satisfied and
// instant, e.g. re-hosting a party that's already hosted). Revealing them
// no faster than one every ~450ms doesn't fabricate anything: it just
// paces a real sequence enough for a human to actually see each step,
// instead of the UI jumping straight to "recovered" in one frame.
export function usePacedEvents(events: RecoverEvent[]): { revealed: RecoverEvent[]; finished: boolean } {
  const [revealedCount, setRevealedCount] = useState(0);

  useEffect(() => {
    if (events.length === 0) {
      setRevealedCount(0);
      return;
    }
    if (revealedCount >= events.length) return;
    const id = setTimeout(() => setRevealedCount((n) => n + 1), 450);
    return () => clearTimeout(id);
  }, [events.length, revealedCount]);

  return { revealed: events.slice(0, revealedCount), finished: revealedCount >= events.length };
}
