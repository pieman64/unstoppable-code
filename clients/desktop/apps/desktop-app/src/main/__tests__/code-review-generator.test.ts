import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const mockDisposeHelperInvocation = jest.fn();
jest.mock('@canopy/desktop-shared/lib/structured-helper-query', () => ({
  runClaudeStructuredHelperQuery: jest.fn(),
  runCodexStructuredHelperQuery: jest.fn(),
}));

jest.mock('../agents/claude-process-host-runner', () => ({
  spawnClaudeCodeProcessOffMain: jest.fn(),
}));

jest.mock('../ollama/helper-invocation', () => ({
  resolveHelperInvocation: jest.fn((model: string | undefined) =>
    Promise.resolve({
      providerType: 'claude',
      sdkModel: model,
      aiCreditsRouted: false,
      dispose: mockDisposeHelperInvocation,
    }),
  ),
}));

import {
  runClaudeStructuredHelperQuery,
  runCodexStructuredHelperQuery,
} from '@canopy/desktop-shared/lib/structured-helper-query';
import {
  generateReviewAnnotations,
  generateReviewDataModelDiff,
  generateReviewLogicDiff,
  sanitizeReviewAnnotations,
} from '../lib/code-review-generator';
import { spawnClaudeCodeProcessOffMain } from '../agents/claude-process-host-runner';
import {
  initClaudeModels,
  type ReviewAnnotationSet,
} from '@canopy/desktop-shared/types';

const repoDir = mkdtempSync(join(tmpdir(), 'code-review-generator-'));
const mockedRunClaudeStructuredHelperQuery = jest.mocked(
  runClaudeStructuredHelperQuery,
);
const mockedRunCodexStructuredHelperQuery = jest.mocked(
  runCodexStructuredHelperQuery,
);

initClaudeModels([{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }]);

beforeAll(() => {
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  writeFileSync(join(repoDir, 'src', 'a.ts'), 'one\ntwo\nthree\n');
});

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedRunClaudeStructuredHelperQuery.mockResolvedValue({
    value: null,
    usage: {},
  });
  mockedRunCodexStructuredHelperQuery.mockResolvedValue({
    value: null,
    usage: {},
  });
});

describe('code review diagram generation', () => {
  it('hosts Claude annotation generation off the main process', async () => {
    await generateReviewAnnotations({
      diffBundleText: 'diff',
      repoPath: '/repo',
      projectId: 'project-a',
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'medium',
    });

    expect(mockedRunClaudeStructuredHelperQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        spawnClaudeCodeProcess: spawnClaudeCodeProcessOffMain,
      }),
    );
    expect(mockDisposeHelperInvocation).toHaveBeenCalledTimes(1);
  });

  it('releases the helper route after a provider failure', async () => {
    mockedRunClaudeStructuredHelperQuery.mockRejectedValueOnce(
      new Error('provider failed'),
    );

    await expect(
      generateReviewAnnotations({
        diffBundleText: 'diff',
        repoPath: '/repo',
        projectId: 'project-a',
        model: 'claude-sonnet-4-6',
        thinkingLevel: 'medium',
      }),
    ).rejects.toThrow('provider failed');

    expect(mockDisposeHelperInvocation).toHaveBeenCalledTimes(1);
  });

  it('keeps the helper route through in-flight retry work and releases it afterward', async () => {
    let finishQuery:
      | ((value: { value: null; usage: Record<string, never> }) => void)
      | undefined;
    let markQueryStarted: (() => void) | undefined;
    const queryStarted = new Promise<void>((resolve) => {
      markQueryStarted = resolve;
    });
    mockedRunClaudeStructuredHelperQuery.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishQuery = resolve;
          markQueryStarted?.();
        }),
    );

    const generation = generateReviewAnnotations({
      diffBundleText: 'diff',
      repoPath: '/repo',
      projectId: 'project-a',
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'medium',
    });
    await queryStarted;
    expect(mockDisposeHelperInvocation).not.toHaveBeenCalled();

    finishQuery?.({ value: null, usage: {} });
    await generation;
    expect(mockDisposeHelperInvocation).toHaveBeenCalledTimes(1);
  });

  it('releases the helper route when generation is cancelled', async () => {
    const abortError = new Error('cancelled');
    abortError.name = 'AbortError';
    mockedRunClaudeStructuredHelperQuery.mockRejectedValueOnce(abortError);

    await expect(
      generateReviewAnnotations({
        diffBundleText: 'diff',
        repoPath: '/repo',
        projectId: 'project-a',
        model: 'claude-sonnet-4-6',
        thinkingLevel: 'medium',
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(mockDisposeHelperInvocation).toHaveBeenCalledTimes(1);
  });

  it('uses maxTurns 50 for Claude logic diff diagrams', async () => {
    await generateReviewLogicDiff({
      diffBundleText: 'diff',
      repoPath: '/repo',
      projectId: 'project-a',
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'medium',
    });

    expect(mockedRunClaudeStructuredHelperQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTurns: 50,
        spawnClaudeCodeProcess: spawnClaudeCodeProcessOffMain,
      }),
    );
  });

  it('uses maxTurns 50 for Claude data model diff diagrams', async () => {
    await generateReviewDataModelDiff({
      diffBundleText: 'diff',
      repoPath: '/repo',
      projectId: 'project-a',
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'medium',
    });

    expect(mockedRunClaudeStructuredHelperQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTurns: 50,
        spawnClaudeCodeProcess: spawnClaudeCodeProcessOffMain,
      }),
    );
  });
});

