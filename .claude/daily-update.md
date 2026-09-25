Date: 2026-09-25
Developer: tomascmk

- Restructured the project's live-context vault (../canton-dr-hackathon-vault) into a real Obsidian
  vault: Hub, ADRs/BDRs for design and process decisions, POCs for the proven identity-recovery
  mechanisms, Runbooks, and a Flows demo script — replacing the old flat ROADMAP/DECISIONS/FINDINGS
  files (kept as redirect stubs).
- Updated this repo's CLAUDE.md to point at the vault's new Hub.md instead of the old flat file names.
- Confirmed with the user: forum outreach messages and DevNet onboarding paperwork have not started
  yet — still open action items, not blocked on engineering time.
- Adapted create-policy and request-recovery to sign as the external owner via Interactive
  Submission Service (distribute needed no change — it never signs as owner). Verified against the
  real environment: the resulting on-chain contracts genuinely show owner's external party as
  signatory, and both commands stay idempotent on re-run.
- Fixed `challenge.ts` too (same bug, same fix, same on-chain verification). Grepped the whole
  agent/src for the pattern to confirm nothing else assumes `owner` is a local party — nothing left.
  Owner-as-external-signatory wiring is now complete across the codebase.
- Resolved the party re-hosting blocker from earlier today. Following two targeted checks (compare
  the local key's fingerprint against the registered one; confirm the target participant's own
  authorization) found the real cause: a stale hardcoded partyId in my own manual debug scripts, not
  a bug in the mechanism or the real code. Also found and fixed a genuine bug along the way: recover
  needed an idempotency guard before re-authorizing an already-hosted party.
- `recover` now works end to end against the real environment: reconstructs the Shamir key, re-hosts
  owner's external party on participant4, imports the ACS — verified by directly querying
  participant4's active contracts (owner shows as genuine signatory). Identity recovery is no longer
  spike-only; committed to feature/identity-recovery.
