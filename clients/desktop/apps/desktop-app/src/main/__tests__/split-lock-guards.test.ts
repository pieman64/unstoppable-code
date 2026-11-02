/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
// Guard tests: each guarded chokepoint must refuse (typed SplitLockError) when
// its worktree is split-locked, and pass through the guard when unlocked OR
// when a DIFFERENT worktree is locked. The split-lock-service itself is REAL
// so lock state is authoritative; the downstream of each guard is mocked to a
// trivial/known outcome so "passed the guard" is observable.

jest.mock('../lib/validation', () => ({
  validateId: jest.fn(),
  validateOptionalRepoId: jest.fn(),
  validatePipelineDefinitionLocator: jest.fn(),
}));

// --- runScript / stopWorktreeScripts (scripts-service) deps ---
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(() =>
    Promise.resolve({ scriptTimeoutMinutes: 5 }),
  ),
}));
jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn(() => Promise.resolve({ items: [] })),
}));
jest.mock('../lib/script-runner', () => ({
  isTrackedShellScriptRunning: jest.fn(() => false),
  listTrackedShellScriptsForWorktree: jest.fn(() => []),
  runShellScript: jest.fn(),
  stopTrackedShellScript: jest.fn(),
}));

// --- runHookCommand (hooks-service) deps ---
jest.mock('../lib/hook-resolver', () => ({
  collectProjectHookLayers: jest.fn(),
  collectWorkspaceRepoHookLayers: jest.fn(),
  collectWorkspaceRootHookLayers: jest.fn(),
  getResolvedHookActions: jest.fn(() => []),
  resolveProjectHooks: jest.fn(() => Promise.resolve({})),
  resolveWorkspaceRepoHooks: jest.fn(() => Promise.resolve({})),
  resolveWorkspaceRootHooks: jest.fn(() => Promise.resolve({})),
}));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: jest.fn(() =>
    Promise.resolve({ type: 'single-repo', repoPath: '/repo', hooks: {} }),
  ),
  writeWorkspaceConfig: jest.fn(),
}));

