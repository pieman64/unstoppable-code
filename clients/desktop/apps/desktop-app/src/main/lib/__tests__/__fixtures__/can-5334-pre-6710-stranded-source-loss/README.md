# Pre-#6710 stranded source-loss fixture (CAN-5334 §4.3)

The on-disk state that a desktop at `e353a287bd`, before CAN-5158's source
admission (#6710), left after archiving a live worktree whose source repository
was gone. `w5-worktree-discard.test.ts` loads it to prove that the discard
handles a journal written by that older code.

## How it was generated

1. Extracted `e353a287bd`'s `apps/desktop-app/src`, `packages`, root Jest
   and TypeScript configuration and `scripts/lib` with `git archive` into a
   gitignored scratch directory, linked to the current `node_modules`.
2. Added a dump call to that revision's
   `w5-workspace-deletion-records.test.ts`, in the test "residual: with the
   source gone for good, archiving the live worktree first leaves a worktree
   journal that keeps refusing the deletion (characterization)". The dump
   records every file under the test directory: once right after the failed
   `archiveWorktree`, and once after the test's last assertion.
3. Ran only that test with that revision's Jest configuration. It passed, and
   both dumps were identical outside the commit-log database.
4. Converted the end-of-test dump into `fixture.json`. The only change to the
   file contents replaces the temporary test directory with `<FIXTURE_DIR>`.

## What it records

- `files`: the stranded journal, workspace `a`'s configuration and rows, the
  checkout's `.git` link, the live chat storage, and the staged container
  `archived-containers/one` (a `capturing` Git descriptor with no repositories,
  plus the copied chat payload). Binary files are base64.
- `layout`: every path in the dump. Entries marked `omitted` are not in
  `files`: app preferences, the commit-log database, and the shared fixture's
  other projects.

The journal records these steps, as observed:

| Phase                      | State     |
| -------------------------- | --------- |
| `live-state-teardown`      | `done`    |
| `retained-payload-capture` | `done`    |
| `git-capture`              | `pending` |

The journal state is `recovery-required`. The operation is `worktree-archive`,
and `ownedPaths` holds the checkout.

## Loading it

The test writes the files over its own layout, which is the same layout the
shared `createW5BoundaryFixture` builds. It also removes the source repository
and the checkout created in its `beforeEach`. Stat identities (the journal's
`directoryIdentity` stat part and `ownedPaths[].identity`) are rebound to the
directories the test creates, because inode numbers are host-specific. The
CAN-5024 incarnation token is kept as recorded.
