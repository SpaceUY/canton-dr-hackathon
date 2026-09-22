import { issueChallenge } from "./challenge.js";
import type { CustodianRef } from "./createPolicy.js";

export interface ChallengeLoopOptions {
  ownerParticipant: string;
  ownerPartyHint: string;
  custodians: CustodianRef[];
  policyId: string;
  intervalSeconds: number;
}

// The "job/trigger" from plan step 5 — not a Daml Trigger (a lot more
// machinery than a hackathon demo needs), just a loop that fires a fresh
// Challenge per custodian on an interval. Runs until killed; logs and
// keeps going on a per-custodian failure instead of dying.
export async function challengeLoop(options: ChallengeLoopOptions): Promise<never> {
  const { ownerParticipant, ownerPartyHint, custodians, policyId, intervalSeconds } = options;

  for (;;) {
    for (const custodian of custodians) {
      const challengeId = `ch-${Date.now()}-${custodian.partyHint}`;
      try {
        const line = await issueChallenge({
          ownerParticipant,
          ownerPartyHint,
          custodianParticipant: custodian.participant,
          custodianPartyHint: custodian.partyHint,
          policyId,
          challengeId,
        });
        console.log(line);
      } catch (err) {
        console.error(`challenge to ${custodian.partyHint} failed:`, err instanceof Error ? err.message : err);
      }
    }
    await sleep(intervalSeconds * 1000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
