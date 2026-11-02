/** @jest-environment jsdom */

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentDelegationCardData } from '@canopy/protocol/delegation';
import type { PortalChatPart } from '@canopy/protocol/portal';
import type { DelegationPagesState } from '@canopy/app-state';
import { ChatPartView } from '../ChatPartView';
import { isStreamBackedDelegation } from '../DelegationChildPages';
import { TranscriptReadHostContext } from '../transcript-read-host-context';

const readPage = jest.fn<
  ReturnType<DelegationPagesState['readPage']>,
  Parameters<DelegationPagesState['readPage']>
>();
const reads: DelegationPagesState = {
  readPage,
  readBlocks: jest.fn(),
  readContent: jest.fn(),
};
jest.mock('@canopy/app-state', () => ({
  useCanopyClient: (): { transcripts: object } => ({ transcripts: {} }),
  useWorkspaceCapabilities: (): { delegationTranscriptReads: boolean } => ({
    delegationTranscriptReads: true,
  }),
  useDelegationPagesStore:
    (): (<T>(selector: (state: DelegationPagesState) => T) => T) =>
    <T,>(selector: (state: DelegationPagesState) => T): T =>
      selector(reads),
}));

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const STALE = 'stale inline child sentinel';

function card(
  transcriptStore?: AgentDelegationCardData['transcriptStore'],
): AgentDelegationCardData {
  return {
    delegationId: 'child-1',
    runGeneration: 2,
    status: 'completed',
    outputTruncated: false,
    routeSnapshot: {
      selectedModelId: 'model',
      runtimeModelId: 'model',
      harnessId: 'codex',
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
    },
    parentHarnessId: 'codex',
    description: 'Review source',
    prompt: 'Read source',
    executionMode: 'background',
    ...(transcriptStore ? { transcriptStore } : {}),
  };
}

function part(delegation: AgentDelegationCardData): PortalChatPart {
  return {
    kind: 'agent',
    data: {
      delegation,
      subBlocks: [{ kind: 'text', data: { text: STALE } }],
    },
  };
}

function expanded(view: PortalChatPart): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement('div');
  const root = createRoot(container);
  act((): void => root.render(<ChatPartView part={view} />));
  const toggle = container.querySelector<HTMLButtonElement>('[aria-expanded]');
  if (!toggle) throw new Error('Agent card expand control was not rendered.');
  act((): void => toggle.click());
  return { container, root };
}

