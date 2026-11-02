/** @jest-environment jsdom */

import {
  act,
  forwardRef,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import { createRoot } from 'react-dom/client';
import type {
  CanopyClient,
  CommandMap,
  CommandName,
  QueryMap,
  QueryName,
  Unsubscribe,
} from '@canopy/app-core';
import { CanopyClientProvider, useChatStore } from '@canopy/app-state';
import type { ChatTurnPhase } from '@canopy/protocol/portal';
import {
  ChatComposerShell,
  CompactQueueProvider,
} from '@canopy/ui-shared/components';
import { ChatPanel, type ChatComposerHostControls } from '../ChatPanel';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('../ChatComposer', () => ({
  ChatComposer: (): JSX.Element => <div data-testid="composer" />,
}));
// A textarea stands in for the Slate composer editor: it keeps the editor
// contract the queued-message composer relies on (seeded text, text changes,
// Enter submits, and the imperative serialize and focus).
jest.mock('@canopy/ui-rich/editor', () => ({
  ComposerEditor: forwardRef(function MockComposerEditor(
    props: {
      initialText?: string;
      dataTestId?: string;
      onTextChange?: (text: string) => void;
      onKeyDown?: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
      onSubmit?: (payload: { text: string }) => void;
      canSubmit?: (payload: { text: string }) => boolean;
    },
    ref,
  ): JSX.Element {
    const input = useRef<HTMLTextAreaElement>(null);
    const text = (): string => input.current?.value ?? '';
    useImperativeHandle(ref, () => ({
      // Like the real editor, focus with no selection puts the caret at the end.
      focus: (): void => {
        const element = input.current;
        element?.focus();
        element?.setSelectionRange(element.value.length, element.value.length);
      },
      serialize: (): { text: string } => ({ text: text() }),
    }));
    return (
      <textarea
        ref={input}
        data-testid={props.dataTestId}
        defaultValue={props.initialText}
        onChange={(event): void => props.onTextChange?.(event.target.value)}
        onKeyDown={(event): void => {
          props.onKeyDown?.(event);
          if (event.key !== 'Enter' || event.defaultPrevented) return;
          event.preventDefault();
          const payload = { text: text() };
          if (props.canSubmit?.(payload) ?? true) props.onSubmit?.(payload);
        }}
      />
    );
  }),
}));
// Honors the real transcript's footer contract: a chat with no messages but a
// queue mounts the transcript, which owns the queued list.
jest.mock('../ChatTranscript', () => ({
  ChatTranscript: ({ footerSlot }: { footerSlot?: ReactNode }): JSX.Element => (
    <div data-testid="transcript">{footerSlot}</div>
  ),
}));

/** Resolves the lazily imported transcript so the queue is on screen. */
async function flushLazyTranscript(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function Seeder(): null {
  // Zustand actions are closure-based and do not use `this`.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const hydrate = useChatStore((state) => state.hydrate);
  useEffect(() => {
    const first = {
      id: 'q1',
      text: 'original',
      origin: 'portal' as const,
      enqueuedAtMs: 1,
    };
    Reflect.set(first, 'canSteer', true);
    hydrate('c1', [], {
      route: {
        scope: 'worktree',
        workspaceLocalId: 'ws',
        worktreeLocalId: 'wt',
      },
      queuedMessages: [
        first,
        { id: 'q2', text: 'second', origin: 'desktop', enqueuedAtMs: 2 },
        {
          id: 'q3',
          text: 'attached',
          origin: 'portal',
          enqueuedAtMs: 3,
          hasAttachments: true,
        },
        {
          id: 'q4',
          text: '',
          origin: 'portal',
          enqueuedAtMs: 4,
          hasAttachments: true,
          attachmentEditsPreservePayload: true,
        },
      ],
      steeringCapabilities: {
        provider: 'claude',
        generation: 'g1',
        steer: true,
        withdraw: true,
        interrupt: true,
      },
    });
  }, [hydrate]);
  return null;
}

describe('ChatPanel queued-message edit in the composer', () => {
  it('offers Steer only for rows the host marks eligible', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <CanopyClientProvider client={createClient([])}>
          <Seeder />
          <ChatPanel chatId="c1" />
        </CanopyClientProvider>,
      );
    });
    await flushLazyTranscript();

    expect(
      container.querySelectorAll('[data-testid="queued-message-steer"]'),
    ).toHaveLength(1);
    act(() => root.unmount());
  });

  it('does not create an optimistic transcript row behind a pending queue', async () => {
    const onSend = jest.fn();
    let composerSend: ChatComposerHostControls['onSend'];
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <CanopyClientProvider client={createClient([])}>
          <Seeder />
          <ChatPanel
            chatId="c1"
            onSend={onSend}
            queuesSendsBehindPendingMessages
            renderComposer={(controls): JSX.Element => {
              composerSend = controls.onSend;
              return <div data-testid="host-composer" />;
            }}
          />
        </CanopyClientProvider>,
      );
    });
    await flushLazyTranscript();

    act(() => {
      void composerSend?.('queued behind pending');
    });

    expect(onSend).toHaveBeenCalledWith('queued behind pending', {
      optimisticLocalId: undefined,
    });
    act(() => root.unmount());
  });

  it('opens the editor in the composer place and keeps the composer mounted', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <CanopyClientProvider client={createClient([])}>
          <Seeder />
          <ChatPanel
            chatId="c1"
            renderComposer={(): JSX.Element => (
              <textarea data-testid="host-composer" defaultValue="my draft" />
            )}
          />
        </CanopyClientProvider>,
      );
    });
    await flushLazyTranscript();
    const composer = (): HTMLTextAreaElement | null =>
      container.querySelector<HTMLTextAreaElement>(
        '[data-testid="host-composer"]',
      );
    const bubbleTexts = (): string[] =>
      Array.from(
        container.querySelectorAll('[data-testid="queued-message-bubble"]'),
        (bubble) => bubble.textContent ?? '',
      );
    expect(bubbleTexts()).toHaveLength(4);

    // The editor opens once the host grants the edit lock.
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="queued-message-edit"]')
        ?.click();
      await Promise.resolve();
    });

    const editor = container.querySelector(
      '[data-testid="queued-message-editor"]',
    );
    // The editor is not inside the transcript any more; the edited row
    // steps out of the queue while the editor holds its text.
    expect(editor).not.toBeNull();
    expect(
      container.querySelector('[data-testid="transcript"]')?.contains(editor),
    ).toBe(false);
    expect(bubbleTexts()).toHaveLength(3);
    expect(bubbleTexts().some((text) => text.includes('original'))).toBe(false);
    expect(
      container.querySelector<HTMLTextAreaElement>(
        '[data-testid="queued-message-edit-input"]',
      )?.value,
    ).toBe('original');
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="queued-message-edit-input"]'),
    );
    // The composer and its draft stay mounted, hidden.
    expect(composer()?.value).toBe('my draft');
    expect(composer()?.closest('[data-queued-edit-hidden]')).not.toBeNull();

    act(() => {
      container
        .querySelector<HTMLElement>(
          '[data-testid="queued-message-edit-cancel"]',
        )
        ?.click();
    });

    expect(
      container.querySelector('[data-testid="queued-message-editor"]'),
    ).toBeNull();
    expect(bubbleTexts()).toHaveLength(4);
    expect(composer()?.value).toBe('my draft');
    expect(composer()?.closest('[data-queued-edit-hidden]')).toBeNull();
    // Focus was in the editor, so it goes back to the composer.
    expect(document.activeElement).toBe(composer());
    act(() => root.unmount());
    container.remove();
  });

  it('edits a compact queue row in the composer place, outside the list', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <CanopyClientProvider client={createClient([])}>
          <CompactQueueProvider value>
            <Seeder />
            <ChatPanel
              chatId="c1"
              renderComposer={(): JSX.Element => (
                <ChatComposerShell dataTestId="host-composer-box">
                  <textarea
                    data-testid="host-composer"
                    defaultValue="my draft"
                  />
                </ChatComposerShell>
              )}
            />
          </CompactQueueProvider>
        </CanopyClientProvider>,
      );
    });
    await flushLazyTranscript();
    const list = (): Element | null =>
      container.querySelector('[aria-label="Queued messages"]');
    // The list sits on the box that shows: the composer's, then the
    // editor's while an edit is open.
    const boxUnderList = (): string | null | undefined =>
      list()
        ?.closest('[data-composer-tray-slot]')
        ?.nextElementSibling?.getAttribute('data-testid');
    expect(boxUnderList()).toBe('host-composer-box');
    const rowTexts = (): string[] =>
      Array.from(
        list()?.querySelectorAll('[data-testid="queued-message-preview"]') ??
          [],
        (row) => row.textContent ?? '',
      );
    expect(rowTexts()).toEqual([
      'original',
      'second',
      'attached',
      'Attached files',
    ]);

    const row = list()?.querySelector('[data-testid="queued-message-preview"]');
    if (!row) throw new Error('missing compact queue row');
    await act(async () => {
      const init = { bubbles: true, cancelable: true, button: 0 };
      row.dispatchEvent(new MouseEvent('mousedown', { ...init, detail: 1 }));
      row.dispatchEvent(new MouseEvent('mousedown', { ...init, detail: 2 }));
      row.dispatchEvent(new MouseEvent('dblclick', { ...init, detail: 2 }));
      await Promise.resolve();
    });

    // One editor, in the composer's place: the edited row leaves the list
    // and no second editor opens under it.
    const editors = container.querySelectorAll(
      '[data-testid="queued-message-editor"]',
    );
    expect(editors).toHaveLength(1);
    expect(list()?.contains(editors[0])).toBe(false);
    expect(rowTexts()).toEqual(['second', 'attached', 'Attached files']);
    expect(
      container.querySelector<HTMLTextAreaElement>(
        '[data-testid="queued-message-edit-input"]',
      )?.value,
    ).toBe('original');
    const composer = container.querySelector('[data-testid="host-composer"]');
    expect(composer?.closest('[data-queued-edit-hidden]')).toBeInstanceOf(
      Element,
    );
    expect(boxUnderList()).toBe('queued-message-edit-shell');

    act(() => {
      container
        .querySelector<HTMLElement>(
          '[data-testid="queued-message-edit-cancel"]',
        )
        ?.click();
    });
    expect(
      container.querySelector('[data-testid="queued-message-editor"]'),
    ).toBeNull();
    expect(rowTexts()).toEqual([
      'original',
      'second',
      'attached',
      'Attached files',
    ]);
    expect(boxUnderList()).toBe('host-composer-box');
    act(() => root.unmount());
    container.remove();
  });

  it('keeps drawer queue controls outside the hidden composer while a host editor is active', async () => {
    let arrive: (() => void) | undefined;
    function Arrival(): null {
      // Zustand actions are closure-based and do not use `this`.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const hydrate = useChatStore((state) => state.hydrate);
      const queued = useChatStore((state) => state.threads.c1?.queuedMessages);
      useEffect(() => {
        arrive = (): void =>
          hydrate('c1', [], {
            route: {
              scope: 'worktree',
              workspaceLocalId: 'ws',
              worktreeLocalId: 'wt',
            },
            queuedMessages: [
              ...(queued ?? []),
              {
                id: 'new',
                text: 'Arrived during editing',
                origin: 'portal',
                enqueuedAtMs: 5,
              },
            ],
          });
      }, [hydrate, queued]);
      return null;
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <CanopyClientProvider client={createClient([])}>
          <CompactQueueProvider value={true}>
            <Seeder />
            <Arrival />
            <ChatPanel
              chatId="c1"
              composerWorkDrawer
              hostQueuedMessageEditor={<div data-testid="host-queued-editor" />}
              renderComposer={(controls): JSX.Element => (
                <div>
                  {controls.queuedPanel}
                  <textarea data-testid="host-composer" />
                </div>
              )}
            />
          </CompactQueueProvider>
        </CanopyClientProvider>,
      ),
    );
    await flushLazyTranscript();
    const visibleRows = Array.from(
      container.querySelectorAll('[data-testid="queued-message-bubble"]'),
    ).filter((row) => !row.closest('[data-queued-edit-hidden]'));
    expect(visibleRows).toHaveLength(4);
    act(() => arrive?.());
    const arrived = Array.from(
      container.querySelectorAll('[data-testid="queued-message-preview"]'),
    ).find((row) => row.textContent === 'Arrived during editing');
    expect(arrived).toBeDefined();
    expect(arrived?.closest('[data-queued-edit-hidden]')).toBeNull();
    act(() => root.unmount());
    container.remove();
  });
  it('renders a host-supplied queued-message editor in the composer place', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const render = (editing: boolean): void => {
      root.render(
        <CanopyClientProvider client={createClient([])}>
          <ChatPanel
            chatId="c1"
            hostQueuedMessageEditor={
              editing ? <div data-testid="host-queued-editor" /> : null
            }
            renderComposer={(): JSX.Element => (
              <div data-testid="host-composer" />
            )}
          />
        </CanopyClientProvider>,
      );
    };
    act(() => render(true));

    expect(
      container.querySelector('[data-testid="host-queued-editor"]'),
    ).not.toBeNull();
    expect(
      container
        .querySelector('[data-testid="host-composer"]')
        ?.closest('[data-queued-edit-hidden]'),
    ).not.toBeNull();

    act(() => render(false));
    expect(
      container.querySelector('[data-testid="host-queued-editor"]'),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-testid="host-composer"]')
        ?.closest('[data-queued-edit-hidden]'),
    ).toBeNull();
    act(() => root.unmount());
  });

  it('locks on open, edits on save, and unlocks on cancel', async () => {
    const calls: Array<[CommandName, unknown]> = [];
    const client: CanopyClient = {
      capabilities: {
        localExecution: false,
        terminalPty: false,
        fileSystemAccess: 'read',
        voice: false,
        settingsScope: 'api-keys-only',
        pipelines: 'read-only',
        routing: 'url',
        overviewNotifications: true,
      },
      query<K extends QueryName>(): Promise<QueryMap[K]['result']> {
        return Promise.reject(new Error('unused'));
      },
      command<K extends CommandName>(
        name: K,
        args: CommandMap[K]['args'],
      ): Promise<CommandMap[K]['result']> {
        calls.push([name, args]);
        return Promise.resolve(undefined as CommandMap[K]['result']);
      },
      subscribe(): Unsubscribe {
        return (): void => {};
      },
    };
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <CanopyClientProvider client={client}>
          <Seeder />
          <ChatPanel chatId="c1" />
        </CanopyClientProvider>,
      );
    });
    await flushLazyTranscript();

    const click = async (testId: string): Promise<void> => {
      await act(async () => {
        container
          .querySelector<HTMLElement>(`[data-testid="${testId}"]`)
          ?.click();

        await Promise.resolve();
      });
    };

    await click('queued-message-edit');
    expect(calls[calls.length - 1]).toEqual([
      'chat.queue.set_edit_lock',
      {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'c1',
        entryId: 'q1',
        locked: true,
      },
    ]);
    const input = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="queued-message-edit-input"]',
    );
    act(() => {
      if (!input) throw new Error('missing queue edit input');
      // Use the native setter so React's value tracker observes the event.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      valueSetter?.call(input, 'revised');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('queued-message-edit-save');
    expect(calls[calls.length - 1]).toEqual([
      'chat.queue.edit',
      {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'c1',
        entryId: 'q1',
        text: 'revised',
      },
    ]);
    expect(
      container.querySelector('[data-testid="queued-message-editor"]'),
    ).toBeNull();

    await click('queued-message-edit');
    await click('queued-message-edit-cancel');
    expect(calls[calls.length - 1]).toEqual([
      'chat.queue.set_edit_lock',
      {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'c1',
        entryId: 'q1',
        locked: false,
      },
    ]);
    act(() => root.unmount());
  });

  it('waits for acquisition, blocks duplicate activation, and respects a deliberate focus move', async () => {
    let accept: () => void = () => undefined;
    const lock = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const calls: Array<[CommandName, unknown]> = [];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <CanopyClientProvider client={createClient(calls, { lock })}>
          <Seeder />
          <ChatPanel chatId="c1" />
        </CanopyClientProvider>,
      ),
    );
    await flushLazyTranscript();
    const badge = container.querySelector<HTMLElement>(
      '[data-testid="queued-message-edit"]',
    );
    act(() => {
      badge?.click();
      badge?.click();
    });
    expect(
      container.querySelector('[data-testid="queued-message-editor"]'),
    ).toBeNull();
    expect(calls).toHaveLength(1);
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();
    await act(async () => {
      const result = accept();
      await Promise.resolve();
      return result;
    });
    expect(
      container.querySelector('[data-testid="queued-message-editor"]'),
    ).not.toBeNull();
    expect(document.activeElement).toBe(elsewhere);
    act(() => root.unmount());
    container.remove();
    elsewhere.remove();
  });

  it('does not open a delayed acquisition after unmount and releases only its acquired target', async () => {
    let accept: () => void = () => undefined;
    const lock = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const calls: Array<[CommandName, unknown]> = [];
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() =>
      root.render(
        <CanopyClientProvider client={createClient(calls, { lock })}>
          <Seeder />
          <ChatPanel chatId="c1" />
        </CanopyClientProvider>,
      ),
    );
    await flushLazyTranscript();
    act(() =>
      container
        .querySelector<HTMLElement>('[data-testid="queued-message-edit"]')
        ?.click(),
    );
    act(() => root.unmount());
    expect(calls).toHaveLength(1);
    await act(async () => {
      const result = accept();
      await Promise.resolve();
      return result;
    });
    expect(calls).toEqual([
      [
        'chat.queue.set_edit_lock',
        {
          projectId: 'ws',
          worktreeId: 'wt',
          chatId: 'c1',
          entryId: 'q1',
          locked: true,
        },
      ],
      [
        'chat.queue.set_edit_lock',
        {
          projectId: 'ws',
          worktreeId: 'wt',
          chatId: 'c1',
          entryId: 'q1',
          locked: false,
        },
      ],
    ]);
  });

  it('opens the same editor on double-click, focused with the caret at the end', async () => {
    const calls: Array<[CommandName, unknown]> = [];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <CanopyClientProvider client={createClient(calls)}>
          <Seeder />
          <ChatPanel chatId="c1" />
        </CanopyClientProvider>,
      );
    });
    await flushLazyTranscript();

    const text = container.querySelector(
      '[data-testid="queued-message-bubble"] p',
    );
    if (!text) throw new Error('missing queued message text');
    await act(async () => {
      const init = { bubbles: true, cancelable: true, button: 0 };
      text.dispatchEvent(new MouseEvent('mousedown', { ...init, detail: 1 }));
      text.dispatchEvent(new MouseEvent('mousedown', { ...init, detail: 2 }));
      text.dispatchEvent(new MouseEvent('dblclick', { ...init, detail: 2 }));

      await Promise.resolve();
    });

    expect(calls).toEqual([
      [
        'chat.queue.set_edit_lock',
        {
          projectId: 'ws',
          worktreeId: 'wt',
          chatId: 'c1',
          entryId: 'q1',
          locked: true,
        },
      ],
    ]);
    const input = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="queued-message-edit-input"]',
    );
    expect(input?.value).toBe('original');
    expect(document.activeElement).toBe(input);
    expect(input?.selectionStart).toBe('original'.length);
    act(() => root.unmount());
    container.remove();
  });

  it('closes the editor and explains when the host rejects the lock', async () => {
    const calls: Array<[CommandName, unknown]> = [];
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <CanopyClientProvider
          client={createClient(calls, { rejectLock: true })}
        >
          <Seeder />
          <ChatPanel chatId="c1" />
        </CanopyClientProvider>,
      );
    });
    await flushLazyTranscript();

    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="queued-message-edit"]')
        ?.click();
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="queued-message-editor"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="message-edit-notice"]')
        ?.textContent,
    ).toContain('This message is no longer available to edit.');
    expect(calls.filter(([name]) => name === 'chat.queue.edit')).toEqual([]);

    // Dismissing clears the explanation.
    act(() => {
      container
        .querySelector<HTMLElement>(
          '[data-testid="message-edit-notice-dismiss"]',
        )
        ?.click();
    });
    expect(
      container.querySelector('[data-testid="message-edit-notice"]'),
    ).toBeNull();
    act(() => root.unmount());
  });

  it('saves with Enter and closes the editor', async () => {
    const calls: Array<[CommandName, unknown]> = [];
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <CanopyClientProvider client={createClient(calls)}>
          <Seeder />
          <ChatPanel chatId="c1" />
        </CanopyClientProvider>,
      );
    });
    await flushLazyTranscript();

    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="queued-message-edit"]')
        ?.click();

      await Promise.resolve();
    });
    const input = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="queued-message-edit-input"]',
    );
    act(() => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });

    expect(calls[calls.length - 1]).toEqual([
      'chat.queue.edit',
      {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'c1',
        entryId: 'q1',
        text: 'original',
      },
    ]);
    expect(
      container.querySelector('[data-testid="queued-message-editor"]'),
    ).toBeNull();
    act(() => root.unmount());
  });

  it('closes the editor and releases the lock when saving fails', async () => {
    const calls: Array<[CommandName, unknown]> = [];
    const client = createClient(calls, { rejectEdit: true });
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <CanopyClientProvider client={client}>
          <Seeder />
          <ChatPanel chatId="c1" />
        </CanopyClientProvider>,
      );
    });
    await flushLazyTranscript();

    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="queued-message-edit"]')
        ?.click();

      await Promise.resolve();
    });
    act(() => {
      container
        .querySelector<HTMLElement>('[data-testid="queued-message-edit-save"]')
        ?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="queued-message-editor"]'),
    ).toBeNull();
    expect(calls.slice(-2)).toEqual([
      [
        'chat.queue.edit',
        {
          projectId: 'ws',
          worktreeId: 'wt',
          chatId: 'c1',
          entryId: 'q1',
          text: 'original',
        },
      ],
      [
        'chat.queue.set_edit_lock',
        {
          projectId: 'ws',
          worktreeId: 'wt',
          chatId: 'c1',
          entryId: 'q1',
          locked: false,
        },
      ],
    ]);
    act(() => root.unmount());
  });

  it('keeps changed text recoverable when a save is rejected', async () => {
    const calls: Array<[CommandName, unknown]> = [];
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <CanopyClientProvider
          client={createClient(calls, { rejectEdit: true })}
        >
          <Seeder />
          <ChatPanel chatId="c1" />
        </CanopyClientProvider>,
      );
    });
    await flushLazyTranscript();
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="queued-message-edit"]')
        ?.click();
      await Promise.resolve();
    });
    const input = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="queued-message-edit-input"]',
    );
    if (!input) throw new Error('missing editor');
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set?.bind(input);
      setValue?.('original, revised');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="queued-message-edit-save"]')
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      container.querySelector<HTMLTextAreaElement>(
        '[data-testid="queued-message-unsaved-edit"] textarea',
      )?.value,
    ).toBe('original, revised');
    expect(
      container.querySelector('[data-testid="message-edit-notice"]')
        ?.textContent,
    ).toContain('save failed');
    act(() => root.unmount());
  });

  it('edits attachments only when the host preserves their send payload', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <CanopyClientProvider client={createClient([])}>
          <Seeder />
          <ChatPanel chatId="c1" />
        </CanopyClientProvider>,
      );
    });
    await flushLazyTranscript();

    expect(
      container.querySelectorAll('[data-testid="queued-message-edit"]'),
    ).toHaveLength(3);
    act(() => root.unmount());
  });

  it('saves an attachment-only queued message as a text-only edit', async () => {
    const calls: Array<[CommandName, unknown]> = [];
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <CanopyClientProvider client={createClient(calls)}>
          <Seeder />
          <ChatPanel chatId="c1" />
        </CanopyClientProvider>,
      );
    });
    await flushLazyTranscript();
    const edits = container.querySelectorAll<HTMLElement>(
      '[data-testid="queued-message-edit"]',
    );
    await act(async () => {
      edits[2]?.click();
      await Promise.resolve();
    });
    const save = container.querySelector<HTMLButtonElement>(
      '[data-testid="queued-message-edit-save"]',
    );
    if (!save) throw new Error('Missing queued save');
    expect(save.disabled).toBe(false);
    await act(async () => {
      save.click();
      await Promise.resolve();
    });
    expect(calls).toContainEqual([
      'chat.queue.edit',
      {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'c1',
        entryId: 'q4',
        text: '',
      },
    ]);
    act(() => root.unmount());
  });

  it('preserves an existing edit when another bubble is activated', async () => {
    const calls: Array<[CommandName, unknown]> = [];
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <CanopyClientProvider client={createClient(calls)}>
          <Seeder />
          <ChatPanel chatId="c1" />
        </CanopyClientProvider>,
      );
    });
    await flushLazyTranscript();

    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="queued-message-edit"]')
        ?.click();

      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="queued-message-edit"]')
        ?.click();

      await Promise.resolve();
    });

    expect(calls).toEqual([
      [
        'chat.queue.set_edit_lock',
        {
          projectId: 'ws',
          worktreeId: 'wt',
          chatId: 'c1',
          entryId: 'q1',
          locked: true,
        },
      ],
    ]);
    expect(
      container.querySelector<HTMLTextAreaElement>(
        '[data-testid="queued-message-edit-input"]',
      )?.value,
    ).toBe('original');
    act(() => root.unmount());
  });

  it('releases an edit whose row disappears and keeps each unsaved draft', async () => {
    const calls: Array<[CommandName, unknown]> = [];
    let hydrate:
      | ((queued: readonly { id: string; text: string }[]) => void)
      | undefined;
    function QueueUpdater(): null {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const hydrateThread = useChatStore((state) => state.hydrate);
      hydrate = (queued): void =>
        hydrateThread('c1', [], {
          route: {
            scope: 'worktree',
            workspaceLocalId: 'ws',
            worktreeLocalId: 'wt',
          },
          queuedMessages: queued.map((row, index) => ({
            ...row,
            origin: 'portal' as const,
            enqueuedAtMs: index + 1,
          })),
        });
      return null;
    }
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <CanopyClientProvider client={createClient(calls)}>
          <Seeder />
          <QueueUpdater />
          <ChatPanel chatId="c1" />
        </CanopyClientProvider>,
      );
    });
    await flushLazyTranscript();
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="queued-message-edit"]')
        ?.click();
      await Promise.resolve();
    });
    const input = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="queued-message-edit-input"]',
    );
    if (!input) throw new Error('missing editor');
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set?.bind(input);
      setValue?.('original, edited');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    act(() => hydrate?.([{ id: 'q2', text: 'second' }]));

    expect(
      container.querySelector('[data-testid="queued-message-editor"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="message-edit-notice"]')
        ?.textContent,
    ).toContain('This message is no longer available to edit.');
    expect(
      container.querySelector<HTMLTextAreaElement>(
        '[data-testid="queued-message-unsaved-edit"] textarea',
      )?.value,
    ).toBe('original, edited');
    expect(calls.at(-1)).toEqual([
      'chat.queue.set_edit_lock',
      {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'c1',
        entryId: 'q1',
        locked: false,
      },
    ]);

    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="queued-message-edit"]')
        ?.click();
      await Promise.resolve();
    });
    expect(calls.at(-1)).toEqual([
      'chat.queue.set_edit_lock',
      {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'c1',
        entryId: 'q2',
        locked: true,
      },
    ]);
    expect(
      container.querySelector<HTMLTextAreaElement>(
        '[data-testid="queued-message-edit-input"]',
      )?.value,
    ).toBe('second');

    // A second interrupted edit keeps both recovered drafts.
    const secondInput = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="queued-message-edit-input"]',
    );
    if (!secondInput) throw new Error('missing second editor');
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set?.bind(secondInput);
      setValue?.('second, edited');
      secondInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => hydrate?.([]));
    const recovered = (): Array<string | undefined> =>
      Array.from(
        container.querySelectorAll<HTMLTextAreaElement>(
          '[data-testid="queued-message-unsaved-edit"] textarea',
        ),
        (draft) => draft.value,
      );
    expect(recovered()).toEqual(['original, edited', 'second, edited']);
    expect(
      container
        .querySelector('[data-testid="queued-message-unsaved-edit"]')
        ?.querySelector(
          '[data-testid="message-edit-card"] textarea.resize-none',
        ),
    ).not.toBeNull();

    act(() => {
      container
        .querySelector<HTMLElement>(
          '[data-testid="queued-message-unsaved-edit-dismiss"]',
        )
        ?.click();
    });
    expect(recovered()).toEqual(['second, edited']);
    act(() => {
      container
        .querySelector<HTMLElement>(
          '[data-testid="queued-message-unsaved-edit-dismiss"]',
        )
        ?.click();
    });
    expect(
      container.querySelector('[data-testid="queued-message-unsaved-edit"]'),
    ).toBeNull();
    act(() => root.unmount());
  });

  it('edits inside the shared composer shell', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <CanopyClientProvider client={createClient([])}>
          <Seeder />
          <ChatPanel chatId="c1" />
        </CanopyClientProvider>,
      );
    });
    await flushLazyTranscript();
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="queued-message-edit"]')
        ?.click();
      await Promise.resolve();
    });
    const input = container.querySelector(
      '[data-testid="queued-message-edit-input"]',
    );
    expect(input).toBeInstanceOf(HTMLElement);
    expect(
      input?.closest('[data-testid="queued-message-edit-shell"]'),
    ).toBeInstanceOf(HTMLElement);
    act(() => root.unmount());
  });

  it('hides edit entry until a save settles', async () => {
    const calls: Array<[CommandName, unknown]> = [];
    let finishEdit: (() => void) | undefined;
    const edit = new Promise<void>((resolve) => {
      finishEdit = resolve;
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <CanopyClientProvider client={createClient(calls, { edit })}>
          <Seeder />
          <ChatPanel chatId="c1" />
        </CanopyClientProvider>,
      );
    });
    await flushLazyTranscript();
    const editBadges = (): number =>
      container.querySelectorAll('[data-testid="queued-message-edit"]').length;
    const badgesBefore = editBadges();
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="queued-message-edit"]')
        ?.click();
      await Promise.resolve();
    });
    act(() => {
      container
        .querySelector<HTMLElement>('[data-testid="queued-message-edit-save"]')
        ?.click();
    });

    expect(
      container.querySelector('[data-testid="queued-message-editor"]'),
    ).toBeNull();
    expect(editBadges()).toBe(0);

    await act(async () => {
      finishEdit?.();
      await edit;
    });
    expect(editBadges()).toBe(badgesBefore);
    act(() => root.unmount());
  });

  it('unlocks the latest editing entry on unmount', async () => {
    const calls: Array<[CommandName, unknown]> = [];
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <CanopyClientProvider client={createClient(calls)}>
          <Seeder />
          <ChatPanel chatId="c1" />
        </CanopyClientProvider>,
      );
    });
    await flushLazyTranscript();
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="queued-message-edit"]')
        ?.click();

      await Promise.resolve();
    });
    act(() => root.unmount());

    expect(calls[calls.length - 1]).toEqual([
      'chat.queue.set_edit_lock',
      {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'c1',
        entryId: 'q1',
        locked: false,
      },
    ]);
  });
});

