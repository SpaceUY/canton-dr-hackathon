import { useMemo } from "react";
import type { RecoverEvent, RecoverStep } from "./api";
import { SUBSTEP_LABEL } from "./labels";

// Named stages, not a spinner - each one explains what it means, and ticks
// only when the real backend event for it has actually landed. The live
// detail line under the active stage is the same real sub-step data the
// graph shows (agent/src/rehostParty.ts's 9 phases, agent/src/recover.ts's
// custodian query/response events) - reusing it here, not inventing a
// second narrative for the same thing.
interface Stage {
  step: RecoverStep;
  name: string;
  blurb: string;
}

const STAGES: Stage[] = [
  {
    step: "identity-reauthorized",
    name: "Identity re-authorized",
    blurb: "The target node is authorized to act for the owner.",
  },
  {
    step: "key-reconstructed",
    name: "Key reconstructed",
    blurb: "2 of 3 fragments are enough — no single custodian could do this alone.",
  },
  {
    step: "state-restored",
    name: "State imported",
    blurb: "The contracts are active again on the new node.",
  },
];

function endpointNodeId(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return endpoint;
  }
}

const CUSTODIAN_NAME: Record<string, string> = { agent2: "Custodian 2", agent3: "Custodian 3" };

export interface StageRailProps {
  revealed: RecoverEvent[];
  finished: boolean;
  failed: boolean;
}

export function StageRail({ revealed, finished, failed }: StageRailProps) {
  const milestones = useMemo(
    () => new Set(revealed.filter((e) => e.type === "milestone").map((e) => e.step)),
    [revealed],
  );

  const latestRehostSubstep = useMemo(() => {
    const events = revealed.filter((e) => e.type === "rehost-substep");
    return events.length > 0 ? events[events.length - 1] : undefined;
  }, [revealed]);

  // Custodian query/response events double as stage 2's live detail - the
  // same events RecoveryGraph reads to pulse the custodian nodes.
  const custodianDetail = useMemo(() => {
    let queried: string | undefined;
    let responded: string | undefined;
    for (const event of revealed) {
      if (event.type === "custodian-query") queried = endpointNodeId(event.endpoint);
      else if (event.type === "custodian-response") responded = endpointNodeId(event.endpoint);
    }
    if (queried !== undefined && queried !== responded) {
      return `Querying ${CUSTODIAN_NAME[queried] ?? queried}…`;
    }
    if (responded !== undefined) {
      return `${CUSTODIAN_NAME[responded] ?? responded} responded`;
    }
    return undefined;
  }, [revealed]);

  const activeIndex = STAGES.findIndex((s) => !milestones.has(s.step));

  return (
    <div className="stage-rail">
      {STAGES.map((stage, i) => {
        const done = milestones.has(stage.step);
        const isActive = !done && i === activeIndex && !(failed && finished);
        const isFailed = failed && finished && i === activeIndex;
        const state = done ? "done" : isFailed ? "failed" : isActive ? "active" : "pending";

        const liveDetail =
          isActive && stage.step === "identity-reauthorized" && latestRehostSubstep !== undefined
            ? SUBSTEP_LABEL[latestRehostSubstep.step]
            : isActive && stage.step === "key-reconstructed"
              ? custodianDetail
              : undefined;

        return (
          <div key={stage.step} className={`stage stage-${state}`}>
            <div className="stage-marker">{done ? "✓" : isFailed ? "✕" : i + 1}</div>
            <div className="stage-body">
              <div className="stage-name">{stage.name}</div>
              <div className="stage-blurb">{stage.blurb}</div>
              {liveDetail !== undefined && <div className="stage-live">{liveDetail}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
