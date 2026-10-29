#!/usr/bin/env bash
# Report where a pull request stands on its way to merging, as one JSON line on stdout.
#
# Usage:
#   merge-status.sh --repo OWNER/NAME --pr N [--since ISO8601] [--wait SECONDS] [--interval SECONDS]
#                   [--delay SECONDS] [--until-unqueued] [--ignore-queue-failures]
#                   [--until-new-removal ISO8601|""]
#
# --since    Only merge queue removals strictly after this time count as an eviction. Pass the
#            lastRemoval.at reported just before you enqueued (GitHub's clock, not the local one),
#            or "" when there was none. Removals older than the PR head's latest push never count.
# --wait     Poll until the PR needs action or this many seconds pass (default 0: probe once).
#            While waiting, up to 3 consecutive API errors are retried before giving up.
# --interval Seconds between polls while waiting (default 60).
# --delay    Sleep this many seconds before the first probe (default 0). Use it to re-check a state
#            after a fixed pause.
# --until-unqueued
#            Only QUEUED and QUEUE_FAILING count as waiting; every other status exits 0. Use it to
#            wait for another PR to leave the queue, whether it merged or was evicted.
# --ignore-queue-failures
#            Treat QUEUE_FAILING as waiting. Use it after deciding to let the queue finish instead of
#            dequeuing.
# --until-new-removal AT
#            Wait until a merge queue removal newer than AT (a previous lastRemoval.at, or "" for
#            none) is recorded, or the PR merges or closes. Use it right after this skill's own
#            dequeue or push to learn the exact removal it caused.
#
# Exit codes:
#   0  The PR needs action or reached a final state (see "status")
#   1  Still waiting on GitHub (queued, auto-merge pending, checks running)
#   2  Usage or API error
#
# Statuses (exit 0): MERGED, CLOSED, EVICTED, QUEUE_FAILING, READY, CHECKS_FAILED, CONFLICTS, BEHIND,
#                    BLOCKED, DRAFT
# Statuses (exit 1): QUEUED, AUTO_MERGE_PENDING, CHECKS_PENDING, UNKNOWN
#
# Anything that needs a human or a fix (CONFLICTS, BEHIND, CHECKS_FAILED, BLOCKED) wins over an armed
# auto-merge, which would otherwise wait forever for a merge that cannot happen.
#
# QUEUE_FAILING means the PR is still queued but a check on its merge group already failed.
# queueGroup.requiredFailed says whether a required check is among them (eviction is then certain).
# Cancelled or stale group runs (common when GitHub rebuilds groups) never count as failing; they are
# listed in queueGroup.cancelled.
#
# queueAhead lists the merge queue entries ahead of this PR: those with a lower position while it is
# queued, and every entry otherwise, since a requeue goes to the back. queueAheadTruncated is true
# when the queue holds more than 100 entries and some were not read.
#
# canPushHead says whether this token can push fixes to the PR head.
#
# checksTruncated is true when a commit has more than 100 check contexts and some were not read.
#
# Required check names come from rulesets, classic branch protection, and isRequired. GraphQL hides
# classic protection from non-admin tokens, so the REST branch endpoint fills that gap. If neither
# source is readable, requiredNamesUnknown is true, and a BLOCKED PR with checks still running is
# reported as CHECKS_PENDING rather than BLOCKED.
set -uo pipefail

USAGE='usage: merge-status.sh --repo OWNER/NAME --pr N [--since ISO8601] [--wait SECONDS] [--interval SECONDS] [--delay SECONDS] [--until-unqueued] [--ignore-queue-failures] [--until-new-removal ISO8601]'

usage_error() {
  jq -cn --arg e "$1" --arg u "$USAGE" '{status: "ERROR", error: ($e + "; " + $u)}'
  exit 2
}

repo="" pr="" since="" wait_s=0 interval=60 delay=0 until_unqueued=0 ignore_queue_failures=0
until_new_removal=0 removal_snapshot=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo | --pr | --since | --wait | --interval | --delay | --until-new-removal)
      [ $# -ge 2 ] || usage_error "missing value for $1"
      case "$1" in
        --repo) repo="$2" ;;
        --pr) pr="$2" ;;
        --since) since="$2" ;;
        --wait) wait_s="$2" ;;
        --interval) interval="$2" ;;
        --delay) delay="$2" ;;
        --until-new-removal) until_new_removal=1; removal_snapshot="$2" ;;
      esac
      shift 2
      ;;
    --until-unqueued) until_unqueued=1; shift ;;
    --ignore-queue-failures) ignore_queue_failures=1; shift ;;
    *) usage_error "unknown argument: $1" ;;
  esac
done

