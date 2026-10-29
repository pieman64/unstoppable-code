/** @jest-environment jsdom */

import { act, type JSX, type ReactNode, useEffect } from 'react';
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
import { ChatPanel, type ChatComposerHostControls } from '../ChatPanel';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('../ChatComposer', () => ({
  ChatComposer: (): JSX.Element => <div data-testid="composer" />,
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

describe('ChatPanel queued-message inline edit', () => {
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

  it('locks on open, edits on save, and unlocks on cancel', async () => {
    const calls: Array<[CommandName, unknown]> = [];
    const client: CanopyClient = {
      capabilities: {
        localExecution: false,
        terminalPty: false,
        fileSystemAccess: 'read',
        voice: false,
        settingsScope: 'limited',
        pipelines: 'view-only',
        routing: 'portal',
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

  it('edits inside the shared composer-style card', async () => {
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
    expect(input?.closest('[data-testid="message-edit-card"]')).not.toBeNull();
    expect(input?.classList.contains('resize-none')).toBe(true);
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
      settingsScope: 'limited',
      pipelines: 'view-only',
      routing: 'portal',
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
