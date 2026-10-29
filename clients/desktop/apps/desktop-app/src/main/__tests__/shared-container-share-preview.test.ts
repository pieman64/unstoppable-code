import type {
  SharedContainerPreviewRequest,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';
import { getCoworkManagedSubdir } from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  link,
  mkdir,
  mkdtemp,
  rm,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  buildSharedContainerSharePreview,
  listSharedContainerUntrackedCandidatePaths,
  type SharedContainerPreviewDependencies,
} from '../shared-containers/share-preview';
import { getCoworkWorkspaceRootDir } from '../lib/paths';
import { getWorktreeAttachmentsDir } from '../lib/paths';
import {
  resolveChatTabsFilePath,
  resolveTrackedPlansFilePath,
  resolveWorktreeCwd,
} from '../lib/resolve-worktree';
import { registerWorkspaceTypes } from '../lib/workspace-registry';
import type { SessionDiagnosticRecord } from '../observability/service';
import {
  ChatStateService,
  getChatStateService,
  resetChatStateServiceForTests,
} from '../services/chat-state-service';
import {
  MAX_SHARED_CONTAINER_ARTIFACT_BYTES,
  MAX_SHARED_CONTAINER_REVISION_BYTES,
} from '@canopy/protocol/shared-containers';

const execFileAsync = promisify(execFile);

const request: SharedContainerPreviewRequest = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  organizationId: 'org-1',
  containerType: 'CODE_WORKTREE',
};

/**
 * Drains and retires the chat state service, then deletes the data dir it
 * writes to. Call only during teardown.
 */
