import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { exerciseChoice, queryActive, resolveParty } from "./ledger.js";

const DATA_DIR = process.env.CUSTODY_DATA_DIR ?? "/canton/custody";

export interface RespondOptions {
  as: string; // which mounted custody dir to read the share from, e.g. "agent2"
  participant: string; // this custodian's own participant, host:port
  custodianPartyHint: string;
  policyId: string;
  challengeId: string;
}

// Proof of possession: HMAC-SHA256(share, challengeId). The share is read
// from local disk and never transmitted — only someone holding it can
// produce this value for a given challengeId.
export async function respond(options: RespondOptions): Promise<string> {
  const { as, participant, custodianPartyHint, policyId, challengeId } = options;

  const custodian = await resolveParty(participant, custodianPartyHint);
  const share = await readFile(join(DATA_DIR, as, policyId, "share.bin"));
  const proof = createHmac("sha256", share).update(challengeId).digest("hex");

  const challenges = await queryActive(participant, custodian, ":BackupPolicy:Challenge");
  const open = challenges.find(
    (c) => c.payload["policyId"] === policyId && c.payload["challengeId"] === challengeId,
  );
  if (open === undefined) {
    throw new Error(
      `no open Challenge '${challengeId}' for policy ${policyId} visible to ${custodian} on ${participant}`,
    );
  }

  await exerciseChoice(participant, custodian, open.templateId, open.contractId, "Respond", { proof });

  return `RESPOND_OK: ${custodian} answered ${challengeId} with proof ${proof.slice(0, 16)}...`;
}