printf '%s' "$repo" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || usage_error "invalid --repo"
printf '%s' "$pr" | grep -Eq '^[0-9]+$' || usage_error "invalid --pr"
printf '%s' "$wait_s" | grep -Eq '^[0-9]+$' || usage_error "invalid --wait"
printf '%s' "$interval" | grep -Eq '^[1-9][0-9]*$' || usage_error "invalid --interval"
printf '%s' "$delay" | grep -Eq '^[0-9]+$' || usage_error "invalid --delay"

owner="${repo%%/*}"
name="${repo#*/}"

read -r -d '' QUERY <<'GRAPHQL'
query($owner: String!, $name: String!, $pr: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    autoMergeAllowed
    viewerPermission
    pullRequest(number: $pr) {
      baseRef {
        branchProtectionRule { requiredStatusCheckContexts }
        rules(first: 50) {
          nodes {
            type
            parameters { ... on RequiredStatusChecksParameters { requiredStatusChecks { context } } }
          }
        }
      }
      number url state isDraft baseRefName headRefName headRefOid
      isCrossRepository maintainerCanModify
      headRepository { nameWithOwner viewerPermission }
      mergeable mergeStateStatus reviewDecision
      isMergeQueueEnabled isInMergeQueue
      mergeCommit { oid }
      autoMergeRequest { enabledAt mergeMethod }
      mergeQueueEntry {
        state position enqueuedAt estimatedTimeToMerge
        headCommit {
          oid
          statusCheckRollup {
            contexts(first: 100) {
              pageInfo { hasNextPage }
              nodes {
                __typename
                ... on CheckRun { name status conclusion detailsUrl isRequired(pullRequestNumber: $pr) }
                ... on StatusContext { context state targetUrl }
              }
            }
          }
        }
      }
      mergeQueue {
        entries(first: 100) {
          pageInfo { hasNextPage }
          nodes { position state enqueuedAt pullRequest { number headRefOid } }
        }
      }
      timelineItems(itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT], last: 20) {
        nodes {
          __typename
          ... on AddedToMergeQueueEvent { createdAt }
          ... on RemovedFromMergeQueueEvent { createdAt reason actor { login } beforeCommit { oid } }
        }
      }
      commits(last: 1) {
        nodes {
          commit {
            committedDate
            checkSuites(first: 50) { nodes { createdAt } }
            statusCheckRollup {
              state
              contexts(first: 100) {
                pageInfo { hasNextPage }
                nodes {
                  __typename
                  ... on CheckRun { name status conclusion detailsUrl isRequired(pullRequestNumber: $pr) }
                  ... on StatusContext { context state targetUrl isRequired(pullRequestNumber: $pr) }
                }
              }
            }
          }
        }
      }
    }
  }
}
GRAPHQL

