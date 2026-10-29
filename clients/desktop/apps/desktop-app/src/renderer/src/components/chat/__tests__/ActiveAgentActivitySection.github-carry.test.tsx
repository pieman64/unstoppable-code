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
import type * as GitHubWorkflowRunArtifactCardModule from '../GitHubWorkflowRunArtifactCard';

// Regression for the 2026-10-22 renderer crash (React #185 from the run card's
// carry effect). The completed-fire history is fetched separately from the
// active watcher list, so it can hold a newer snapshot of the same watcher.
// The section and the card must then record the same snapshot instead of
// overwriting each other's on every render.

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
  hydrated: true,
  loading: false,
  subscribeBridge: (): (() => void) => () => undefined,
  hydrate: jest.fn(),
};
jest.mock('@/stores/appAdvisorWatchersStore', () => ({
  useAppAdvisorWatchersStore: Object.assign(
    (selector: (state: typeof mockWatcherState) => unknown): unknown =>
      selector(mockWatcherState),
    { getState: (): typeof mockWatcherState => mockWatcherState },
  ),
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
// The desktop section renders one real card per GitHub receipt.
jest.mock('../DesktopAgentActivitySection', () => {
  const { GitHubWorkflowRunArtifactCard } = jest.requireActual<
    typeof GitHubWorkflowRunArtifactCardModule
  >('../GitHubWorkflowRunArtifactCard');
  return {
    DesktopAgentActivitySection: ({
      artifacts,
      chatTarget,
      ownerUserMessageId,
    }: {
      artifacts: GitHubWorkflowRunArtifactReceiptV1[];
      chatTarget: typeof destination;
      ownerUserMessageId: string;
    }): JSX.Element => (
      <div>
        {artifacts.map((receipt) => (
          <GitHubWorkflowRunArtifactCard
            key={receipt.dedupeKey}
            receipt={receipt}
            chatTarget={chatTarget}
            ownerUserMessageId={ownerUserMessageId}
          />
        ))}
      </div>
    ),
  };
});

import { ActiveAgentActivitySection } from '../ActiveAgentActivitySection';

function useCarry(): AgentArtifactCarryReceiptV1[] {
  return useSyncExternalStore(
    (listener) => {
      carryListeners.add(listener);
      return () => carryListeners.delete(listener);
    },
    () => carry,
  );
}

/** A completed latest turn whose parent passes a fresh chatTarget per render. */
function InlineTargetTurn(): JSX.Element {
  const projected = mergeAgentArtifactTurn([], useCarry());
  return (
    <ActiveAgentActivitySection
      projectedArtifacts={projected}
      ownerUserMessageId={TURN}
      variant="completed"
      chatTarget={{ ...destination }}
    />
  );
}

describe('ActiveAgentActivitySection GitHub run carry', () => {
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
});