describe('sanitizeReviewAnnotations', () => {
  it('keeps valid annotations, clamps ranges, drops unknown repos/files', async () => {
    const set: ReviewAnnotationSet = {
      schemaVersion: 1,
      annotations: [
        {
          id: 'ok',
          repoId: 'default',
          filePath: 'src/a.ts',
          side: 'new',
          lineStart: 2,
          lineEnd: 99,
          kind: 'explanation',
          title: 't',
          body: 'b',
        },
        {
          id: 'bad-repo',
          repoId: 'nope',
          filePath: 'src/a.ts',
          side: 'new',
          lineStart: 1,
          lineEnd: 1,
          kind: 'context',
          title: 't',
          body: 'b',
        },
        {
          id: 'bad-file',
          repoId: 'default',
          filePath: 'src/missing.ts',
          side: 'new',
          lineStart: 1,
          lineEnd: 1,
          kind: 'caution',
          title: 't',
          body: 'b',
        },
      ],
    };
    const result = await sanitizeReviewAnnotations(set, [
      { repoId: 'default', repoPath: repoDir },
    ]);
    expect(result.annotations.map((a) => a.id)).toEqual(['ok']);
    expect(result.annotations[0]?.lineEnd).toBe(3);
  });

  it('drops annotations whose filePath is absolute or escapes the repo root', async () => {
    const set: ReviewAnnotationSet = {
      schemaVersion: 1,
      annotations: [
        {
          id: 'absolute',
          repoId: 'default',
          filePath: '/etc/passwd',
          side: 'new',
          lineStart: 1,
          lineEnd: 1,
          kind: 'caution',
          title: 't',
          body: 'b',
        },
        {
          id: 'escape',
          repoId: 'default',
          filePath: '../../secret.ts',
          side: 'new',
          lineStart: 1,
          lineEnd: 1,
          kind: 'caution',
          title: 't',
          body: 'b',
        },
      ],
    };
    const result = await sanitizeReviewAnnotations(set, [
      { repoId: 'default', repoPath: repoDir },
    ]);
    expect(result.annotations).toEqual([]);
  });

  it('drops annotations whose file resolves through a symlink outside the repo root', async () => {
    const secretDir = mkdtempSync(join(tmpdir(), 'code-review-secret-'));
    try {
      writeFileSync(join(secretDir, 'secret.ts'), 'secret\n');
      symlinkSync(secretDir, join(repoDir, 'linked-secret'), 'dir');
      const set: ReviewAnnotationSet = {
        schemaVersion: 1,
        annotations: [
          {
            id: 'symlink-parent',
            repoId: 'default',
            filePath: 'linked-secret/secret.ts',
            side: 'new',
            lineStart: 1,
            lineEnd: 1,
            kind: 'caution',
            title: 't',
            body: 'b',
          },
        ],
      };
      const result = await sanitizeReviewAnnotations(set, [
        { repoId: 'default', repoPath: repoDir },
      ]);
      expect(result.annotations).toEqual([]);
    } finally {
      rmSync(join(repoDir, 'linked-secret'), { force: true });
      rmSync(secretDir, { recursive: true, force: true });
    }
  });
});
