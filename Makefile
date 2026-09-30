.PHONY: build-dar rebuild demo-reset

# Builds the DAR without assuming dpm/damlc is on PATH — see
# daml/build-dar.sh. Uses either one if already installed; otherwise
# downloads dpm's own binary into daml/.dpm-cache/ (gitignored, not
# installed system-wide) and builds with that. Run this once after
# cloning, and again any time daml/*.daml changes (bump `version` in
# daml/daml.yaml first — Canton refuses to vet two different-content
# packages under the same name+version).
build-dar:
	cd daml && ./build-dar.sh

# The one command to run after editing anything in agent/src, before
# testing with `docker compose run`/`up` again. agent, agent1, agent2,
# agent3, dashboard and seed all build from ../agent and now share one
# image tag (canton-dr-agent:latest, see infra/docker-compose.yml) — this
# builds it once and force-recreates every long-running container that
# uses it, so there's no way to end up running stale code in one of them
# without noticing (see the vault's ADR-008 / POC - External Party As
# Signatory for why this exists).
rebuild:
	cd infra && docker compose build agent
	cd infra && docker compose up -d --force-recreate agent1 agent2 agent3 dashboard

# The one command to run before rehearsing or demoing: tears the whole
# environment down (including volumes — no leftover state from a previous
# run's tests can bite twice, see ADR-007/ADR-009 in the vault) and rebuilds
# it from scratch into an exact pre-disaster state — participant1 alive,
# owner seeded with its 3 real positions, policy active, blob + identity key
# distributed to all 3 custodians, both custodians' last challenge OK.
# Each step here fails the whole target immediately if it errors (Make's
# default) — no silent partial state. The last step, `verify-demo-state`,
# fails loudly (throws, naming exactly what's wrong) if the result isn't
# genuinely pre-disaster-ready, instead of leaving that to be discovered by
# hand on demo day.
demo-reset:
	cd infra && docker compose down -v
	cd infra && docker compose up -d synchronizer participant1 participant2 participant3 participant4
	cd infra && until [ -z "$$(docker compose ps --format '{{.Status}}' | grep -v healthy)" ]; do sleep 3; done
	cd infra && docker compose run --rm bootstrap
	cd infra && docker compose up -d agent1 agent2 agent3 dashboard
	cd infra && docker compose run --rm agent seed
	cd infra && docker compose run --rm agent create-policy --owner-participant participant1:5013 --owner owner --custodian participant2:5023:custodian2 --custodian participant3:5033:custodian3 --k 2 --n 3 --frequency-hours 1 --policy-id demo
	cd infra && docker compose run --rm agent distribute --source participant1 --party owner --policy-id demo --endpoints http://agent1:4001,http://agent2:4002,http://agent3:4003 --k 2
	cd infra && docker compose run --rm agent accept-custody --as agent2 --participant participant2:5023 --custodian custodian2 --owner-participant participant1:5013 --owner owner --policy-id demo
	cd infra && docker compose run --rm agent accept-custody --as agent3 --participant participant3:5033 --custodian custodian3 --owner-participant participant1:5013 --owner owner --policy-id demo
	cd infra && docker compose run --rm agent distribute-identity --policy-id demo --endpoints http://agent1:4001,http://agent2:4002,http://agent3:4003 --k 2
	cd infra && docker compose run --rm agent challenge --owner-participant participant1:5013 --owner owner --custodian-participant participant2:5023 --custodian custodian2 --policy-id demo --challenge-id demo-reset-c1
	cd infra && docker compose run --rm agent respond --as agent2 --participant participant2:5023 --custodian custodian2 --policy-id demo --challenge-id demo-reset-c1
	cd infra && docker compose run --rm agent challenge --owner-participant participant1:5013 --owner owner --custodian-participant participant3:5033 --custodian custodian3 --policy-id demo --challenge-id demo-reset-c2
	cd infra && docker compose run --rm agent respond --as agent3 --participant participant3:5033 --custodian custodian3 --policy-id demo --challenge-id demo-reset-c2
	cd infra && docker compose run --rm agent verify-demo-state
