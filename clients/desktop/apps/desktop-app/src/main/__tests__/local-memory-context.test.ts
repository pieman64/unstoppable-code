const readPreferencesFileMock = jest.fn<
  Promise<{ localMemoryEnabled: boolean } | null>,
  []
>();
const readWorkspaceConfigDetailedMock = jest.fn();
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfigDetailed: (workspaceId: string): unknown =>
    readWorkspaceConfigDetailedMock(workspaceId),
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: (): Promise<{
    localMemoryEnabled: boolean;
  } | null> => readPreferencesFileMock(),
}));

jest.mock('../lib/paths', () => ({
  getUserMemoryDir: (): string => '/memory/user',
  getWorkspaceMemoryDir: (workspaceId: string): string =>
    `/memory/workspaces/${workspaceId}`,
}));

const readMemoryIndexMock = jest.fn<Promise<string>, [string]>();
/** Scope directories whose index read reports that its limits cut it. */
const lineClippedIndexDirs = new Set<string>();
interface NoteEntry {
  fileKey: string;
  text: string;
}
const readRecentInboxNotesMock = jest.fn<
  Promise<NoteEntry[]>,
  [string, { maxNotes?: number; maxCharsPerNote?: number }]
>();
jest.mock('../memory/local/store', () => ({
  // The shared topic reference parser validates names with the real rule.
  normalizeTopicName: jest.requireActual<typeof StoreModule>(
    '../memory/local/store',
  ).normalizeTopicName,
  readMemoryIndex: async (
    scopeDir: string,
  ): Promise<{ text: string; truncated: boolean }> => ({
    text: await readMemoryIndexMock(scopeDir),
    truncated: lineClippedIndexDirs.has(scopeDir),
  }),
  readRecentInboxNoteEntries: (
    scopeDir: string,
    options: { maxNotes?: number; maxCharsPerNote?: number },
  ): Promise<NoteEntry[]> => readRecentInboxNotesMock(scopeDir, options),
}));
type DeferredKeys = () => Iterable<string>;
const recordUsageSoonMock = jest.fn<
  void,
  [string, string[], DeferredKeys | undefined]
>();
jest.mock('../memory/local/usage', () => ({
  recordUsageSoon: (
    scopeDir: string,
    fileKeys: string[],
    deferredKeys?: DeferredKeys,
  ): void => recordUsageSoonMock(scopeDir, fileKeys, deferredKeys),
}));

/**
 * Every use recorded for a scope, each with the topics its deferred keys
 * resolve to (as when the usage batch is applied) ahead of its notes.
 */
function recordedUses(scopeDir: string): string[][] {
  return recordUsageSoonMock.mock.calls
    .filter(([calledScopeDir]) => calledScopeDir === scopeDir)
    .map(([, fileKeys, deferredKeys]) => [
      ...(deferredKeys === undefined ? [] : Array.from(deferredKeys())),
      ...fileKeys,
    ]);
}

// Spied so a test can show the hot path never parses the index excerpt.
const referencedTopicFileKeysSpy = jest.fn<string[], [string]>();
jest.mock('../memory/local/topic-reference', () => {
  const actual = jest.requireActual<typeof TopicReferenceModule>(
    '../memory/local/topic-reference',
  );
  return {
    ...actual,
    referencedTopicFileKeys: (source: string): string[] => {
      referencedTopicFileKeysSpy(source);
      return actual.referencedTopicFileKeys(source);
    },
  };
});

interface TargetRef {
  projectId: string;
  worktreeId: string;
}
const getPlanExploreTargetMock = jest.fn<Promise<TargetRef | null>, [string]>();
const getCodeReviewTargetMock = jest.fn<Promise<TargetRef | null>, [string]>();
jest.mock('../lib/plan-explore-registry', () => ({
  getPlanExploreTarget: (planId: string): Promise<TargetRef | null> =>
    getPlanExploreTargetMock(planId),
}));
jest.mock('../lib/code-review-registry', () => ({
  getCodeReviewTarget: (scopeKey: string): Promise<TargetRef | null> =>
    getCodeReviewTargetMock(scopeKey),
}));

