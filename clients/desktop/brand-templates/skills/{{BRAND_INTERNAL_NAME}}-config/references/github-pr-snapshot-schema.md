# GitHub PR Snapshot Schema

Use this reference when authoring hooks or chat hook `if-command` gates that read `{{BRAND_ENV_PREFIX}}_PR_CURRENT_FILE` or `{{BRAND_ENV_PREFIX}}_PR_PREV_FILE`.

Both files use the same JSON schema. `{{BRAND_ENV_PREFIX}}_PR_PREV_FILE` is only present when a previous stored snapshot exists.

## Top-Level Shape

```json
{
  "version": 1,
  "provider": "github",
  "capturedAt": "2026-04-10T13:23:35.000Z",
  "includesComments": true,
  "includesReviews": true,
  "includesReviewComments": true,
  "repository": {
    "owner": "unstoppabledomains",
    "name": "{{BRAND_INTERNAL_NAME}}",
    "fullName": "example-org/{{BRAND_INTERNAL_NAME}}"
  },
  "branch": {
    "currentName": "feature/local-branch",
    "headRefName": "feature/pr-head-branch",
    "baseRefName": "main",
    "headSha": "abc123",
    "baseSha": "def456"
  },
  "pr": {
    "id": 123456789,
    "number": 320,
    "nodeId": "PR_kw...",
    "htmlUrl": "https://github.com/owner/repo/pull/320",
    "apiUrl": "https://api.github.com/repos/owner/repo/pulls/320",
    "state": "open",
    "isDraft": false,
    "title": "Add PR hook triggers",
    "body": "PR body",
    "author": {
      "login": "tirish",
      "id": 4465898,
      "nodeId": "MDQ6...",
      "htmlUrl": "https://github.com/tirish",
      "apiUrl": "https://api.github.com/users/tirish"
    },
    "createdAt": "2026-04-09T00:00:00.000Z",
    "updatedAt": "2026-04-10T13:23:35.000Z",
    "mergedAt": null,
    "closedAt": null,
    "mergeCommitSha": null,
    "mergedBy": null,
    "isCrossRepository": false,
    "labels": [],
    "assignees": [],
    "requestedReviewers": []
  },
  "issueComments": [],
  "reviews": [],
  "reviewComments": [],
  "checks": {
    "headSha": "abc123",
    "items": []
  },
  "mergeConflicts": {
    "hasConflicts": false,
    "mergeable": true,
    "mergeableState": "clean"
  }
}
```

## Key Fields

- `version`: currently always `1`
- `provider`: currently always `"github"`
- `capturedAt`: ISO timestamp for when {{BRAND_DISPLAY_NAME}} captured the snapshot
- `includesComments`, `includesReviews`, `includesReviewComments`: completeness flags for the three comment/review collections

## Repository And Branch

- `repository.owner`, `repository.name`, `repository.fullName`: GitHub repo identity for the actual PR
- `branch.currentName`: current local branch name in the worktree
- `branch.headRefName`: actual PR head branch name
- `branch.baseRefName`: actual PR base branch name
- `branch.headSha`: PR head commit SHA used for check lookup
- `branch.baseSha`: PR base commit SHA when GitHub provides it

For hook authors:

- `{{BRAND_ENV_PREFIX}}_PR_BRANCH` mirrors `branch.headRefName`
- `{{BRAND_ENV_PREFIX}}_PR_BASE_BRANCH` mirrors `branch.baseRefName`

## PR Object

`pr` contains the main PR metadata:

- identity: `id`, `number`, `nodeId`
- URLs: `htmlUrl`, `apiUrl`
- state: `state`, `isDraft`
- content: `title`, `body`
- timestamps: `createdAt`, `updatedAt`, `mergedAt`, `closedAt`
- merge metadata: `mergeCommitSha`, `mergedBy`
- repo topology: `isCrossRepository`
- participant collections: `labels`, `assignees`, `requestedReviewers`

`pr.state` is one of:

- `open`
- `draft`
- `closed`
- `merged`

## Comment And Review Collections

- `issueComments`: PR conversation comments
- `reviews`: submitted PR reviews
- `reviewComments`: inline review comments

Important:

- Treat these arrays as authoritative only when their matching completeness flag is `true`
- An empty array can mean either "none exist" or "fetch was incomplete and this collection was omitted"
- If you are comparing `current` versus `previous`, check the completeness flags first before assuming a missing item means it was deleted
- `pr:reviews:new` is derived from newly added submitted reviews, not just any new `reviews[].id`: reply-only review-thread comments can create new review ids in GitHub, so {{BRAND_DISPLAY_NAME}} only treats a new review as submitted when it has non-comment review state, non-empty review body, or at least one top-level inline review comment (`inReplyToId == null`)
- `pr:reviews:new:has-comments` is the stricter subset trigger: it only fires when a newly submitted review has at least one top-level inline review comment, so hooks can check `reviewComments[].pullRequestReviewId` and `inReplyToId == null` against the new review ids

