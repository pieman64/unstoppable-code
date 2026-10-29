import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import type {
  ArchivedChatEntry,
  PersistedChatTab,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';
import type { ExecutionSummary } from '@canopy/desktop-shared/node/pipelines/executor/types';
import {
  hasSplitWorktreeItems,
  partitionSplitWorktreeItems,
  type SplitWorktreeItemsAnalysis,
} from '../lib/split-temporary-workspace-items';

function tab(id: string, selectedRepoId?: string): PersistedChatTab {
  return {
    id,
    title: `Chat ${id}`,
    messages: [],
    createdAt: '2026-07-30T00:00:00.000Z',
    ...(selectedRepoId ? { selectedRepoId } : {}),
  };
}

function execution(id: string, cwd: string): ExecutionSummary {
  return {
    id,
    pipeline_id: `pipeline-${id}`,
    pipeline_name: `Pipeline ${id}`,
    status: 'success',
    status_reasons: [],
    started_at: '2026-07-30T00:00:00.000Z',
    cwd,
  };
}

function plan(
  id: string,
  overrides: Partial<TrackedPlanData> = {},
): TrackedPlanData {
  return {
    id,
    projectId: 'temp-ws',
    worktreeId: 'wt-1',
    source: 'claude',
    title: `Plan ${id}`,
    content: '',
    reviewStatus: 'pending',
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
    latestRevisionNumber: 1,
    revisions: [],
    linkedExecutionIds: [],
    ...overrides,
  };
}

const REPO_A_PATH = '/data/workspaces/temp-ws/worktrees/wt-1/repos/repo-a';
const REPO_B_PATH = '/data/workspaces/temp-ws/worktrees/wt-1/repos/repo-b';
const ROOT_PATH = '/data/workspaces/temp-ws/worktrees/wt-1';

function fileTab(id: string, filePath: string): PersistedChatTab {
  return { ...tab(id), kind: 'file', filePath };
}

function archivedChat(id: string, selectedRepoId?: string): ArchivedChatEntry {
  return {
    tab: tab(id, selectedRepoId),
    archivedAt: '2026-07-30T00:00:00.000Z',
    turnCount: 1,
  };
}

function partition(input: {
  chatTabs?: PersistedChatTab[];
  archivedChats?: ArchivedChatEntry[];
  executions?: ExecutionSummary[];
  plans?: TrackedPlanData[];
  attachmentNames?: string[];
}): ReturnType<typeof partitionSplitWorktreeItems> {
  return partitionSplitWorktreeItems({
    repoIds: ['repo-a', 'repo-b'],
    repoCheckoutPathById: new Map([
      ['repo-a', REPO_A_PATH],
      ['repo-b', REPO_B_PATH],
    ]),
    chatTabs: input.chatTabs ?? [],
    archivedChats: input.archivedChats ?? [],
    executions: input.executions ?? [],
    plans: input.plans ?? [],
    attachmentNames: input.attachmentNames,
    attachmentsDir: `${ROOT_PATH}/attachments`,
  });
}

describe('partitionSplitWorktreeItems', () => {
  it('attributes chat tabs by selectedRepoId and roots the rest', () => {
    const result = partition({
      chatTabs: [
        tab('a1', 'repo-a'),
        tab('b1', 'repo-b'),
        tab('root-implicit'),
        tab('root-explicit', WORKSPACE_ROOT_REPO_ID),
        tab('unknown-repo', 'repo-gone'),
      ],
    });

    expect(result.perRepo.get('repo-a')?.chatTabs.map((t) => t.id)).toEqual([
      'a1',
    ]);
    expect(result.perRepo.get('repo-b')?.chatTabs.map((t) => t.id)).toEqual([
      'b1',
    ]);
    expect(result.root.chatTabs.map((t) => t.id)).toEqual([
      'root-implicit',
      'root-explicit',
      'unknown-repo',
    ]);
  });

  it('attributes attachments to every chat bucket that references them', () => {
    const sharedPath = `${ROOT_PATH}/attachments/shared.png`;
    const repoTab = tab('repo-chat', 'repo-a');
    repoTab.messages = [
      {
        id: 'repo-message',
        role: 'user',
        timestamp: 1,
        blocks: [],
        attachmentPaths: [sharedPath],
      },
    ];
    const rootTab = tab('root-chat');
    rootTab.messages = [
      {
        id: 'root-message',
        role: 'system',
        timestamp: 2,
        blocks: [
          {
            type: 'revert_info',
            timestamp: 2,
            revertedFromMessageId: 'before',
            revertedFromTimestamp: 1,
            files: [],
            totalInsertions: 0,
            totalDeletions: 0,
            attachmentPath: sharedPath,
          },
        ],
      },
    ];

    const result = partition({
      chatTabs: [repoTab, rootTab],
      attachmentNames: ['shared.png', 'unreferenced.txt'],
    });

    expect(result.perRepo.get('repo-a')?.attachmentNames).toEqual([
      'shared.png',
    ]);
    expect(result.root.attachmentNames).toEqual([
      'shared.png',
      'unreferenced.txt',
    ]);
  });

  it('attributes file tabs by file path, separate from the chat list', () => {
    const result = partition({
      chatTabs: [
        fileTab('f-a', `${REPO_A_PATH}/src/index.ts`),
        fileTab('f-root', `${ROOT_PATH}/README.md`),
        fileTab('f-outside', '/somewhere/else/file.ts'),
        tab('chat-a', 'repo-a'),
      ],
    });

    expect(result.perRepo.get('repo-a')?.fileTabs.map((t) => t.id)).toEqual([
      'f-a',
    ]);
    expect(result.perRepo.get('repo-a')?.chatTabs.map((t) => t.id)).toEqual([
      'chat-a',
    ]);
    expect(result.root.fileTabs.map((t) => t.id)).toEqual([
      'f-root',
      'f-outside',
    ]);
    expect(result.root.chatTabs).toHaveLength(0);
  });

  it('attributes archived chats by their embedded tab scope', () => {
    const result = partition({
      archivedChats: [
        archivedChat('arch-a', 'repo-a'),
        archivedChat('arch-root'),
        archivedChat('arch-root-explicit', WORKSPACE_ROOT_REPO_ID),
      ],
    });

    expect(
      result.perRepo.get('repo-a')?.archivedChats.map((e) => e.tab.id),
    ).toEqual(['arch-a']);
    expect(result.root.archivedChats.map((e) => e.tab.id)).toEqual([
      'arch-root',
      'arch-root-explicit',
    ]);
  });

  it('attributes executions by cwd prefix, including the checkout itself', () => {
    const result = partition({
      executions: [
        execution('e1', REPO_A_PATH),
        execution('e2', `${REPO_B_PATH}/nested/dir`),
        execution('e3', ROOT_PATH),
        execution('e4', '/somewhere/else'),
      ],
    });

    expect(result.perRepo.get('repo-a')?.executions.map((e) => e.id)).toEqual([
      'e1',
    ]);
    expect(result.perRepo.get('repo-b')?.executions.map((e) => e.id)).toEqual([
      'e2',
    ]);
    expect(result.root.executions.map((e) => e.id)).toEqual(['e3', 'e4']);
  });

  it('does not attribute a sibling path that only shares a string prefix', () => {
    const result = partition({
      executions: [execution('e1', `${REPO_A_PATH}-sibling`)],
    });
    expect(result.perRepo.get('repo-a')?.executions).toHaveLength(0);
    expect(result.root.executions.map((e) => e.id)).toEqual(['e1']);
  });

  it('attributes plans by sourceRepoId first, then linked-execution cwd, else root', () => {
    const result = partition({
      executions: [execution('e1', `${REPO_B_PATH}/x`)],
      plans: [
        plan('p1', { sourceRepoId: 'repo-a' }),
        plan('p2', { sourceRepoId: WORKSPACE_ROOT_REPO_ID }),
        plan('p3', { linkedExecutionIds: ['e1'] }),
        plan('p4', { linkedExecutionIds: ['missing-execution'] }),
        plan('p5'),
      ],
    });

    expect(result.perRepo.get('repo-a')?.plans.map((p) => p.id)).toEqual([
      'p1',
    ]);
    expect(result.perRepo.get('repo-b')?.plans.map((p) => p.id)).toEqual([
      'p3',
    ]);
    expect(result.root.plans.map((p) => p.id)).toEqual(['p2', 'p4', 'p5']);
  });
});

describe('hasSplitWorktreeItems', () => {
  const empty = (): SplitWorktreeItemsAnalysis['root'] => ({
    chatTabs: [],
    fileTabs: [],
    archivedChats: [],
    executions: [],
    plans: [],
    attachmentNames: [],
  });

  it('includes root file tabs in presence detection', () => {
    expect(
      hasSplitWorktreeItems({
        ...empty(),
        fileTabs: [fileTab('root-file', `${ROOT_PATH}/README.md`)],
      }),
    ).toBe(true);
  });

  it('includes root archived chats in presence detection', () => {
    expect(
      hasSplitWorktreeItems({
        ...empty(),
        archivedChats: [archivedChat('root-archive')],
      }),
    ).toBe(true);
  });

  it('returns false for an empty partition bucket', () => {
    expect(hasSplitWorktreeItems(empty())).toBe(false);
  });
});
