# GitHub PR Comment ID Types

GitHub uses different ID formats across its REST and GraphQL APIs. Understanding these is critical for PR comment operations.

## ID Types

| ID Type             | Format   | Example                 | Used For                                   |
| ------------------- | -------- | ----------------------- | ------------------------------------------ |
| **Database ID**     | Numeric  | `2737789739`            | REST API operations (replying to comments) |
| **Comment Node ID** | `PRRC_*` | `PRRC_kwDOQ82ISc6jL1sr` | GraphQL identification of comments         |
| **Thread Node ID**  | `PRRT_*` | `PRRT_kwDOQ82ISc5rfaZ6` | GraphQL operations (resolving threads)     |

## Common Mistake

The GraphQL `reviewThreads` query returns comment `id` fields that look like `PRRC_kwDOQ82ISc6jL1sr`. These are **GraphQL node IDs**, NOT database IDs.

**This will fail:**

```bash
# WRONG - Using GraphQL node ID with REST API
gh api repos/owner/repo/pulls/22/comments/PRRC_kwDOQ82ISc6jL1sr/replies -f body="Done"
# Result: 404 Not Found
```

**This will work:**

```bash
# CORRECT - Using database ID with REST API
gh api repos/owner/repo/pulls/22/comments/2737789739/replies -f body="Done"
```

## How to Get the Right IDs

### For Replying to Comments (REST API - needs Database ID)

Use the REST API to get comments with their numeric database IDs:

```bash
gh api repos/{owner}/{repo}/pulls/{pr}/comments --jq '.[] | {id, path, body}'
```

Response includes numeric `id` field:

```json
{
  "id": 2737789739,
  "path": "src/file.ts",
  "body": "Please fix this"
}
```

### For Resolving Threads (GraphQL - needs Thread Node ID)

Use the GraphQL API to get thread IDs (prefixed with `PRRT_`):

```bash
gh api graphql -f query='
query {
  repository(owner: "{owner}", name: "{repo}") {
    pullRequest(number: {pr}) {
      reviewThreads(first: 100) {
        nodes {
          id          # This is the PRRT_* thread ID for resolving
          isResolved
          comments(first: 1) {
            nodes {
              id      # This is PRRC_* - NOT useful for REST API
              body
            }
          }
        }
      }
    }
  }
}'
```

## Recommended Workflow

1. **Fetch comments via REST API** to get database IDs for replying:

   ```bash
   gh api repos/{owner}/{repo}/pulls/{pr}/comments
   ```

2. **Fetch threads via GraphQL** to get resolution status and thread IDs:

   ```bash
   gh api graphql -f query='...'
   ```

3. **Reply using REST API** with database ID:

   ```bash
   gh api repos/{owner}/{repo}/pulls/{pr}/comments/{database_id}/replies -f body="Addressed in abc1234"
   ```

4. **Resolve using GraphQL** with thread node ID:
   ```bash
   gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "PRRT_xyz"}) { thread { isResolved } } }'
   ```

## Matching Comments to Threads

To reply and resolve the same comment, you need to correlate:

- REST API comment (has database ID for replying)
- GraphQL thread (has thread ID for resolving)

Match them by `path` + `line` + `body` fields which appear in both API responses.
