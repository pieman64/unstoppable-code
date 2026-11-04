/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import type {
  AgentDelegationSnapshot,
  DelegationWorkspaceChanges,
} from '@canopy/protocol/delegation';
import {
  DelegatedAgentCard,
  delegatedAgentRouteMetadata,
} from '../DelegatedAgentCard';
import { hideDelegationTransportParts } from '../../../lib/delegation-display';
import { ChatLookProvider } from '../../chat-look';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const route: AgentDelegationSnapshot['routeSnapshot'] = {
  selectedModelId: 'hidden-agent',
  selectedModelLabel: 'Historical reviewer',
  runtimeModelId: 'old-model',
  harnessId: 'future-harness',
  runtimeKind: 'local',
  runnerRegistrationId: 'runner',
  runtimeVersion: '1',
  adapterVersion: '1',
  modelSource: 'agent',
  providerType: 'custom',
  assignmentRevision: '1',
  billingAuthority: 'native',
  aiCreditsRouted: false,
  capabilities: [],
  supportedThinkingLevels: [],
  capabilitySnapshotHash: 'hash',
  capabilityGeneration: 1,
  policyRevision: '1',
};
const card = {
  delegationId: 'child',
  parentToolCallId: 'spawn',
  parentHarnessId: 'codex',
  description: 'Review source',
  prompt: 'Read source',
  executionMode: 'background' as const,
  status: 'completed' as const,
  outputTruncated: false,
  routeSnapshot: route,
};

const capabilitySummary: NonNullable<AgentDelegationSnapshot['capabilities']> =
  {
    inherit: true,
    discovery: false,
    items: [
      { kind: 'skill', name: 'Inherited one', source: 'inherited' },
      { kind: 'plugin', name: 'Inherited two', source: 'inherited' },
      { kind: 'skill', name: 'Assigned skill', source: 'explicit' },
      { kind: 'mcp', name: 'Loaded server', source: 'loaded' },
    ],
    skipped: [
      { kind: 'plugin', name: 'Skipped plugin', reason: 'missing_selection' },
      {
        kind: 'skill',
        name: 'Skipped skill',
        reason: 'unsupported_capability',
      },
    ],
  };

const queuedCases: readonly {
  queue: NonNullable<AgentDelegationSnapshot['queue']>;
  detail: string;
}[] = [
  {
    queue: { id: 'default', name: 'Default', position: 1 },
    detail: 'Up next',
  },
  {
    queue: { id: 'default', name: 'Default', position: 3 },
    detail: '2 tasks ahead',
  },
  {
    queue: { id: 'default', name: 'Default', position: 2 },
    detail: '1 task ahead',
  },
  {
    queue: { id: 'default', name: 'Default', waitingFor: 'app' },
    detail: 'App limit reached',
  },
];

const pendingSnapshots: readonly AgentDelegationSnapshot[] = [
  { ...card, status: 'pending', phase: 'starting' },
  { ...card, status: 'pending' },
];

function renderDelegatedCard(
  snapshot: AgentDelegationSnapshot,
  options: { waitingOnParent?: boolean } = {},
): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement('div');
  const root = createRoot(container);
  act((): void => {
    root.render(
      <ChatLookProvider value="classic">
        <DelegatedAgentCard
          snapshot={snapshot}
          parentHarnessId="codex"
          description="Review source"
          prompt="Read source"
          executionMode="background"
          waitingOnParent={options.waitingOnParent}
        />
      </ChatLookProvider>,
    );
  });
  return { container, root };
}

function expandDelegatedCard(container: HTMLDivElement): void {
  act((): void => {
    container
      .querySelector<HTMLButtonElement>('[aria-label="Expand delegated task"]')
      ?.click();
  });
}

it('memoizes the delegated task card rendered in streaming chat lists', () => {
  expect(DelegatedAgentCard).toHaveProperty(
    '$$typeof',
    Symbol.for('react.memo'),
  );
});

