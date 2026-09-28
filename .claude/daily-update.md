Date: 2026-09-29
Developer: tomascmk

- Wrote the final 5-minute demo script (identity-recovery timebox closed 2026-09-28): opens killing
  participant1 in the first 10 seconds, closes with a counterparty transacting against the recovered
  party, three named live-failure points with a plan B each. Vault: Flows/5-Minute Demo Flow.md.
- Closed the punch list the script surfaced, in the priority order given:
  - P1: dashboard status now queries via the custodians' own participants, not owner's — verified by
    genuinely killing participant1 (stop+rm+volume rm, not simulated) and confirming status, recover,
    and the closing command all kept working afterward.
  - P2: new `agent counterparty-tx` command for the closing beat — resolves both party ids itself,
    no more hand-typed 60+ character hashes. Verified on-chain.
  - P3: Recover now shows real step-by-step progress (identity re-authorized → key reconstructed →
    state restored) via a new /recover-progress endpoint, not a bare spinner or a fake timer.
    Verified by polling mid-flight and catching it at 2 of 3 steps done.
- Rebuilt the demo's UI needs into the closed script; docs/README.md flag updates and a full timed
  rehearsal are what's left, no longer any open engineering risk.
- Built an animated network graph for the Recover flow (user's request — "que se vea impresionante"):
  React Flow + Framer Motion, 5 nodes (owner's node/destroyed, owner's own backup/unused, two
  custodians pulsing then turning green as they genuinely respond, recovery target glowing green on
  success). Backend now emits per-custodian query/response events, not just 3 coarse milestones, so
  every animation beat maps to something that actually happened.
- Found and fixed, through the user's own live testing in a real browser: a stale Docker build (own
  process slip — forgot `make rebuild` after the last backend change), a polling race where a fast/
  idempotent recovery could finish before the first progress poll ever fired, an edge animating off
  a UI flag instead of a real event, a real naming bug (a node was labeled with a party — "custodian1"
  — that doesn't exist anywhere in the code), and a label-clipping rendering bug in the graph library
  itself (worked around with a custom edge component).
- Redesigned the layout per feedback: policy/custodian details collapse into an accordion the moment
  Recover is clicked, and the button became the visual centerpiece of its own section instead of a
  small inline control.
- Found and fixed a real permission bug in party re-hosting: the recovered owner could receive
  commands from counterparties but never submit its own (Interactive Submission timed out silently).
  Root cause: rehostParty.ts requested Observation instead of Confirmation. Verified against Canton's
  own source (canConfirm is false for Observation) and against the live environment — owner can now
  submit real commands from the recovered participant4.
- Started the "what's at stake" real-positions feature (Position.daml + seed.ts) but hit a real
  environment blocker: this dev environment's owner party ended up hosted on two participants with
  inconsistent vetted package sets, which Interactive Submission rejects outright. The safe fix
  (removing the dead host from the party's topology) was correctly blocked by the auto-mode permission
  classifier as a shared-resource change — needs an explicit yes/no, documented in the vault's demo
  flow doc under "Pendiente".
- Shipped three of the five UI closing-list items, all real backend data: a ciphertext panel (fetches
  actual encrypted bytes live from a real custodian's own volume, replacing the terminal `xxd` step),
  a live recovery timer (real wall-clock RTO, frozen at the end), and an always-visible pre-disaster
  strip (each custodian's last-challenge-OK time, so the demo shows the product working before showing
  it destroyed). Typechecked clean on both agent and ui; could not click through in an actual browser
  this session (no browser-automation tool available) — worth a human pass before the real demo.

---
Date: 2026-09-28
Developer: tomascmk

- Investigated the "owner's partyId seemed to change" concern: no reseed bug exists — the identity
  file never changed. The real cause was forgetting to rebuild the agent Docker image after editing
  agent/src on 2026-09-25, so create-policy/challenge/request-recovery's earlier "verification" ran
  old pre-external-party code against a leftover local "owner" party. Re-verified all three for real
  today against the actual external party — they work correctly.
- Added a fail-loudly identity guard (assertKeyMatchesParty): any signing operation now verifies the
  local key's fingerprint matches the partyId first, and fixed a related bug where a key/party
  mismatch was being silently papered over by allocating a brand new party instead of erroring.
  Verified both the pass case (real identity) and the fail case (synthetic corrupted party-id file).
- Timebox check: today is day 5/7 (day 7 = 2026-09-30) — 2 days of runway left, not 5.
- Verified the full success criterion against the real pipeline (not the spike): custodian2 created a
  brand-new contract naming the recovered owner as observer, active immediately on participant4.
- Tested the UI Recover button properly (not just CLI) and found two more real bugs: dashboard.ts's
  status endpoint had the same identity-resolution bug as the CLI commands, and the UI's success
  regex broke when recover()'s output format changed. Both fixed. Also found each agent-based
  docker-compose service (agent1/2/3, dashboard, seed) tags its own separate image — rebuilding
  `agent` alone never rebuilds the others; fixed the runbook to say rebuild all of them.
- Started the UI dev server (localhost:5173) — no browser-automation tool available this session, so
  the actual click-through needs a human or a different tool.
- User clicked Recover in a real browser — confirmed working, friendly success banner rendered
  correctly.
- Fixed the root cause of "forgot to rebuild before testing" for good: all six agent-based
  docker-compose services now share one image tag (canton-dr-agent:latest) instead of one each, and
  `make rebuild` (repo root) is the one command to run after editing agent/src. Verified all four
  long-running containers report the same image SHA after one `make rebuild`.
- Cleaned up a related dead-code landmine in acceptCustody.ts (an unused resolveParty(owner) call —
  same dangerous pattern, just never wired up to anything yet).
- Implemented and verified Shamir protection for the identity key itself (distribute-identity/
  recover-identity), completing the full one-week identity-recovery timebox two days early. Verified
  with a real destructive test: deleted the actual identity file, rebuilt it from 2 of 3 custodian
  shares, signed a real transaction with the restored identity, confirmed on-chain. Found and fixed a
  fourth instance of the "picked the wrong stale candidate" bug pattern along the way (this time in
  the new recover-identity code itself, matching by BackupPolicy).

---
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