import type * as StoreModule from '../memory/local/store';
import type * as TopicReferenceModule from '../memory/local/topic-reference';
import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import {
  composeSubmittedText,
  joinHiddenBlocks,
} from '../memory/memory-context';
import { prepareLocalMemoryContext } from '../memory/local/prepare';
import { LOCAL_MEMORY_MORE_MARKER } from '../memory/local/boundary-truncation';
import { LOCAL_MEMORY_RECALL_BUDGET } from '../memory/local/render';

describe('local memory turn preparation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    lineClippedIndexDirs.clear();
    readPreferencesFileMock.mockResolvedValue({ localMemoryEnabled: true });
    readWorkspaceConfigDetailedMock.mockResolvedValue({
      authority: 'ok',
      ownerMalformed: false,
      memoryMalformed: false,
      config: { privateMemory: false },
    });
    readMemoryIndexMock.mockResolvedValue('');
    readRecentInboxNotesMock.mockResolvedValue([]);
  });

  it('does no store reads when the preference is off', async () => {
    readPreferencesFileMock.mockResolvedValue({ localMemoryEnabled: false });
    await expect(
      prepareLocalMemoryContext({
        userText: 'This is a substantive memory query.',
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
      }),
    ).resolves.toBeNull();
    expect(readMemoryIndexMock).not.toHaveBeenCalled();
  });

  it('does no store reads for trivial input', async () => {
    await expect(
      prepareLocalMemoryContext({
        userText: 'short',
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
      }),
    ).resolves.toBeNull();
    expect(readMemoryIndexMock).not.toHaveBeenCalled();
  });

  it('returns null for an enabled but empty store', async () => {
    await expect(
      prepareLocalMemoryContext({
        userText: 'This is a substantive memory query.',
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
      }),
    ).resolves.toBeNull();
    expect(readMemoryIndexMock).toHaveBeenCalledTimes(2);
    expect(readRecentInboxNotesMock).toHaveBeenCalledTimes(2);
  });

  it('renders user and project content for a populated store', async () => {
    readMemoryIndexMock.mockImplementation((scopeDir: string) =>
      Promise.resolve(
        scopeDir === '/memory/user' ? 'Personal preference' : 'Build command',
      ),
    );
    readRecentInboxNotesMock.mockImplementation((scopeDir: string) =>
      Promise.resolve(
        scopeDir === '/memory/user'
          ? [{ fileKey: 'inbox/recent.md', text: 'Recent correction' }]
          : [],
      ),
    );
    const prepared = await prepareLocalMemoryContext({
      userText: 'How should I build this project today?',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
    });
    expect(prepared?.renderedBlock).toContain(
      'User memory:\nPersonal preference',
    );
    expect(prepared?.renderedBlock).toContain('Project memory:\nBuild command');
    expect(prepared?.renderedBlock).toContain('Recent correction');
  });

  it('counts the injected topics and notes as used, per scope', async () => {
    readMemoryIndexMock.mockImplementation((scopeDir: string) =>
      Promise.resolve(
        scopeDir === '/memory/user'
          ? '- [Travel](topics/travel.md): window seat.\n- See topics/food.md and topics/travel.md.'
          : '- [Build](topics/build.md): pnpm.',
      ),
    );
    readRecentInboxNotesMock.mockImplementation((scopeDir: string) =>
      Promise.resolve(
        scopeDir === '/memory/user'
          ? [{ fileKey: 'inbox/user-note.md', text: 'User note' }]
          : [{ fileKey: 'inbox/project-note.md', text: 'Project note' }],
      ),
    );

    await prepareLocalMemoryContext({
      userText: 'How should I build this project today?',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
    });

    expect(recordedUses('/memory/user')).toEqual([
      ['topics/travel.md', 'topics/food.md', 'inbox/user-note.md'],
    ]);
    expect(recordedUses('/memory/workspaces/workspace-1')).toEqual([
      ['topics/build.md', 'inbox/project-note.md'],
    ]);
  });

  it('leaves parsing the injected index to the usage batch, once per excerpt', async () => {
    readMemoryIndexMock.mockImplementation((scopeDir: string) =>
      Promise.resolve(
        scopeDir === '/memory/user'
          ? '- [Deploy](topics/deploy-once.md): staging first.'
          : '',
      ),
    );

    for (let turn = 0; turn < 3; turn += 1) {
      await prepareLocalMemoryContext({
        userText: 'How should I deploy this project today?',
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
      });
    }

    // The turn starts without the Markdown parse; the batch resolves each
    // use later, and an unchanged excerpt is parsed only once.
    expect(referencedTopicFileKeysSpy).not.toHaveBeenCalled();
    expect(recordedUses('/memory/user')).toEqual([
      ['topics/deploy-once.md'],
      ['topics/deploy-once.md'],
      ['topics/deploy-once.md'],
    ]);
    expect(referencedTopicFileKeysSpy).toHaveBeenCalledTimes(1);
  });

  it('counts a topic linked in any case once, under its topic identity', async () => {
    readMemoryIndexMock.mockImplementation((scopeDir: string) =>
      Promise.resolve(
        scopeDir === '/memory/user'
          ? '- [Build](Topics/Build.md): pnpm.\n- Also topics/build.md.'
          : '',
      ),
    );
    readRecentInboxNotesMock.mockResolvedValue([]);

    await prepareLocalMemoryContext({
      userText: 'How should I build this project today?',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
    });

    expect(recordedUses('/memory/user')).toEqual([['topics/build.md']]);
  });

  it('counts the topic reference forms the consolidation resolver accepts', async () => {
    readMemoryIndexMock.mockImplementation((scopeDir: string) =>
      Promise.resolve(
        scopeDir === '/memory/user'
          ? [
              '- [Build](./topics/build.md): pnpm.',
              '- [Deploy](topics%2Fdeploy.md#steps): staging first.',
              '- [Food](<topics/food.md?v=1>): no nuts.',
              '- See topics/my\\_travel.md, then rest.',
              '- Not a topic: ../topics/outside.md and topics/nested/deep.md.',
            ].join('\n')
          : '',
      ),
    );
    readRecentInboxNotesMock.mockResolvedValue([]);

    await prepareLocalMemoryContext({
      userText: 'How should I build this project today?',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
    });

    expect(recordedUses('/memory/user')).toEqual([
      [
        'topics/build.md',
        'topics/deploy.md',
        'topics/food.md',
        'topics/my_travel.md',
      ],
    ]);
  });

  it('does not count a topic whose index line was cut from the injection', async () => {
    const filler = Array.from(
      { length: 200 },
      (_, index) => `- fact ${index}: ${'x'.repeat(80)}.`,
    ).join('\n');
    readMemoryIndexMock.mockImplementation((scopeDir: string) =>
      Promise.resolve(
        scopeDir === '/memory/user'
          ? `${filler}\n- [Late](topics/late.md): cut off.`
          : '',
      ),
    );

    await prepareLocalMemoryContext({
      userText: 'How should I build this project today?',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
    });

    expect(recordedUses('/memory/user').flat()).not.toContain('topics/late.md');
  });

  it('reads only project files when private memory is enabled', async () => {
    readWorkspaceConfigDetailedMock.mockResolvedValue({
      authority: 'ok',
      ownerMalformed: false,
      memoryMalformed: false,
      config: { privateMemory: true },
    });
    readMemoryIndexMock.mockResolvedValue('Private project marker');
    await prepareLocalMemoryContext({
      userText: 'What should I remember about this project?',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
    });
    expect(readMemoryIndexMock).toHaveBeenCalledWith(
      '/memory/workspaces/workspace-1',
    );
    expect(readMemoryIndexMock).not.toHaveBeenCalledWith('/memory/user');
    expect(readRecentInboxNotesMock).not.toHaveBeenCalledWith(
      '/memory/user',
      expect.anything(),
    );
    expect(recordUsageSoonMock).not.toHaveBeenCalledWith(
      '/memory/user',
      expect.anything(),
    );
  });

  it('fails closed when the project config is unreadable', async () => {
    readWorkspaceConfigDetailedMock.mockResolvedValue({
      authority: 'unreadable',
      ownerMalformed: false,
      memoryMalformed: false,
      config: {},
    });
    await expect(
      prepareLocalMemoryContext({
        userText: 'What should I remember about this project?',
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
      }),
    ).resolves.toBeNull();
    expect(readMemoryIndexMock).not.toHaveBeenCalled();
  });

  it('resolves plan-explore sentinels to the real project before reading', async () => {
    getPlanExploreTargetMock.mockResolvedValue({
      projectId: 'real-project',
      worktreeId: 'wt-9',
    });
    readMemoryIndexMock.mockImplementation((scopeDir: string) =>
      Promise.resolve(
        scopeDir === '/memory/workspaces/real-project' ? 'Build command' : '',
      ),
    );
    const prepared = await prepareLocalMemoryContext({
      userText: 'How should I build this project today?',
      projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
      worktreeId: 'plan-77',
    });
    expect(getPlanExploreTargetMock).toHaveBeenCalledWith('plan-77');
    expect(prepared?.renderedBlock).toContain('Project memory:\nBuild command');
    expect(readMemoryIndexMock).toHaveBeenCalledWith(
      '/memory/workspaces/real-project',
    );
  });

  it('says more is saved when the index was cut at its line limit but is small', async () => {
    // A 200-line read of a longer index: well under the recall byte budget,
    // so only the read-time cut can tell the model more is saved.
    readMemoryIndexMock.mockImplementation((scopeDir: string) =>
      Promise.resolve(
        scopeDir === '/memory/user'
          ? Array.from({ length: 200 }, (_, index) => `- f${index}`).join('\n')
          : '',
      ),
    );
    lineClippedIndexDirs.add('/memory/user');
    const prepared = await prepareLocalMemoryContext({
      userText: 'What do you remember about my preferences?',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
    });
    expect(prepared?.renderedBlock).toContain('- f199');
    expect(prepared?.renderedBlock).toContain(
      `${LOCAL_MEMORY_MORE_MARKER}\n</local_memory>`,
    );
    expect(
      Buffer.byteLength(prepared?.renderedBlock ?? '', 'utf8'),
    ).toBeLessThanOrEqual(LOCAL_MEMORY_RECALL_BUDGET.blockBytes);
  });

  it('fails closed when a code-review sentinel has no target', async () => {
    getCodeReviewTargetMock.mockResolvedValue(null);
    readMemoryIndexMock.mockImplementation((scopeDir: string) =>
      Promise.resolve(scopeDir === '/memory/user' ? 'Personal preference' : ''),
    );
    const prepared = await prepareLocalMemoryContext({
      userText: 'How should I build this project today?',
      projectId: CODE_REVIEW_CHAT_PROJECT_ID,
      worktreeId: 'proj--wt',
    });
    expect(prepared).toBeNull();
    expect(readMemoryIndexMock).not.toHaveBeenCalled();
  });

  it('maps the legacy cowork sentinel to the project id in the worktree slot', async () => {
    readMemoryIndexMock.mockImplementation((scopeDir: string) =>
      Promise.resolve(
        scopeDir === '/memory/workspaces/cowork-42' ? 'Cowork note' : '',
      ),
    );
    const prepared = await prepareLocalMemoryContext({
      userText: 'How should I build this project today?',
      projectId: STANDALONE_CHAT_PROJECT_ID,
      worktreeId: 'cowork-42',
    });
    expect(prepared?.renderedBlock).toContain('Project memory:\nCowork note');
    expect(readMemoryIndexMock).toHaveBeenCalledWith(
      '/memory/workspaces/cowork-42',
    );
  });

  it('keeps submitted text byte-identical when local and org blocks are absent', () => {
    expect(
      composeSubmittedText(
        'visible',
        'hidden',
        joinHiddenBlocks(null, undefined),
      ),
    ).toBe('hidden\n\nvisible');
    expect(
      composeSubmittedText(
        'visible',
        undefined,
        joinHiddenBlocks(null, undefined),
      ),
    ).toBe('visible');
    expect(joinHiddenBlocks('<org_memory/>', '<local_memory/>')).toBe(
      '<org_memory/>\n\n<local_memory/>',
    );
  });
});
