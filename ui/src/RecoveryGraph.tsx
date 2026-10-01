import {
  Background,
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  ReactFlow,
  getBezierPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { AnimatePresence, motion } from "framer-motion";
import { useMemo } from "react";
import type { CustodySecret, RecoverEvent } from "./api";
import { SUBSTEP_LABEL } from "./labels";

// Every state below is derived from real backend data: recover events (via
// GET /recover-progress) and participant1's real reachability (via GET
// /participant1-status, polled by App.tsx) — nothing here is a fake timer
// or a hardcoded "already dead". The map is meant to be honest before the
// disaster too, not just during recovery.

type NodeStatus = "idle" | "alive" | "dead" | "querying" | "responded" | "no-response" | "recovered";

interface NodeVisualData extends Record<string, unknown> {
  label: string;
  techId: string;
  sublabel: string;
  status: NodeStatus;
  kind: "owner-home" | "self-backup" | "custodian" | "target";
}

const STATUS_STYLE: Record<NodeStatus, { border: string; glow: string; bg: string }> = {
  idle: { border: "#3f3f46", glow: "none", bg: "#18181b" },
  alive: { border: "#3f6212", glow: "0 0 10px rgba(101,163,13,0.25)", bg: "#141a0f" },
  dead: { border: "#7f1d1d", glow: "none", bg: "#1c1010" },
  querying: { border: "#ca8a04", glow: "0 0 16px rgba(202,138,4,0.55)", bg: "#1c1a10" },
  responded: { border: "#16a34a", glow: "0 0 14px rgba(22,163,74,0.45)", bg: "#0f1c14" },
  "no-response": { border: "#dc2626", glow: "0 0 14px rgba(220,38,38,0.4)", bg: "#1c1010" },
  recovered: { border: "#22c55e", glow: "0 0 28px rgba(34,197,94,0.75)", bg: "#0d1f14" },
};

const STATUS_ICON: Record<NodeStatus, string> = {
  idle: "⚪",
  alive: "🟢",
  dead: "💀",
  querying: "🔄",
  responded: "✅",
  "no-response": "❌",
  recovered: "🟢",
};

function NetworkNode({ data }: NodeProps<Node<NodeVisualData>>) {
  const style = STATUS_STYLE[data.status];
  return (
    <motion.div
      animate={
        data.status === "querying"
          ? { scale: [1, 1.05, 1] }
          : data.status === "recovered"
            ? { scale: [1, 1.12, 1] }
            : { scale: 1 }
      }
      transition={data.status === "querying" ? { duration: 1, repeat: Infinity } : { duration: 0.5 }}
      style={{
        border: `2px solid ${style.border}`,
        background: style.bg,
        boxShadow: style.glow,
        borderRadius: 10,
        padding: "0.6rem 0.9rem",
        minWidth: 150,
        color: "#e4e4e7",
        fontFamily: "inherit",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 600 }}>
        <AnimatePresence mode="wait">
          <motion.span
            key={data.status}
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            {STATUS_ICON[data.status]}
          </motion.span>
        </AnimatePresence>
        {data.label}
      </div>
      <div style={{ fontSize: "0.68rem", opacity: 0.45, fontFamily: "monospace", marginTop: 1 }}>
        {data.techId}
      </div>
      <div style={{ fontSize: "0.75rem", opacity: 0.7, marginTop: 3 }}>{data.sublabel}</div>
    </motion.div>
  );
}

const nodeTypes = { network: NetworkNode };

// React Flow's built-in string `label` prop measures the text's SVG bbox to
// size its background — when the label goes from absent to present (as this
// one does, the moment identity is re-authorized) that measurement can be
// stale, clipping the text (seen live: "same identity" rendered as "me
// identity"). A plain positioned HTML div via EdgeLabelRenderer sizes itself
// the normal CSS way instead, sidestepping that measurement entirely.
function LabeledEdge({ id, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, style, data }: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const label = (data as { label?: string } | undefined)?.label;
  return (
    <>
      <BaseEdge id={id} path={edgePath} style={style} />
      {label !== undefined && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              // Offset above the curve's own midpoint, not sitting on it -
              // keeps the label clearly separated from the line itself
              // (and from anything else near the curve's path) instead of
              // relying on the line and the label never visually crossing.
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY - 22}px)`,
              background: "#1e1030",
              border: "1px solid #a855f7",
              borderRadius: 4,
              padding: "3px 8px",
              fontSize: 11,
              fontWeight: 600,
              color: "#c4b5fd",
              whiteSpace: "nowrap",
              pointerEvents: "none",
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes = { labeled: LabeledEdge };

export interface RecoveryGraphProps {
  revealed: RecoverEvent[];
  finished: boolean;
  recovering: boolean;
  succeeded: boolean;
  failed: boolean;
  participant1Alive: boolean;
}

function endpointNodeId(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return endpoint;
  }
}

function custodianSublabel(state: { status: NodeStatus; secret?: CustodySecret } | undefined): string {
  if (state === undefined || state.secret === undefined) return "Holding encrypted fragments";
  const fragment = state.secret === "identity" ? "identity-key fragment" : "data-key fragment";
  if (state.status === "responded") return `Sent its ${fragment}`;
  if (state.status === "querying") return `Sending its ${fragment}…`;
  if (state.status === "no-response") return "Unreachable — skipped";
  return "Holding encrypted fragments";
}

export function RecoveryGraph({
  revealed,
  finished,
  recovering,
  succeeded,
  failed,
  participant1Alive,
}: RecoveryGraphProps) {
  // Each custodian is asked twice in a real recovery - first for its
  // identity-key fragment, later for its data-key fragment - so it pulses
  // twice; the latest round trip (and which secret it was for) wins.
  const custodianState = useMemo(() => {
    const state: Record<string, { status: NodeStatus; secret?: CustodySecret }> = {
      agent2: { status: "idle" },
      agent3: { status: "idle" },
    };
    for (const event of revealed) {
      if (event.type === "custodian-query") {
        state[endpointNodeId(event.endpoint)] = { status: "querying", secret: event.secret };
      } else if (event.type === "custodian-response") {
        state[endpointNodeId(event.endpoint)] = {
          status: event.ok ? "responded" : "no-response",
          secret: event.secret,
        };
      }
    }
    return state;
  }, [revealed]);
  const custodianStatus: Record<string, NodeStatus> = {
    agent2: custodianState.agent2?.status ?? "idle",
    agent3: custodianState.agent3?.status ?? "idle",
  };
  const identityFetchStarted = revealed.some((e) => e.type === "custodian-query" && e.secret === "identity");

  const milestones = useMemo(
    () => new Set(revealed.filter((e) => e.type === "milestone").map((e) => e.step)),
    [revealed],
  );

  // Real phases of re-authorizing identity (propose/sign/load/verify),
  // each reported by agent/src/rehostParty.ts as it actually happens - not
  // a single "done" event at the end of a ~55s black box. The latest one
  // drives both the target node's sublabel and the identity edge's label
  // while the milestone hasn't landed yet.
  const latestRehostSubstep = useMemo(() => {
    const events = revealed.filter((e) => e.type === "rehost-substep");
    return events.length > 0 ? events[events.length - 1] : undefined;
  }, [revealed]);

  const targetStatus: NodeStatus = succeeded && finished
    ? "recovered"
    : failed && finished
      ? "no-response"
      : milestones.size > 0 || latestRehostSubstep !== undefined || identityFetchStarted
        ? "querying"
        : "idle";

  const targetSublabel = succeeded && finished
    ? "Recovered — same node, same identity"
    : failed && finished
      ? "Recovery failed"
      : milestones.has("state-restored")
        ? "State imported"
        : milestones.has("key-reconstructed")
          ? "Key reconstructed — importing state…"
          : milestones.has("identity-reauthorized")
            ? "Identity re-authorized — fetching data-key fragments…"
            : latestRehostSubstep !== undefined
              ? SUBSTEP_LABEL[latestRehostSubstep.step]
              : milestones.has("identity-key-reconstructed")
                ? "Identity key rebuilt — re-authorizing…"
                : identityFetchStarted
                  ? "Rebuilding the owner's identity key…"
                  : recovering
                    ? "Awaiting recovery…"
                    : "Empty — awaiting recovery";

  const identityTransferred = milestones.has("identity-reauthorized");

  const nodes: Node<NodeVisualData>[] = [
    {
      id: "participant1",
      type: "network",
      position: { x: 0, y: 0 },
      data: {
        label: "Owner's node",
        techId: "participant1",
        sublabel: participant1Alive ? "Live — holds identity + data" : "Destroyed",
        status: participant1Alive ? "alive" : "dead",
        kind: "owner-home",
      },
      draggable: false,
    },
    {
      id: "agent2",
      type: "network",
      position: { x: 0, y: 140 },
      data: {
        label: "Custodian 2",
        techId: "agent2",
        sublabel: custodianSublabel(custodianState.agent2),
        status: custodianStatus.agent2 ?? "idle",
        kind: "custodian",
      },
      draggable: false,
    },
    {
      id: "agent3",
      type: "network",
      position: { x: 0, y: 280 },
      data: {
        label: "Custodian 3",
        techId: "agent3",
        sublabel: custodianSublabel(custodianState.agent3),
        status: custodianStatus.agent3 ?? "idle",
        kind: "custodian",
      },
      draggable: false,
    },
    // Positioned below the two real custodians, off the direct
    // participant1 -> participant4 path (it used to sit between them,
    // which put the identity edge's line and label right behind this
    // node's box — moved out of the way, which also reinforces the point:
    // this one isn't part of the active recovery path).
    {
      id: "agent1",
      type: "network",
      position: { x: 0, y: 420 },
      data: {
        label: "Owner's own backup",
        techId: "agent1",
        sublabel: "Skipped on purpose — rebuilt only from others' fragments",
        status: "idle",
        kind: "self-backup",
      },
      draggable: false,
    },
    {
      id: "participant4",
      type: "network",
      position: { x: 600, y: 140 },
      data: {
        label: "Recovery target",
        techId: "participant4",
        sublabel: targetSublabel,
        status: targetStatus,
        kind: "target",
      },
      draggable: false,
    },
  ];

  const queryEdge = (id: string, source: string, status: NodeStatus): Edge => {
    const active = status === "querying";
    const done = status === "responded";
    return {
      id,
      source,
      target: "participant4",
      animated: active,
      style: {
        stroke: done ? "#16a34a" : active ? "#ca8a04" : "#3f3f46",
        strokeWidth: done || active ? 2.5 : 1.5,
      },
    };
  };

  // Structural facts, not live actions - always drawn, quiet/muted so the
  // live query edges below still win the eye (see the legend under the
  // graph). Both originate from participant1: that's where the whole blob
  // and the whole key lived before distribution.
  const structuralEdge = (id: string, target: string, kind: "blob" | "key"): Edge => ({
    id,
    source: "participant1",
    target,
    style:
      kind === "blob"
        ? { stroke: "#3b4252", strokeWidth: 1, strokeDasharray: "2 4" }
        : { stroke: "#4a3f2a", strokeWidth: 1, strokeDasharray: "1 3 5 3" },
  });

  const edges: Edge[] = [
    structuralEdge("e-blob-agent1", "agent1", "blob"),
    structuralEdge("e-blob-agent2", "agent2", "blob"),
    structuralEdge("e-blob-agent3", "agent3", "blob"),
    structuralEdge("e-key-agent1", "agent1", "key"),
    structuralEdge("e-key-agent2", "agent2", "key"),
    structuralEdge("e-key-agent3", "agent3", "key"),
    queryEdge("e-agent2-query", "agent2", custodianStatus.agent2 ?? "idle"),
    queryEdge("e-agent3-query", "agent3", custodianStatus.agent3 ?? "idle"),
    {
      id: "e-identity",
      type: "labeled",
      source: "participant1",
      target: "participant4",
      // Driven by the paced reveal (!finished), not the raw `recovering`
      // flag — a fast/idempotent recovery can flip `recovering` back to
      // false well before the reveal queue (see revealedCount above) has
      // caught up, which used to freeze this edge mid-animation instead of
      // riding out the same pacing every other node already follows.
      animated: !identityTransferred && !finished,
      style: {
        stroke: identityTransferred ? "#a855f7" : "#52525b",
        strokeWidth: identityTransferred ? 2.5 : 1.5,
      },
      data: {
        label: identityTransferred
          ? "same identity"
          : latestRehostSubstep !== undefined
            ? SUBSTEP_LABEL[latestRehostSubstep.step]
            : milestones.has("identity-key-reconstructed")
              ? "identity key rebuilt"
              : undefined,
      },
    },
  ];

  return (
    <div>
      <div style={{ height: 310, background: "#09090b", borderRadius: 12, border: "1px solid #27272a" }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={{ padding: 0.3 }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#27272a" gap={24} />
        </ReactFlow>
      </div>
      <div className="graph-legend">
        <span>
          <i className="legend-swatch legend-solid" /> who can act (identity)
        </span>
        <span>
          <i className="legend-swatch legend-dotted" /> where the encrypted blob lives
        </span>
        <span>
          <i className="legend-swatch legend-dashdot" /> where key fragments live
        </span>
      </div>
    </div>
  );
}
