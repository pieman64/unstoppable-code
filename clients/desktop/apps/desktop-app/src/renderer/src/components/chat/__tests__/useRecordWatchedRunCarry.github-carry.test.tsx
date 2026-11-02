/** @jest-environment jsdom */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act, useSyncExternalStore, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AgentArtifactCarryReceiptV1,
  AppAdvisorWatcherSummary,
  GitHubWorkflowRunArtifactReceiptV1,
} from '@canopy/desktop-shared/types';
import { isSameAgentArtifactCarryReceipt } from '@canopy/desktop-shared/lib/agent-artifacts';
import { mergeAgentArtifactTurn } from '@canopy/desktop-shared/lib/agent-artifact-projection';

// Regression for the 2026-10-22 renderer crash (React #185 from the run card's
// carry effect). The completed-fire history is fetched separately from the
// active watcher list, so it can hold a newer snapshot of the same watcher.
// The chat's carry recorder and the record's run card must then record the
// same snapshot instead of overwriting each other's on every render.

const destination = { projectId: 'canopy', worktreeId: 'quail', chatId: 'c1' };
const TURN = 'turn-1';

function watcher(
  status: AppAdvisorWatcherSummary['status'],
  observedAt: string,
  runState: GitHubWorkflowRunArtifactReceiptV1['state'],
): AppAdvisorWatcherSummary {
  return {
    id: 'gh-watch-1',
    trigger: 'github_workflow_runs_changed',
    status,
    label: 'CI',
    target: {
      kind: 'github_workflow_runs',
      items: [{ kind: 'workflow_run', repository: 'acme/api', runId: '101' }],
      notifyOn: { statuses: [], conclusions: [], jobConclusions: [] },
      display: {
        repositories: ['acme/api'],
        sample: [{ repository: 'acme/api', runId: '101', runAttempt: 1 }],
      },
    },
    destination,
    createdAt: '2026-10-22T15:41:48.571Z',
    githubProgress: {
      runs: [
        {
          repository: 'acme/api',
          runId: '101',
          runAttempt: 1,
          htmlUrl: 'https://github.com/acme/api/actions/runs/101',
          state: runState,
          observedAt,
        },
      ],
    },
  };
}

const mockWatcherState = {
  watchers: [] as AppAdvisorWatcherSummary[],
  completedWatchers: [] as AppAdvisorWatcherSummary[],
};
jest.mock('@/stores/appAdvisorWatchersStore', () => ({
  useAppAdvisorWatchersStore: (
    selector: (state: typeof mockWatcherState) => unknown,
  ): unknown => selector(mockWatcherState),
  retainAppAdvisorWatchersBridge: (): (() => void) => () => undefined,
}));
jest.mock('@/stores/pipelineRunsStore', () => ({
  usePipelineRunsStore: (
    selector: (state: { summaries: unknown[] }) => unknown,
  ): unknown => selector({ summaries: [] }),
}));

// Minimal chat store with the real per-identity guard from
// recordAgentArtifactCarry: skip identical receipts, replace otherwise, and
// only publish a new state when something changed.
let carry: AgentArtifactCarryReceiptV1[] = [];
let writes = 0;
const carryListeners = new Set<() => void>();
const mockChatState = {
  recordAgentArtifactCarry: (
    _target: unknown,
    _turn: string,
    receipts: AgentArtifactCarryReceiptV1[],
  ): void => {
    let next = carry;
    for (const receipt of receipts) {
      const index = next.findIndex((r) => r.dedupeKey === receipt.dedupeKey);
      if (index >= 0 && isSameAgentArtifactCarryReceipt(next[index], receipt))
        continue;
      next =
        index >= 0
          ? next.map((r, i) => (i === index ? receipt : r))
          : [...next, receipt];
    }
    if (next === carry) return;
    carry = next;
    writes += 1;
    carryListeners.forEach((listener) => listener());
  },
};
jest.mock('@/stores/chatStore', () => ({
  useChatStore: { getState: (): typeof mockChatState => mockChatState },
}));
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: (
    selector: (state: { addToast: jest.Mock }) => unknown,
  ): unknown => selector({ addToast: jest.fn() }),
}));
jest.mock('@canopy/ui-app', () => ({
  GitHubWorkflowRunRow: ({
    run,
  }: {
    run: GitHubWorkflowRunArtifactReceiptV1;
  }): JSX.Element => <div data-testid="run">{run.observedAt}</div>,
}));
jest.mock('@/components/watchers/WatcherManagementButton', () => ({
  WatcherManagementButton: (): null => null,
}));
jest.mock('../agent-artifact-navigation', () => ({
  openAgentArtifactNavigation: jest.fn(),
}));
import { GitHubWorkflowRunArtifactCard } from '../GitHubWorkflowRunArtifactCard';
import { WatchedRunCarryRecorder } from '../useRecordWatchedRunCarry';

