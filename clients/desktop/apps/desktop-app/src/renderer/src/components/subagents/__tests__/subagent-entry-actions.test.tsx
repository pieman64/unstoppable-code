/** @jest-environment jsdom */

/** Open chat and View tree entry actions for one root chat (D1, D2). */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useSubagentViewStateStore } from '@canopy/ui-app/subagents';
import {
  openSubagentChatPanel,
  openSubagentsPanel,
} from '@/lib/panels/subagent-panel-open';
import {
  createSubagentEntryActions,
  SubagentEntryActionsContext,
  useSubagentEntryActionsValue,
  useSubagentOpenChatCallback,
  type SubagentEntryActions,
} from '../subagent-entry-actions';

jest.mock('@/lib/panels/subagent-panel-open', () => ({
  openSubagentChatPanel: jest.fn(() => Promise.resolve({ status: 'failed' })),
  openSubagentsPanel: jest.fn(() => Promise.resolve({ status: 'failed' })),
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const SCOPE = { projectId: 'project-1', worktreeId: 'worktree-1' };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  jest.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('createSubagentEntryActions', () => {
  it('opens a subagent chat bound to the root chat', () => {
    createSubagentEntryActions(SCOPE, 'root-chat').openSubagentChat({
      kind: 'codex-native',
      id: 'thread-7',
      title: 'Explore',
    });
    expect(openSubagentChatPanel).toHaveBeenCalledWith(SCOPE, {
      rootChatId: 'root-chat',
      subagentId: 'thread-7',
      subagentKind: 'codex-native',
      title: 'Explore',
    });
  });

  it('selects the root chat and then opens the Subagents panel', async () => {
    createSubagentEntryActions(SCOPE, 'root-chat').viewTree();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(
      useSubagentViewStateStore.getState().scopes['project-1/worktree-1']
        ?.selectedRootId,
    ).toBe('root-chat');
    expect(openSubagentsPanel).toHaveBeenCalledWith(SCOPE);
  });
});

describe('useSubagentOpenChatCallback', () => {
  function Card({
    id,
    onRender,
  }: {
    id: string | undefined;
    onRender: (callback: (() => void) | undefined) => void;
  }): JSX.Element {
    onRender(useSubagentOpenChatCallback('managed', id, 'Task'));
    return <span />;
  }

  it('is undefined without a provider or identity', () => {
    const seen: Array<(() => void) | undefined> = [];
    act(() => {
      root.render(<Card id="d-1" onRender={(cb) => seen.push(cb)} />);
    });
    expect(seen.at(-1)).toBeUndefined();
    const actions = createSubagentEntryActions(SCOPE, 'root-chat');
    act(() => {
      root.render(
        <SubagentEntryActionsContext.Provider value={actions}>
          <Card id={undefined} onRender={(cb) => seen.push(cb)} />
        </SubagentEntryActionsContext.Provider>,
      );
    });
    expect(seen.at(-1)).toBeUndefined();
  });

  it('keeps one callback across unrelated re-renders', () => {
    const seen: Array<(() => void) | undefined> = [];
    const actions = createSubagentEntryActions(SCOPE, 'root-chat');
    const render = (): void => {
      act(() => {
        root.render(
          <SubagentEntryActionsContext.Provider value={actions}>
            <Card id="d-1" onRender={(cb) => seen.push(cb)} />
          </SubagentEntryActionsContext.Provider>,
        );
      });
    };
    render();
    render();
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeDefined();
    expect(seen[1]).toBe(seen[0]);
    seen[1]?.();
    expect(openSubagentChatPanel).toHaveBeenCalledWith(SCOPE, {
      rootChatId: 'root-chat',
      subagentId: 'd-1',
      subagentKind: 'managed',
      title: 'Task',
    });
  });
});

describe('useSubagentEntryActionsValue', () => {
  function Probe({
    scope,
    enabled,
    onRender,
  }: {
    scope: { projectId: string; worktreeId: string } | null;
    enabled: boolean;
    onRender: (value: SubagentEntryActions | null) => void;
  }): JSX.Element {
    onRender(useSubagentEntryActionsValue(scope, 'root-chat', enabled));
    return <span />;
  }

  it('is stable for one scope and null when disabled', () => {
    const seen: Array<SubagentEntryActions | null> = [];
    act(() => {
      root.render(
        <Probe scope={{ ...SCOPE }} enabled onRender={(v) => seen.push(v)} />,
      );
    });
    act(() => {
      root.render(
        <Probe scope={{ ...SCOPE }} enabled onRender={(v) => seen.push(v)} />,
      );
    });
    expect(seen[0]).not.toBeNull();
    expect(seen[1]).toBe(seen[0]);
    act(() => {
      root.render(
        <Probe scope={SCOPE} enabled={false} onRender={(v) => seen.push(v)} />,
      );
    });
    expect(seen.at(-1)).toBeNull();
    act(() => {
      root.render(
        <Probe scope={null} enabled onRender={(v) => seen.push(v)} />,
      );
    });
    expect(seen.at(-1)).toBeNull();
  });
});
