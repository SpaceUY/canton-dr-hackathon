#!/bin/bash
# Allocates one party per participant and creates a Record contract that
# spans all 3 (owner on participant1, custodians on participant2/3), so
# there's real ACS state on every node before plan step 2 (export/import).
# Run after `bootstrap.canton` has connected the participants and uploaded
# the DAR — see docker-compose's `seed` service.
#
# Idempotent: safe to re-run (`docker compose up seed`) against an already
# seeded topology — reuses existing parties and skips creating a second
# Record if one is already there.
set -eo pipefail

RETRIES=20
RETRY_DELAY=1

# Retries on connection failure (ledger API not accepting connections yet)
# and on 5xx. Fails immediately on 4xx (a client/application error — e.g.
# "party already exists" — that retrying will never fix) and after
# exhausting retries.
curl_check() {
  local url=$1
  shift
  local attempt response code body
  for attempt in $(seq 1 "$RETRIES"); do
    if response=$(curl -s -S -w "\n%{http_code}" "$url" -H "Content-Type: application/json" "$@" 2>/tmp/curl_err); then
      code=$(echo "$response" | tail -n1)
      body=$(echo "$response" | sed '$d')
      if [ "$code" -eq 200 ]; then
        echo "$body"
        return 0
      fi
      if [[ "$code" == 4* ]]; then
        echo "FAILED (client error $code) $url: $body" >&2
        exit 1
      fi
      echo "attempt $attempt/$RETRIES: $url -> HTTP $code: $body" >&2
    else
      echo "attempt $attempt/$RETRIES: $url -> $(cat /tmp/curl_err)" >&2
    fi
    sleep "$RETRY_DELAY"
  done
  echo "FAILED after $RETRIES attempts: $url" >&2
  exit 1
}

# participantId comes back as "<node-name>::<fingerprint>" (e.g.
# "participant1::1220..."), and parties this node allocates are named
# "<hint>::<that same fingerprint>" — so the namespace is everything after
# the first "::", not a fixed "participant::" prefix.
get_namespace() {
  local participant=$1
  curl_check "http://$participant/v2/parties/participant-id" | jq -r '.participantId | split("::")[1]'
}

# Reuses the party if it already exists (namespace-scoped hint), else
# allocates a fresh one. Makes re-running this script safe.
get_or_allocate_party() {
  local hint=$1
  local participant=$2
  local namespace party
  namespace=$(get_namespace "$participant")
  party=$(curl_check "http://$participant/v2/parties/party?parties=$hint::$namespace" | jq -r '.partyDetails[0].party // empty')
  if [ -n "$party" ]; then
    echo "$party"
    return 0
  fi
  party=$(curl_check "http://$participant/v2/parties" \
    --data-raw '{"partyIdHint": "'"$hint"'", "identityProviderId": ""}' | jq -r '.partyDetails.party // empty')
  if [ -z "$party" ]; then
    echo "party allocation for '$hint' on $participant returned no party id" >&2
    exit 1
  fi
  echo "$party"
}

# Polls $participant's known-parties list until $party shows up (topology
# propagation from another participant isn't instant).
wait_for_party_known() {
  local party=$1
  local participant=$2
  local attempt found
  for attempt in $(seq 1 "$RETRIES"); do
    found=$(curl_check "http://$participant/v2/parties/party?parties=$party" | jq -r '.partyDetails[0].party // empty')
    if [ "$found" = "$party" ]; then
      return 0
    fi
    sleep "$RETRY_DELAY"
  done
  echo "party $party never became known to $participant after $RETRIES attempts" >&2
  exit 1
}

active_record_label() {
  local participant=$1
  local party=$2
  local end
  end=$(curl_check "http://$participant/v2/state/ledger-end" | jq -r .offset)
  curl_check "http://$participant/v2/state/active-contracts" \
    --data-raw '{"filter":{"filtersByParty":{"'"$party"'":{"cumulative":[{"identifierFilter":{"WildcardFilter":{"value":{"includeCreatedEventBlob":false}}}}]}},"verbose":true},"verbose":true,"activeAtOffset":'"$end"'}' \
    | jq -r '[.[] | select(.contractEntry.JsActiveContract.createdEvent.templateId | endswith(":Record:Record")) | .contractEntry.JsActiveContract.createdEvent.createArgument.label][0] // empty'
}

owner=$(get_or_allocate_party "owner" "participant1:5013")
custodian2=$(get_or_allocate_party "custodian2" "participant2:5023")
custodian3=$(get_or_allocate_party "custodian3" "participant3:5033")

echo "owner=$owner"
echo "custodian2=$custodian2"
echo "custodian3=$custodian3"

wait_for_party_known "$custodian2" "participant1:5013"
wait_for_party_known "$custodian3" "participant1:5013"

owner_label=$(active_record_label participant1:5013 "$owner")
if [ "$owner_label" != "seed" ]; then
  curl_check "http://participant1:5013/v2/commands/submit-and-wait" \
    --data-raw '{
      "commands": [
        {"CreateCommand": {
          "templateId": "#canton-dr:Record:Record",
          "createArguments": {
            "owner": "'"$owner"'",
            "custodians": ["'"$custodian2"'", "'"$custodian3"'"],
            "label": "seed"
          }
        }}
      ],
      "userId": "participant_admin",
      "commandId": "seed-record-1",
      "actAs": ["'"$owner"'"],
      "readAs": ["'"$owner"'"]
    }' > /dev/null
else
  echo "Record already exists on participant1 — skipping create"
fi

# Parallel arrays (not packed "a:b:c" strings — party ids already contain
# ':' in their own "hint::fingerprint" form, which broke a colon-based split).
participants=("participant1:5013" "participant2:5023" "participant3:5033")
parties=("$owner" "$custodian2" "$custodian3")
for i in "${!participants[@]}"; do
  # Poll: submit-and-wait only guarantees participant1 (owner) committed —
  # custodian2/3 are mere observers and index the resulting transaction into
  # their own ACS asynchronously afterwards.
  ok=false
  for attempt in $(seq 1 "$RETRIES"); do
    label=$(active_record_label "${participants[$i]}" "${parties[$i]}")
    if [ "$label" = "seed" ]; then
      ok=true
      break
    fi
    sleep "$RETRY_DELAY"
  done
  if [ "$ok" != true ]; then
    echo "VERIFICATION FAILED: no Record with label 'seed' visible to ${parties[$i]} on ${participants[$i]} after $RETRIES attempts" >&2
    exit 1
  fi
done

echo "SEED_OK: Record verified in the ACS of all 3 participants (owner + 2 custodians)"
