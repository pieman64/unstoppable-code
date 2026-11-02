/**
 * @jest-environment jsdom
 */
import type {
  AgentDelegationTranscript,
  AgentDelegationTranscriptItem,
} from '@canopy/protocol/delegation';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { ManagedDelegationTranscriptPageResult } from '@canopy/desktop-shared/types';
import type { DisplayBlock } from '../../components/chat/types';
import {
  DelegationTranscriptSourceContext,
  useDelegatedAgentTranscript,
} from '../../components/chat/delegated-agent-transcript';
import {
  DELEGATION_TRANSCRIPT_RUN_LIMIT,
  delegationRunKey,
  holdDelegationRun,
  useDelegationTranscriptStore,
  type DelegationTranscriptSource,
} from '../delegationTranscriptStore';

const TARGET = { projectId: 'project', worktreeId: 'tree', chatId: 'chat' };
const RUN = { delegationId: 'child', runGeneration: 1 };
const KEY = delegationRunKey(TARGET, RUN);

function text(
  id: string,
  sequence: number,
  value: string,
): AgentDelegationTranscriptItem {
  return { id, sequence, occurredAt: sequence, type: 'text', text: value };
}

function snapshot(
  sequence: number,
  transcript: AgentDelegationTranscriptItem[],
  patch = false,
): AgentDelegationTranscript {
  return {
    ...RUN,
    sequence,
    parentHarnessId: 'claude',
    parentTurnId: 'turn',
    parentToolCallId: 'spawn',
    createdAt: 1,
    transcriptStore: 'chat-log-v1',
    task: {
      description: 'Review',
      prompt: 'Review',
      executionMode: 'background',
    },
    snapshot: {
      delegationId: RUN.delegationId,
      status: 'running',
      outputTruncated: false,
    },
    transcript,
    ...(patch ? { transcriptMode: 'patch' as const } : {}),
  };
}