# Classify one GraphQL response into the status JSON. Exit status is decided by the caller.
read -r -d '' JQ <<'JQ'
# Normalize check runs and status contexts to {name, required, url, state}.
# state is SUCCESS, PENDING, FAILURE, or CANCELLED (cancelled or stale runs).
def checks($required_names):
  [(.contexts.nodes // [])[]
    | if .__typename == "CheckRun" then
        {name, required: ((.isRequired // false) or (.name | IN($required_names[]))), url: .detailsUrl,
         state: (if .status != "COMPLETED" then "PENDING"
                 elif (.conclusion | IN("SUCCESS", "NEUTRAL", "SKIPPED")) then "SUCCESS"
                 elif (.conclusion | IN("CANCELLED", "STALE")) then "CANCELLED"
                 else "FAILURE" end)}
      else
        {name: .context, required: ((.isRequired // false) or (.context | IN($required_names[]))), url: .targetUrl,
         state: (if .state == "SUCCESS" then "SUCCESS"
                 elif (.state | IN("PENDING", "EXPECTED")) then "PENDING"
                 else "FAILURE" end)}
      end];

.data.viewer.login as $viewer
| .data.repository.pullRequest as $p
| if $p == null then {status: "ERROR", error: "pull request not found"} else
  ([($p.baseRef.branchProtectionRule.requiredStatusCheckContexts // [])[],
    (($p.baseRef.rules.nodes // [])[] | select(.type == "REQUIRED_STATUS_CHECKS")
      | .parameters.requiredStatusChecks[].context),
    ($rest_required // [])[]] | unique) as $required_names
  | ($p.baseRef.branchProtectionRule == null and $rest_required == null) as $names_unknown
  | ($p.commits.nodes[0].commit) as $head_commit
  # GitHub creates check suites when a commit is pushed, so the earliest one dates the push.
  # committedDate is the fallback for repos with no checks at all.
  | ([($head_commit.checkSuites.nodes // [])[].createdAt] | min // $head_commit.committedDate) as $head_pushed_at
  | ($head_commit.statusCheckRollup) as $roll
  | ($roll // {} | checks($required_names)) as $checks
  # A cancelled required check on the PR head blocks merging just like a failure.
  | ([$checks[] | select(.required) | if .state == "CANCELLED" then .state = "FAILURE" else . end]) as $req
  # Required checks that have not been created yet only matter while GitHub reports the PR blocked.
  | (if ($p.mergeStateStatus | IN("BLOCKED", "UNKNOWN")) then
       [$required_names[] as $r | select(any($checks[]; .name == $r) | not) | $r]
     else [] end) as $missing_required
  | (if any($req[]; .state == "FAILURE") then "FAILURE"
     elif any($req[]; .state == "PENDING") or ($roll.state // "") == "EXPECTED" then "PENDING"
     elif ($missing_required | length) > 0 then "PENDING"
     elif $names_unknown and $p.mergeStateStatus == "BLOCKED" and any($checks[]; .state == "PENDING") then "PENDING"
     else "SUCCESS" end) as $required_state
  | ($p.mergeQueueEntry.headCommit) as $group
  | ($group.statusCheckRollup // {} | checks($required_names)) as $group_checks
  | ([$group_checks[] | select(.state == "FAILURE")]) as $group_failing
  | ([$p.timelineItems.nodes[] | select(.__typename == "RemovedFromMergeQueueEvent")] | last) as $removal
  | ([$p.timelineItems.nodes[] | select(.__typename == "AddedToMergeQueueEvent")] | last) as $added
  | ($removal != null
     and $removal.reason != "merged"
     and ($since == "" or $removal.createdAt > $since)
     and ($head_pushed_at == null or $head_pushed_at <= $removal.createdAt)
     and ($added == null or $added.createdAt <= $removal.createdAt)
     and ($p.autoMergeRequest == null or $p.autoMergeRequest.enabledAt <= $removal.createdAt)) as $evicted
  | ($p.autoMergeRequest != null) as $armed
  | {
      status: (
        if $p.state == "MERGED" then "MERGED"
        elif $p.state == "CLOSED" then "CLOSED"
        elif $p.isInMergeQueue and ($group_failing | length) > 0 then "QUEUE_FAILING"
        elif $p.isInMergeQueue then "QUEUED"
        elif $p.isDraft then "DRAFT"
        elif $evicted and $p.mergeStateStatus == "UNKNOWN" then "UNKNOWN"
        elif $evicted then "EVICTED"
        elif $p.mergeStateStatus == "DIRTY" then "CONFLICTS"
        elif $required_state == "FAILURE" then "CHECKS_FAILED"
        elif $p.mergeStateStatus == "BEHIND" then "BEHIND"
        elif $required_state == "PENDING" then (if $armed then "AUTO_MERGE_PENDING" else "CHECKS_PENDING" end)
        elif $p.mergeStateStatus == "BLOCKED" then "BLOCKED"
        elif $armed then "AUTO_MERGE_PENDING"
        elif ($p.mergeStateStatus | IN("CLEAN", "UNSTABLE", "HAS_HOOKS")) then "READY"
        else "UNKNOWN" end),
      pr: $p.number,
      url: $p.url,
      base: $p.baseRefName,
      head: $p.headRefName,
      headOid: $p.headRefOid,
      headPushedAt: $head_pushed_at,
      crossRepository: $p.isCrossRepository,
      maintainerCanModify: $p.maintainerCanModify,
      headRepository: $p.headRepository.nameWithOwner,
      # Whether this token can push fixes to the PR head: write access to the head repository, or a
      # cross-repository PR that allows maintainer edits when this token can write to the base.
      canPushHead: ((($p.headRepository.viewerPermission // "") | IN("ADMIN", "MAINTAIN", "WRITE"))
        or ($p.isCrossRepository and $p.maintainerCanModify
            and ((.data.repository.viewerPermission // "") | IN("ADMIN", "MAINTAIN", "WRITE")))),
      mergeQueue: $p.isMergeQueueEnabled,
      autoMergeAllowed: .data.repository.autoMergeAllowed,
      mergeStateStatus: $p.mergeStateStatus,
      reviewDecision: $p.reviewDecision,
      requiredChecks: $required_state,
      requiredCheckNames: $required_names,
      requiredNamesUnknown: $names_unknown,
      failingChecks: [$checks[] | select(.state == "FAILURE" or (.state == "CANCELLED" and .required)) | {name, required, url}],
      pendingRequiredChecks: ([$req[] | select(.state == "PENDING") | .name] + $missing_required | unique),
      checksTruncated: (($roll.contexts.pageInfo.hasNextPage // false)
        or ($group.statusCheckRollup.contexts.pageInfo.hasNextPage // false)),
      queueEntry: (if $p.mergeQueueEntry == null then null else
        $p.mergeQueueEntry | {state, position, enqueuedAt, estimatedTimeToMerge} end),
      queueGroup: (if $group == null then null else
        {oid: $group.oid,
         failing: [$group_failing[] | {name, required, url}],
         cancelled: [$group_checks[] | select(.state == "CANCELLED") | .name],
         requiredFailed: any($group_failing[]; .required),
         pendingRequired: [$required_names[] as $r
           | select(any($group_checks[]; .name == $r and (.state | IN("SUCCESS", "FAILURE"))) | not) | $r]} end),
      queueAhead: [($p.mergeQueue.entries.nodes // [])[]
        | select(.pullRequest.number != $p.number)
        | select($p.mergeQueueEntry == null or .position < $p.mergeQueueEntry.position)
        | {pr: .pullRequest.number, headOid: .pullRequest.headRefOid, position, state, enqueuedAt}],
      queueAheadTruncated: ($p.mergeQueue.entries.pageInfo.hasNextPage // false),
      autoMerge: $p.autoMergeRequest,
      lastRemoval: (if $removal == null then null else
        {at: $removal.createdAt, reason: $removal.reason, actor: $removal.actor.login,
         byViewer: ($removal.actor.login == $viewer), beforeCommit: $removal.beforeCommit.oid} end),
      viewer: $viewer,
      mergeCommit: $p.mergeCommit.oid
    }
  end
JQ

probe() {
  local raw
  if ! raw=$(gh api graphql -f query="$QUERY" -f owner="$owner" -f name="$name" -F pr="$pr" 2>&1); then
    jq -cn --arg e "$raw" '{status: "ERROR", error: $e}'
    return 2
  fi
  # GraphQL returns branchProtectionRule as null to non-admin tokens; REST exposes the contexts to
  # anyone with read access. Only fetched when GraphQL came back empty.
  local rest_required=null base
  if printf '%s' "$raw" | jq -e '.data.repository.pullRequest.baseRef != null
      and .data.repository.pullRequest.baseRef.branchProtectionRule == null' >/dev/null 2>&1; then
    base=$(printf '%s' "$raw" | jq -r '.data.repository.pullRequest.baseRefName')
    rest_required=$(gh api "repos/$owner/$name/branches/$base" \
      --jq '[(.protection.required_status_checks.contexts // [])[]]' 2>/dev/null) || rest_required=null
    printf '%s' "$rest_required" | jq -e 'type == "array"' >/dev/null 2>&1 || rest_required=null
  fi
  local out
  if ! out=$(printf '%s' "$raw" | jq -c --arg since "$since" --argjson rest_required "$rest_required" "$JQ" 2>&1); then
    jq -cn --arg e "$out" '{status: "ERROR", error: ("unparseable response: " + $e)}'
    return 2
  fi
  printf '%s\n' "$out"
  local status
  status=$(printf '%s' "$out" | jq -r .status)
  if [ "$until_new_removal" -eq 1 ]; then
    case "$status" in
      ERROR) return 2 ;;
      MERGED | CLOSED) return 0 ;;
    esac
    if printf '%s' "$out" | jq -e --arg s "$removal_snapshot" \
      '.lastRemoval != null and .lastRemoval.at != $s and .status != "QUEUED" and .status != "QUEUE_FAILING"' >/dev/null; then
      return 0
    fi
    return 1
  fi
  if [ "$until_unqueued" -eq 1 ]; then
    case "$status" in
      QUEUED | QUEUE_FAILING) return 1 ;;
      ERROR) return 2 ;;
      *) return 0 ;;
    esac
  fi
  if [ "$ignore_queue_failures" -eq 1 ] && [ "$status" = QUEUE_FAILING ]; then
    return 1
  fi
  case "$status" in
    QUEUED | AUTO_MERGE_PENDING | CHECKS_PENDING | UNKNOWN) return 1 ;;
    ERROR) return 2 ;;
    *) return 0 ;;
  esac
}

[ "$delay" -gt 0 ] && sleep "$delay"
deadline=$(($(date +%s) + wait_s))
errors=0
while :; do
  out=$(probe)
  rc=$?
  if [ "$rc" -eq 2 ]; then
    errors=$((errors + 1))
  else
    errors=0
  fi
  # Inside a wait, ride out up to 3 consecutive API errors (network blips, 502s, rate limits).
  if [ "$rc" -eq 0 ] || [ "$(date +%s)" -ge "$deadline" ] || [ "$errors" -gt 3 ] \
    || { [ "$rc" -eq 2 ] && [ "$wait_s" -eq 0 ]; }; then
    printf '%s\n' "$out"
    exit "$rc"
  fi
  sleep "$interval"
done