function PhaseSeeder({
  rows,
}: {
  rows: ReadonlyArray<{
    id: string;
    turnPhase?: ChatTurnPhase;
    retryable?: boolean;
    canSteer?: boolean;
  }>;
}): null {
  // Zustand actions are closure-based and do not use `this`.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const hydrate = useChatStore((state) => state.hydrate);
  useEffect(() => {
    hydrate('c1', [], {
      route: {
        scope: 'worktree',
        workspaceLocalId: 'ws',
        worktreeLocalId: 'wt',
      },
      queuedMessages: rows.map((row, index) => ({
        text: `queued ${row.id}`,
        origin: 'portal' as const,
        enqueuedAtMs: index + 1,
        ...row,
      })),
      steeringCapabilities: {
        provider: 'claude',
        generation: 'g1',
        steer: true,
        withdraw: true,
        interrupt: true,
      },
    });
  }, [hydrate, rows]);
  return null;
}

describe('ChatPanel queued-message actions by turn phase', () => {
  async function renderRows(
    rows: Parameters<typeof PhaseSeeder>[0]['rows'],
    calls: Array<[CommandName, unknown]> = [],
  ): Promise<{ container: HTMLDivElement; unmount: () => void }> {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <CanopyClientProvider client={createClient(calls)}>
          <PhaseSeeder rows={rows} />
          <ChatPanel chatId="c1" />
        </CanopyClientProvider>,
      );
    });
    await flushLazyTranscript();
    return { container, unmount: (): void => act(() => root.unmount()) };
  }

  function count(container: HTMLElement, testId: string): number {
    return container.querySelectorAll(`[data-testid="${testId}"]`).length;
  }

  it('keeps Steer and Interrupt for rows from a host that reports no phase', async () => {
    const { container, unmount } = await renderRows([
      { id: 'q1', canSteer: true },
      { id: 'q2' },
    ]);

    expect(count(container, 'queued-message-steer')).toBe(1);
    expect(count(container, 'queued-message-interrupt')).toBe(2);
    expect(count(container, 'queued-message-retry')).toBe(0);
    unmount();
  });

  it('offers Steer and Interrupt while a foreground turn runs', async () => {
    const { container, unmount } = await renderRows([
      { id: 'q1', turnPhase: 'foreground', canSteer: true },
    ]);

    expect(count(container, 'queued-message-steer')).toBe(1);
    expect(count(container, 'queued-message-interrupt')).toBe(1);
    unmount();
  });

  it.each(['idle', 'background'] as const)(
    'hides Steer and Interrupt when the chat is %s',
    async (turnPhase) => {
      const { container, unmount } = await renderRows([
        { id: 'q1', turnPhase, canSteer: true },
        { id: 'q2', turnPhase },
      ]);

      expect(count(container, 'queued-message-steer')).toBe(0);
      expect(count(container, 'queued-message-interrupt')).toBe(0);
      expect(count(container, 'queued-message-cancel')).toBe(2);
      unmount();
    },
  );

  it.each(['idle', 'background'] as const)(
    'offers Retry for a row still queued while the chat is %s',
    async (turnPhase) => {
      const calls: Array<[CommandName, unknown]> = [];
      const { container, unmount } = await renderRows(
        [{ id: 'q1', turnPhase }],
        calls,
      );

      // Nothing is left to interrupt, so the row keeps a way to be sent.
      expect(count(container, 'queued-message-retry')).toBe(1);
      act(() => {
        container
          .querySelector<HTMLElement>('[data-testid="queued-message-retry"]')
          ?.click();
      });
      expect(calls).toEqual([
        [
          'chat.queue.force',
          { projectId: 'ws', worktreeId: 'wt', chatId: 'c1', entryId: 'q1' },
        ],
      ]);
      unmount();
    },
  );

  it.each([undefined, 'idle', 'background', 'foreground'] as const)(
    'retries a failed delivery through the force command (phase %s)',
    async (turnPhase) => {
      const calls: Array<[CommandName, unknown]> = [];
      const { container, unmount } = await renderRows(
        [{ id: 'q1', retryable: true, ...(turnPhase ? { turnPhase } : {}) }],
        calls,
      );

      expect(count(container, 'queued-message-retry')).toBe(1);
      expect(count(container, 'queued-message-interrupt')).toBe(0);
      act(() => {
        container
          .querySelector<HTMLElement>('[data-testid="queued-message-retry"]')
          ?.click();
      });
      expect(calls).toEqual([
        [
          'chat.queue.force',
          { projectId: 'ws', worktreeId: 'wt', chatId: 'c1', entryId: 'q1' },
        ],
      ]);
      unmount();
    },
  );
});