// --- runPipeline (pipelines-service) deps ---
jest.mock('../pipelines/project-pipeline-discovery', () => ({
  discoverProjectPipelines: jest.fn(() => Promise.resolve([])),
  loadProjectPipelineFromDisk: jest.fn(),
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PortalServiceError } from '../services/portal-service-error';
import { SplitLockError } from '../services/split-lock-service';
import {
  acquireSplitLock,
  releaseSplitLock,
} from '../services/split-lock-service';

describe('split lock chokepoint guards', () => {
  const WS = 'ws-guard';
  const WT = 'wt-guard';
  const OTHER_WT = 'wt-other';

  afterEach(() => {
    releaseSplitLock(WS, WT);
    releaseSplitLock(WS, OTHER_WT);
    jest.clearAllMocks();
  });

  describe('runScript (scripts-service)', () => {
    it('refuses with SplitLockError when the worktree is locked', async () => {
      const { runScript } = await import('../services/scripts-service');
      acquireSplitLock(WS, WT);
      await expect(
        runScript({
          target: 'project',
          projectId: WS,
          worktreeId: WT,
          scriptName: 'setup',
        } as any),
      ).rejects.toBeInstanceOf(SplitLockError);
    });

    it('passes the guard when unlocked (no lock error)', async () => {
      const { runScript } = await import('../services/scripts-service');
      // Downstream (project lookup on an empty sidebar) rejects with a
      // non-lock PortalServiceError, proving the guard was passed.
      await expect(
        runScript({
          target: 'project',
          projectId: WS,
          worktreeId: WT,
          scriptName: 'setup',
        } as any),
      ).rejects.not.toBeInstanceOf(SplitLockError);
    });

    it('passes the guard when a DIFFERENT worktree is locked', async () => {
      const { runScript } = await import('../services/scripts-service');
      acquireSplitLock(WS, OTHER_WT);
      await expect(
        runScript({
          target: 'project',
          projectId: WS,
          worktreeId: WT,
          scriptName: 'setup',
        } as any),
      ).rejects.not.toBeInstanceOf(SplitLockError);
    });
  });

  describe('runHookCommand (hooks-service)', () => {
    it('refuses with SplitLockError when the worktree is locked', async () => {
      const { runHookCommand } = await import('../services/hooks-service');
      acquireSplitLock(WS, WT);
      await expect(
        runHookCommand({
          target: 'project',
          projectId: WS,
          worktreeId: WT,
          triggerName: 'pr-review',
        } as any),
      ).rejects.toBeInstanceOf(SplitLockError);
    });

    it('passes the guard when unlocked (reaches NOOP, no lock error)', async () => {
      const { runHookCommand } = await import('../services/hooks-service');
      // No resolved actions -> NOOP_SUCCESS, proving the guard was passed.
      const result = await runHookCommand({
        target: 'project',
        projectId: WS,
        worktreeId: WT,
        triggerName: 'pr-review',
      } as any);
      expect(result.success).toBe(true);
    });

    it('passes the guard when a DIFFERENT worktree is locked', async () => {
      const { runHookCommand } = await import('../services/hooks-service');
      acquireSplitLock(WS, OTHER_WT);
      const result = await runHookCommand({
        target: 'project',
        projectId: WS,
        worktreeId: WT,
        triggerName: 'pr-review',
      } as any);
      expect(result.success).toBe(true);
    });
  });

  describe('runPipeline (pipelines-service)', () => {
    async function callRunPipeline(worktreeId: string): Promise<unknown> {
      const { runPipeline } = await import('../services/pipelines-service');
      return runPipeline({
        pipelineId: 'p1',
        projectId: WS,
        worktreeId,
        cwd: '/repo',
      });
    }

    it('refuses with SplitLockError when the worktree is locked', async () => {
      acquireSplitLock(WS, WT);
      await expect(callRunPipeline(WT)).rejects.toBeInstanceOf(SplitLockError);
    });

    it('passes the guard when unlocked (reaches not_found, no lock error)', async () => {
      // Empty discovered pipelines -> PortalServiceError not_found, proving
      // the guard was passed.
      await expect(callRunPipeline(WT)).rejects.toBeInstanceOf(
        PortalServiceError,
      );
      await expect(callRunPipeline(WT)).rejects.not.toBeInstanceOf(
        SplitLockError,
      );
    });

    it('passes the guard when a DIFFERENT worktree is locked', async () => {
      acquireSplitLock(WS, OTHER_WT);
      await expect(callRunPipeline(WT)).rejects.not.toBeInstanceOf(
        SplitLockError,
      );
    });
  });

  describe('split engine does not block its own child-worktree setup', () => {
    it('a locked PARENT worktree does not refuse a child-worktree script run', async () => {
      const { runScript } = await import('../services/scripts-service');
      // The split executor creates child worktrees with NEW worktreeIds
      // (see buildDefaultSplitterDeps.createWorktree -> createSingleRepoWorktree,
      // which returns response.id). Guards are keyed on the LOCKED parent
      // worktreeId, so a child run keyed on a different worktreeId is not
      // refused even though the parent is locked.
      acquireSplitLock(WS, WT);
      // The child run keyed on a different worktreeId must NOT be refused by
      // the parent's lock (it reaches downstream, which rejects for unrelated
      // reasons in this isolated test — never a SplitLockError).
      await expect(
        runScript({
          target: 'project',
          projectId: WS,
          worktreeId: 'child-wt-1',
          scriptName: 'setup',
        } as any),
      ).rejects.not.toBeInstanceOf(SplitLockError);
      releaseSplitLock(WS, WT);
    });

    it('the setup wrapper runs scripts directly, NOT through the guarded runScript seam', () => {
      // The post-create setup wrapper calls `runShellScript` from
      // script-runner (the low-level runner), never scripts-service.runScript
      // (the guarded chokepoint). If this import edge is ever added, the guard
      // WOULD block the split engine's own child setup and this must be caught.
      const source = readFileSync(
        join(__dirname, '..', 'lib', 'project-worktree-runtime.ts'),
        'utf8',
      );
      expect(source).toContain("from './script-runner'");
      expect(source).not.toContain('scripts-service');
    });
  });
});