## `checks`

`checks` may be absent in older snapshots, so hooks should read it defensively.

Shape:

```json
{
  "headSha": "abc123",
  "items": [
    {
      "id": 11,
      "name": "test",
      "appSlug": "github-actions",
      "appName": "GitHub Actions",
      "status": "passing",
      "rawStatus": "completed",
      "conclusion": "success",
      "detailsUrl": "https://github.com/owner/repo/actions/runs/123",
      "startedAt": "2026-04-10T13:00:00.000Z",
      "completedAt": "2026-04-10T13:02:00.000Z"
    }
  ]
}
```

Check item fields:

- `id`: GitHub check run id
- `name`: check name
- `appSlug`, `appName`: GitHub App identity when available
- `status`: normalized {{BRAND_DISPLAY_NAME}} status
- `rawStatus`: raw GitHub check run status
- `conclusion`: raw GitHub conclusion when completed
- `detailsUrl`: GitHub details page if available
- `startedAt`, `completedAt`: timestamps from GitHub when available

Normalized `status` values:

- `passing`
- `failing`
- `pending`
- `neutral`
- `none`

## `mergeConflicts`

`mergeConflicts` may be absent in older snapshots, so hooks should read it defensively.

Shape:

```json
{
  "hasConflicts": true,
  "mergeable": null,
  "mergeableState": "dirty"
}
```

Fields:

- `hasConflicts`: {{BRAND_DISPLAY_NAME}}’s derived boolean for whether the PR currently has merge conflicts
- `mergeable`: GitHub `mergeable` value, which may be `true`, `false`, or `null`
- `mergeableState`: GitHub `mergeable_state` string when available

## `mergeQueue`

Merge queue state is read for open and draft PRs. `mergeQueue` is absent in older snapshots and until the state is first read for the PR; treat a missing value as unknown, not as "not queued".

When a sample can't read the state of an open or draft PR, `mergeQueue` keeps the last known value, so its presence doesn't mean it was read on this sample. A closed or merged PR keeps its stored fields with an out-of-queue `membership`.

Shape:

```json
{
  "required": true,
  "membership": {
    "inQueue": true,
    "entryId": "MQE_kwDOABC",
    "phase": "awaiting_checks",
    "enqueuedAt": "2026-10-07T10:00:00.000Z",
    "position": 2
  },
  "lastRemoved": {
    "entryId": "MQE_kwDOXYZ",
    "removedAt": "2026-10-07T09:58:00.000Z",
    "reason": "failed_checks",
    "evidence": "timeline",
    "requeued": true,
    "observedAt": "2026-10-07T10:01:00.000Z"
  }
}
```

Fields:

- `required`: the base branch requires the merge queue
- `membership`: the PR's last known merge queue entry; `phase` is absent when the PR is not queued
- `lastEntered`: the entry last reported by `pr:queue:entered` (`entryId`, `enqueuedAt`, `phase`, `position`, `reentry`, `observedAt`)
- `lastRemoved`: the exit last reported by `pr:queue:removed`; `evidence` is `timeline` (GitHub's removal event), `entry_changed`, or `membership`, and `reason` is set only for `timeline`
- `cursor` and `pendingExit` are internal tracking state; do not depend on them

## Compatibility Notes For Hook Authors

- `{{BRAND_ENV_PREFIX}}_PR_CURRENT_FILE` should always exist for a hook run
- `{{BRAND_ENV_PREFIX}}_PR_PREV_FILE` may be missing on the first snapshot for a branch, after branch changes, or when no prior snapshot was stored
- `checks`, `mergeConflicts`, and `mergeQueue` are optional in the schema for backward compatibility; treat missing values as "unknown"
- If your hook compares `current` and `previous`, compare by stable ids where available (`pr.id`, label `id`, comment/review ids, check `id`)

## Practical `jq` Examples

Current failing check names:

```bash
jq -r '.checks.items[]? | select(.status == "failing") | .name' "${{BRAND_ENV_PREFIX}}_PR_CURRENT_FILE"
```

Current merge-conflict status:

```bash
jq '.mergeConflicts // { hasConflicts: false, mergeable: null, mergeableState: null }' "${{BRAND_ENV_PREFIX}}_PR_CURRENT_FILE"
```

Current versus previous labels:

```bash
jq -r '.pr.labels[]?.name' "${{BRAND_ENV_PREFIX}}_PR_CURRENT_FILE"
jq -r '.pr.labels[]?.name' "${{BRAND_ENV_PREFIX}}_PR_PREV_FILE"
```
