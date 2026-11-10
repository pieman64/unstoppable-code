import { join } from 'node:path';
import type { W5CommitLogHost } from '@canopy/core-runtime/node/w5/commit-log-host';
import type { W5Resource } from '@canopy/core-runtime/node/w5/commit-log/commit-log';
import { fingerprintW5File } from '@canopy/core-runtime/node/w5/commit-log/fingerprint';
import { flush } from '@canopy/desktop-shared/node/internal-root-migration/filesystem';
import { validateW5Document } from './w5-backup';
import type { W5Diagnosis, W5FileIssue } from './w5-maintenance-diagnosis';

const METADATA_PATH = /^([A-Za-z0-9_-]+)\/(workspace|worktrees)\.json$/;

export function isToleratedInternalRootW5Issue(issue: W5FileIssue): boolean {
  return (
    issue.reason === 'untracked-file' ||
    (issue.reason === 'unknown-artifact' &&
      (issue.artifactKind === 'unrecognized-workspace-file' ||
        issue.artifactKind === 'unindexed-workspace-directory' ||
        issue.artifactKind === 'unrecognized-w5-file'))
  );
}

/** q-61: adopt legacy disk images, never restore a historical commit image. */
export async function adoptInternalRootW5Metadata(
  host: Pick<W5CommitLogHost, 'root' | 'capture' | 'commit'>,
  diagnosis: W5Diagnosis,
  assertHeld: () => Promise<void>,
  syncFile: (path: string) => Promise<void> = flush,
): Promise<void> {
  // Unresolved commits include their receipts; no reservation is safe to replay.
  if (
    diagnosis.logIssue ||
    diagnosis.commits.length ||
    diagnosis.reservations.length ||
    diagnosis.files.some(
      (issue) =>
        !isToleratedInternalRootW5Issue(issue) &&
        !(issue.reason === 'log-mismatch' && METADATA_PATH.test(issue.path)),
    )
  )
    return;
  for (const issue of diagnosis.files) {
    if (issue.reason !== 'log-mismatch') continue;
    const match = METADATA_PATH.exec(issue.path);
    const workspaceId = match?.[1];
    if (!workspaceId) throw new Error('Invalid adoption path');
    const kind = match[2] === 'workspace' ? 'manifest' : 'worktrees';
    await assertHeld();
    const capture = await host.capture({
      files: [{ kind, workspaceId }],
      discoverWorkspaces: false,
    });
    await assertHeld();
    const image = capture.files[0];
    if (
      capture.log.unresolvedCommits ||
      capture.files.length !== 1 ||
      !image ||
      image.kind !== kind ||
      !('workspaceId' in image) ||
      image.workspaceId !== workspaceId ||
      image.state !== 'present'
    )
      throw new Error(
        `W5 adoption requires a readable settled image: ${issue.path}`,
      );
    const bytes = Buffer.from(image.base64, 'base64');
    const document = validateW5Document(bytes, issue.path);
    const advance: W5Resource[] =
      kind === 'manifest'
        ? [{ kind: 'workspace', workspaceId }]
        : [{ kind: 'worktrees', workspaceId }];
    if (kind === 'worktrees') {
      const children = new Set<string>();
      const prefix = `worktree:${workspaceId}/`;
      for (const key of Object.keys(capture.log.revisions))
        if (key.startsWith(prefix)) children.add(key.slice(prefix.length));
      const rows: readonly unknown[] = Array.isArray(document.worktrees)
        ? document.worktrees
        : [];
      for (const row of rows)
        if (
          typeof row === 'object' &&
          row !== null &&
          'id' in row &&
          typeof row.id === 'string'
        )
          children.add(row.id);
      for (const worktreeId of children)
        advance.push({ kind: 'worktree', workspaceId, worktreeId });
    }
    const path = join(host.root, issue.path);
    const contents = bytes.toString('utf8');
    // An identical-image W5 commit treats this as a dependency and skips fsync.
    await syncFile(path);
    await assertHeld();
    const result = await host.commit({
      operation: 'internal-root-migration.adopt-legacy-metadata',
      advance,
      files: [
        { path, contents, previousFingerprint: fingerprintW5File(contents) },
      ],
      outcome: { adopted: issue.path },
    });
    await assertHeld();
    if (result.status !== 'applied')
      throw new Error(`W5 metadata adoption requires recovery: ${issue.path}`);
  }
}