function useCarry(): AgentArtifactCarryReceiptV1[] {
  return useSyncExternalStore(
    (listener) => {
      carryListeners.add(listener);
      return () => carryListeners.delete(listener);
    },
    () => carry,
  );
}

/**
 * The chat's carry recorder beside the latest turn's record, which renders
 * one real card per carried GitHub run; the parent passes a fresh
 * chatTarget per render.
 */
function InlineTargetTurn(): JSX.Element {
  const projected = mergeAgentArtifactTurn([], useCarry());
  const chatTarget = { ...destination };
  return (
    <div>
      <WatchedRunCarryRecorder
        chatTarget={chatTarget}
        ownerUserMessageId={TURN}
        knownPipelineRuns={{}}
      />
      {projected.map((receipt) =>
        receipt.kind === 'github_workflow_run' ? (
          <GitHubWorkflowRunArtifactCard
            key={receipt.dedupeKey}
            receipt={receipt}
            chatTarget={chatTarget}
            ownerUserMessageId={TURN}
          />
        ) : null,
      )}
    </div>
  );
}

/**
 * The recorder alone: while the background drawer holds a finished run, no
 * record mounts its card, so the recorder refreshes the carry itself. A later
 * turn owns new carry.
 */
function RecorderOnly(): JSX.Element {
  const current = useCarry();
  return (
    <WatchedRunCarryRecorder
      chatTarget={destination}
      ownerUserMessageId={TURN}
      knownPipelineRuns={{}}
      carryByTurn={{ [TURN]: current }}
    />
  );
}

describe('useRecordWatchedRunCarry GitHub run carry', () => {
  let container: HTMLDivElement;
  let root: Root;
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    carry = [];
    writes = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    consoleError.mockRestore();
  });

  const active = watcher('active', '2026-10-22T15:59:40.000Z', {
    kind: 'intermediate',
    status: 'in_progress',
  });
  const firing = watcher('firing', '2026-10-22T15:59:52.000Z', {
    kind: 'terminal',
    conclusion: 'success',
  });

  it('records one snapshot when the completed history is newer than the active list', () => {
    mockWatcherState.watchers = [active];
    mockWatcherState.completedWatchers = [firing];
    act(() => root.render(<InlineTargetTurn />));
    expect(writes).toBe(1);
    expect(carry).toEqual([
      expect.objectContaining({
        runId: '101',
        observedAt: '2026-10-22T15:59:52.000Z',
        state: { kind: 'terminal', conclusion: 'success' },
      }),
    ]);
  });

  it('saves the final snapshot into the carried turn with no card mounted', () => {
    mockWatcherState.watchers = [active];
    mockWatcherState.completedWatchers = [];
    act(() => root.render(<RecorderOnly />));
    expect(carry).toEqual([
      expect.objectContaining({
        state: { kind: 'intermediate', status: 'in_progress' },
      }),
    ]);
    // The run finishes: its watcher leaves the active list for the history.
    mockWatcherState.watchers = [];
    mockWatcherState.completedWatchers = [
      watcher('fired', '2026-10-22T15:59:52.000Z', {
        kind: 'terminal',
        conclusion: 'success',
      }),
    ];
    act(() => root.render(<RecorderOnly />));
    expect(carry).toEqual([
      expect.objectContaining({
        observedAt: '2026-10-22T15:59:52.000Z',
        state: { kind: 'terminal', conclusion: 'success' },
      }),
    ]);
  });
});