it('shows depth and immediate parent in the collapsed agent card', () => {
  const html = renderToString(
    <ChatLookProvider value="classic">
      <DelegatedAgentCard
        snapshot={{
          ...card,
          depth: 2,
          parentDelegationId: 'parent-agent',
          parentDescription: 'Review API',
        }}
        parentHarnessId="codex"
        description="Review source"
        prompt="Read source"
        executionMode="background"
      />
    </ChatLookProvider>,
  );
  expect(html).toContain('Depth 2');
  expect(html).toContain('Parent: Review API');
});

it.each([{}, { depth: 1 }])(
  'omits the lineage for a direct child of this chat (%o)',
  (lineage) => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <DelegatedAgentCard
          snapshot={{ ...card, ...lineage }}
          parentHarnessId="codex"
          description="Review source"
          prompt="Read source"
          executionMode="background"
        />
      </ChatLookProvider>,
    );
    expect(html).not.toContain('delegated-agent-lineage');
    expect(html).not.toContain('Depth 1');
    expect(html).not.toContain('Parent: This chat');
    expect(html).toContain('Historical reviewer');
  },
);

it.each([{}, { depth: 2, parentDelegationId: 'parent-agent' }])(
  'keeps the header left aligned while awaiting approval (%o)',
  (lineage) => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() =>
      root.render(
        <ChatLookProvider value="classic">
          <DelegatedAgentCard
            snapshot={{
              ...card,
              ...lineage,
              status: 'running',
              approvalPending: true,
            }}
            parentHarnessId="codex"
            description="Review source"
            prompt="Read source"
            executionMode="background"
          />
        </ChatLookProvider>,
      ),
    );
    const header = container.querySelector<HTMLButtonElement>(
      '[aria-label="Expand delegated task"]',
    );
    const status = container.querySelector('[role="status"]');
    // The status is pushed to the end of the row; only it may be right
    // aligned, never the agent label that precedes it.
    expect(status?.textContent).toBe('Awaiting approval');
    expect(status?.className).toContain('ml-auto');
    expect(header?.lastElementChild).toBe(status);
    expect(header?.textContent?.indexOf('Agent')).toBeLessThan(
      header?.textContent?.indexOf('Awaiting approval') ?? -1,
    );
    act(() => root.unmount());
  },
);

it('shows the stable settled result index', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() =>
    root.render(
      <ChatLookProvider value="classic">
        <DelegatedAgentCard
          snapshot={{ ...card, resultIndex: 3 }}
          parentHarnessId="codex"
          description="Review source"
          prompt="Read source"
          executionMode="background"
        />
      </ChatLookProvider>,
    ),
  );
  act(() => {
    container
      .querySelector<HTMLButtonElement>('[aria-label="Expand delegated task"]')
      ?.click();
  });
  expect(container.textContent).toContain('Result 3');
  act(() => root.unmount());
});

it('shows a complete queued status without live queue fields and no spinner', (): void => {
  const { container, root } = renderDelegatedCard({
    ...card,
    status: 'pending',
    phase: 'queued',
    queue: { id: 'default', name: 'Default' },
  });
  const status = container.querySelector<HTMLElement>(
    '[data-testid="delegated-agent-queue-status"]',
  );
  expect(status?.textContent).toBe('Queued');
  // A run state takes an operational status role, not the brand accent.
  expect(status?.classList.contains('fg-secondary')).toBe(true);
  expect(container.querySelector('[aria-label="Thinking"]')).toBeNull();
  act((): void => root.unmount());
});

it.each(queuedCases)('shows queued detail: %s', ({ queue, detail }): void => {
  const { container, root } = renderDelegatedCard({
    ...card,
    status: 'pending',
    phase: 'queued',
    queue,
  });
  expect(
    container.querySelector<HTMLElement>(
      '[data-testid="delegated-agent-queue-status"]',
    )?.textContent,
  ).toBe(`Queued · ${detail}`);
  expect(container.querySelector('[aria-label="Thinking"]')).toBeNull();
  act((): void => root.unmount());
});

