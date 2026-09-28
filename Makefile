.PHONY: rebuild

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
