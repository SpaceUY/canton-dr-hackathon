Date: 2026-09-25
Developer: tomascmk

- Restructured the project's live-context vault (../canton-dr-hackathon-vault) into a real Obsidian
  vault: Hub, ADRs/BDRs for design and process decisions, POCs for the proven identity-recovery
  mechanisms, Runbooks, and a Flows demo script — replacing the old flat ROADMAP/DECISIONS/FINDINGS
  files (kept as redirect stubs).
- Updated this repo's CLAUDE.md to point at the vault's new Hub.md instead of the old flat file names.
- Confirmed with the user: forum outreach messages and DevNet onboarding paperwork have not started
  yet — still open action items, not blocked on engineering time.
- Starting: adapt create-policy/distribute/request-recovery to sign externally (Interactive
  Submission Service) instead of assuming `owner` is a local party.