describe('ChatPartView stream-backed delegation cards', () => {
  it('refreshes an expanded card once on an owning-card revision-only update', async () => {
    readPage.mockReset();
    readPage.mockImplementation((request) =>
      Promise.resolve({
        ok: true,
        value: {
          transcriptRevision: request.streamRevisionHint ?? 1,
          rows: [],
        },
      }),
    );
    const source = {
      scope: { workspaceId: 'owner', worktreeId: 'tree', chatId: 'root-chat' },
    };
    const container = document.createElement('div');
    const root = createRoot(container);
    const renderCard = async (streamRevision?: number): Promise<void> => {
      await act(async () => {
        root.render(
          <TranscriptReadHostContext.Provider
            value={{ source, epoch: 12, renderRows: () => null }}
          >
            <ChatPartView
              part={part({ ...card('chat-stream-v2'), streamRevision })}
            />
          </TranscriptReadHostContext.Provider>,
        );
        await Promise.resolve();
      });
    };
    try {
      await renderCard();
      const toggle = container.querySelector<HTMLButtonElement>(
        '[aria-label="Expand delegated task"]',
      );
      if (!toggle) throw new Error('Missing delegation toggle');
      await act(async () => {
        toggle.click();
        await Promise.resolve();
      });
      expect(
        readPage.mock.calls.map(([request]) => request.streamRevisionHint),
      ).toEqual([undefined]);
      await renderCard(7);
      await renderCard(7);
      await renderCard(6);
      expect(
        readPage.mock.calls.map(([request]) => ({
          epoch: request.epoch,
          revision: request.streamRevisionHint,
          chatId: request.target.chatId,
        })),
      ).toEqual([
        { epoch: 12, revision: undefined, chatId: 'root-chat' },
        { epoch: 12, revision: 7, chatId: 'root-chat' },
      ]);
      expect(container.querySelector('[aria-expanded="true"]')).toBe(toggle);
    } finally {
      act(() => root.unmount());
    }
  });

  it('mounts host-supplied rows for nested cards using the owner chat source and epoch', async () => {
    readPage.mockReset();
    readPage.mockImplementation((request) =>
      Promise.resolve({
        ok: true,
        value: {
          transcriptRevision: 1,
          rows: [
            {
              id:
                request.target.delegationId === 'child-1'
                  ? 'nested-card'
                  : 'child-body',
              role: 'assistant',
              timestamp: 1,
              row: {},
            },
          ],
        },
      }),
    );
    const ownerSource = {
      scope: {
        workspaceId: 'owner-project',
        worktreeId: 'owner-tree',
        chatId: 'owner-chat',
      },
    };
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <TranscriptReadHostContext.Provider
          value={{
            source: ownerSource,
            epoch: 12,
            renderRows: (entries): ReactNode =>
              entries.map((entry) => (
                <div key={entry.key}>
                  {entry.key === 'nested-card' ? (
                    <ChatPartView
                      part={part({
                        ...card('chat-stream-v2'),
                        delegationId: 'child-2',
                      })}
                    />
                  ) : (
                    entry.key
                  )}
                </div>
              )),
          }}
        >
          <ChatPartView part={part(card('chat-stream-v2'))} />
        </TranscriptReadHostContext.Provider>,
      );
      await Promise.resolve();
    });
    for (let index = 0; index < 2; index += 1) {
      const toggle = container.querySelector<HTMLButtonElement>(
        '[aria-expanded="false"]',
      );
      if (!toggle) throw new Error('Missing nested card toggle');
      await act(async () => {
        toggle.click();
        await Promise.resolve();
      });
    }
    expect(
      readPage.mock.calls.map(([request]) => ({
        source: request.source,
        chatId: request.target.chatId,
        delegationId: request.target.delegationId,
        epoch: request.epoch,
        revision: request.streamRevisionHint,
      })),
    ).toEqual([
      {
        source: ownerSource,
        chatId: 'owner-chat',
        delegationId: 'child-1',
        epoch: 12,
        revision: undefined,
      },
      {
        source: ownerSource,
        chatId: 'owner-chat',
        delegationId: 'child-2',
        epoch: 12,
        revision: undefined,
      },
    ]);
    expect(container.textContent).toContain('child-body');
    expect(container.textContent).not.toContain(STALE);
    act(() => root.unmount());
  });
  it('shows the shared unavailable state, never stale inline children', () => {
    const { container, root } = expanded(part(card('chat-stream-v2')));
    const notice = container.querySelector(
      '[data-testid="delegation-child-pages-unavailable"]',
    );
    expect(notice?.textContent).toBe("Couldn't load messages in this view.");
    expect(notice?.getAttribute('data-target-delegation-id')).toBe('child-1');
    expect(notice?.getAttribute('data-target-run-generation')).toBe('2');
    expect(container.textContent).not.toContain(STALE);
    act((): void => root.unmount());
  });

  it('keeps a log card and an unmarked card rendering their children', () => {
    for (const store of ['chat-log-v1', undefined] as const) {
      const { container, root } = expanded(part(card(store)));
      expect(container.textContent).toContain(STALE);
      expect(
        container.querySelector(
          '[data-testid="delegation-child-pages-unavailable"]',
        ),
      ).toBeNull();
      act((): void => root.unmount());
    }
  });

  it('treats an unknown store marker as stream-backed', () => {
    expect(isStreamBackedDelegation('chat-stream-v3')).toBe(true);
    expect(isStreamBackedDelegation('chat-stream-v2')).toBe(true);
    expect(isStreamBackedDelegation('chat-log-v1')).toBe(false);
    expect(isStreamBackedDelegation(undefined)).toBe(false);
  });
});
