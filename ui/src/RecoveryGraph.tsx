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
import { useEffect, useMemo, useState } from "react";
import type { RecoverEvent, RehostSubStep } from "./api";

// Every state below is derived from real backend events (agent/src/recover.ts's
// RecoverEvent, via GET /recover-progress) — nothing here is a fake timer.
// The only thing NOT derived from an event is participant1: it's shown dead
// from the start, because by the time this screen matters in the real demo,
// it already has been (see docs/DEMO_SCRIPT_SKELETON.md's opening beat).

type NodeStatus = "idle" | "dead" | "querying" | "responded" | "no-response" | "recovered";

interface NodeVisualData extends Record<string, unknown> {
  label: string;
  techId: string;
  sublabel: string;
  status: NodeStatus;
  kind: "owner-home" | "custodian" | "target";
}

const STATUS_STYLE: Record<NodeStatus, { border: string; glow: string; bg: string }> = {
  idle: { border: "#3f3f46", glow: "none", bg: "#18181b" },
  dead: { border: "#7f1d1d", glow: "none", bg: "#1c1010" },
  querying: { border: "#ca8a04", glow: "0 0 16px rgba(202,138,4,0.55)", bg: "#1c1a10" },
  responded: { border: "#16a34a", glow: "0 0 14px rgba(22,163,74,0.45)", bg: "#0f1c14" },
  "no-response": { border: "#dc2626", glow: "0 0 14px rgba(220,38,38,0.4)", bg: "#1c1010" },
  recovered: { border: "#22c55e", glow: "0 0 28px rgba(34,197,94,0.75)", bg: "#0d1f14" },
};

const STATUS_ICON: Record<NodeStatus, string> = {
  idle: "⚪",
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
function IdentityEdge({ id, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, style, data }: EdgeProps) {
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
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
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

const edgeTypes = { identity: IdentityEdge };

export interface RecoveryGraphProps {
  events: RecoverEvent[];
  recovering: boolean;
  succeeded: boolean;
  failed: boolean;
}

const SUBSTEP_LABEL: Record<RehostSubStep, string> = {
  "checking-idempotency": "Checking if already hosted…",
  "already-hosted": "Already hosted — nothing to re-authorize",
  proposing: "Proposing identity change…",
  proposed: "Proposal signed by target",
  signing: "Signing with owner's key…",
  signed: "Signature ready",
  loading: "Loading authorization…",
  loaded: "Authorization loaded",
  verifying: "Verifying submission rights…",
  verified: "Identity verified",
};

function endpointNodeId(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return endpoint;
  }
}

export function RecoveryGraph({ events, recovering, succeeded, failed }: RecoveryGraphProps) {
  // Every event here genuinely happened — but the backend can report several
  // in one poll tick (or all of them, if a step was already-satisfied and
  // instant, e.g. re-hosting a party that's already hosted). Revealing them
  // no faster than one every ~450ms doesn't fabricate anything: it just
  // paces a real sequence enough for a human to actually see each step,
  // instead of the graph jumping straight to "recovered" in one frame.
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

  const revealed = events.slice(0, revealedCount);
  const finished = revealedCount >= events.length;

  const custodianStatus = useMemo(() => {
    const status: Record<string, NodeStatus> = { agent2: "idle", agent3: "idle" };
    for (const event of revealed) {
      if (event.type === "custodian-query") {
        status[endpointNodeId(event.endpoint)] = "querying";
      } else if (event.type === "custodian-response") {
        status[endpointNodeId(event.endpoint)] = event.ok ? "responded" : "no-response";
      }
    }
    return status;
  }, [revealed]);

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
      : milestones.size > 0 || latestRehostSubstep !== undefined
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
            ? "Identity re-authorized — fetching fragments…"
            : latestRehostSubstep !== undefined
              ? SUBSTEP_LABEL[latestRehostSubstep.step]
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
        sublabel: "Destroyed",
        status: "dead",
        kind: "owner-home",
      },
      draggable: false,
    },
    {
      id: "agent1",
      type: "network",
      position: { x: 0, y: 130 },
      data: {
        label: "Owner's own backup",
        techId: "agent1",
        sublabel: "Not needed — 2 external fragments are enough",
        status: "idle",
        kind: "custodian",
      },
      draggable: false,
    },
    {
      id: "agent2",
      type: "network",
      position: { x: 0, y: 250 },
      data: {
        label: "Custodian 2",
        techId: "agent2",
        sublabel:
          custodianStatus.agent2 === "responded"
            ? "Fragment sent"
            : custodianStatus.agent2 === "querying"
              ? "Sending fragment…"
              : "Holding an encrypted fragment",
        status: custodianStatus.agent2 ?? "idle",
        kind: "custodian",
      },
      draggable: false,
    },
    {
      id: "agent3",
      type: "network",
      position: { x: 0, y: 370 },
      data: {
        label: "Custodian 3",
        techId: "agent3",
        sublabel:
          custodianStatus.agent3 === "responded"
            ? "Fragment sent"
            : custodianStatus.agent3 === "querying"
              ? "Sending fragment…"
              : "Holding an encrypted fragment",
        status: custodianStatus.agent3 ?? "idle",
        kind: "custodian",
      },
      draggable: false,
    },
    {
      id: "participant4",
      type: "network",
      position: { x: 480, y: 185 },
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

  const flowEdge = (id: string, source: string, status: NodeStatus): Edge => {
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

  const edges: Edge[] = [
    {
      id: "e-agent1",
      source: "agent1",
      target: "participant4",
      style: { stroke: "#27272a", strokeWidth: 1, strokeDasharray: "4 4" },
    },
    flowEdge("e-agent2", "agent2", custodianStatus.agent2 ?? "idle"),
    flowEdge("e-agent3", "agent3", custodianStatus.agent3 ?? "idle"),
    {
      id: "e-identity",
      type: "identity",
      source: "participant1",
      target: "participant4",
      // Driven by the paced reveal (!finished), not the raw `recovering`
      // flag — a fast/idempotent recovery can flip `recovering` back to
      // false well before the reveal queue (see revealedCount above) has
      // caught up, which used to freeze this edge mid-animation instead of
      // riding out the same pacing every other node already follows.
      animated: !identityTransferred && !finished,
      style: {
        stroke: identityTransferred ? "#a855f7" : "#3f3f46",
        strokeWidth: identityTransferred ? 2.5 : 1,
        strokeDasharray: "6 4",
      },
      data: {
        label: identityTransferred
          ? "same identity"
          : latestRehostSubstep !== undefined
            ? SUBSTEP_LABEL[latestRehostSubstep.step]
            : undefined,
      },
    },
  ];

  return (
    <div style={{ height: 420, background: "#09090b", borderRadius: 12, border: "1px solid #27272a" }}>
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
  );
}
