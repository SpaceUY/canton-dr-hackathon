import type { RehostSubStep } from "./api";

// Shared between RecoveryGraph (edge/node sublabels) and StageRail (the
// live detail line under the active stage) - one source of truth for how
// each real sub-step of identity re-authorization reads on screen.
export const SUBSTEP_LABEL: Record<RehostSubStep, string> = {
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