it.each(pendingSnapshots)(
  'keeps the spinner for a pending task outside the queued phase',
  (snapshot): void => {
    const { container, root } = renderDelegatedCard(snapshot);
    expect(
      container.querySelector('[data-testid="delegated-agent-queue-status"]'),
    ).toBeNull();
    expect(container.querySelector('[aria-label="Thinking"]')).not.toBeNull();
    act((): void => root.unmount());
  },
);

it('keeps approval status ahead of the queued status', (): void => {
  const { container, root } = renderDelegatedCard({
    ...card,
    status: 'pending',
    phase: 'queued',
    queue: { id: 'default', name: 'Default' },
    approvalPending: true,
  });
  expect(container.textContent).toContain('Awaiting approval');
  expect(
    container.querySelector('[data-testid="delegated-agent-queue-status"]'),
  ).toBeNull();
  expect(container.querySelector('[aria-label="Thinking"]')).toBeNull();
  act((): void => root.unmount());
});

describe('waiting for the parent', () => {
  const running: AgentDelegationSnapshot = {
    ...card,
    status: 'running',
  };
  const waitingLine = (container: HTMLDivElement): HTMLElement | null =>
    container.querySelector<HTMLElement>(
      '[data-testid="delegated-agent-waiting-on-parent"]',
    );

  it('shows one quiet line while its request waits for the parent', (): void => {
    const { container, root } = renderDelegatedCard(running, {
      waitingOnParent: true,
    });
    const line = waitingLine(container);
    expect(line?.textContent).toBe('Waiting for the parent');
    expect(line?.getAttribute('role')).toBe('status');
    expect(line?.classList.contains('fg-secondary')).toBe(true);
    expect(
      container.querySelectorAll(
        '[data-testid="delegated-agent-waiting-on-parent"]',
      ),
    ).toHaveLength(1);
    act((): void => root.unmount());
  });

  it('omits the line when the host does not say the delegate is waiting', (): void => {
    for (const waitingOnParent of [undefined, false]) {
      const { container, root } = renderDelegatedCard(running, {
        waitingOnParent,
      });
      expect(waitingLine(container)).toBeNull();
      act((): void => root.unmount());
    }
  });

  it('takes the place of the queued status and yields to approval', (): void => {
    const queued = renderDelegatedCard(
      {
        ...card,
        status: 'pending',
        phase: 'queued',
        queue: { id: 'default', name: 'Default' },
      },
      { waitingOnParent: true },
    );
    expect(waitingLine(queued.container)).not.toBeNull();
    expect(
      queued.container.querySelector(
        '[data-testid="delegated-agent-queue-status"]',
      ),
    ).toBeNull();
    act((): void => queued.root.unmount());
    const approval = renderDelegatedCard(
      { ...running, approvalPending: true },
      { waitingOnParent: true },
    );
    expect(approval.container.textContent).toContain('Awaiting approval');
    expect(waitingLine(approval.container)).toBeNull();
    act((): void => approval.root.unmount());
  });

  it('keeps the settled outcome once the delegate has finished', (): void => {
    const { container, root } = renderDelegatedCard(
      { ...card, status: 'completed' },
      { waitingOnParent: true },
    );
    expect(waitingLine(container)).toBeNull();
    act((): void => root.unmount());
  });

  it('never renders the request itself', (): void => {
    const { container, root } = renderDelegatedCard(running, {
      waitingOnParent: true,
    });
    expect(container.textContent).not.toContain('system_instruction');
    expect(waitingLine(container)?.textContent).toBe('Waiting for the parent');
    act((): void => root.unmount());
  });
});

