/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  SubagentNode,
  SubagentRecipient,
  SubagentTree,
} from '@canopy/ui-shared';
import {
  subagentRecipientRelationLabel,
  subagentRecipients,
  subagentRootChatStateLabel,
  withSubagentReference,
} from '@canopy/ui-shared';
import type {
  SubagentCommandResult,
  SubagentMessageRequest,
  SubagentMessageResult,
  SubagentNativeInterruptResult,
} from '../../types';
import {
  SubagentComposer,
  type SubagentComposerProps,
} from '../SubagentComposer';
import {
  SubagentChatPanel,
  type SubagentChatPanelProps,
} from '../SubagentChatPanel';
import {
  forgetSubagentDrafts,
  getSubagentComposerDraft,
  subagentDraftKey,
  useSubagentComposerStore,
} from '../subagent-composer-store';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function node(
  id: string,
  title: string,
  kind: SubagentNode['kind'],
  parentId: string | null,
  childIds: readonly string[],
  status: SubagentNode['status'],
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
    ...(kind === 'managed' ? { workspace: 'shared' as const } : {}),
  };
}

type CurrentControl = NonNullable<
  NonNullable<SubagentNode['snapshot']>['control']
>;

function makeTree(
  status: SubagentNode['status'] = 'completed',
  currentKind: SubagentNode['kind'] = 'managed',
  currentRunGenerations: readonly number[] = [1],
  currentControl?: CurrentControl,
): SubagentTree {
  const parent = node(
    'parent',
    'Two levels up',
    'managed',
    null,
    ['ancestor'],
    'completed',
  );
  const ancestor = node(
    'ancestor',
    'Parent task',
    'managed',
    'parent',
    ['current'],
    'running',
  );
  const current: SubagentNode = {
    ...node('current', 'Selected task', currentKind, 'ancestor', [], status),
    ...(currentKind === 'managed'
      ? {
          runs: currentRunGenerations.map((runGeneration) => ({
            runGeneration,
          })),
        }
      : {}),
    ...(currentControl
      ? {
          snapshot: {
            delegationId: 'current',
            status: status === 'completed' ? 'completed' : 'running',
            outputTruncated: false,
            control: currentControl,
          },
        }
      : {}),
  };
  return {
    root: { id: 'root-chat', title: 'Root chat' },
    nodes: new Map([
      [parent.id, parent],
      [ancestor.id, ancestor],
      [current.id, current],
    ]),
    rootChildIds: [parent.id],
    complete: true,
  };
}

const defaultCapabilities = {
  stop: true,
  messaging: true,
  worktreeDetails: true,
  nativeInterrupt: true,
  openWorkflow: true,
  stopWorkflow: true,
};

function panelProps(
  selectedTree: SubagentTree,
  overrides: Partial<SubagentChatPanelProps> = {},
): SubagentChatPanelProps {
  return {
    tree: selectedTree,
    subagentId: 'current',
    capabilities: defaultCapabilities,
    transcript: <p>Transcript</p>,
    onOpenLineage: (): void => {},
    createOperationId: (): string => 'test-operation',
    ...overrides,
  };
}

interface PanelHarness {
  readonly container: HTMLDivElement;
  readonly render: (props: SubagentChatPanelProps) => void;
  readonly unmount: () => void;
}

const mountedPanels: Array<() => void> = [];

function mountPanel(initialProps: SubagentChatPanelProps): PanelHarness {
  const container = document.createElement('div');
  const root = createRoot(container);
  let mounted = true;
  const render = (nextProps: SubagentChatPanelProps): void => {
    act((): void => root.render(<SubagentChatPanel {...nextProps} />));
  };
  render(initialProps);
  const unmount = (): void => {
    if (!mounted) return;
    mounted = false;
    act((): void => root.unmount());
  };
  mountedPanels.push(unmount);
  return {
    container,
    render,
    unmount,
  };
}

function resetStore(): void {
  act((): void => useSubagentComposerStore.setState({ drafts: {} }));
}

function click(container: Element, testId: string): void {
  const selector = `[data-testid="${testId}"]`;
  const element =
    container.querySelector<HTMLButtonElement>(selector) ??
    document.body.querySelector<HTMLButtonElement>(selector);
  if (!element) throw new Error(`missing ${testId}`);
  act((): void => element.click());
}

function enterText(container: Element, text: string): void {
  const input = container.querySelector<HTMLTextAreaElement>(
    '[data-testid="subagent-composer-input"]',
  );
  if (!input) throw new Error('missing composer input');
  act((): void => {
    // Use the native setter so React's value tracker observes the input event.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function pressEnter(container: Element): void {
  const input = container.querySelector<HTMLTextAreaElement>(
    '[data-testid="subagent-composer-input"]',
  );
  if (!input) throw new Error('missing composer input');
  act((): void => {
    input.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }),
    );
  });
}