function liveItems(): string[] {
  return (
    useDelegationTranscriptStore
      .getState()
      .runs[
        KEY
      ]?.live?.transcript.map((item) => `${item.id}:${item.type === 'text' ? item.text : ''}`) ??
    []
  );
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

describe('useDelegationTranscriptStore', () => {
  let transcript: jest.Mock;

  beforeEach(() => {
    useDelegationTranscriptStore.getState().reset();
    transcript = jest.fn();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { managedDelegation: { transcript } },
    });
  });

  it('merges a patch of changed items into the items it holds', () => {
    const { applyLive } = useDelegationTranscriptStore.getState();
    applyLive(TARGET, snapshot(1, [text('a', 1, 'x'), text('b', 2, 'y')]));
    applyLive(
      TARGET,
      snapshot(2, [text('b', 2, 'yz'), text('c', 3, 'w')], true),
    );
    expect(liveItems()).toEqual(['a:x', 'b:yz', 'c:w']);
    expect(transcript).not.toHaveBeenCalled();
  });

  it('reads the delegate log for a patch whose earlier items it never saw', async () => {
    transcript.mockResolvedValue({
      ok: true,
      items: [text('a', 1, 'logged'), text('b', 2, 'old')],
    });
    useDelegationTranscriptStore
      .getState()
      .applyLive(TARGET, snapshot(4, [text('b', 2, 'new')], true));
    await settle();
    expect(transcript).toHaveBeenCalledWith({ ...TARGET, ...RUN });
    // The live item is newer than its logged version.
    expect(liveItems()).toEqual(['a:logged', 'b:new']);
  });

  it('reads the delegate log for a card-only patch', async () => {
    transcript.mockResolvedValue({ ok: true, items: [text('a', 1, 'x')] });
    useDelegationTranscriptStore
      .getState()
      .applyLive(TARGET, snapshot(3, [], true));
    await settle();
    expect(transcript).toHaveBeenCalledTimes(1);
    expect(liveItems()).toEqual(['a:x']);
  });

  it('keeps an archived or history copy of the chat apart from the live chat', async () => {
    transcript.mockResolvedValue({
      ok: true,
      items: [text('a', 1, 'archived')],
    });
    useDelegationTranscriptStore
      .getState()
      .applyLive(TARGET, snapshot(1, [text('a', 1, 'live')]));
    const archived = { ...TARGET, archivedContainerId: 'archive' };
    const history = { ...TARGET, standaloneHistory: true };
    expect(
      new Set([
        KEY,
        delegationRunKey(archived, RUN),
        delegationRunKey(history, RUN),
      ]).size,
    ).toBe(3);
    useDelegationTranscriptStore.getState().load(archived, RUN);
    await settle();
    expect(transcript).toHaveBeenCalledWith({
      ...TARGET,
      ...RUN,
      archivedContainerId: 'archive',
    });
    const { runs } = useDelegationTranscriptStore.getState();
    expect(runs[delegationRunKey(archived, RUN)]?.logged).toEqual([
      text('a', 1, 'archived'),
    ]);
    expect(liveItems()).toEqual(['a:live']);
  });

  it('keeps a held run past the run limit and evicts runs no card holds', () => {
    const release = holdDelegationRun(KEY);
    try {
      const { applyLive } = useDelegationTranscriptStore.getState();
      applyLive(TARGET, snapshot(1, [text('a', 1, 'held')]));
      const others = Array.from(
        { length: DELEGATION_TRANSCRIPT_RUN_LIMIT + 1 },
        (_, index) => `other-${String(index)}`,
      );
      for (const delegationId of others)
        applyLive(TARGET, {
          ...snapshot(1, [text('a', 1, delegationId)]),
          delegationId,
        });
      const { runs, order } = useDelegationTranscriptStore.getState();
      expect(liveItems()).toEqual(['a:held']);
      expect(order).toHaveLength(DELEGATION_TRANSCRIPT_RUN_LIMIT);
      // The oldest runs no card holds were evicted.
      expect(
        runs[delegationRunKey(TARGET, { ...RUN, delegationId: 'other-0' })],
      ).toBeUndefined();
    } finally {
      release();
    }
  });

  it('replaces its items with a whole transcript', () => {
    const { applyLive } = useDelegationTranscriptStore.getState();
    applyLive(TARGET, snapshot(1, [text('a', 1, 'x'), text('b', 2, 'y')]));
    applyLive(TARGET, snapshot(2, [text('a', 1, 'x2')]));
    expect(liveItems()).toEqual(['a:x2']);
  });
});