it('shows capability summary and details in the expanded card', (): void => {
  const { container, root } = renderDelegatedCard({
    ...card,
    capabilities: capabilitySummary,
  });
  expandDelegatedCard(container);
  const capabilities = container.querySelector<HTMLElement>(
    '[data-testid="delegated-agent-capabilities"]',
  );
  expect(capabilities?.textContent).toContain(
    'Inherited 2 · Assigned 1 · Loaded 1 · 2 skipped',
  );
  act((): void => {
    container
      .querySelector<HTMLButtonElement>(
        '[data-testid="delegated-agent-capabilities-toggle"]',
      )
      ?.click();
  });
  expect(
    container.querySelector(
      '[data-testid="delegated-agent-capability-inherited"]',
    ),
  ).not.toBeNull();
  expect(
    container.querySelector(
      '[data-testid="delegated-agent-capability-explicit"]',
    ),
  ).not.toBeNull();
  expect(
    container.querySelector(
      '[data-testid="delegated-agent-capability-loaded"]',
    ),
  ).not.toBeNull();
  expect(
    container.querySelector(
      '[data-testid="delegated-agent-capability-skipped"]',
    ),
  ).not.toBeNull();
  act((): void => root.unmount());
});

it('omits an empty delegated capability summary', (): void => {
  const emptySummary: NonNullable<AgentDelegationSnapshot['capabilities']> = {
    inherit: true,
    discovery: false,
    items: [],
    skipped: [],
  };
  const snapshots: readonly AgentDelegationSnapshot[] = [
    { ...card, capabilities: emptySummary },
    { ...card },
  ];
  for (const snapshot of snapshots) {
    const { container, root } = renderDelegatedCard(snapshot);
    expandDelegatedCard(container);
    expect(
      container.querySelector('[data-testid="delegated-agent-capabilities"]'),
    ).toBeNull();
    act((): void => root.unmount());
  }
});

it.each([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'deadline_exceeded',
] as const)(
  'renders canonical %s metadata without native resume actions',
  (status) => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <DelegatedAgentCard
          snapshot={{ ...card, status }}
          parentHarnessId="codex"
          description="Review source"
          prompt="Read source"
          executionMode="background"
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('chat-delegated-agent');
    expect(html).toContain('Historical reviewer');
    expect(html).toContain('future-harness');
    if (status === 'running' || status === 'pending') {
      expect(html).toContain('aria-label="Thinking"');
      expect(html).not.toContain('>Running<');
    } else if (status === 'completed') {
      expect(html).not.toContain('Completed');
      expect(html).not.toContain('aria-label="Thinking"');
    } else {
      expect(html).toContain(
        status === 'deadline_exceeded'
          ? 'Deadline exceeded'
          : status[0].toUpperCase() + status.slice(1),
      );
    }
    expect(html).not.toContain('Open in');
    expect(html).not.toContain('Copy native session ID');
  },
);

it('renders stable preparation metadata before route resolution', () => {
  expect(
    delegatedAgentRouteMetadata({
      ...card,
      status: 'pending',
      routeSnapshot: undefined,
    }),
  ).toEqual({ selected: 'Preparing model', runtime: 'Preparing' });
});

it('uses a theme-safe inset ring for the metadata separator', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() =>
    root.render(
      <ChatLookProvider value="classic">
        <DelegatedAgentCard
          snapshot={card}
          parentHarnessId="codex"
          description="Review source"
          prompt="Read source"
          executionMode="background"
        />
      </ChatLookProvider>,
    ),
  );
  act(() => {
    container
      .querySelector<HTMLButtonElement>('[aria-label="Expand delegated task"]')
      ?.click();
  });
  const metadata = container.querySelector<HTMLElement>(
    '[data-testid="delegated-agent-metadata"]',
  );
  expect(metadata?.className).toContain(
    'inset-ring-[length:var(--border-hairline)]',
  );
  expect(metadata?.className).toContain('inset-ring-line-base');
  expect(metadata?.className).not.toContain('border-border');
  act(() => root.unmount());
});

