/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { SubagentNode, SubagentTree } from '@canopy/ui-shared';
import {
  SubagentChatPanel,
  type SubagentChatPanelProps,
} from '../SubagentChatPanel';
import { useSubagentComposerStore } from '../subagent-composer-store';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function node(
  id: string,
  title: string,
  kind: SubagentNode['kind'],
  parentId: string | null,
  childIds: readonly string[],
  status: SubagentNode['status'],
  workspace?: SubagentNode['workspace'],
): SubagentNode {
  return {
    id,
    kind,
    parentId,
    depth: parentId === null ? 1 : 2,
    title,
    status,
    childIds,
    liveDescendantCount: 0,
    approvalPending: false,
    runs: kind === 'managed' ? [{ runGeneration: 1 }] : [],
    ...(workspace ? { workspace } : {}),
    ...(workspace === 'isolated' ? { isolatedRevision: 'rev-1' } : {}),
  };
}

function tree(
  status: SubagentNode['status'] = 'completed',
  kind: SubagentNode['kind'] = 'managed',
  workspace: SubagentNode['workspace'] = 'isolated',
): SubagentTree {
  const parent = node(
    'parent',
    'Parent task',
    'managed',
    null,
    ['current'],
    'running',
    'shared',
  );
  const current = node(
    'current',
    'Selected task',
    kind,
    'parent',
    [],
    status,
    workspace,
  );
  return {
    root: { id: 'root-chat', title: 'Root chat' },
    nodes: new Map([
      [parent.id, parent],
      [current.id, current],
    ]),
    rootChildIds: [parent.id],
    complete: true,
  };
}

function workflowTree(): SubagentTree {
  const workflow = {
    runId: 'wf_panel-123',
    runName: 'Panel workflow',
    runOrdinal: 1,
    runCount: 1,
    phaseCount: 1,
    agentCount: 1,
  };
  const run = node(
    'workflow-run-node',
    'Panel workflow',
    'workflow-run',
    null,
    ['workflow-phase-node'],
    'completed',
  );
  const phase = node(
    'workflow-phase-node',
    'Review',
    'workflow-phase',
    'workflow-run-node',
    ['workflow-agent-node'],
    'completed',
  );
  const current = node(
    'workflow-agent-node',
    'Review agent',
    'workflow-agent',
    'workflow-phase-node',
    [],
    'completed',
  );
  return {
    root: { id: 'root-chat', title: 'Root chat' },
    nodes: new Map([
      [run.id, { ...run, workflow }],
      [
        phase.id,
        {
          ...phase,
          workflow: { ...workflow, phaseTitle: 'Review', phaseIndex: 0 },
        },
      ],
      [
        current.id,
        {
          ...current,
          workflow: {
            ...workflow,
            phaseTitle: 'Review',
            phaseIndex: 0,
            agentPosition: 1,
          },
        },
      ],
    ]),
    rootChildIds: [run.id],
    complete: true,
  };
}

const capabilities = {
  stop: true,
  messaging: true,
  worktreeDetails: true,
  nativeInterrupt: true,
  openWorkflow: true,
  stopWorkflow: true,
};

const readyWorktree = {
  status: 'ready' as const,
  summary: {
    checkout: 'retained' as const,
    startingRevision: '0123456789abcdef',
    startingSubject: 'Initial revision',
    startingBranch: 'main',
    filesChanged: 2,
    additions: 5,
    deletions: 1,
    commitsAhead: 1,
    untrackedFiles: 0,
    applyState: 'not_applied' as const,
    topFiles: [],
    truncated: false,
  },
};

function props(
  overrides: Partial<SubagentChatPanelProps> = {},
): SubagentChatPanelProps {
  return {
    tree: tree(),
    subagentId: 'current',
    capabilities,
    transcript: <p>Transcript</p>,
    onOpenLineage: (): void => {},
    ...overrides,
  };
}

function resetStore(): void {
  act((): void => useSubagentComposerStore.setState({ drafts: {} }));
}

const resizeObservers: TestResizeObserver[] = [];

class TestResizeObserver implements ResizeObserver {
  public target: Element | null = null;

  public constructor(private readonly callback: ResizeObserverCallback) {
    resizeObservers.push(this);
  }

  public observe(target: Element): void {
    this.target = target;
    this.emit(640);
  }

  public unobserve(target: Element): void {
    if (target === this.target) this.target = null;
  }

  public disconnect(): void {
    this.target = null;
  }

  public takeRecords(): ResizeObserverEntry[] {
    return [];
  }

  public emit(width: number, height = 400): void {
    if (!this.target) return;
    const entry: ResizeObserverEntry = {
      target: this.target,
      contentRect: new DOMRectReadOnly(0, 0, width, height),
      borderBoxSize: [],
      contentBoxSize: [],
      devicePixelContentBoxSize: [],
    };
    this.callback([entry], this);
  }
}