describe('SubagentComposer in the shared panel', () => {
  beforeEach((): void => {
    resetStore();
    document.body.innerHTML = '';
  });

  afterEach((): void => {
    mountedPanels.splice(0).forEach((unmount) => unmount());
    resetStore();
    document.body.innerHTML = '';
  });

  it('forgets only the drafts belonging to a deleted root chat', () => {
    const store = useSubagentComposerStore.getState();
    const deletedKey = subagentDraftKey('deleted-root', 'one');
    const retainedKey = subagentDraftKey('retained-root', 'two');
    store.setInput(deletedKey, 'delete me');
    store.setInput(retainedKey, 'keep me');
    forgetSubagentDrafts('deleted-root');
    expect(getSubagentComposerDraft(deletedKey).input).toBe('');
    expect(getSubagentComposerDraft(retainedKey).input).toBe('keep me');
  });

  it('shows Interrupt only for a live self-recipient with an empty input', () => {
    const requests: SubagentMessageRequest[] = [];
    const liveHarness = mountPanel(
      panelProps(makeTree('running'), {
        onMessageSubagent: (
          request: SubagentMessageRequest,
        ): Promise<SubagentMessageResult> => {
          requests.push(request);
          return Promise.resolve({ ok: true });
        },
      }),
    );
    expect(
      liveHarness.container.querySelector(
        '[data-testid="subagent-composer-interrupt"]',
      ),
    ).not.toBeNull();
    click(liveHarness.container, 'subagent-composer-interrupt');
    enterText(liveHarness.container, 'Please check');
    expect(
      liveHarness.container.querySelector(
        '[data-testid="subagent-composer-send"]',
      ),
    ).not.toBeNull();
    expect(
      liveHarness.container.querySelector(
        '[data-testid="subagent-composer-interrupt"]',
      ),
    ).toBeNull();
    expect(requests[0]).toEqual({
      operation: 'interrupt',
      operationId: 'test-operation',
    });
    liveHarness.unmount();

    resetStore();
    const settledHarness = mountPanel(
      panelProps(makeTree('completed'), {
        onMessageSubagent: (): Promise<SubagentMessageResult> =>
          Promise.resolve({ ok: true }),
      }),
    );
    expect(
      settledHarness.container.querySelector(
        '[data-testid="subagent-composer-send"]',
      ),
    ).not.toBeNull();
    settledHarness.unmount();
  });

  it('lists self, nearest parent and root in tree order with relation and root state labels', () => {
    const recipients = subagentRecipients(makeTree(), 'current');
    expect(recipients.map((recipient) => recipient.id)).toEqual([
      'current',
      'ancestor',
      'parent',
      'root-chat',
    ]);
    expect(recipients.map(subagentRecipientRelationLabel)).toEqual([
      'This subagent',
      'Parent',
      '2 levels up',
      'Root chat',
    ]);
    expect(subagentRootChatStateLabel(true)).toBe('Working');
    expect(subagentRootChatStateLabel(false)).toBe('Idle');

    const harness = mountPanel(
      panelProps(makeTree('running'), {
        rootChatBusy: true,
        onMessageSubagent: (): Promise<SubagentMessageResult> =>
          Promise.resolve({ ok: true }),
      }),
    );
    click(harness.container, 'subagent-composer-to');
    const options = Array.from(
      document.body.querySelectorAll(
        '[data-testid^="subagent-composer-to-option-"]',
      ),
    );
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('This subagent'),
      expect.stringContaining('Parent'),
      expect.stringContaining('2 levels up · Done'),
      expect.stringContaining('Root chat · Working'),
    ]);
    harness.unmount();
  });

  it('sends a root-chat message once while its delivery is pending', async () => {
    const key = subagentDraftKey('root-chat', 'current');
    act((): void =>
      useSubagentComposerStore.getState().setRecipientId(key, 'root-chat'),
    );
    const sent: string[] = [];
    let resolveSend: ((result: SubagentCommandResult) => void) | undefined;
    const harness = mountPanel(
      panelProps(makeTree('running'), {
        onSendToRecipient: (
          _recipient: SubagentRecipient,
          text: string,
        ): Promise<SubagentCommandResult> => {
          sent.push(text);
          return new Promise((resolve) => {
            resolveSend = resolve;
          });
        },
      }),
    );
    enterText(harness.container, 'Please review this');
    const sendButton = harness.container.querySelector<HTMLButtonElement>(
      '[data-testid="subagent-composer-send"]',
    );
    if (!sendButton) throw new Error('missing send button');
    act((): void => {
      sendButton.click();
      sendButton.click();
    });
    expect(sent).toHaveLength(1);
    expect(sendButton.disabled).toBe(true);

    act((): void => resolveSend?.({ ok: true }));
    await flush();
    expect(sent).toHaveLength(1);
    expect(
      harness.container.querySelector<HTMLTextAreaElement>(
        '[data-testid="subagent-composer-input"]',
      )?.value,
    ).toBe('');
    harness.unmount();
  });

  it('sends a workflow-agent message to the only root-chat recipient', async () => {
    const workflowAgent: SubagentNode = {
      id: 'workflow-agent',
      kind: 'workflow-agent',
      parentId: 'workflow-phase',
      depth: 3,
      title: 'Review agent',
      status: 'completed',
      childIds: [],
      liveDescendantCount: 0,
      approvalPending: false,
      runs: [],
      workflow: {
        runId: 'wf_root-only',
        runName: 'Review workflow',
        runOrdinal: 1,
        runCount: 1,
        phaseCount: 1,
        phaseTitle: 'Review',
        phaseIndex: 0,
        agentPosition: 1,
        agentCount: 1,
      },
    };
    const phase: SubagentNode = {
      ...node(
        'workflow-phase',
        'Review',
        'workflow-phase',
        'workflow-run',
        ['workflow-agent'],
        'completed',
      ),
      workflow: workflowAgent.workflow,
    };
    const run: SubagentNode = {
      ...node(
        'workflow-run',
        'Review workflow',
        'workflow-run',
        null,
        ['workflow-phase'],
        'completed',
      ),
      workflow: workflowAgent.workflow,
    };
    const selectedTree: SubagentTree = {
      root: { id: 'root-chat', title: 'Root chat' },
      nodes: new Map([
        [run.id, run],
        [phase.id, phase],
        [workflowAgent.id, workflowAgent],
      ]),
      rootChildIds: [run.id],
      complete: true,
    };
    const rootRecipient: SubagentRecipient = {
      id: 'root-chat',
      kind: 'root',
      title: 'Root chat',
      levelsUp: 3,
      canMessage: true,
    };
    const recipients: readonly SubagentRecipient[] = [rootRecipient];
    const sent: Array<{
      readonly recipient: SubagentRecipient;
      readonly text: string;
    }> = [];
    const container = document.createElement('div');
    const root = createRoot(container);
    const composerProps: SubagentComposerProps = {
      rootChatId: selectedTree.root.id,
      tree: selectedTree,
      node: workflowAgent,
      capabilities: defaultCapabilities,
      recipients,
      onSendToRecipient: (
        recipient: SubagentRecipient,
        text: string,
      ): Promise<SubagentCommandResult> => {
        sent.push({ recipient, text });
        return Promise.resolve({ ok: true });
      },
    };
    act((): void => root.render(<SubagentComposer {...composerProps} />));

    expect(
      container.querySelector('[data-testid="subagent-composer-to"]')
        ?.textContent,
    ).toContain('Root chat');
    const input = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="subagent-composer-input"]',
    );
    expect(input?.disabled).toBe(false);
    expect(
      container.querySelector('[data-testid="subagent-composer-interrupt"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="subagent-composer-send"]'),
    ).not.toBeNull();
    enterText(container, 'Check this workflow result');
    click(container, 'subagent-composer-send');
    await flush();
    expect(sent).toEqual([
      {
        recipient: rootRecipient,
        text: withSubagentReference(
          {
            kind: 'workflow-agent',
            id: workflowAgent.id,
            title: workflowAgent.title,
          },
          'Check this workflow result',
        ),
      },
    ]);

    act((): void => root.unmount());
  });

  it('sends a referenced parent message, clears on success and retains text on failure', async () => {
    const key = subagentDraftKey('root-chat', 'current');
    act((): void =>
      useSubagentComposerStore.getState().setRecipientId(key, 'root-chat'),
    );
    const sent: string[] = [];
    const responses: SubagentCommandResult[] = [
      { ok: true },
      { ok: false, error: 'Root chat is unavailable' },
    ];
    const harness = mountPanel(
      panelProps(makeTree('running'), {
        onSendToRecipient: (
          _recipient: SubagentRecipient,
          text: string,
        ): Promise<SubagentCommandResult> => {
          sent.push(text);
          return Promise.resolve(responses.shift() ?? { ok: true });
        },
      }),
    );
    enterText(harness.container, 'Please review this');
    click(harness.container, 'subagent-composer-send');
    await flush();
    expect(sent[0]).toBe(
      withSubagentReference(
        { kind: 'managed', id: 'current', title: 'Selected task' },
        'Please review this',
      ),
    );
    expect(
      harness.container.querySelector<HTMLTextAreaElement>(
        '[data-testid="subagent-composer-input"]',
      )?.value,
    ).toBe('');

    enterText(harness.container, 'Keep this draft');
    click(harness.container, 'subagent-composer-send');
    await flush();
    expect(
      harness.container.querySelector<HTMLTextAreaElement>(
        '[data-testid="subagent-composer-input"]',
      )?.value,
    ).toBe('Keep this draft');
    expect(harness.container.textContent).toContain('Root chat is unavailable');
    harness.unmount();
  });

  it('retains a failed self follow-up draft and clears it after a successful retry', async () => {
    const results: SubagentMessageResult[] = [
      { ok: false, code: 'failed', error: 'Try again later' },
      { ok: true },
    ];
    const requests: SubagentMessageRequest[] = [];
    const harness = mountPanel(
      panelProps(makeTree('completed'), {
        onMessageSubagent: (
          request: SubagentMessageRequest,
        ): Promise<SubagentMessageResult> => {
          requests.push(request);
          return Promise.resolve(results.shift() ?? { ok: true });
        },
      }),
    );
    enterText(harness.container, 'Try this follow-up');
    click(harness.container, 'subagent-composer-send');
    await flush();
    expect(
      harness.container.querySelector<HTMLTextAreaElement>(
        '[data-testid="subagent-composer-input"]',
      )?.value,
    ).toBe('Try this follow-up');
    expect(harness.container.textContent).toContain('Try again later');

    click(harness.container, 'subagent-composer-send');
    await flush();
    expect(requests.map((request) => request.operation)).toEqual([
      'follow_up',
      'follow_up',
    ]);
    expect(
      harness.container.querySelector<HTMLTextAreaElement>(
        '[data-testid="subagent-composer-input"]',
      )?.value,
    ).toBe('');
    harness.unmount();
  });

  it('turns a busy direct send into a queued retry on the next status change', async () => {
    const requests: SubagentMessageRequest[] = [];
    const results: SubagentMessageResult[] = [
      { ok: false, code: 'busy', error: 'The run just started' },
      { ok: true },
    ];
    const harness = mountPanel(
      panelProps(makeTree('completed'), {
        onMessageSubagent: (request): Promise<SubagentMessageResult> => {
          requests.push(request);
          return Promise.resolve(results.shift() ?? { ok: true });
        },
      }),
    );
    enterText(harness.container, 'Keep this follow-up');
    click(harness.container, 'subagent-composer-send');
    await flush();
    expect(requests).toHaveLength(1);
    expect(
      harness.container.querySelector('[data-testid="subagent-queued-0"]')
        ?.textContent,
    ).toContain('Keep this follow-up');

    harness.render(
      panelProps(makeTree('running'), {
        onMessageSubagent: (request): Promise<SubagentMessageResult> => {
          requests.push(request);
          return Promise.resolve(results.shift() ?? { ok: true });
        },
      }),
    );
    harness.render(
      panelProps(makeTree('completed'), {
        onMessageSubagent: (request): Promise<SubagentMessageResult> => {
          requests.push(request);
          return Promise.resolve(results.shift() ?? { ok: true });
        },
      }),
    );
    await flush();
    expect(requests).toHaveLength(2);
    expect(requests[1]?.message).toBe('Keep this follow-up');
    expect(
      harness.container.querySelector('[data-testid="subagent-queued-0"]'),
    ).toBeNull();
    harness.unmount();
  });

  it('queues while live, steers one draft, interrupts another, then follows up after settle', async () => {
    const requests: SubagentMessageRequest[] = [];
    const send = (
      request: SubagentMessageRequest,
    ): Promise<SubagentMessageResult> => {
      requests.push(request);
      return Promise.resolve({ ok: true });
    };
    const harness = mountPanel(
      panelProps(makeTree('running'), { onMessageSubagent: send }),
    );
    enterText(harness.container, 'Steer now');
    pressEnter(harness.container);
    enterText(harness.container, 'Interrupt then follow up');
    pressEnter(harness.container);
    expect(
      harness.container.querySelectorAll('[data-testid^="subagent-queued-"]'),
    ).toHaveLength(2);

    const firstDraft = harness.container.querySelector(
      '[data-testid="subagent-queued-0"]',
    );
    const steer = firstDraft?.querySelector<HTMLButtonElement>(
      '[data-testid="queued-message-steer"]',
    );
    if (!steer) throw new Error('missing steer action');
    act((): void => steer.click());
    await flush();
    expect(requests[0]).toMatchObject({
      operation: 'steer',
      message: 'Steer now',
    });
    expect(requests[0]?.operationId).toBe('test-operation');
    // Accepted is not delivered: the draft stays until the control settles.
    expect(
      harness.container.querySelector('[data-testid="subagent-queued-0"]')
        ?.textContent,
    ).toContain('Steer now');
    harness.render(
      panelProps(
        makeTree('running', 'managed', [1], {
          operationId: 'test-operation',
          operation: 'steer',
          status: 'completed',
        }),
        { onMessageSubagent: send },
      ),
    );
    await flush();

    const secondDraft = harness.container.querySelector(
      '[data-testid="subagent-queued-0"]',
    );
    const interrupt = secondDraft?.querySelector<HTMLButtonElement>(
      '[data-testid="queued-message-interrupt"]',
    );
    if (!interrupt) throw new Error('missing queued interrupt action');
    act((): void => interrupt.click());
    await flush();
    expect(requests[1]).toMatchObject({ operation: 'interrupt' });
    expect(
      harness.container
        .querySelector('[data-testid="subagent-queued-0"]')
        ?.getAttribute('data-state'),
    ).toBe('awaiting-settle');

    harness.render(
      panelProps(makeTree('completed'), { onMessageSubagent: send }),
    );
    await flush();
    expect(requests[2]).toMatchObject({
      operation: 'follow_up',
      message: 'Interrupt then follow up',
    });
    expect(
      harness.container.querySelector('[data-testid="subagent-queued-0"]'),
    ).toBeNull();
    harness.unmount();
  });

  it('keeps a steered draft for retry when delivery of the steer fails', async () => {
    const requests: SubagentMessageRequest[] = [];
    const send = (
      request: SubagentMessageRequest,
    ): Promise<SubagentMessageResult> => {
      requests.push(request);
      return Promise.resolve({ ok: true });
    };
    const earlier = makeTree('running', 'managed', [1], {
      operationId: 'earlier-operation',
      operation: 'follow_up',
      status: 'completed',
    });
    const harness = mountPanel(
      panelProps(earlier, { onMessageSubagent: send }),
    );
    enterText(harness.container, 'Steer now');
    pressEnter(harness.container);
    const steer = harness.container.querySelector<HTMLButtonElement>(
      '[data-testid="subagent-queued-0"] [data-testid="queued-message-steer"]',
    );
    if (!steer) throw new Error('missing steer action');
    act((): void => steer.click());
    await flush();
    expect(requests).toHaveLength(1);
    // The tree still shows the control from before the steer.
    harness.render(panelProps(earlier, { onMessageSubagent: send }));
    await flush();
    expect(
      harness.container
        .querySelector('[data-testid="subagent-queued-0"]')
        ?.getAttribute('data-state'),
    ).toBe('sending');

    harness.render(
      panelProps(
        makeTree('running', 'managed', [1], {
          operationId: 'test-operation',
          operation: 'steer',
          status: 'failed',
          error: 'Active steering is unavailable',
        }),
        { onMessageSubagent: send },
      ),
    );
    await flush();

    const draft = harness.container.querySelector(
      '[data-testid="subagent-queued-0"]',
    );
    expect(draft?.textContent).toContain('Steer now');
    expect(draft?.getAttribute('data-state')).toBe('failed');
    expect(draft?.textContent).toContain('Active steering is unavailable');
    harness.unmount();
  });

  it('sends only the oldest queued draft on settle and advances after the next run settles', async () => {
    const requests: SubagentMessageRequest[] = [];
    const send = (
      request: SubagentMessageRequest,
    ): Promise<SubagentMessageResult> => {
      requests.push(request);
      return Promise.resolve({ ok: true });
    };
    const harness = mountPanel(
      panelProps(makeTree('running'), { onMessageSubagent: send }),
    );
    enterText(harness.container, 'First');
    pressEnter(harness.container);
    enterText(harness.container, 'Second');
    pressEnter(harness.container);

    harness.render(
      panelProps(makeTree('completed'), { onMessageSubagent: send }),
    );
    await flush();
    expect(requests.map((request) => request.message)).toEqual(['First']);
    expect(
      harness.container.querySelector('[data-testid="subagent-queued-0"]')
        ?.textContent,
    ).toContain('Second');

    harness.render(
      panelProps(makeTree('running'), { onMessageSubagent: send }),
    );
    await flush();
    expect(requests).toHaveLength(1);
    harness.render(
      panelProps(makeTree('completed'), { onMessageSubagent: send }),
    );
    await flush();
    expect(requests.map((request) => request.message)).toEqual([
      'First',
      'Second',
    ]);
    harness.unmount();
  });

  it('sends the next queued draft when a follow-up run settles before it is seen running', async () => {
    const requests: SubagentMessageRequest[] = [];
    const send = (
      request: SubagentMessageRequest,
    ): Promise<SubagentMessageResult> => {
      requests.push(request);
      return Promise.resolve({ ok: true });
    };
    const harness = mountPanel(
      panelProps(makeTree('running'), { onMessageSubagent: send }),
    );
    enterText(harness.container, 'First');
    pressEnter(harness.container);
    enterText(harness.container, 'Second');
    pressEnter(harness.container);

    harness.render(
      panelProps(makeTree('completed'), { onMessageSubagent: send }),
    );
    await flush();
    expect(requests.map((request) => request.message)).toEqual(['First']);

    // The follow-up's run started and settled between two tree refreshes.
    harness.render(
      panelProps(makeTree('completed', 'managed', [1, 2]), {
        onMessageSubagent: send,
      }),
    );
    await flush();
    expect(requests.map((request) => request.message)).toEqual([
      'First',
      'Second',
    ]);
    harness.unmount();
  });

  it('retries busy after another status change and offers Retry after a failed delivery', async () => {
    const requests: SubagentMessageRequest[] = [];
    const results: SubagentMessageResult[] = [
      { ok: false, code: 'busy', error: 'Still running' },
      { ok: false, code: 'failed', error: 'Delivery failed' },
      { ok: true },
    ];
    const send = (
      request: SubagentMessageRequest,
    ): Promise<SubagentMessageResult> => {
      requests.push(request);
      return Promise.resolve(results.shift() ?? { ok: true });
    };
    const harness = mountPanel(
      panelProps(makeTree('running'), { onMessageSubagent: send }),
    );
    enterText(harness.container, 'Retry me');
    pressEnter(harness.container);

    harness.render(
      panelProps(makeTree('completed'), { onMessageSubagent: send }),
    );
    await flush();
    expect(requests).toHaveLength(1);
    harness.render(
      panelProps(makeTree('running'), { onMessageSubagent: send }),
    );
    await flush();
    expect(requests).toHaveLength(1);
    harness.render(
      panelProps(makeTree('completed'), { onMessageSubagent: send }),
    );
    await flush();
    expect(requests).toHaveLength(2);
    expect(harness.container.textContent).toContain('Delivery failed');
    click(harness.container, 'subagent-queue-retry');
    await flush();
    expect(requests).toHaveLength(3);
    expect(
      harness.container.querySelector('[data-testid="subagent-queued-0"]'),
    ).toBeNull();
    harness.unmount();
  });

  it.each(['badge', 'gesture'])(
    'edits and clears queued drafts via %s and keeps them across panel unmount/remount',
    async (entry) => {
      let sendCount = 0;
      const send = (): Promise<SubagentMessageResult> => {
        sendCount += 1;
        return Promise.resolve({ ok: true });
      };
      let harness = mountPanel(
        panelProps(makeTree('running'), { onMessageSubagent: send }),
      );
      enterText(harness.container, 'Edit this later');
      pressEnter(harness.container);
      const queued = harness.container.querySelector(
        '[data-testid="subagent-queued-0"]',
      );
      const edit = queued?.querySelector<HTMLButtonElement>(
        '[data-testid="queued-message-edit"]',
      );
      if (!edit) throw new Error('missing edit action');
      document.body.append(harness.container);
      enterText(harness.container, 'Keep this text');
      await act(async () => {
        if (entry === 'badge') edit.click();
        else {
          const text = queued?.querySelector('p');
          if (!text) throw new Error('missing queued text');
          const init = { bubbles: true, cancelable: true, button: 0 };
          text.dispatchEvent(
            new MouseEvent('mousedown', { ...init, detail: 1 }),
          );
          text.dispatchEvent(
            new MouseEvent('mousedown', { ...init, detail: 2 }),
          );
          text.dispatchEvent(
            new MouseEvent('dblclick', { ...init, detail: 2 }),
          );
        }

        await Promise.resolve();
      });
      const input = harness.container.querySelector<HTMLTextAreaElement>(
        '[data-testid="subagent-composer-input"]',
      );
      expect(document.activeElement).toBe(input);
      expect(input?.selectionStart).toBe(input?.value.length);
      expect(
        harness.container.querySelector<HTMLTextAreaElement>(
          '[data-testid="subagent-composer-input"]',
        )?.value,
      ).toBe('Edit this later\n\nKeep this text');
      pressEnter(harness.container);
      expect(
        harness.container.querySelector('[data-testid="subagent-queued-0"]'),
      ).not.toBeNull();
      enterText(harness.container, 'Clear this draft');
      pressEnter(harness.container);
      const clear = harness.container.querySelector<HTMLButtonElement>(
        '[data-testid="subagent-queued-1"] [data-testid="queued-message-cancel"]',
      );
      if (!clear) throw new Error('missing clear action');
      act((): void => clear.click());
      expect(
        harness.container.querySelectorAll('[data-testid^="subagent-queued-"]'),
      ).toHaveLength(1);
      harness.unmount();

      harness = mountPanel(
        panelProps(makeTree('completed'), { onMessageSubagent: send }),
      );
      await flush();
      expect(
        harness.container.querySelector('[data-testid="subagent-queued-0"]'),
      ).toBeNull();
      expect(sendCount).toBe(1);
      harness.unmount();
    },
  );

  it('keeps a single command in flight and renders the native/read-only capability states', async () => {
    const requests: SubagentMessageRequest[] = [];
    let resolveRequest: ((result: SubagentMessageResult) => void) | undefined;
    const deferredSend = (
      request: SubagentMessageRequest,
    ): Promise<SubagentMessageResult> => {
      requests.push(request);
      return new Promise((resolve) => {
        resolveRequest = resolve;
      });
    };
    const harness = mountPanel(
      panelProps(makeTree('running'), { onMessageSubagent: deferredSend }),
    );
    enterText(harness.container, 'First');
    pressEnter(harness.container);
    enterText(harness.container, 'Second');
    pressEnter(harness.container);
    harness.render(
      panelProps(makeTree('completed'), { onMessageSubagent: deferredSend }),
    );
    expect(requests).toHaveLength(1);
    const second = harness.container.querySelector(
      '[data-testid="subagent-queued-1"]',
    );
    const steer = second?.querySelector<HTMLButtonElement>(
      '[data-testid="queued-message-steer"]',
    );
    if (!steer) throw new Error('missing second draft steer action');
    act((): void => steer.click());
    expect(requests).toHaveLength(1);
    act((): void => resolveRequest?.({ ok: true }));
    await flush();
    harness.unmount();

    resetStore();
    const nativeInterrupts: number[] = [];
    const nativeResult: SubagentNativeInterruptResult = { ok: true };
    const native = mountPanel(
      panelProps(makeTree('running', 'claude-native'), {
        onInterruptNative: (): Promise<SubagentNativeInterruptResult> => {
          nativeInterrupts.push(1);
          return Promise.resolve(nativeResult);
        },
      }),
    );
    const nativeInput = native.container.querySelector<HTMLTextAreaElement>(
      '[data-testid="subagent-composer-input"]',
    );
    expect(nativeInput?.disabled).toBe(true);
    expect(nativeInput?.placeholder).toContain(
      "This subagent can't take messages",
    );
    expect(
      native.container.querySelector<HTMLButtonElement>(
        '[data-testid="subagent-composer-interrupt"]',
      )?.disabled,
    ).toBe(false);
    click(native.container, 'subagent-composer-interrupt');
    await flush();
    expect(nativeInterrupts).toHaveLength(1);
    native.unmount();

    resetStore();
    const unavailableNative = mountPanel(
      panelProps(makeTree('running', 'claude-native'), {
        capabilities: { ...defaultCapabilities, nativeInterrupt: false },
      }),
    );
    expect(
      unavailableNative.container.querySelector<HTMLButtonElement>(
        '[data-testid="subagent-composer-interrupt"]',
      )?.disabled,
    ).toBe(true);
    unavailableNative.unmount();

    resetStore();
    const nativeParent = mountPanel(
      panelProps(makeTree('running', 'claude-native'), {
        onSendToRecipient: (): Promise<SubagentCommandResult> =>
          Promise.resolve({ ok: true }),
      }),
    );
    click(nativeParent.container, 'subagent-composer-to');
    const nativeSelfOption = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="subagent-composer-to-option-current"]',
    );
    const parentOption = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="subagent-composer-to-option-ancestor"]',
    );
    expect(nativeSelfOption?.disabled).toBe(true);
    expect(nativeSelfOption?.title).toContain(
      "This subagent can't take messages",
    );
    expect(parentOption?.disabled).toBe(false);
    click(nativeParent.container, 'subagent-composer-to-option-ancestor');
    expect(
      nativeParent.container.querySelector<HTMLTextAreaElement>(
        '[data-testid="subagent-composer-input"]',
      )?.disabled,
    ).toBe(false);
    expect(
      nativeParent.container.querySelector(
        '[data-testid="subagent-reference-chip"]',
      ),
    ).not.toBeNull();
    nativeParent.unmount();

    resetStore();
    const readOnly = mountPanel(
      panelProps(makeTree('running'), {
        capabilities: { ...defaultCapabilities, messaging: false },
      }),
    );
    expect(
      readOnly.container.querySelector(
        '[data-testid="subagent-composer-interrupt"]',
      ),
    ).toBeNull();
    expect(readOnly.container.textContent).toContain(
      "Messaging subagents isn't available here",
    );
    readOnly.unmount();
  });

  it('shows native Interrupt even when a parent draft is kept', () => {
    const harness = mountPanel(
      panelProps(makeTree('running', 'claude-native'), {
        onInterruptNative: (): Promise<SubagentNativeInterruptResult> =>
          Promise.resolve({ ok: true }),
        onSendToRecipient: (): Promise<SubagentCommandResult> =>
          Promise.resolve({ ok: true }),
      }),
    );
    click(harness.container, 'subagent-composer-to');
    click(harness.container, 'subagent-composer-to-option-ancestor');
    enterText(harness.container, 'Kept for the parent');

    click(harness.container, 'subagent-composer-to');
    click(harness.container, 'subagent-composer-to-option-current');

    expect(
      harness.container.querySelector<HTMLButtonElement>(
        '[data-testid="subagent-composer-interrupt"]',
      )?.disabled,
    ).toBe(false);
    harness.unmount();
  });

  it('lets a running native subagent be chosen again so Interrupt stays reachable', () => {
    const harness = mountPanel(
      panelProps(makeTree('running', 'claude-native'), {
        onInterruptNative: (): Promise<SubagentNativeInterruptResult> =>
          Promise.resolve({ ok: true }),
        onSendToRecipient: (): Promise<SubagentCommandResult> =>
          Promise.resolve({ ok: true }),
      }),
    );
    click(harness.container, 'subagent-composer-to');
    click(harness.container, 'subagent-composer-to-option-ancestor');
    expect(
      harness.container.querySelector(
        '[data-testid="subagent-composer-interrupt"]',
      ),
    ).toBeNull();

    click(harness.container, 'subagent-composer-to');
    const selfOption = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="subagent-composer-to-option-current"]',
    );
    expect(selfOption?.disabled).toBe(false);
    click(harness.container, 'subagent-composer-to-option-current');

    expect(
      harness.container.querySelector<HTMLTextAreaElement>(
        '[data-testid="subagent-composer-input"]',
      )?.disabled,
    ).toBe(true);
    expect(
      harness.container.querySelector<HTMLButtonElement>(
        '[data-testid="subagent-composer-interrupt"]',
      )?.disabled,
    ).toBe(false);
    harness.unmount();
  });

  it('offers a parent delegate only when the host can message delegates', () => {
    const sendToRecipient = (): Promise<SubagentCommandResult> =>
      Promise.resolve({ ok: true });

    resetStore();
    const withoutMessaging = mountPanel(
      panelProps(makeTree('running'), {
        capabilities: { ...defaultCapabilities, messaging: false },
        onSendToRecipient: sendToRecipient,
      }),
    );
    click(withoutMessaging.container, 'subagent-composer-to');
    const blockedParent = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="subagent-composer-to-option-ancestor"]',
    );
    const rootOption = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="subagent-composer-to-option-root-chat"]',
    );
    expect(blockedParent?.disabled).toBe(true);
    expect(blockedParent?.title).toContain(
      "Messaging subagents isn't available here",
    );
    expect(rootOption?.disabled).toBe(false);
    click(withoutMessaging.container, 'subagent-composer-to-option-root-chat');
    expect(
      withoutMessaging.container.querySelector<HTMLTextAreaElement>(
        '[data-testid="subagent-composer-input"]',
      )?.disabled,
    ).toBe(false);
    withoutMessaging.unmount();

    resetStore();
    const withMessaging = mountPanel(
      panelProps(makeTree('running'), { onSendToRecipient: sendToRecipient }),
    );
    click(withMessaging.container, 'subagent-composer-to');
    expect(
      document.body.querySelector<HTMLButtonElement>(
        '[data-testid="subagent-composer-to-option-ancestor"]',
      )?.disabled,
    ).toBe(false);
    withMessaging.unmount();
  });

  it('applies a pending operation result to the store after its panel unmounts', async () => {
    let resolveRequest: ((result: SubagentMessageResult) => void) | undefined;
    const harness = mountPanel(
      panelProps(makeTree('running'), {
        onMessageSubagent: (): Promise<SubagentMessageResult> =>
          new Promise((resolve) => {
            resolveRequest = resolve;
          }),
      }),
    );
    enterText(harness.container, 'Complete after unmount');
    pressEnter(harness.container);
    harness.render(
      panelProps(makeTree('completed'), {
        onMessageSubagent: (): Promise<SubagentMessageResult> =>
          new Promise((resolve) => {
            resolveRequest = resolve;
          }),
      }),
    );
    expect(
      getSubagentComposerDraft(subagentDraftKey('root-chat', 'current'))
        .inFlight,
    ).toBe(true);
    harness.unmount();
    act((): void => resolveRequest?.({ ok: true }));
    await flush();
    const completed = getSubagentComposerDraft(
      subagentDraftKey('root-chat', 'current'),
    );
    expect(completed.inFlight).toBe(false);
    expect(completed.queue).toEqual([]);
  });
});