it('replaces only the matching native transport call and receipt, retaining other activity', () => {
  const messages = [
    { text: '', parts: [{ kind: 'tool_use', data: { toolUseId: 'spawn' } }] },
    {
      text: 'raw receipt',
      parts: [{ kind: 'tool_result', data: { toolUseId: 'spawn' } }],
    },
    { text: '', parts: [{ kind: 'agent', data: { delegation: card } }] },
    {
      text: 'Parent answer',
      parts: [{ kind: 'tool_use', data: { toolUseId: 'read' } }],
    },
  ];
  expect(hideDelegationTransportParts(messages)).toEqual(messages.slice(2));
  expect(hideDelegationTransportParts(messages.slice(0, 2))).toEqual(
    messages.slice(0, 2),
  );
});

describe('row Stop', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  function renderCard(
    snapshot: AgentDelegationSnapshot,
    props: {
      onStop?: () => Promise<boolean>;
      hasLiveDescendants?: boolean;
    } = {},
  ): void {
    act(() =>
      root.render(
        <ChatLookProvider value="classic">
          <DelegatedAgentCard
            snapshot={snapshot}
            parentHarnessId="codex"
            description="Review source"
            prompt="Read source"
            executionMode="background"
            {...props}
          />
        </ChatLookProvider>,
      ),
    );
  }

  function stopButton(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(
      '[data-testid="delegated-agent-stop"]',
    );
  }

  function hoverStop(): void {
    act(() => {
      stopButton()?.parentElement?.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true }),
      );
    });
  }

  it.each<AgentDelegationSnapshot>([
    { ...card, status: 'pending', phase: 'queued' },
    { ...card, status: 'pending', phase: 'starting' },
    { ...card, status: 'running' },
    { ...card, status: 'running', approvalPending: true },
  ])('offers Stop while the delegation is live (%o)', (snapshot) => {
    renderCard(snapshot, { onStop: jest.fn().mockResolvedValue(true) });
    const stop = stopButton();
    expect(stop).not.toBeNull();
    expect(stop?.getAttribute('aria-label')).toBe('Stop delegation');
    expect(stop?.textContent).toBe('Stop');
    expect(stop?.disabled).toBe(false);
    // A sibling of the disclosure button, never nested inside it.
    expect(stop?.closest('[aria-label="Expand delegated task"]')).toBeNull();
  });

  it.each<AgentDelegationSnapshot['status']>([
    'completed',
    'failed',
    'cancelled',
    'interrupted',
    'deadline_exceeded',
  ])('omits Stop once the delegation is %s', (status) => {
    renderCard({ ...card, status }, { onStop: jest.fn() });
    expect(stopButton()).toBeNull();
  });

  it('omits Stop when the host cannot stop delegations (Portal)', () => {
    renderCard({ ...card, status: 'running' });
    expect(stopButton()).toBeNull();
  });

  it('stops without expanding the card', async () => {
    const onStop = jest.fn().mockResolvedValue(true);
    renderCard({ ...card, status: 'running' }, { onStop });
    await act(async () => {
      stopButton()?.click();
      await Promise.resolve();
    });
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('[aria-label="Collapse delegated task"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="delegated-agent-metadata"]'),
    ).toBeNull();
  });

  it.each([
    [false, 'Stop delegation'],
    [true, 'Stop delegation and the tasks it started'],
  ])(
    'names what Stop ends in its tooltip (live descendants: %s)',
    (hasLiveDescendants, tooltip) => {
      renderCard(
        { ...card, status: 'running' },
        { onStop: jest.fn().mockResolvedValue(true), hasLiveDescendants },
      );
      hoverStop();
      expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
        tooltip,
      );
    },
  );

  it('shows the stop is working and cannot be sent twice', async () => {
    let resolveStop: (accepted: boolean) => void = () => undefined;
    const onStop = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveStop = resolve;
        }),
    );
    renderCard({ ...card, status: 'running' }, { onStop });
    act(() => stopButton()?.click());
    expect(stopButton()?.textContent).toBe('Stopping…');
    expect(stopButton()?.disabled).toBe(true);
    act(() => stopButton()?.click());
    expect(onStop).toHaveBeenCalledTimes(1);

    // Accepted: it stays working until the row settles.
    await act(async () => {
      resolveStop(true);
      await Promise.resolve();
    });
    expect(stopButton()?.textContent).toBe('Stopping…');

    // Settled: the control is replaced by the outcome.
    renderCard({ ...card, status: 'cancelled' }, { onStop });
    expect(stopButton()).toBeNull();
    expect(
      container.querySelector('[data-testid="delegated-agent-status"]')
        ?.textContent,
    ).toBe('Cancelled');
  });

  it('re-enables Stop when the host could not stop the delegation', async () => {
    const onStop = jest.fn().mockResolvedValue(false);
    renderCard({ ...card, status: 'running' }, { onStop });
    await act(async () => {
      stopButton()?.click();
      await Promise.resolve();
    });
    expect(stopButton()?.textContent).toBe('Stop');
    expect(stopButton()?.disabled).toBe(false);
  });

  it('shows a stop an agent already requested as working', () => {
    renderCard(
      {
        ...card,
        status: 'running',
        stopRequested: { operationId: 'op-1', status: 'accepted' },
      },
      { onStop: jest.fn().mockResolvedValue(true) },
    );
    expect(stopButton()?.textContent).toBe('Stopping…');
    expect(stopButton()?.disabled).toBe(true);
  });
});