async function removeDataDir(dataDir: string): Promise<void> {
  try {
    await getChatStateService().drain();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

describe('shared-container share preview', () => {
  // The default service records storage diagnostics through the process
  // observability service, which writes under CANOPY_DATA_DIR asynchronously,
  // racing the temp data dir's removal and the env var's restoration.
  const recordDiagnostic = jest.fn<void, [SessionDiagnosticRecord]>();
  beforeEach(() => {
    recordDiagnostic.mockClear();
    resetChatStateServiceForTests(new ChatStateService({ recordDiagnostic }));
  });
  afterEach(() => resetChatStateServiceForTests());
  it('ignores overlong chat strings while listing Cowork file candidates', async () => {
    const originalDataDir = process.env.CANOPY_DATA_DIR;
    const dataDir = await mkdtemp(join(tmpdir(), 'cowork-preview-long-chat-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    const projectId = 'cowork-long-chat-project';
    const worktreeId = 'entry-1';
    registerWorkspaceTypes(new Map([[projectId, 'cowork']]));
    try {
      const root = getCoworkWorkspaceRootDir(projectId);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'hello.md'), 'hello\n');
      const chatTabsPath = resolveChatTabsFilePath(projectId, worktreeId);
      await mkdir(dirname(chatTabsPath), { recursive: true });
      await writeFile(
        chatTabsPath,
        JSON.stringify({
          version: 1,
          activeTabId: 'chat-1',
          tabs: [
            {
              id: 'chat-1',
              title: 'Chat',
              createdAt: 'now',
              messages: [
                {
                  id: 'long-message',
                  role: 'user',
                  timestamp: 1,
                  blocks: [{ type: 'text', text: 'x'.repeat(300) }],
                },
              ],
            },
          ],
        }),
      );

      await expect(
        buildSharedContainerSharePreview({
          projectId,
          worktreeId,
          organizationId: 'org-1',
          containerType: 'COWORK_WORK_ENTRY',
        }),
      ).resolves.toMatchObject({
        untrackedCandidates: ['hello.md'],
        untrackedCandidateCount: 1,
      });
    } finally {
      registerWorkspaceTypes(new Map());
      if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = originalDataDir;
      await removeDataDir(dataDir);
    }
  });

  it('normalizes decomposed Cowork candidate paths to NFC for scope matching', async () => {
    const originalDataDir = process.env.CANOPY_DATA_DIR;
    const dataDir = await mkdtemp(join(tmpdir(), 'cowork-preview-unicode-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    const projectId = 'cowork-unicode-preview-project';
    const worktreeId = 'entry-1';
    const nfdPath = 'cafe\u0301.txt';
    const nfcPath = 'caf\u00e9.txt';
    registerWorkspaceTypes(new Map([[projectId, 'cowork']]));
    try {
      const root = getCoworkWorkspaceRootDir(projectId);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, nfdPath), 'evidence\n');

      await expect(
        buildSharedContainerSharePreview({
          projectId,
          worktreeId,
          organizationId: 'org-1',
          containerType: 'COWORK_WORK_ENTRY',
        }),
      ).resolves.toMatchObject({
        untrackedCandidates: [nfcPath],
        defaultIncludedFilePaths: [nfcPath],
      });
    } finally {
      registerWorkspaceTypes(new Map());
      if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = originalDataDir;
      await removeDataDir(dataDir);
    }
  });

  it('includes mode-only tracked changes in the preview budget', async () => {
    const originalDataDir = process.env.CANOPY_DATA_DIR;
    const dataDir = await mkdtemp(join(tmpdir(), 'code-preview-mode-only-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    const projectId = 'preview-mode-only-project';
    const worktreeId = 'worktree-1';
    try {
      const worktreeRoot = resolveWorktreeCwd(projectId, worktreeId);
      await mkdir(worktreeRoot, { recursive: true });
      await execFileAsync('git', ['init'], { cwd: worktreeRoot });
      await execFileAsync('git', ['config', 'user.name', 'Test'], {
        cwd: worktreeRoot,
      });
      await execFileAsync(
        'git',
        ['config', 'user.email', 'test@example.test'],
        { cwd: worktreeRoot },
      );
      await writeFile(join(worktreeRoot, 'script.sh'), '#!/bin/sh\n');
      await execFileAsync('git', ['add', 'script.sh'], { cwd: worktreeRoot });
      await execFileAsync('git', ['commit', '-m', 'fixture'], {
        cwd: worktreeRoot,
      });
      await execFileAsync(
        'git',
        ['remote', 'add', 'origin', 'https://github.com/example/repo.git'],
        { cwd: worktreeRoot },
      );
      await execFileAsync('chmod', ['+x', 'script.sh'], { cwd: worktreeRoot });

      await expect(
        buildSharedContainerSharePreview({
          projectId,
          worktreeId,
          organizationId: 'org-1',
          containerType: 'CODE_WORKTREE',
        }),
      ).resolves.toMatchObject({
        dirtyFileCount: 1,
        artifactBudget: { used: 3, limit: 200 },
      });
    } finally {
      if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = originalDataDir;
      await removeDataDir(dataDir);
    }
  }, 15_000);

  it.each(['legacy', 'migrated'] as const)(
    'counts only referenced content-distinct code attachments from %s storage',
    async (storage) => {
      const originalDataDir = process.env.CANOPY_DATA_DIR;
      const dataDir = await mkdtemp(
        join(tmpdir(), 'code-preview-attachments-'),
      );
      process.env.CANOPY_DATA_DIR = dataDir;
      const projectId = 'preview-code-attachments-project';
      const worktreeId = 'worktree-1';
      try {
        const worktreeRoot = resolveWorktreeCwd(projectId, worktreeId);
        await mkdir(worktreeRoot, { recursive: true });
        await execFileAsync('git', ['init'], { cwd: worktreeRoot });
        await execFileAsync('git', ['config', 'user.name', 'Test'], {
          cwd: worktreeRoot,
        });
        await execFileAsync(
          'git',
          ['config', 'user.email', 'test@example.test'],
          { cwd: worktreeRoot },
        );
        await writeFile(join(worktreeRoot, 'README.md'), 'fixture\n');
        await execFileAsync('git', ['add', '.'], { cwd: worktreeRoot });
        await execFileAsync('git', ['commit', '-m', 'fixture'], {
          cwd: worktreeRoot,
        });
        await execFileAsync(
          'git',
          ['remote', 'add', 'origin', 'https://github.com/example/repo.git'],
          { cwd: worktreeRoot },
        );
        const attachmentDir = getWorktreeAttachmentsDir(projectId, worktreeId);
        const first = join(attachmentDir, 'first.txt');
        const duplicate = join(attachmentDir, 'duplicate.txt');
        await mkdir(attachmentDir, { recursive: true });
        await writeFile(first, 'same bytes');
        await writeFile(duplicate, 'same bytes');
        await writeFile(join(attachmentDir, 'unreferenced.txt'), 'other bytes');
        const chatTabsPath = resolveChatTabsFilePath(projectId, worktreeId);
        await mkdir(dirname(chatTabsPath), { recursive: true });
        await writeFile(
          chatTabsPath,
          JSON.stringify({
            version: 1,
            activeTabId: 'chat-1',
            tabs: [
              {
                id: 'chat-1',
                title: 'Chat',
                createdAt: 'now',
                messages: [
                  {
                    id: 'message-1',
                    role: 'user',
                    timestamp: 1,
                    blocks: [],
                    attachmentPaths: [first, duplicate],
                  },
                ],
              },
            ],
          }),
        );

        if (storage === 'migrated') {
          await getChatStateService().getCompatibilityTabs({
            projectId,
            worktreeId,
          });
        }

        await expect(
          buildSharedContainerSharePreview({
            projectId,
            worktreeId,
            organizationId: 'org-1',
            containerType: 'CODE_WORKTREE',
          }),
        ).resolves.toMatchObject({
          chatCount: 1,
          attachmentCount: 1,
          artifactBudget: { used: 4, limit: 200 },
        });
      } finally {
        if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
        else process.env.CANOPY_DATA_DIR = originalDataDir;
        await removeDataDir(dataDir);
      }
    },
    15_000,
  );

  it('excludes hidden plans from the preview and artifact budget', async () => {
    const originalDataDir = process.env.CANOPY_DATA_DIR;
    const dataDir = await mkdtemp(join(tmpdir(), 'code-preview-hidden-plans-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    const projectId = 'preview-hidden-plans-project';
    const worktreeId = 'worktree-1';
    try {
      const worktreeRoot = resolveWorktreeCwd(projectId, worktreeId);
      await mkdir(worktreeRoot, { recursive: true });
      await execFileAsync('git', ['init'], { cwd: worktreeRoot });
      await execFileAsync('git', ['config', 'user.name', 'Test'], {
        cwd: worktreeRoot,
      });
      await execFileAsync(
        'git',
        ['config', 'user.email', 'test@example.test'],
        {
          cwd: worktreeRoot,
        },
      );
      await writeFile(join(worktreeRoot, 'README.md'), 'fixture\n');
      await execFileAsync('git', ['add', '.'], { cwd: worktreeRoot });
      await execFileAsync('git', ['commit', '-m', 'fixture'], {
        cwd: worktreeRoot,
      });
      await execFileAsync(
        'git',
        ['remote', 'add', 'origin', 'https://github.com/example/repo.git'],
        { cwd: worktreeRoot },
      );
      const plansPath = resolveTrackedPlansFilePath(projectId, worktreeId);
      await mkdir(dirname(plansPath), { recursive: true });
      const timestamp = '2026-01-01T00:00:00.000Z';
      const plan = (id: string, hidden: boolean): TrackedPlanData => ({
        id,
        projectId,
        worktreeId,
        source: 'claude',
        title: id,
        content: id,
        reviewStatus: 'pending',
        createdAt: timestamp,
        updatedAt: timestamp,
        latestRevisionNumber: 1,
        revisions: [
          {
            revisionNumber: 1,
            content: id,
            source: 'claude',
            reviewStatus: 'pending',
            createdAt: timestamp,
          },
        ],
        linkedExecutionIds: [],
        hidden,
      });
      await writeFile(
        plansPath,
        JSON.stringify({
          version: 1,
          plans: [plan('visible-plan', false), plan('hidden-plan', true)],
        }),
      );

      await expect(
        buildSharedContainerSharePreview({
          projectId,
          worktreeId,
          organizationId: 'org-1',
          containerType: 'CODE_WORKTREE',
        }),
      ).resolves.toMatchObject({
        planCount: 1,
        artifactBudget: { used: 3, limit: 200 },
      });
      // Guards the isolation in beforeEach: storage diagnostics must reach the
      // injected sink, not the process observability service.
      expect(recordDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'chat_storage_diagnostic', projectId }),
      );
    } finally {
      if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = originalDataDir;
      await removeDataDir(dataDir);
    }
  }, 15_000);

  it.each(['legacy', 'migrated'] as const)(
    "counts only this Cowork entry's referenced managed attachments from %s storage",
    async (storage) => {
      const originalDataDir = process.env.CANOPY_DATA_DIR;
      const dataDir = await mkdtemp(
        join(tmpdir(), 'cowork-preview-attachments-'),
      );
      process.env.CANOPY_DATA_DIR = dataDir;
      const projectId = 'cowork-preview-project';
      const worktreeId = 'entry-1';
      registerWorkspaceTypes(new Map([[projectId, 'cowork']]));
      try {
        const attachmentDir = getCoworkManagedSubdir(
          getCoworkWorkspaceRootDir(projectId),
          'attachments',
        );
        const referencedPath = join(attachmentDir, 'referenced.png');
        await mkdir(attachmentDir, { recursive: true });
        await writeFile(referencedPath, 'referenced');
        await writeFile(join(attachmentDir, 'sibling-entry.png'), 'sibling');
        const chatTabsPath = resolveChatTabsFilePath(projectId, worktreeId);
        await mkdir(dirname(chatTabsPath), { recursive: true });
        await writeFile(
          chatTabsPath,
          JSON.stringify({
            version: 1,
            activeTabId: 'chat-1',
            tabs: [
              {
                id: 'chat-1',
                title: 'Chat',
                createdAt: 'now',
                messages: [
                  {
                    id: 'message-1',
                    role: 'user',
                    timestamp: 1,
                    blocks: [],
                    attachmentPaths: [referencedPath],
                  },
                ],
              },
            ],
          }),
          'utf8',
        );

        if (storage === 'migrated')
          await getChatStateService().getCompatibilityTabs({
            projectId,
            worktreeId,
          });

        await expect(
          buildSharedContainerSharePreview({
            projectId,
            worktreeId,
            organizationId: 'org-1',
            containerType: 'COWORK_WORK_ENTRY',
          }),
        ).resolves.toMatchObject({ attachmentCount: 1 });
      } finally {
        registerWorkspaceTypes(new Map());
        if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
        else process.env.CANOPY_DATA_DIR = originalDataDir;
        await removeDataDir(dataDir);
      }
    },
    15_000,
  );

  it.each(['legacy', 'migrated'] as const)(
    'keeps a referenced Cowork file ahead of an earlier traversal cutoff in %s storage',
    async (storage) => {
      const originalDataDir = process.env.CANOPY_DATA_DIR;
      const dataDir = await mkdtemp(join(tmpdir(), 'cowork-preview-ranking-'));
      process.env.CANOPY_DATA_DIR = dataDir;
      const projectId = 'cowork-preview-ranking-project';
      const worktreeId = 'entry-1';
      registerWorkspaceTypes(new Map([[projectId, 'cowork']]));
      try {
        const root = getCoworkWorkspaceRootDir(projectId);
        const fillerDir = join(root, 'a-fillers');
        const referencedPath = join(root, 'z-referenced', 'latest.txt');
        await mkdir(fillerDir, { recursive: true });
        for (let offset = 0; offset < 1_000; offset += 100) {
          await Promise.all(
            Array.from({ length: 100 }, (_, index) =>
              writeFile(
                join(
                  fillerDir,
                  `${String(offset + index).padStart(4, '0')}.txt`,
                ),
                'filler',
              ),
            ),
          );
        }
        await mkdir(dirname(referencedPath), { recursive: true });
        await writeFile(referencedPath, 'referenced');
        await utimes(referencedPath, 1, 1);
        const chatTabsPath = resolveChatTabsFilePath(projectId, worktreeId);
        await mkdir(dirname(chatTabsPath), { recursive: true });
        await writeFile(
          chatTabsPath,
          JSON.stringify({
            version: 1,
            activeTabId: 'chat-1',
            tabs: [
              {
                id: 'chat-1',
                title: 'Chat',
                createdAt: 'now',
                messages: [
                  {
                    id: 'reference',
                    role: 'user',
                    timestamp: 1,
                    blocks: [],
                    attachmentPaths: [referencedPath],
                  },
                ],
              },
            ],
          }),
          'utf8',
        );

        if (storage === 'migrated')
          await getChatStateService().getCompatibilityTabs({
            projectId,
            worktreeId,
          });

        const preview = await buildSharedContainerSharePreview({
          projectId,
          worktreeId,
          organizationId: 'org-1',
          containerType: 'COWORK_WORK_ENTRY',
        });

        expect(preview.untrackedCandidates[0]).toBe('z-referenced/latest.txt');
      } finally {
        registerWorkspaceTypes(new Map());
        if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
        else process.env.CANOPY_DATA_DIR = originalDataDir;
        await removeDataDir(dataDir);
      }
    },
    60_000,
  );

  it('collects intended scope without publishing content', async () => {
    const resolveRepositories = jest.fn(() =>
      Promise.resolve([
        {
          repoId: 'workspace-root',
          repoName: 'Workspace root',
          repoPath: '/tmp/worktree-1',
          relativePrefix: '',
        },
      ]),
    );
    const getRemoteUrl = jest.fn(() =>
      Promise.resolve('https://github.com/example/repo.git'),
    );
    const resolvePushedBase = jest.fn(() =>
      Promise.resolve({
        baseSha: 'b'.repeat(40),
        headSha: 'a'.repeat(40),
        unpushedCommitCount: 2,
      }),
    );
    const deps: SharedContainerPreviewDependencies = {
      countChats: () => Promise.resolve(3),
      countPlans: () => Promise.resolve(2),
      countAttachments: () => Promise.resolve(1),
      resolveRepositories,
      getRemoteUrl,
      getHeadCommitSha: () => Promise.resolve('abc123'),
      getChangedFiles: (_path, baseCommitSha) => {
        expect(baseCommitSha).toBe('b'.repeat(40));
        return Promise.resolve([{ path: 'src/a.ts' }, { path: 'src/b.ts' }]);
      },
      listUntrackedFiles: () => Promise.resolve(['private.txt', 'new.txt']),
      readApprovedFileScope: () =>
        Promise.resolve({
          includedPaths: ['legacy-ignored.txt'],
          legacyAllowlist: true,
          excludedPaths: ['private.txt'],
        }),
      resolvePushedBase,
    };
    await expect(
      buildSharedContainerSharePreview(
        {
          ...request,
          worktreePath: '/tmp/attacker-controlled',
        } as SharedContainerPreviewRequest,
        deps,
      ),
    ).resolves.toEqual({
      containerType: 'CODE_WORKTREE',
      chatCount: 3,
      planCount: 2,
      attachmentCount: 1,
      noteCount: 0,
      promptCount: 0,
      notes: [],
      prompts: [],
      startPage: null,
      repository: {
        remoteUrl: 'https://github.com/example/repo.git',
        baseCommitSha: 'b'.repeat(40),
      },
      dirtyFileCount: 2,
      untrackedCandidates: ['new.txt', 'private.txt'],
      untrackedCandidateCount: 2,
      approvedFileScope: {
        includedPaths: ['legacy-ignored.txt'],
        legacyAllowlist: true,
        excludedPaths: ['private.txt'],
      },
      defaultIncludedFilePaths: ['new.txt'],
      artifactBudget: { used: 10, limit: 200 },
      unpushedCommitCount: 2,
      undisclosedRepositoryCount: 0,
    });
    expect(resolveRepositories).toHaveBeenCalledWith('project-1', 'worktree-1');
    expect(getRemoteUrl).toHaveBeenCalledWith('/tmp/worktree-1');
    // A preview never waits on the remote for its default branch.
    expect(resolvePushedBase).toHaveBeenCalledWith(
      expect.objectContaining({ allowRemoteLookup: false }),
    );
  });

  it('ranks referenced worktree files first and caps default inclusion', async () => {
    const preview = await buildSharedContainerSharePreview(request, {
      countChats: () => Promise.resolve(198),
      countPlans: () => Promise.resolve(0),
      countAttachments: () => Promise.resolve(0),
      resolveRepositories: () =>
        Promise.resolve([
          {
            repoId: 'repo-1',
            repoName: 'Repo',
            repoPath: '/tmp/repo-1',
            relativePrefix: '',
          },
        ]),
      getRemoteUrl: () =>
        Promise.resolve('https://github.com/example/repo.git'),
      getHeadCommitSha: () => Promise.resolve('a'.repeat(40)),
      getChangedFiles: () => Promise.resolve([]),
      listUntrackedFiles: () => Promise.resolve(['a.txt', 'z.txt']),
      readApprovedFileScope: () => Promise.resolve({ includedPaths: [] }),
      listReferencedPaths: () => Promise.resolve(['/tmp/repo-1/z.txt']),
      resolvePushedBase: () =>
        Promise.resolve({
          baseSha: 'a'.repeat(40),
          headSha: 'a'.repeat(40),
          unpushedCommitCount: 0,
        }),
    });

    expect(preview.defaultIncludedFilePaths).toEqual(['z.txt']);
    expect(preview.untrackedCandidates).toEqual(['z.txt', 'a.txt']);
    expect(preview.artifactBudget).toEqual({ used: 200, limit: 200 });
  });

  it('caps default worktree files after non-file revision bytes', async () => {
    const deps: SharedContainerPreviewDependencies & {
      measureCodeRevisionBaseBytes: () => Promise<number>;
    } = {
      countChats: () => Promise.resolve(0),
      countPlans: () => Promise.resolve(0),
      countAttachments: () => Promise.resolve(0),
      resolveRepositories: () =>
        Promise.resolve([
          {
            repoId: 'repo-1',
            repoName: 'Repo',
            repoPath: '/tmp/repo-1',
            relativePrefix: '',
          },
        ]),
      getRemoteUrl: () =>
        Promise.resolve('https://github.com/example/repo.git'),
      getHeadCommitSha: () => Promise.resolve('a'.repeat(40)),
      getChangedFiles: () => Promise.resolve([]),
      listUntrackedFiles: () => Promise.resolve(['optional.txt']),
      inspectFile: () =>
        Promise.resolve({
          isRegularFile: true,
          hardLinked: false,
          sizeBytes: 1,
        }),
      readApprovedFileScope: () => Promise.resolve({ includedPaths: [] }),
      measureCodeRevisionBaseBytes: () =>
        Promise.resolve(MAX_SHARED_CONTAINER_REVISION_BYTES - 1),
      resolvePushedBase: () =>
        Promise.resolve({
          baseSha: 'a'.repeat(40),
          headSha: 'a'.repeat(40),
          unpushedCommitCount: 0,
        }),
    };

    const preview = await buildSharedContainerSharePreview(request, deps);

    expect(preview.untrackedCandidates).toEqual(['optional.txt']);
    expect(preview.defaultIncludedFilePaths).toEqual([]);
  });

  it('reports non-GitHub repositories as snapshot shares', async () => {
    const snapshotChunk = Buffer.from('snapshot');
    const deps: SharedContainerPreviewDependencies = {
      countChats: () => Promise.resolve(0),
      countPlans: () => Promise.resolve(0),
      countAttachments: () => Promise.resolve(0),
      resolveRepositories: () =>
        Promise.resolve([
          {
            repoId: 'workspace-root',
            repoName: 'Workspace root',
            repoPath: '/tmp/worktree-1',
            relativePrefix: '',
          },
        ]),
      getRemoteUrl: () => Promise.resolve('https://gitlab.com/acme/repo.git'),
      getHeadCommitSha: () => Promise.resolve('abc123'),
      getChangedFiles: () => Promise.resolve([{ path: 'src/a.ts' }]),
      listUntrackedFiles: () => Promise.resolve(['new.txt']),
      readApprovedFileScope: () => Promise.resolve({ includedPaths: [] }),
      buildSnapshot: () =>
        Promise.resolve({
          baseCommitSha: 'b'.repeat(40),
          chunks: [
            {
              hash: createHash('sha256').update(snapshotChunk).digest('hex'),
              sizeBytes: snapshotChunk.byteLength,
            },
          ],
          treeFileCount: 1,
          treeBytes: BigInt(8),
          treeFileSizes: new Map([['src/a.ts', BigInt(8)]]),
          withheldPaths: ['.env.local'],
          withheldReasons: { '.env.local': 'credential-shaped' },
        }),
    };

    const preview = await buildSharedContainerSharePreview(request, deps);
    expect(preview.repository).toBeUndefined();
    expect(preview.repositories).toBeUndefined();
    expect(preview).toMatchObject({
      undisclosedRepositoryCount: 0,
      snapshotRepositoryCount: 1,
      snapshotBytes: snapshotChunk.byteLength,
      snapshotRepositoryNames: ['Workspace root'],
      withheldFileCount: 1,
      withheldFilePaths: ['.env.local'],
      dirtyFileCount: 1,
      untrackedCandidateCount: 1,
      artifactBudget: { used: 4, limit: 200 },
    });
  });

  it('does not offer unborn snapshot contents as optional untracked files', async () => {
    const deps: SharedContainerPreviewDependencies = {
      countChats: () => Promise.resolve(0),
      countPlans: () => Promise.resolve(0),
      countAttachments: () => Promise.resolve(0),
      resolveRepositories: () =>
        Promise.resolve([
          {
            repoId: 'workspace-root',
            repoName: 'Workspace root',
            repoPath: '/tmp/unborn-worktree',
            relativePrefix: '',
          },
        ]),
      getRemoteUrl: () => Promise.resolve(null),
      getHeadCommitSha: () => Promise.resolve(null),
      getChangedFiles: () => Promise.resolve([]),
      listUntrackedFiles: () => Promise.resolve(['included-in-snapshot.txt']),
      readApprovedFileScope: () =>
        Promise.resolve({ includedPaths: ['included-in-snapshot.txt'] }),
      buildSnapshot: () =>
        Promise.resolve({
          baseCommitSha: 'b'.repeat(40),
          chunks: [],
          treeFileCount: 1,
          treeBytes: BigInt(20),
          treeFileSizes: new Map([['included-in-snapshot.txt', BigInt(20)]]),
          withheldPaths: [],
        }),
    };

    await expect(
      buildSharedContainerSharePreview(request, deps),
    ).resolves.toMatchObject({
      snapshotRepositoryCount: 1,
      snapshotRepositoryNames: ['Workspace root'],
      untrackedCandidates: [],
      untrackedCandidateCount: 0,
      approvedFileScope: { includedPaths: [] },
    });
  });

  it('carries the preferred layout state to the dialog without the snapshot', async () => {
    const preferredLayout = {
      enabled: true,
      pinnedAt: '2026-10-13T00:00:00.000Z',
    };
    const deps: SharedContainerPreviewDependencies = {
      countChats: () => Promise.resolve(0),
      countPlans: () => Promise.resolve(0),
      countAttachments: () => Promise.resolve(0),
      resolveRepositories: () =>
        Promise.resolve([
          {
            repoId: 'workspace-root',
            repoName: 'Workspace root',
            repoPath: '/tmp/unborn-worktree',
            relativePrefix: '',
          },
        ]),
      getRemoteUrl: () => Promise.resolve(null),
      getHeadCommitSha: () => Promise.resolve(null),
      getChangedFiles: () => Promise.resolve([]),
      listUntrackedFiles: () => Promise.resolve([]),
      readApprovedFileScope: () =>
        Promise.resolve({ includedPaths: [], preferredLayout }),
      buildSnapshot: () =>
        Promise.resolve({
          baseCommitSha: 'b'.repeat(40),
          chunks: [],
          treeFileCount: 0,
          treeBytes: BigInt(0),
          treeFileSizes: new Map(),
          withheldPaths: [],
        }),
    };

    const preview = await buildSharedContainerSharePreview(request, deps);

    expect(preview.approvedFileScope.preferredLayout).toEqual(preferredLayout);
  });

  it('excludes withheld changes and deletions from the artifact budget', async () => {
    const deps: SharedContainerPreviewDependencies = {
      countChats: () => Promise.resolve(0),
      countPlans: () => Promise.resolve(0),
      countAttachments: () => Promise.resolve(0),
      resolveRepositories: () =>
        Promise.resolve([
          {
            repoId: 'workspace-root',
            repoName: 'Workspace root',
            repoPath: '/tmp/worktree-1',
            relativePrefix: '',
          },
        ]),
      getRemoteUrl: () =>
        Promise.resolve('https://github.com/example/repo.git'),
      getHeadCommitSha: () => Promise.resolve('abc123'),
      getChangedFiles: () =>
        Promise.resolve([
          { path: '.env.production', status: 'modified' },
          { path: 'obsolete.ts', status: 'deleted' },
          { path: 'src/live.ts', status: 'modified' },
          { path: 'src/local-link', status: 'modified' },
          { path: 'src/escaping-link', status: 'modified' },
        ]),
      listUntrackedFiles: () => Promise.resolve([]),
      inspectFile: (_repoPath, path) =>
        Promise.resolve(
          path.endsWith('link')
            ? {
                isRegularFile: false,
                isSymbolicLink: true,
                symlinkTarget: path.includes('escaping')
                  ? '../../outside'
                  : 'live.ts',
                hardLinked: false,
                sizeBytes: 8,
              }
            : {
                isRegularFile: true,
                hardLinked: false,
                sizeBytes: 8,
              },
        ),
      readApprovedFileScope: () => Promise.resolve({ includedPaths: [] }),
    };

    await expect(
      buildSharedContainerSharePreview(request, deps),
    ).resolves.toMatchObject({
      dirtyFileCount: 3,
      withheldFileCount: 2,
      withheldSymlinkPaths: ['src/escaping-link'],
      artifactBudget: { used: 3, limit: 200 },
    });
  });

  it('names an unchanged escaping symlink from the base commit', async () => {
    const deps: SharedContainerPreviewDependencies = {
      countChats: () => Promise.resolve(0),
      countPlans: () => Promise.resolve(0),
      countAttachments: () => Promise.resolve(0),
      resolveRepositories: () =>
        Promise.resolve([
          {
            repoId: 'workspace-root',
            repoName: 'Workspace root',
            repoPath: '/tmp/worktree-1',
            relativePrefix: '',
          },
        ]),
      getRemoteUrl: () =>
        Promise.resolve('https://github.com/example/repo.git'),
      getHeadCommitSha: () => Promise.resolve('abc123'),
      getChangedFiles: () => Promise.resolve([]),
      listUntrackedFiles: () => Promise.resolve([]),
      inspectTreeEntries: () =>
        Promise.resolve([
          {
            mode: '120000',
            type: 'blob' as const,
            objectId: 'a'.repeat(40),
            path: 'src/escaping-link',
            symlinkTarget: '../../outside',
            symlinkEscapesRepository: true,
          },
        ]),
      readApprovedFileScope: () => Promise.resolve({ includedPaths: [] }),
    };

    await expect(
      buildSharedContainerSharePreview(request, deps),
    ).resolves.toMatchObject({
      dirtyFileCount: 0,
      withheldFileCount: 1,
      withheldSymlinkPaths: ['src/escaping-link'],
      artifactBudget: { used: 1, limit: 200 },
    });
  });

  it('withholds an unchanged oversized in-repository symlink from the base commit', async () => {
    const deps: SharedContainerPreviewDependencies = {
      countChats: () => Promise.resolve(0),
      countPlans: () => Promise.resolve(0),
      countAttachments: () => Promise.resolve(0),
      resolveRepositories: () =>
        Promise.resolve([
          {
            repoId: 'workspace-root',
            repoName: 'Workspace root',
            repoPath: '/tmp/worktree-1',
            relativePrefix: '',
          },
        ]),
      getRemoteUrl: () =>
        Promise.resolve('https://github.com/example/repo.git'),
      getHeadCommitSha: () => Promise.resolve('abc123'),
      getChangedFiles: () => Promise.resolve([]),
      listUntrackedFiles: () => Promise.resolve([]),
      inspectTreeEntries: () =>
        Promise.resolve([
          {
            mode: '120000',
            type: 'blob' as const,
            objectId: 'a'.repeat(40),
            path: 'oversized-link',
            symlinkTarget: `${'nested/'.repeat(10_000)}target.ts`,
            symlinkEscapesRepository: false,
          },
        ]),
      readApprovedFileScope: () => Promise.resolve({ includedPaths: [] }),
    };

    const preview = await buildSharedContainerSharePreview(request, deps);

    expect(preview).toMatchObject({
      dirtyFileCount: 0,
      withheldFileCount: 1,
      artifactBudget: { used: 1, limit: 200 },
    });
    expect(preview.withheldSymlinkPaths).toBeUndefined();
  });

  it('does not double-count an escaping base symlink changed in the working tree', async () => {
    const deps: SharedContainerPreviewDependencies = {
      countChats: () => Promise.resolve(0),
      countPlans: () => Promise.resolve(0),
      countAttachments: () => Promise.resolve(0),
      resolveRepositories: () =>
        Promise.resolve([
          {
            repoId: 'workspace-root',
            repoName: 'Workspace root',
            repoPath: '/tmp/worktree-1',
            relativePrefix: '',
          },
        ]),
      getRemoteUrl: () =>
        Promise.resolve('https://github.com/example/repo.git'),
      getHeadCommitSha: () => Promise.resolve('abc123'),
      getChangedFiles: () =>
        Promise.resolve([{ path: 'src/escaping-link', status: 'modified' }]),
      listUntrackedFiles: () => Promise.resolve([]),
      inspectTreeEntries: () =>
        Promise.resolve([
          {
            mode: '120000',
            type: 'blob' as const,
            objectId: 'a'.repeat(40),
            path: 'src/escaping-link',
            symlinkTarget: '../../old-outside',
            symlinkEscapesRepository: true,
          },
        ]),
      inspectFile: () =>
        Promise.resolve({
          isRegularFile: false,
          isSymbolicLink: true,
          symlinkTarget: '../../new-outside',
          hardLinked: false,
          sizeBytes: 17,
        }),
      readApprovedFileScope: () => Promise.resolve({ includedPaths: [] }),
    };

    await expect(
      buildSharedContainerSharePreview(request, deps),
    ).resolves.toMatchObject({
      dirtyFileCount: 0,
      withheldFileCount: 1,
      withheldSymlinkPaths: ['src/escaping-link'],
      artifactBudget: { used: 1, limit: 200 },
    });
  });

  it('does not withhold a safe symlink only because it has multiple links', async () => {
    const deps: SharedContainerPreviewDependencies = {
      countChats: () => Promise.resolve(0),
      countPlans: () => Promise.resolve(0),
      countAttachments: () => Promise.resolve(0),
      resolveRepositories: () =>
        Promise.resolve([
          {
            repoId: 'workspace-root',
            repoName: 'Workspace root',
            repoPath: '/tmp/worktree-1',
            relativePrefix: '',
          },
        ]),
      getRemoteUrl: () =>
        Promise.resolve('https://github.com/example/repo.git'),
      getHeadCommitSha: () => Promise.resolve('abc123'),
      getChangedFiles: () =>
        Promise.resolve([{ path: 'src/local-link', status: 'modified' }]),
      listUntrackedFiles: () => Promise.resolve([]),
      inspectFile: () =>
        Promise.resolve({
          isRegularFile: false,
          isSymbolicLink: true,
          symlinkTarget: 'target.ts',
          hardLinked: true,
          sizeBytes: 9,
        }),
      readApprovedFileScope: () => Promise.resolve({ includedPaths: [] }),
    };

    const preview = await buildSharedContainerSharePreview(request, deps);

    expect(preview).toMatchObject({
      dirtyFileCount: 1,
      artifactBudget: { used: 2, limit: 200 },
    });
    expect(preview.withheldFileCount).toBeUndefined();
  });

  it('classifies approved untracked symlinks in preview accounting and disclosure', async () => {
    const deps: SharedContainerPreviewDependencies = {
      countChats: () => Promise.resolve(0),
      countPlans: () => Promise.resolve(0),
      countAttachments: () => Promise.resolve(0),
      resolveRepositories: () =>
        Promise.resolve([
          {
            repoId: 'workspace-root',
            repoName: 'Workspace root',
            repoPath: '/tmp/worktree-1',
            relativePrefix: '',
          },
        ]),
      getRemoteUrl: () =>
        Promise.resolve('https://github.com/example/repo.git'),
      getHeadCommitSha: () => Promise.resolve('abc123'),
      getChangedFiles: () => Promise.resolve([]),
      listUntrackedFiles: () =>
        Promise.resolve(['approved-link', 'approved-escaping-link']),
      inspectFile: (_repoPath, path) =>
        Promise.resolve({
          isRegularFile: false,
          isSymbolicLink: true,
          symlinkTarget:
            path === 'approved-link' ? 'src/target.ts' : '../outside',
          hardLinked: false,
          sizeBytes: 13,
        }),
      readApprovedFileScope: () =>
        Promise.resolve({
          includedPaths: ['approved-link', 'approved-escaping-link'],
        }),
    };

    await expect(
      buildSharedContainerSharePreview(request, deps),
    ).resolves.toMatchObject({
      dirtyFileCount: 0,
      withheldFileCount: 1,
      withheldSymlinkPaths: ['approved-escaping-link'],
      artifactBudget: { used: 2, limit: 200 },
    });
  });

  it('withholds multiply linked tracked files from preview accounting', async () => {
    const deps: SharedContainerPreviewDependencies = {
      countChats: () => Promise.resolve(0),
      countPlans: () => Promise.resolve(0),
      countAttachments: () => Promise.resolve(0),
      resolveRepositories: () =>
        Promise.resolve([
          {
            repoId: 'workspace-root',
            repoName: 'Workspace root',
            repoPath: '/tmp/worktree-1',
            relativePrefix: '',
          },
        ]),
      getRemoteUrl: () =>
        Promise.resolve('https://github.com/example/repo.git'),
      getHeadCommitSha: () => Promise.resolve('abc123'),
      getChangedFiles: () =>
        Promise.resolve([{ path: 'src/hardlinked.ts', status: 'modified' }]),
      listUntrackedFiles: () => Promise.resolve([]),
      inspectFile: () =>
        Promise.resolve({
          isRegularFile: true,
          hardLinked: true,
          sizeBytes: 12,
        }),
      readApprovedFileScope: () => Promise.resolve({ includedPaths: [] }),
    };

    await expect(
      buildSharedContainerSharePreview(request, deps),
    ).resolves.toMatchObject({
      dirtyFileCount: 0,
      withheldFileCount: 1,
      artifactBudget: { used: 1, limit: 200 },
    });
  });

  it('returns Cowork file candidates and selectable workspace-wide items without plans', async () => {
    const deps: SharedContainerPreviewDependencies = {
      countChats: () => Promise.resolve(2),
      countPlans: () => Promise.resolve(9),
      countAttachments: () => Promise.resolve(1),
      resolveRepositories: () => Promise.resolve([]),
      getRemoteUrl: () => Promise.resolve(null),
      getHeadCommitSha: () => Promise.resolve(null),
      getChangedFiles: () => Promise.resolve([]),
      listUntrackedFiles: () => Promise.resolve([]),
      readApprovedFileScope: () =>
        Promise.resolve({
          includedPaths: ['evidence/approved.txt'],
          includedNoteIds: ['note-1'],
          includedPromptIds: [],
        }),
      listWorkspaceItems: () =>
        Promise.resolve({
          notes: [{ id: 'note-1', title: 'Selected note' }],
          prompts: [{ id: 'prompt-1', title: 'Available prompt' }],
        }),
      listCoworkCandidateFiles: () =>
        Promise.resolve(['evidence/approved.txt', 'draft.md']),
    };

    await expect(
      buildSharedContainerSharePreview(
        { ...request, containerType: 'COWORK_WORK_ENTRY' },
        deps,
      ),
    ).resolves.toEqual({
      containerType: 'COWORK_WORK_ENTRY',
      chatCount: 2,
      planCount: 0,
      attachmentCount: 1,
      noteCount: 1,
      promptCount: 1,
      notes: [{ id: 'note-1', title: 'Selected note' }],
      prompts: [{ id: 'prompt-1', title: 'Available prompt' }],
      startPage: null,
      dirtyFileCount: 0,
      untrackedCandidates: ['evidence/approved.txt', 'draft.md'],
      untrackedCandidateCount: 2,
      defaultIncludedFilePaths: ['evidence/approved.txt'],
      approvedFileScope: {
        includedPaths: ['evidence/approved.txt'],
        includedNoteIds: ['note-1'],
        includedPromptIds: [],
      },
      // container.json, 2 chats, 1 attachment, the selected note, and the
      // approved file. The unselected prompt is never published, so it is not
      // charged to the budget.
      artifactBudget: { used: 7, limit: 200 },
    });
  });

  it('describes included, withheld, and URL start pages', async () => {
    const deps: SharedContainerPreviewDependencies = {
      countChats: () => Promise.resolve(0),
      countPlans: () => Promise.resolve(0),
      countAttachments: () => Promise.resolve(0),
      resolveRepositories: () => Promise.resolve([]),
      getRemoteUrl: () => Promise.resolve(null),
      getHeadCommitSha: () => Promise.resolve(null),
      getChangedFiles: () => Promise.resolve([]),
      listUntrackedFiles: () => Promise.resolve([]),
      readApprovedFileScope: () =>
        Promise.resolve({ includedPaths: [], excludedPaths: [] }),
      listCoworkCandidateFiles: () => Promise.resolve(['README.md']),
      resolveStartPage: () =>
        Promise.resolve({
          startPage: { kind: 'file', path: 'README.md' },
          source: 'cowork',
        }),
    };
    const coworkRequest = {
      ...request,
      containerType: 'COWORK_WORK_ENTRY' as const,
    };

    await expect(
      buildSharedContainerSharePreview(coworkRequest, deps),
    ).resolves.toMatchObject({
      startPage: { label: 'README.md', status: 'included' },
    });
    await expect(
      buildSharedContainerSharePreview(coworkRequest, {
        ...deps,
        readApprovedFileScope: () =>
          Promise.resolve({
            includedPaths: [],
            excludedPaths: ['README.md'],
          }),
      }),
    ).resolves.toMatchObject({
      startPage: { label: 'README.md', status: 'withheld' },
    });
    await expect(
      buildSharedContainerSharePreview(coworkRequest, {
        ...deps,
        resolveStartPage: () =>
          Promise.resolve({
            startPage: { kind: 'url', url: 'https://example.test/docs' },
            source: 'cowork',
          }),
      }),
    ).resolves.toMatchObject({
      startPage: { label: 'https://example.test/docs', status: 'url' },
    });
    await expect(
      buildSharedContainerSharePreview(request, {
        ...deps,
        resolveRepositories: () =>
          Promise.resolve([
            {
              repoId: 'workspace-root',
              repoName: 'Workspace root',
              repoPath: '/tmp/worktree-1',
              relativePrefix: '',
            },
          ]),
        getRemoteUrl: () =>
          Promise.resolve('https://github.com/example/repo.git'),
        getHeadCommitSha: () => Promise.resolve('abc123'),
        getChangedFiles: () =>
          Promise.resolve([{ path: 'README.md', status: 'deleted' }]),
        resolveStartPage: () =>
          Promise.resolve({
            startPage: { kind: 'file', path: 'README.md' },
            source: 'local',
          }),
      }),
    ).resolves.toMatchObject({
      startPage: { label: 'README.md', status: 'withheld' },
    });
  });

  it('includes safe Cowork candidates by default, honors exclusions, and caps files to the remaining artifact budget', async () => {
    const deps: SharedContainerPreviewDependencies = {
      countChats: () => Promise.resolve(198),
      countPlans: () => Promise.resolve(0),
      countAttachments: () => Promise.resolve(0),
      resolveRepositories: () => Promise.resolve([]),
      getRemoteUrl: () => Promise.resolve(null),
      getHeadCommitSha: () => Promise.resolve(null),
      getChangedFiles: () => Promise.resolve([]),
      listUntrackedFiles: () => Promise.resolve([]),
      readApprovedFileScope: () =>
        Promise.resolve({
          includedPaths: [],
          excludedPaths: ['excluded.md'],
        }),
      listCoworkCandidateFiles: () =>
        Promise.resolve({
          paths: ['first.md', 'excluded.md', 'past-budget.md'],
          withheldFileCount: 2,
        }),
    };

    await expect(
      buildSharedContainerSharePreview(
        { ...request, containerType: 'COWORK_WORK_ENTRY' },
        deps,
      ),
    ).resolves.toMatchObject({
      untrackedCandidateCount: 3,
      defaultIncludedFilePaths: ['first.md'],
      withheldFileCount: 2,
      artifactBudget: { used: 200, limit: 200 },
    });
  });

  it('shows a legacy Cowork allowlist exceeding the budget instead of truncating it', async () => {
    const deps: SharedContainerPreviewDependencies = {
      countChats: () => Promise.resolve(198),
      countPlans: () => Promise.resolve(0),
      countAttachments: () => Promise.resolve(0),
      resolveRepositories: () => Promise.resolve([]),
      getRemoteUrl: () => Promise.resolve(null),
      getHeadCommitSha: () => Promise.resolve(null),
      getChangedFiles: () => Promise.resolve([]),
      listUntrackedFiles: () => Promise.resolve([]),
      readApprovedFileScope: () =>
        Promise.resolve({
          includedPaths: ['first.md', 'over-budget.md'],
        }),
      listCoworkCandidateFiles: () =>
        Promise.resolve({
          paths: ['first.md', 'over-budget.md'],
          withheldFileCount: 0,
        }),
    };

    await expect(
      buildSharedContainerSharePreview(
        { ...request, containerType: 'COWORK_WORK_ENTRY' },
        deps,
      ),
    ).resolves.toMatchObject({
      defaultIncludedFilePaths: ['first.md', 'over-budget.md'],
      artifactBudget: { used: 201, limit: 200 },
    });
  });

  it('caps default Cowork files to the remaining revision byte budget', async () => {
    const paths = Array.from({ length: 20 }, (_, index) => `file-${index}.bin`);
    const deps: SharedContainerPreviewDependencies = {
      countChats: () => Promise.resolve(0),
      countPlans: () => Promise.resolve(0),
      countAttachments: () => Promise.resolve(0),
      resolveRepositories: () => Promise.resolve([]),
      getRemoteUrl: () => Promise.resolve(null),
      getHeadCommitSha: () => Promise.resolve(null),
      getChangedFiles: () => Promise.resolve([]),
      listUntrackedFiles: () => Promise.resolve([]),
      readApprovedFileScope: () =>
        Promise.resolve({ includedPaths: [], excludedPaths: [] }),
      measureCoworkRevisionBaseBytes: () => Promise.resolve(0),
      listCoworkCandidateFiles: () =>
        Promise.resolve({
          paths,
          sizeBytesByPath: Object.fromEntries(
            paths.map((path) => [path, MAX_SHARED_CONTAINER_ARTIFACT_BYTES]),
          ),
          withheldFileCount: 0,
        }),
    };

    const preview = await buildSharedContainerSharePreview(
      { ...request, containerType: 'COWORK_WORK_ENTRY' },
      deps,
    );

    expect(preview.defaultIncludedFilePaths).toEqual(paths.slice(0, 19));
    expect(preview.untrackedCandidateCount).toBe(20);
  });

  it('does not reserve 25 MiB for every tiny Cowork chat', async () => {
    const deps: SharedContainerPreviewDependencies = {
      countChats: () => Promise.resolve(19),
      countPlans: () => Promise.resolve(0),
      countAttachments: () => Promise.resolve(0),
      resolveRepositories: () => Promise.resolve([]),
      getRemoteUrl: () => Promise.resolve(null),
      getHeadCommitSha: () => Promise.resolve(null),
      getChangedFiles: () => Promise.resolve([]),
      listUntrackedFiles: () => Promise.resolve([]),
      readApprovedFileScope: () =>
        Promise.resolve({ includedPaths: [], excludedPaths: [] }),
      listCoworkCandidateFiles: () =>
        Promise.resolve({
          paths: ['evidence.txt'],
          sizeBytesByPath: { 'evidence.txt': 8 },
          withheldFileCount: 0,
        }),
    };

    const preview = await buildSharedContainerSharePreview(
      { ...request, containerType: 'COWORK_WORK_ENTRY' },
      deps,
    );

    expect(preview.defaultIncludedFilePaths).toEqual(['evidence.txt']);
  });

  it('withholds credential-shaped, oversized, colliding, and noisy Cowork paths', async () => {
    const originalDataDir = process.env.CANOPY_DATA_DIR;
    const dataDir = await mkdtemp(join(tmpdir(), 'cowork-preview-withheld-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    const projectId = 'cowork-withheld-project';
    const worktreeId = 'entry-1';
    registerWorkspaceTypes(new Map([[projectId, 'cowork']]));
    try {
      const root = getCoworkWorkspaceRootDir(projectId);
      await mkdir(join(root, 'chats'), { recursive: true });
      await mkdir(join(root, 'node_modules', 'package'), { recursive: true });
      await writeFile(join(root, 'hello.md'), 'hello\n');
      await writeFile(join(root, '.env'), 'TOKEN=secret\n');
      await writeFile(join(root, 'large.bin'), '');
      await truncate(
        join(root, 'large.bin'),
        MAX_SHARED_CONTAINER_ARTIFACT_BYTES + 1,
      );
      await writeFile(join(root, 'chats', 'collision.md'), 'collision\n');
      await writeFile(
        join(root, 'node_modules', 'package', 'index.js'),
        'noise\n',
      );
      const chatTabsPath = resolveChatTabsFilePath(projectId, worktreeId);
      await mkdir(dirname(chatTabsPath), { recursive: true });
      await writeFile(
        chatTabsPath,
        JSON.stringify({
          version: 1,
          activeTabId: 'chat-1',
          tabs: [
            {
              id: 'chat-1',
              title: 'Chat',
              createdAt: 'now',
              messages: [
                {
                  id: 'noise-reference',
                  role: 'user',
                  timestamp: 1,
                  blocks: [],
                  attachmentPaths: ['node_modules/package/index.js'],
                },
              ],
            },
          ],
        }),
        'utf8',
      );

      await expect(
        buildSharedContainerSharePreview({
          projectId,
          worktreeId,
          organizationId: 'org-1',
          containerType: 'COWORK_WORK_ENTRY',
        }),
      ).resolves.toMatchObject({
        untrackedCandidates: ['hello.md'],
        untrackedCandidateCount: 1,
        defaultIncludedFilePaths: ['hello.md'],
        withheldFileCount: 4,
      });
    } finally {
      registerWorkspaceTypes(new Map());
      if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = originalDataDir;
      await removeDataDir(dataDir);
    }
  }, 15_000);

  it('withholds hard-linked Cowork files from default inclusion', async () => {
    const originalDataDir = process.env.CANOPY_DATA_DIR;
    const dataDir = await mkdtemp(join(tmpdir(), 'cowork-preview-hardlink-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    const projectId = 'cowork-hardlink-project';
    const worktreeId = 'entry-1';
    registerWorkspaceTypes(new Map([[projectId, 'cowork']]));
    try {
      const root = getCoworkWorkspaceRootDir(projectId);
      const outsidePath = join(dataDir, 'outside-secret.txt');
      await mkdir(root, { recursive: true });
      await writeFile(outsidePath, 'secret\n');
      await link(outsidePath, join(root, 'innocent.txt'));
      await writeFile(join(root, 'safe.txt'), 'safe\n');

      await expect(
        buildSharedContainerSharePreview({
          projectId,
          worktreeId,
          organizationId: 'org-1',
          containerType: 'COWORK_WORK_ENTRY',
        }),
      ).resolves.toMatchObject({
        untrackedCandidates: ['safe.txt'],
        untrackedCandidateCount: 1,
        defaultIncludedFilePaths: ['safe.txt'],
        withheldFileCount: 1,
      });
    } finally {
      registerWorkspaceTypes(new Map());
      if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = originalDataDir;
      await removeDataDir(dataDir);
    }
  }, 15_000);

  it('bounds untracked-file details while preserving the total count', async () => {
    const untrackedFiles = Array.from(
      { length: 205 },
      (_, index) => `new-${String(index).padStart(3, '0')}.txt`,
    );
    const deps: SharedContainerPreviewDependencies = {
      countChats: () => Promise.resolve(0),
      countPlans: () => Promise.resolve(0),
      countAttachments: () => Promise.resolve(0),
      resolveRepositories: () =>
        Promise.resolve([
          {
            repoId: 'workspace-root',
            repoName: 'Workspace root',
            repoPath: '/tmp/worktree-1',
            relativePrefix: '',
          },
        ]),
      getRemoteUrl: () =>
        Promise.resolve('https://github.com/example/repo.git'),
      getHeadCommitSha: () => Promise.resolve('abc123'),
      getChangedFiles: () => Promise.resolve([]),
      listUntrackedFiles: () => Promise.resolve(untrackedFiles),
      readApprovedFileScope: () => Promise.resolve({ includedPaths: [] }),
    };

    const result = await buildSharedContainerSharePreview(request, deps);

    expect(result.untrackedCandidates).toHaveLength(200);
    expect(result).toMatchObject({ untrackedCandidateCount: 205 });
  });

  it('returns the complete untracked set for authoritative scope validation', async () => {
    const untrackedFiles = Array.from(
      { length: 205 },
      (_, index) => `new-${String(index).padStart(3, '0')}.txt`,
    );

    await expect(
      listSharedContainerUntrackedCandidatePaths('project-1', 'worktree-1', {
        resolveRepositories: () =>
          Promise.resolve([
            {
              repoId: 'workspace-root',
              repoName: 'Workspace root',
              repoPath: '/tmp/worktree-1',
              relativePrefix: '',
            },
          ]),
        listUntrackedFiles: () => Promise.resolve(untrackedFiles),
      }),
    ).resolves.toEqual(untrackedFiles);
  });

  it('limits concurrent repository probes while building a preview', async () => {
    let releaseProbes: (() => void) | undefined;
    const probeGate = new Promise<void>((resolve) => {
      releaseProbes = resolve;
    });
    let activeProbes = 0;
    let maximumActiveProbes = 0;
    const repositories = Array.from({ length: 8 }, (_, index) => ({
      repoId: `repo-${index}`,
      repoName: `Repo ${index}`,
      repoPath: `/tmp/worktree-1/repos/repo-${index}`,
      relativePrefix: `repos/repo-${index}`,
    }));
    const preview = buildSharedContainerSharePreview(request, {
      countChats: () => Promise.resolve(0),
      countPlans: () => Promise.resolve(0),
      countAttachments: () => Promise.resolve(0),
      resolveRepositories: () => Promise.resolve(repositories),
      getRemoteUrl: async () => {
        activeProbes += 1;
        maximumActiveProbes = Math.max(maximumActiveProbes, activeProbes);
        await probeGate;
        activeProbes -= 1;
        return 'https://github.com/acme/repo.git';
      },
      getHeadCommitSha: () => Promise.resolve('abc123'),
      getChangedFiles: () => Promise.resolve([]),
      listUntrackedFiles: () => Promise.resolve([]),
      readApprovedFileScope: () => Promise.resolve({ includedPaths: [] }),
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseProbes?.();

    await expect(preview).resolves.toBeDefined();
    expect(maximumActiveProbes).toBe(4);
  });

  it('limits concurrent repository probes during file-scope validation', async () => {
    let releaseProbes: (() => void) | undefined;
    const probeGate = new Promise<void>((resolve) => {
      releaseProbes = resolve;
    });
    let activeProbes = 0;
    let maximumActiveProbes = 0;
    const repositories = Array.from({ length: 8 }, (_, index) => ({
      repoId: `repo-${index}`,
      repoName: `Repo ${index}`,
      repoPath: `/tmp/worktree-1/repos/repo-${index}`,
      relativePrefix: `repos/repo-${index}`,
    }));
    const candidates = listSharedContainerUntrackedCandidatePaths(
      'project-1',
      'worktree-1',
      {
        resolveRepositories: () => Promise.resolve(repositories),
        listUntrackedFiles: async () => {
          activeProbes += 1;
          maximumActiveProbes = Math.max(maximumActiveProbes, activeProbes);
          await probeGate;
          activeProbes -= 1;
          return [];
        },
      },
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseProbes?.();

    await expect(candidates).resolves.toEqual([]);
    expect(maximumActiveProbes).toBe(4);
  });

  it('sanitizes credential-bearing repository remotes before disclosure', async () => {
    const deps: SharedContainerPreviewDependencies = {
      countChats: () => Promise.resolve(0),
      countPlans: () => Promise.resolve(0),
      countAttachments: () => Promise.resolve(0),
      resolveRepositories: () =>
        Promise.resolve([
          {
            repoId: 'workspace-root',
            repoName: 'Workspace root',
            repoPath: '/tmp/worktree-1',
            relativePrefix: '',
          },
        ]),
      getRemoteUrl: () =>
        Promise.resolve(
          'https://user:token@github.com/acme/repo.git?access_token=secret#credential',
        ),
      getHeadCommitSha: () => Promise.resolve('abc123'),
      getChangedFiles: () => Promise.resolve([]),
      listUntrackedFiles: () => Promise.resolve([]),
      readApprovedFileScope: () => Promise.resolve({ includedPaths: [] }),
    };

    await expect(
      buildSharedContainerSharePreview(request, deps),
    ).resolves.toMatchObject({
      repository: {
        remoteUrl: 'https://github.com/acme/repo.git',
        baseCommitSha: 'abc123',
      },
    });
  });

  it('does not count untracked candidates as tracked dirty files', async () => {
    const deps: SharedContainerPreviewDependencies = {
      countChats: () => Promise.resolve(0),
      countPlans: () => Promise.resolve(0),
      countAttachments: () => Promise.resolve(0),
      resolveRepositories: () =>
        Promise.resolve([
          {
            repoId: 'workspace-root',
            repoName: 'Workspace root',
            repoPath: '/tmp/worktree-1',
            relativePrefix: '',
          },
        ]),
      getRemoteUrl: () =>
        Promise.resolve('https://github.com/example/repo.git'),
      getHeadCommitSha: () => Promise.resolve('abc123'),
      getChangedFiles: () =>
        Promise.resolve([
          { path: 'src/tracked.ts', status: 'modified' },
          { path: 'new.txt', status: 'untracked' },
        ]),
      listUntrackedFiles: () => Promise.resolve(['new.txt']),
      readApprovedFileScope: () => Promise.resolve({ includedPaths: [] }),
    };

    await expect(
      buildSharedContainerSharePreview(request, deps),
    ).resolves.toMatchObject({
      dirtyFileCount: 1,
      untrackedCandidates: ['new.txt'],
      untrackedCandidateCount: 1,
    });
  });

  it('aggregates child repositories for a multi-repo worktree', async () => {
    const deps: SharedContainerPreviewDependencies = {
      countChats: () => Promise.resolve(0),
      countPlans: () => Promise.resolve(0),
      countAttachments: () => Promise.resolve(0),
      resolveRepositories: () =>
        Promise.resolve([
          {
            repoId: 'repo-a',
            repoName: 'Repo A',
            repoPath: '/tmp/worktree-1/repos/repo-a',
            relativePrefix: 'repos/repo-a',
          },
          {
            repoId: 'repo-b',
            repoName: 'Repo B',
            repoPath: '/tmp/worktree-1/repos/repo-b',
            relativePrefix: 'repos/repo-b',
          },
        ]),
      getRemoteUrl: (repoPath) => {
        const segments = repoPath.split('/');
        return Promise.resolve(
          `https://github.com/acme/${segments[segments.length - 1]}.git`,
        );
      },
      getHeadCommitSha: (repoPath) => Promise.resolve(`sha:${repoPath}`),
      getChangedFiles: (repoPath) =>
        Promise.resolve([{ path: `${repoPath}/changed.ts` }]),
      listUntrackedFiles: (repoPath) => {
        const segments = repoPath.split('/');
        return Promise.resolve([`${segments[segments.length - 1]}.txt`]);
      },
      readApprovedFileScope: () => Promise.resolve({ includedPaths: [] }),
    };

    await expect(
      buildSharedContainerSharePreview(request, deps),
    ).resolves.toMatchObject({
      repositories: [
        {
          repoId: 'repo-a',
          repoName: 'Repo A',
          remoteUrl: 'https://github.com/acme/repo-a.git',
        },
        {
          repoId: 'repo-b',
          repoName: 'Repo B',
          remoteUrl: 'https://github.com/acme/repo-b.git',
        },
      ],
      dirtyFileCount: 2,
      untrackedCandidates: [
        'repos/repo-a/repo-a.txt',
        'repos/repo-b/repo-b.txt',
      ],
      untrackedCandidateCount: 2,
    });
  });
  it('normalizes code-worktree candidates to NFC so approvals still match', async () => {
    // git reports the on-disk (NFD) form on macOS, while the approval store
    // persists NFC. Without normalizing here the modal renders an approved
    // file as unapproved and the artifact budget undercounts it.
    const nfd = 'cafe\u0301.txt';
    const nfc = 'caf\u00e9.txt';
    const deps: SharedContainerPreviewDependencies = {
      countChats: () => Promise.resolve(0),
      countPlans: () => Promise.resolve(0),
      countAttachments: () => Promise.resolve(0),
      resolveRepositories: () =>
        Promise.resolve([
          {
            repoId: 'workspace-root',
            repoName: 'Workspace root',
            repoPath: '/tmp/worktree-1',
            relativePrefix: '',
          },
        ]),
      getRemoteUrl: () =>
        Promise.resolve('https://github.com/example/repo.git'),
      getHeadCommitSha: () => Promise.resolve('abc123'),
      getChangedFiles: () => Promise.resolve([]),
      listUntrackedFiles: () => Promise.resolve([nfd]),
      readApprovedFileScope: () => Promise.resolve({ includedPaths: [nfc] }),
    };

    const preview = await buildSharedContainerSharePreview(request, deps);

    expect(preview.untrackedCandidates).toEqual([nfc]);
    // container.json plus the one approved untracked file.
    expect(preview.artifactBudget.used).toBe(2);
  });
});