describe('logged delegation card reconnect hydration', () => {
  type Card = Extract<DisplayBlock, { type: 'delegated_agent_call' }>;
  const card: Card = {
    type: 'delegated_agent_call',
    ...RUN,
    agentBlockId: 'delegated-agent-child',
    sequence: 3,
    parentHarnessId: 'claude',
    parentTurnId: 'turn',
    parentToolCallId: 'spawn',
    createdAt: 1,
    selectedModelId: 'model',
    runtimeModelId: 'model',
    targetHarnessId: 'claude',
    description: 'Review',
    prompt: 'Review',
    executionMode: 'background',
    status: 'pending',
    outputTruncated: false,
    transcriptStore: 'chat-log-v1',
    subBlocks: [],
  };
  function page(
    revision = 3,
    runGeneration = 1,
  ): ManagedDelegationTranscriptPageResult {
    return {
      ok: true,
      task: {
        description: 'Review',
        prompt: 'Review',
        executionMode: 'background',
      },
      snapshot: {
        delegationId: RUN.delegationId,
        runGeneration,
        status: 'pending',
        phase: 'queued',
        queue: { id: 'default', name: 'Default' },
        outputTruncated: false,
      },
      runGeneration,
      revision,
      items: [],
      hasMore: false,
    };
  }
  let transcript: jest.Mock;
  let transcriptPage: jest.Mock;
  let root: ReturnType<typeof createRoot>;
  let host: HTMLDivElement;
  let displayed: Card;
  let originalApi: PropertyDescriptor | undefined;

  function Probe({ block }: { block: Card }): null {
    displayed = useDelegatedAgentTranscript(block);
    return null;
  }
  async function renderCard(
    block = card,
    source: DelegationTranscriptSource = TARGET,
  ): Promise<void> {
    await act(async () => {
      root.render(
        createElement(
          DelegationTranscriptSourceContext.Provider,
          { value: source },
          createElement(Probe, { block }),
        ),
      );
      await settle();
    });
  }

  beforeEach(() => {
    useDelegationTranscriptStore.getState().reset();
    transcript = jest.fn().mockResolvedValue({
      ok: true,
      items: [text('logged', 1, 'Read before reload')],
    });
    transcriptPage = jest.fn().mockResolvedValue(page());
    originalApi = Object.getOwnPropertyDescriptor(window, 'api');
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { managedDelegation: { transcript, transcriptPage } },
    });
    host = document.createElement('div');
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    if (originalApi) Object.defineProperty(window, 'api', originalApi);
    else Reflect.deleteProperty(window, 'api');
  });

  it('hydrates a cold queued card from the existing current snapshot', async () => {
    await renderCard();
    expect(transcriptPage).toHaveBeenCalledWith({ ...TARGET, ...RUN });
    expect(useDelegationTranscriptStore.getState().runs[KEY]?.loading).toBe(
      false,
    );
    expect(displayed).toMatchObject({
      status: 'pending',
      phase: 'queued',
      runGeneration: 1,
      sequence: 3,
      queue: { id: 'default', name: 'Default' },
    });
    expect(displayed.subBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: 'Read before reload' }),
      ]),
    );
    await renderCard();
    expect(transcriptPage).toHaveBeenCalledTimes(1);
  });

  it('keeps newer live progress when a queued hydration response is delayed', async () => {
    let respond: (
      value: ManagedDelegationTranscriptPageResult,
    ) => void = () => {};
    transcriptPage.mockReturnValue(
      new Promise<ManagedDelegationTranscriptPageResult>((resolve) => {
        respond = resolve;
      }),
    );
    await renderCard();
    await act(async () => {
      useDelegationTranscriptStore
        .getState()
        .applyLive(TARGET, snapshot(5, []));
      respond(page());
      await settle();
    });
    expect(transcriptPage).toHaveBeenCalledTimes(1);
    expect(displayed).toMatchObject({ status: 'running', sequence: 5 });
    expect(displayed.phase).not.toBe('queued');
  });

  it('keeps a newer committed card when a queued hydration response is delayed', async () => {
    let respond: (
      value: ManagedDelegationTranscriptPageResult,
    ) => void = () => {};
    transcriptPage.mockReturnValue(
      new Promise<ManagedDelegationTranscriptPageResult>((resolve) => {
        respond = resolve;
      }),
    );
    await renderCard();
    await renderCard({
      ...card,
      status: 'completed',
      sequence: 6,
      finalText: 'Done',
    });
    await act(async () => {
      respond(page());
      await settle();
    });
    expect(transcriptPage).toHaveBeenCalledTimes(1);
    expect(displayed).toMatchObject({
      status: 'completed',
      sequence: 6,
      finalText: 'Done',
    });
    expect(displayed.phase).not.toBe('queued');
  });

  it('does not overlay a snapshot from another run generation', async () => {
    transcriptPage.mockResolvedValue(page(20, 2));
    await renderCard();
    expect(transcriptPage).toHaveBeenCalledTimes(1);
    expect(displayed).toMatchObject({
      status: 'pending',
      runGeneration: 1,
      sequence: 3,
    });
    expect(displayed.phase).toBeUndefined();
  });

  it('never hydrates archived or standalone-history cards from current state', async () => {
    await renderCard(card, { ...TARGET, archivedContainerId: 'archive' });
    await renderCard(card, { ...TARGET, standaloneHistory: true });
    expect(transcriptPage).not.toHaveBeenCalled();
    expect(transcript).toHaveBeenCalledWith({
      ...TARGET,
      ...RUN,
      archivedContainerId: 'archive',
    });
    expect(transcript).toHaveBeenCalledWith({
      ...TARGET,
      ...RUN,
      standaloneHistory: true,
    });
    expect(displayed.phase).toBeUndefined();
  });
});