describe('stopped status', () => {
  it.each<[string, Partial<AgentDelegationSnapshot>, string]>([
    ['a user stop', { stopReason: 'user_cancelled' }, 'Cancelled'],
    [
      'a user stop recorded with its stopper',
      { stopReason: 'user_cancelled', stoppedBy: { kind: 'user' } },
      'Cancelled',
    ],
    ['a legacy cancellation', {}, 'Cancelled'],
    [
      'a parent agent stop',
      {
        stopReason: 'stopped_by_parent',
        stoppedBy: { kind: 'agent', depth: 1, delegationId: 'parent' },
      },
      'Stopped by parent',
    ],
    [
      'an ancestor stop',
      { stopReason: 'ancestor_stopped', stoppedBy: { kind: 'user' } },
      'Stopped by parent',
    ],
    [
      'a root agent stop',
      { stoppedBy: { kind: 'agent', depth: 0 } },
      'Stopped by parent',
    ],
  ])('labels %s', (_name, stop, label) => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <DelegatedAgentCard
          snapshot={{ ...card, status: 'cancelled', ...stop }}
          parentHarnessId="codex"
          description="Review source"
          prompt="Read source"
          executionMode="background"
        />
      </ChatLookProvider>,
    );
    expect(html).toContain(label);
    if (label === 'Stopped by parent') expect(html).not.toContain('Cancelled');
  });
});

