#!/usr/bin/env bash
# Scale test: back up and recover N contracts (default 1000) and time it.
# NOT part of the demo path; touches no demo code. Run from the repo root:
#
#   ./scripts/scale-test.sh            # 1000 contracts
#   ./scripts/scale-test.sh 500
#
# It WIPES the environment (make demo-reset) at the start, destroys
# participant1 in the middle, and runs make demo-reset again at the end so
# you're left in a clean pre-disaster state. Expect ~10-20 min total.
# Close heavy apps first (Docker memory is the known bottleneck).
set -euo pipefail
N="${1:-1000}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$ROOT/scripts/scale-test-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee "$LOG") 2>&1
cd "$ROOT"

run_node() { (cd infra && docker compose run --rm -T --entrypoint node -v "$ROOT/scripts:/scripts:ro" agent /scripts/scale-load.mjs "$@"); }
now() { python3 -c 'import time; print(time.time())'; }
secs() { python3 -c "print(f'{$2-$1:.1f}')"; }

echo "== 1/7 clean environment (make demo-reset)"
make demo-reset

echo "== 2/7 loading $N contracts into owner's ACS"
run_node load "$N"
sleep 5   # let participant1 ingest the last batch
BEFORE_LINE=$(run_node count participant1 | grep ACS_COUNT | tail -1)
echo "$BEFORE_LINE"

echo "== 3/7 backup (distribute) with $N extra contracts"
t=$(now)
(cd infra && docker compose run --rm agent distribute --source participant1 --party owner --policy-id demo \
  --endpoints http://agent1:4001,http://agent2:4002,http://agent3:4003 --k 2)
BACKUP_S=$(secs "$t" "$(now)")
BLOB_BYTES=$(docker run --rm --entrypoint sh -v infra_agent2_custody:/c canton-dr-agent:latest -c 'du -sb /c | cut -f1' || echo "?")

echo "== 4/7 disaster (make destroy-node)"
make destroy-node

echo "== 5/7 recover (timed)"
t=$(now)
(cd infra && docker compose run --rm agent recover --target participant4 --target-ledger-api participant4:5043 \
  --loader-participant participant2 --policy-id demo \
  --endpoints http://agent2:4002,http://agent3:4003 --k 2 \
  --identity-custodian participant2:5023:custodian2)
RECOVER_S=$(secs "$t" "$(now)")

echo "== 6/7 verify on participant4"
sleep 5
AFTER_LINE=$(run_node count participant4 | grep ACS_COUNT | tail -1)
echo "$AFTER_LINE"

echo "== 7/7 counterparty transacts with the recovered owner (JSON API path, owner now holds $N+ contracts)"
t=$(now)
(cd infra && docker compose run --rm agent counterparty-tx --as custodian2 --participant participant2:5023 \
  --owner-participant participant4:5043 --label scale-close)
CLOSE_S=$(secs "$t" "$(now)")

echo
echo "================ RESULT ================"
echo "contracts loaded:        $N"
echo "backup (distribute):     ${BACKUP_S}s"
echo "custodian2 store size:   ${BLOB_BYTES} bytes"
echo "recover (RTO):           ${RECOVER_S}s"
echo "before (participant1):   $BEFORE_LINE"
echo "after  (participant4):   $AFTER_LINE"
echo "counterparty-tx:         ${CLOSE_S}s"
echo "log:                     $LOG"
echo "========================================"

echo "== restoring a clean demo state (make demo-reset)"
make demo-reset
