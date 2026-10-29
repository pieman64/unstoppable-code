/** @jest-environment jsdom */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { create } from 'zustand';
import type { BackgroundProcess } from '@canopy/desktop-shared/types';
import type {
  TurnGroupOrMessage,
  TurnMessage,
} from '@canopy/desktop-shared/lib/turn-utils';

interface TestActivityState {
  bgProcesses: Record<string, BackgroundProcess[]>;
}

const useTestActivityStore = create<TestActivityState>(() => ({
  bgProcesses: {},
}));

jest.mock('@/stores/activityStore', () => ({
  useActivityStore: (
    selector: (state: TestActivityState) => unknown,
  ): unknown => useTestActivityStore(selector),
}));

import { useChatBackgroundProcessesByTurn } from '../turn-background-processes';

const WORKTREE_KEY = 'project-1/worktree-1';

function process(
  toolUseId: string,
  overrides: Partial<BackgroundProcess> = {},
): BackgroundProcess {
  return {
    id: toolUseId,
    chatId: 'chat-1',
    toolUseId,
    toolName: 'Bash',
    kind: 'bash',
    description: toolUseId,
    status: 'running',
    startedAt: 0,
    updatedAt: 0,
    outputLines: [],
    canStop: true,
    ...overrides,
  };
}

function assistantMessage(id: string, toolUseId: string): TurnMessage {
  return {
    id,
    role: 'assistant',
    timestamp: 0,
    blocks: [{ type: 'tool_use', toolUseId, toolName: 'Bash', input: '{}' }],
  };
}

function turnGroup(id: string, toolUseId: string): TurnGroupOrMessage {
  return {
    kind: 'turn-group',
    userMessage: { id, role: 'user', timestamp: 0, blocks: [] },
    assistantMessages: [assistantMessage(`${id}-a`, toolUseId)],
    timerMessage: {
      id: `${id}-timer`,
      role: 'system',
      timestamp: 1,
      blocks: [{ type: 'turn_timer', completedAt: 1 }],
    },
    isComplete: true,
  };
}

const TURN_GROUPS: TurnGroupOrMessage[] = [
  turnGroup('turn-mine', 'mine'),
  turnGroup('turn-theirs', 'someone-else'),
];

describe('useChatBackgroundProcessesByTurn', () => {
  let container: HTMLDivElement;
  let root: Root;
  let renders: number;
  let latest: Readonly<Record<string, readonly BackgroundProcess[]>>;

  function Probe(): JSX.Element {
    renders += 1;
    latest = useChatBackgroundProcessesByTurn(
      'project-1',
      'worktree-1',
      'chat-1',
      TURN_GROUPS,
    );
    return <div />;
  }

  beforeEach(() => {
    renders = 0;
    latest = {};
    useTestActivityStore.setState({
      bgProcesses: {
        [WORKTREE_KEY]: [process('mine'), process('someone-else')],
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Probe />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('keys each turn to the processes it launched', () => {
    expect(latest['turn-mine']?.map((entry) => entry.toolUseId)).toEqual([
      'mine',
    ]);
    expect(latest['turn-theirs']?.map((entry) => entry.toolUseId)).toEqual([
      'someone-else',
    ]);
  });

  it('keeps a turn`s array identity when an unrelated process streams output', () => {
    const before = latest['turn-mine'];
    act(() =>
      useTestActivityStore.setState((state) => ({
        bgProcesses: {
          [WORKTREE_KEY]: [
            state.bgProcesses[WORKTREE_KEY][0],
            process('someone-else', { outputLines: ['tick'] }),
          ],
        },
      })),
    );
    // The owning turn re-renders, but the untouched turn hands its memoized
    // child the same array, so it does not.
    expect(latest['turn-mine']?.[0]).toBe(before?.[0]);
    expect(latest['turn-theirs']?.[0].outputLines).toEqual(['tick']);
  });

  it('does not re-render for activity updates in another worktree', () => {
    const before = renders;
    act(() =>
      useTestActivityStore.setState((state) => ({
        bgProcesses: {
          ...state.bgProcesses,
          'project-2/worktree-2': [process('elsewhere')],
        },
      })),
    );
    expect(renders).toBe(before);
  });

  it('returns an empty record when the worktree has no background processes', () => {
    act(() => useTestActivityStore.setState({ bgProcesses: {} }));
    expect(latest).toEqual({});
  });
});