function createClient(
  calls: Array<[CommandName, unknown]>,
  options: {
    rejectEdit?: boolean;
    rejectLock?: boolean;
    lock?: Promise<void>;
    edit?: Promise<void>;
  } = {},
): CanopyClient {
  function command<K extends CommandName>(
    name: K,
    args: CommandMap[K]['args'],
  ): Promise<CommandMap[K]['result']>;
  function command(
    name: CommandName,
    args: CommandMap[CommandName]['args'],
  ): Promise<unknown> {
    calls.push([name, args]);
    switch (name) {
      case 'chat.queue.edit':
        if (options.edit) return options.edit;
        return options.rejectEdit
          ? Promise.reject(new Error('save failed'))
          : Promise.resolve();
      case 'chat.queue.set_edit_lock':
        if (options.lock && Reflect.get(args, 'locked') === true)
          return options.lock;
        return options.rejectLock && Reflect.get(args, 'locked') === true
          ? Promise.reject(
              new Error('This message is no longer available to edit.'),
            )
          : Promise.resolve();
      case 'chat.queue.force':
      case 'chat.queue.steer':
        return Promise.resolve();
      default:
        return Promise.reject(new Error(`Unexpected command: ${name}`));
    }
  }

  return {
    capabilities: {
      localExecution: false,
      terminalPty: false,
      fileSystemAccess: 'read',
      voice: false,
      settingsScope: 'api-keys-only',
      pipelines: 'read-only',
      routing: 'url',
      overviewNotifications: true,
    },
    query<K extends QueryName>(): Promise<QueryMap[K]['result']> {
      return Promise.reject(new Error('unused'));
    },
    command,
    subscribe(): Unsubscribe {
      return (): void => {};
    },
  };
}