describe('isolated delegate changes', () => {
  let container: HTMLDivElement;
  let root: Root;
  const isolated: AgentDelegationSnapshot = {
    ...card,
    isolatedWorkspace: {
      revision: 'a'.repeat(40),
      dirtyParentChangesIncluded: false,
    },
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderExpanded(
    snapshot: AgentDelegationSnapshot,
    onLoadChanges?: () => Promise<DelegationWorkspaceChanges>,
  ): void {
    act(() =>
      root.render(
        <ChatLookProvider value="classic">
          <DelegatedAgentCard
            snapshot={snapshot}
            parentHarnessId="codex"
            description="Review source"
            prompt="Read source"
            executionMode="background"
            onLoadChanges={onLoadChanges}
          />
        </ChatLookProvider>,
      ),
    );
    expandDelegatedCard(container);
  }

  function showChanges(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(
      '[data-testid="delegated-agent-show-changes"]',
    );
  }

  it('reads changes only when asked and lists each file with its diff', async () => {
    const onLoadChanges = jest.fn().mockResolvedValue({
      files: [
        {
          path: 'src/a.ts',
          change: 'modified',
          diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n',
        },
        { path: '.env.local', change: 'added' },
        {
          path: 'src/b.ts',
          change: 'deleted',
          diff: '--- a/src/b.ts\n+++ /dev/null\n',
          diffTruncated: true,
        },
      ],
      omittedFiles: 4,
    } satisfies DelegationWorkspaceChanges);
    renderExpanded(isolated, onLoadChanges);
    expect(onLoadChanges).not.toHaveBeenCalled();
    expect(showChanges()?.textContent).toBe('Show changes');

    await act(async () => {
      showChanges()?.click();
      await Promise.resolve();
    });
    expect(onLoadChanges).toHaveBeenCalledTimes(1);
    const files = Array.from(
      container.querySelectorAll('[data-testid="delegated-change"]'),
    );
    const toggles = files.map((file) =>
      file.querySelector<HTMLButtonElement>(
        '[data-testid="delegated-change-toggle"]',
      ),
    );
    expect(toggles.map((toggle) => toggle?.textContent)).toEqual([
      'src/a.ts · modified',
      '.env.local · added',
      'src/b.ts · deleted',
    ]);
    expect(
      toggles.map((toggle) => toggle?.getAttribute('aria-expanded')),
    ).toEqual(['false', 'false', 'false']);
    act(() => toggles.forEach((toggle) => toggle?.click()));
    expect(files[0]?.querySelector('pre')?.textContent).toContain('+new');
    expect(files[1]?.textContent).toContain('No diff shown for this file');
    expect(files[2]?.textContent).toContain('Diff shortened to fit');
    expect(container.textContent).toContain('Showing first 3 files');
  });

  it('says when the worktree has no changes and can read them again', async () => {
    const onLoadChanges = jest.fn().mockResolvedValue({ files: [] });
    renderExpanded(isolated, onLoadChanges);
    await act(async () => {
      showChanges()?.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain(
      "No changes in the delegate's worktree",
    );
    const refresh = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Refresh changes',
    );
    await act(async () => {
      refresh?.click();
      await Promise.resolve();
    });
    expect(onLoadChanges).toHaveBeenCalledTimes(2);
  });

  it('reports a failed read and offers to try again', async () => {
    const onLoadChanges = jest
      .fn()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue({ files: [] });
    renderExpanded(isolated, onLoadChanges);
    await act(async () => {
      showChanges()?.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain(
      "Couldn't read the delegate's changes.",
    );
    expect(showChanges()?.textContent).toBe('Try again');
    await act(async () => {
      showChanges()?.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain(
      "No changes in the delegate's worktree",
    );
  });

  it.each<[string, AgentDelegationSnapshot, boolean]>([
    ['a shared delegate', card, true],
    ['a discarded worktree', { ...isolated, workspaceDiscarded: true }, true],
    ['a host that cannot read worktrees (Portal)', isolated, false],
  ])('offers no changes for %s', (_case, snapshot, hostCanRead) => {
    renderExpanded(
      snapshot,
      hostCanRead ? jest.fn().mockResolvedValue({ files: [] }) : undefined,
    );
    expect(showChanges()).toBeNull();
  });
});

it('shows a watcher-started run without its hidden payload', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <ChatLookProvider value="classic">
        <DelegatedAgentCard
          snapshot={card}
          parentHarnessId="codex"
          description="Review source"
          prompt={[
            '<system_instruction>',
            'Canopy watcher internal event details.',
            '<canopy_watcher_event>',
            JSON.stringify({
              watcherId: 'watcher-1',
              label: 'Delegate completion',
              target: { kind: 'managed_delegation', outcome: 'completed' },
            }),
            '</canopy_watcher_event>',
            '</system_instruction>',
          ].join('\n')}
          executionMode="background"
        />
      </ChatLookProvider>,
    ),
  );
  const expand = container.querySelector<HTMLElement>(
    '[aria-label="Expand delegated task"]',
  );
  act(() => expand?.click());
  const showPrompt = Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === 'Show prompt',
  );
  act(() => showPrompt?.click());
  expect(container.textContent).toContain(
    'Delegate watch completed watcher has fired',
  );
  expect(container.textContent).toContain('Delegate completion');
  expect(container.textContent).not.toContain('watcher-1');
  expect(container.textContent).not.toContain('system_instruction');
  act(() => root.unmount());
  container.remove();
});
