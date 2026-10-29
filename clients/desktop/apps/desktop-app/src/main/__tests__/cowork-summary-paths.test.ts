// Cowork worktree-summary path resolution: real cowork workspace ids resolve
// to `workspaces/{id}/summaries/home.json` (the workspace-typed branch), and
// the legacy standalone sentinel maps through the cowork-migration id
// resolver with the workspace id carried in `worktreeId` (mirroring
// resolveChatTabsFilePath). Uses a temp CANOPY_DATA_DIR and the real path
// helpers — no fs mocks.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  COWORK_HOME_WORKTREE_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { resolveWorktreeSummaryFilePath } from '../lib/resolve-worktree';
import { registerWorkspaceTypes } from '../lib/workspace-registry';

describe('resolveWorktreeSummaryFilePath (cowork)', () => {
  const originalCanopyDataDir = process.env.CANOPY_DATA_DIR;
  let tempDataDir = '';

  beforeEach(() => {
    tempDataDir = mkdtempSync(join(tmpdir(), 'canopy-cowork-summary-'));
    process.env.CANOPY_DATA_DIR = tempDataDir;
    registerWorkspaceTypes(new Map([['cowork-ws-1', 'cowork']]));
  });

  afterEach(() => {
    registerWorkspaceTypes(new Map());
    if (originalCanopyDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalCanopyDataDir;
    }
    rmSync(tempDataDir, { recursive: true, force: true });
  });

  it('resolves real cowork project ids to the project summaries path', () => {
    const filePath = resolveWorktreeSummaryFilePath(
      'cowork-ws-1',
      COWORK_HOME_WORKTREE_ID,
    );
    expect(filePath).toContain(
      ['workspaces', 'cowork-ws-1', 'summaries', 'home.json'].join(sep),
    );
  });

  it('maps the legacy standalone sentinel through the cowork id resolver', () => {
    // No migration map file exists in the temp data dir, so the resolver is
    // the identity function.
    const filePath = resolveWorktreeSummaryFilePath(
      STANDALONE_CHAT_PROJECT_ID,
      'cowork-ws-1',
    );
    expect(filePath).toContain(
      ['workspaces', 'cowork-ws-1', 'summaries', 'home.json'].join(sep),
    );
  });
});
