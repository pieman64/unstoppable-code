import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockGetCanonicalState = jest.fn();
const runArchiveIoRequestMock = jest.fn<Promise<unknown>, [unknown]>();

jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: (): {
    getCanonicalState: typeof mockGetCanonicalState;
  } => ({
    getCanonicalState: mockGetCanonicalState,
  }),
}));
jest.mock('../lib/claude-project-paths', () => ({
  resolveClaudeCodeSessionTranscriptPath: jest.fn(),
}));
jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(),
}));
jest.mock('../lib/paths', () => ({
  getArchivedContainerProviderSessionsDir: jest.fn(),
}));
jest.mock('../archive/archive-io-runner', () => ({
  runArchiveIoRequest: (...args: [unknown]): Promise<unknown> =>
    runArchiveIoRequestMock(...args),
}));

import { resolveClaudeCodeSessionTranscriptPath } from '../lib/claude-project-paths';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { getArchivedContainerProviderSessionsDir } from '../lib/paths';
import { captureArchivedContainerProviderState } from '../lib/archived-container-provider-state';
import { executeArchiveIoRequest } from '../archive/archive-io-engine';
import type { ArchiveIoOperationRequest } from '../archive/archive-io-protocol';

let rootDir: string;

describe('archived container provider capture', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    runArchiveIoRequestMock.mockImplementation(
      (request: ArchiveIoOperationRequest) =>
        executeArchiveIoRequest(request, new AbortController().signal, {
          progress: () => undefined,
          child: {
            started: () => undefined,
            exited: () => undefined,
          },
        }),
    );
    rootDir = await mkdtemp(join(tmpdir(), 'canopy-provider-archive-'));
    jest
      .mocked(getArchivedContainerProviderSessionsDir)
      .mockReturnValue(join(rootDir, 'captured'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it.each([false, true])(
    'resolves a Claude transcript from selected multi-repo metadata (unloaded=%s)',
    async (unloaded) => {
      const transcript = join(rootDir, 'claude-session.jsonl');
      await writeFile(transcript, '{"type":"user"}\n');
      jest
        .mocked(resolveWorktreeCwd)
        .mockReturnValue('/workspace/worktree/repos/repo-b');
      jest
        .mocked(resolveClaudeCodeSessionTranscriptPath)
        .mockResolvedValue(transcript);

      await expect(
        captureArchivedContainerProviderState({
          projectId: 'workspace-1',
          containerId: 'worktree-1',
          includeClaude: true,
          tabs: [
            {
              id: 'chat-1',
              title: 'Claude chat',
              createdAt: new Date().toISOString(),
              get messages(): [] {
                if (unloaded) throw new Error('Transcript was not selected');
                return [];
              },
              ...(unloaded
                ? {
                    transcript: {
                      format: 'complete-message-jsonl-v1' as const,
                      committedMessageCount: 3,
                      committedByteLength: 100,
                      transcriptRevision: 1,
                      hasActiveSidecar: false,
                      messageCount: 3,
                      lastMessageAt: Date.now(),
                    },
                  }
                : {}),
              providerType: 'claude',
              sdkSessionId: 'session-1',
              selectedRepoId: 'repo-b',
            },
          ],
        }),
      ).resolves.toEqual([]);

      expect(resolveWorktreeCwd).toHaveBeenCalledWith(
        'workspace-1',
        'worktree-1',
        'repo-b',
      );
      expect(resolveClaudeCodeSessionTranscriptPath).toHaveBeenCalledWith(
        'session-1',
        '/workspace/worktree/repos/repo-b',
      );
      await expect(
        readFile(
          join(rootDir, 'captured', 'claude', 'session-1.jsonl'),
          'utf8',
        ),
      ).resolves.toContain('"type":"user"');
    },
  );

  it('captures plugin-selected Codex rollouts from the canonical home', async () => {
    const codexHome = join(rootDir, 'canonical-codex-home');
    const rolloutDir = join(codexHome, 'sessions', '2026', '07', '22');
    await mkdir(rolloutDir, { recursive: true });
    await writeFile(
      join(rolloutDir, 'rollout-2026-session-codex.jsonl'),
      '{"type":"session_meta"}\n',
    );
    mockGetCanonicalState.mockResolvedValue({ codexHome });

    await expect(
      captureArchivedContainerProviderState({
        projectId: 'workspace-1',
        containerId: 'worktree-1',
        includeClaude: false,
        onlyPluginCodex: true,
        strictPluginCodexCopy: true,
        tabs: [
          {
            id: 'chat-codex',
            title: 'Codex chat',
            createdAt: new Date().toISOString(),
            messages: [],
            providerType: 'codex',
            sdkSessionId: 'session-codex',
            pluginSelections: {
              collectionIds: [],
              skillRefs: [],
              pluginRefs: [
                { marketplaceId: 'marketplace-1', pluginName: 'plugin-1' },
              ],
              mcpServerRefs: [],
            },
          },
        ],
      }),
    ).resolves.toEqual([]);

    expect(mockGetCanonicalState).toHaveBeenCalledTimes(1);
    await expect(
      readFile(
        join(
          rootDir,
          'captured',
          'codex',
          'chat-codex',
          'sessions',
          '2026',
          '07',
          '22',
          'rollout-2026-session-codex.jsonl',
        ),
        'utf8',
      ),
    ).resolves.toContain('session_meta');
  });

  it('captures Codex rollouts for an Ollama-backed Codex chat', async () => {
    const codexHome = join(rootDir, 'ollama-codex-home');
    const rolloutDir = join(codexHome, 'sessions');
    await mkdir(rolloutDir, { recursive: true });
    await writeFile(
      join(rolloutDir, 'rollout-session-ollama.jsonl'),
      '{"type":"session_meta"}\n',
    );
    mockGetCanonicalState.mockResolvedValue({ codexHome });

    await expect(
      captureArchivedContainerProviderState({
        projectId: 'workspace-1',
        containerId: 'worktree-1',
        includeClaude: false,
        tabs: [
          {
            id: 'chat-ollama',
            title: 'Ollama Codex chat',
            createdAt: new Date().toISOString(),
            messages: [],
            providerType: 'ollama',
            executionHarness: 'codex',
            sdkSessionId: 'session-ollama',
          },
        ],
      }),
    ).resolves.toEqual([]);

    expect(mockGetCanonicalState).toHaveBeenCalledTimes(1);
    await expect(
      readFile(
        join(
          rootDir,
          'captured',
          'codex',
          'chat-ollama',
          'sessions',
          'rollout-session-ollama.jsonl',
        ),
        'utf8',
      ),
    ).resolves.toContain('session_meta');
  });

  it('rejects a traversal chat id during strict Codex capture', async () => {
    const codexHome = join(rootDir, 'canonical-codex-home');
    const rolloutDir = join(codexHome, 'sessions');
    await mkdir(rolloutDir, { recursive: true });
    await writeFile(
      join(rolloutDir, 'rollout-session-codex.jsonl'),
      '{"type":"session_meta"}\n',
    );
    mockGetCanonicalState.mockResolvedValue({ codexHome });

    await expect(
      captureArchivedContainerProviderState({
        projectId: 'workspace-1',
        containerId: 'worktree-1',
        includeClaude: false,
        strictPluginCodexCopy: true,
        tabs: [
          {
            id: '../escape',
            title: 'Invalid Codex chat',
            createdAt: new Date().toISOString(),
            messages: [],
            providerType: 'codex',
            sdkSessionId: 'session-codex',
            pluginSelections: {
              collectionIds: [],
              skillRefs: [],
              pluginRefs: [
                { marketplaceId: 'marketplace-1', pluginName: 'plugin-1' },
              ],
              mcpServerRefs: [],
            },
          },
        ],
      }),
    ).rejects.toThrow('Invalid chatId');
  });
});