describe('SubagentChatPanel', () => {
  beforeEach(resetStore);

  it('chooses stacked at 719px and columns at 720px from the panel observer', () => {
    const previous = globalThis.ResizeObserver;
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: TestResizeObserver,
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    resizeObservers.length = 0;

    act((): void => root.render(<SubagentChatPanel {...props()} />));
    const observer = resizeObservers[0];
    if (!observer) throw new Error('panel did not observe its width');
    act((): void => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="subagent-chat-details-toggle"]',
        )
        ?.click();
    });
    expect(container.querySelector('[data-layout="stacked"]')).not.toBeNull();
    act((): void => observer.emit(719));
    expect(container.querySelector('[data-layout="stacked"]')).not.toBeNull();
    act((): void => observer.emit(720));
    expect(container.querySelector('[data-layout="columns"]')).not.toBeNull();

    act((): void => root.unmount());
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: previous,
    });
  });

  it('caps open details to half the panel height and scrolls them in both layouts', () => {
    const previous = globalThis.ResizeObserver;
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: TestResizeObserver,
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    resizeObservers.length = 0;

    act((): void => root.render(<SubagentChatPanel {...props()} />));
    const observer = resizeObservers[0];
    if (!observer) throw new Error('panel did not observe its size');
    act((): void => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="subagent-chat-details-toggle"]',
        )
        ?.click();
    });
    const details = (): HTMLElement | null =>
      container.querySelector<HTMLElement>(
        '[data-testid="subagent-chat-details"]',
      );

    act((): void => observer.emit(900, 900));
    expect(details()?.dataset.layout).toBe('columns');
    expect(details()?.style.maxHeight).toBe('450px');
    expect(details()?.className).toContain('overflow-y-auto');

    act((): void => observer.emit(640, 200));
    expect(details()?.dataset.layout).toBe('stacked');
    expect(details()?.style.maxHeight).toBe('160px');
    expect(details()?.className).toContain('overflow-y-auto');

    act((): void => root.unmount());
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: previous,
    });
  });

  it('opens at the latest output and follows it until the reader scrolls up', () => {
    const previous = globalThis.ResizeObserver;
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: TestResizeObserver,
    });
    let height = 1000;
    const isScroller = (element: Element): boolean =>
      element instanceof HTMLElement &&
      element.dataset['testid'] === 'subagent-chat-scroll';
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement): number {
        return isScroller(this) ? height : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement): number {
        return isScroller(this) ? 400 : 0;
      },
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    resizeObservers.length = 0;
    try {
      act((): void =>
        root.render(
          <SubagentChatPanel {...props({ tree: tree('running') })} />,
        ),
      );
      const scroller = container.querySelector<HTMLElement>(
        '[data-testid="subagent-chat-scroll"]',
      );
      if (!scroller) throw new Error('missing transcript scroller');
      const content = scroller.querySelector(
        '[data-testid="subagent-chat-transcript"]',
      );
      const contentObserver = resizeObservers.find(
        (observer) => observer.target === content,
      );
      if (!contentObserver) throw new Error('transcript is not observed');
      expect(scroller.scrollTop).toBe(1000);
      expect(
        container.querySelector('[data-testid="subagent-chat-working"]'),
      ).not.toBeNull();

      height = 1500;
      act((): void => contentObserver.emit(640));
      expect(scroller.scrollTop).toBe(1500);

      act((): void => {
        scroller.scrollTop = 200;
        scroller.dispatchEvent(new Event('scroll'));
      });
      height = 2000;
      act((): void => contentObserver.emit(640));
      expect(scroller.scrollTop).toBe(200);

      act((): void =>
        root.render(
          <SubagentChatPanel {...props({ tree: tree('completed') })} />,
        ),
      );
      expect(
        container.querySelector('[data-testid="subagent-chat-working"]'),
      ).toBeNull();
    } finally {
      act((): void => root.unmount());
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
      Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
      Object.defineProperty(globalThis, 'ResizeObserver', {
        configurable: true,
        value: previous,
      });
    }
  });

  it('shows worktree details only for isolated managed nodes with capability and data', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    let expanded = false;
    const renderAndExpand = (nextProps: SubagentChatPanelProps): void => {
      act((): void => root.render(<SubagentChatPanel {...nextProps} />));
      if (!expanded) {
        act((): void => {
          container
            .querySelector<HTMLButtonElement>(
              '[data-testid="subagent-chat-details-toggle"]',
            )
            ?.click();
        });
        expanded = true;
      }
    };
    renderAndExpand(
      props({
        worktree: readyWorktree,
        onShowChanges: (): void => {},
      }),
    );
    expect(
      container.querySelector('[data-testid="subagent-chat-details-worktree"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Show changes');

    renderAndExpand(
      props({
        tree: tree('completed', 'managed', 'shared'),
        worktree: readyWorktree,
      }),
    );
    expect(
      container.querySelector('[data-testid="subagent-chat-details-worktree"]'),
    ).toBeNull();
    renderAndExpand(
      props({
        tree: tree('completed', 'claude-native'),
        worktree: readyWorktree,
      }),
    );
    expect(
      container.querySelector('[data-testid="subagent-chat-details-worktree"]'),
    ).toBeNull();
    renderAndExpand(
      props({
        worktree: readyWorktree,
        capabilities: { ...capabilities, worktreeDetails: false },
      }),
    );
    expect(
      container.querySelector('[data-testid="subagent-chat-details-worktree"]'),
    ).toBeNull();
    act((): void => root.unmount());
  });

  it('shows workflow details and gates Open workflow on capability and callback', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const selectedTree = workflowTree();
    let expanded = false;
    const renderAndExpand = (nextProps: SubagentChatPanelProps): void => {
      act((): void => root.render(<SubagentChatPanel {...nextProps} />));
      if (!expanded) {
        act((): void => {
          container
            .querySelector<HTMLButtonElement>(
              '[data-testid="subagent-chat-details-toggle"]',
            )
            ?.click();
        });
        expanded = true;
      }
    };
    let openedRunId: string | undefined;
    renderAndExpand(
      props({
        tree: selectedTree,
        subagentId: 'workflow-agent-node',
        onOpenWorkflow: (runId): void => {
          openedRunId = runId;
        },
      }),
    );

    expect(
      container.querySelector('[data-testid="subagent-chat-details-workflow"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="subagent-chat-details-worktree"]'),
    ).toBeNull();
    const runBreadcrumb = container.querySelector<HTMLButtonElement>(
      '[data-testid="subagent-chat-breadcrumb-workflow-run-node"]',
    );
    const phaseBreadcrumb = container.querySelector<HTMLButtonElement>(
      '[data-testid="subagent-chat-breadcrumb-workflow-phase-node"]',
    );
    expect(runBreadcrumb?.title).toBe('Panel workflow');
    expect(phaseBreadcrumb?.title).toBe('Review');
    const openButton = (): HTMLButtonElement | null =>
      container.querySelector<HTMLButtonElement>(
        '[data-testid="subagent-chat-open-workflow"]',
      );
    expect(openButton()).not.toBeNull();
    act((): void => openButton()?.click());
    expect(openedRunId).toBe('wf_panel-123');

    renderAndExpand(
      props({
        tree: selectedTree,
        subagentId: 'workflow-agent-node',
        capabilities: { ...capabilities, openWorkflow: false },
        onOpenWorkflow: (): void => {},
      }),
    );
    expect(openButton()).toBeNull();

    renderAndExpand(
      props({
        tree: selectedTree,
        subagentId: 'workflow-agent-node',
        capabilities: { ...capabilities, openWorkflow: true },
      }),
    );
    expect(openButton()).toBeNull();
    act((): void => root.unmount());
  });

  it('marks the panel as a chat window', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act((): void => root.render(<SubagentChatPanel {...props()} />));
    // The shared stylesheet keeps plain line breaks inside it.
    expect(
      container
        .querySelector('[data-testid="subagent-chat-panel"]')
        ?.hasAttribute('data-chat-window'),
    ).toBe(true);
    act((): void => root.unmount());
  });

  it('keeps tree loading and missing-node states quiet', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act((): void =>
      root.render(<SubagentChatPanel {...props({ tree: null })} tree={null} />),
    );
    expect(container.textContent).toContain('Loading subagent chat');
    act((): void =>
      root.render(
        <SubagentChatPanel
          {...props({ subagentId: 'missing' })}
          subagentId="missing"
        />,
      ),
    );
    expect(container.textContent).toContain(
      "This subagent's chat is no longer available",
    );
    act((): void => root.unmount());
  });

  it('reports banner detail expansion changes to the host', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const onDetailsExpandedChange = jest.fn();
    act((): void =>
      root.render(
        <SubagentChatPanel
          {...props({ onDetailsExpandedChange })}
          onDetailsExpandedChange={onDetailsExpandedChange}
        />,
      ),
    );

    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="subagent-chat-details-toggle"]',
    );
    if (!toggle) throw new Error('details toggle not rendered');
    act((): void => toggle.click());
    act((): void => toggle.click());

    expect(onDetailsExpandedChange.mock.calls).toEqual([[true], [false]]);
    act((): void => root.unmount());
  });
});
