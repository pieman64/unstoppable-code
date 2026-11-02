/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PortalChatMessage } from '@canopy/protocol/portal';
import type { TurnFileRecord } from '@canopy/protocol/turn-files';
import { collectPortalTurnFiles } from '@canopy/agent-transcript/lib/portal-turn-files';
import { ChatLookProvider } from '@canopy/ui-shared/components/chat-look';
import { TranscriptFileLinkInteractionProvider } from '../TranscriptFileLinks';
import { TurnGroupView } from '../TurnGroupView';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const open = jest.fn<Promise<boolean>, [string]>();
const resolve = jest.fn<
  Promise<{ identity: string; projectName: string; exists?: boolean } | null>,
  [TurnFileRecord]
>((file) =>
  Promise.resolve(
    file.path === 'missing.md'
      ? null
      : { identity: file.path.replace('/ws/', ''), projectName: 'Research' },
  ),
);
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  open.mockReset().mockResolvedValue(true);
  resolve.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(
  files: TurnFileRecord[],
  clean = false,
  complete = true,
  supported = true,
  messages: PortalChatMessage[] = [],
): Promise<void> {
  const user: PortalChatMessage = {
    chatId: 'chat-1',
    messageId: 'u',
    role: 'user',
    text: 'Revise the report',
    status: 'complete',
    createdAtMs: 0,
  };
  const final: PortalChatMessage = {
    ...user,
    role: 'assistant',
    chatId: 'chat-1',
    messageId: 'final',
    text: 'Done.',
  };
  await act(async () => {
    root.render(
      <ChatLookProvider value={clean ? 'clean' : 'classic'}>
        <TranscriptFileLinkInteractionProvider
          value={
            supported
              ? {
                  openFileLink: open,
                  turnFiles: { collect: collectPortalTurnFiles, resolve },
                }
              : {}
          }
        >
          <TurnGroupView
            latest
            turnGroup={{
              userMessageId: 'u',
              intermediateMessageIds: messages.map((m) => m.messageId),
              finalMessageIds: ['final'],
              files,
              complete,
            }}
            messagesById={Object.fromEntries(
              [user, ...messages, final].map((m) => [m.messageId, m]),
            )}
          />
        </TranscriptFileLinkInteractionProvider>
      </ChatLookProvider>,
    );
    await Promise.resolve();
  });
}

async function click(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

it.each([false, true])(
  'mounts the shared summary, opens through the host, and survives remount (clean=%s)',
  async (clean) => {
    const files: TurnFileRecord[] = [
      { path: 'report.md', state: 'ready', change: 'updated' },
    ];
    await render(files, clean);
    if (clean) expect(container.textContent).not.toContain('1 file updated');
    else expect(container.textContent).toContain('1 file updated');
    expect(container.textContent).toContain('Updated in Research');
    expect(
      container.querySelectorAll('[data-testid="turn-file-chip"]'),
    ).toHaveLength(1);
    expect(
      container.querySelector('[data-testid="turn-file-chip-reveal"]'),
    ).toBeNull();
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="turn-file-chip-open"]',
    );
    await click(() => button?.click());
    expect(open).toHaveBeenCalledWith('report.md');
    act(() => root.unmount());
    root = createRoot(container);
    await render(
      files.map((file) => ({ ...file })),
      clean,
    );
    expect(container.textContent).toContain('Updated in Research');
  },
);

it('gates pending actions and removes failed edits deterministically', async () => {
  await render(
    [{ path: 'report.md', state: 'creating', change: 'updated' }],
    false,
    false,
  );
  expect(container.textContent).toContain('1 file updating');
  const button = container.querySelector<HTMLButtonElement>(
    '[data-testid="turn-file-chip-open"]',
  );
  await click(() => button?.click());
  expect(open).not.toHaveBeenCalled();
  expect(resolve).toHaveBeenCalledWith(
    expect.objectContaining({ state: 'creating' }),
  );
  await render(
    [{ path: 'report.md', state: 'ready', change: 'updated' }],
    false,
    false,
  );
  expect(container.textContent).toContain('1 file updated');
  await render([{ path: 'report.md', state: 'failed', change: 'updated' }]);
  expect(container.querySelector('[data-testid="turn-files"]')).toBeNull();
});

it('counts only existing resolved identities, keeps saved precedence, and gates unsupported hosts', async () => {
  const files: TurnFileRecord[] = [
    { path: 'report.md', state: 'ready', change: 'updated' },
    { path: '/ws/report.md', state: 'ready', saved: true },
    { path: 'missing.md', state: 'ready', change: 'updated' },
  ];
  await render(files);
  expect(
    container.querySelectorAll('[data-testid="turn-file-chip"]'),
  ).toHaveLength(1);
  expect(container.textContent).toContain('Saved in Research');
  expect(container.textContent).not.toContain('updated');
  await render(files, false, true, false);
  expect(container.querySelector('[data-testid="turn-files"]')).toBeNull();
});

it.each([false, true])(
  'discovers tools and retries an open error (clean=%s)',
  async (clean) => {
    await render([], clean, true, true, [
      {
        chatId: 'chat-1',
        messageId: 'edit',
        role: 'assistant',
        text: '',
        status: 'complete',
        createdAtMs: 1,
        parts: [
          {
            kind: 'tool_use',
            data: {
              toolName: 'Edit',
              input: '{"file_path":"report.md"}',
              result: { output: 'Done', isError: false },
            },
          },
        ],
      },
    ]);
    if (!clean) expect(container.textContent).toContain('1 file updated');
    open.mockRejectedValueOnce(new Error('Offline'));
    await click(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="turn-file-chip-open"]')
        ?.click(),
    );
    expect(container.textContent).toContain(
      'Unable to open this file. Try again.',
    );
    await click(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="turn-file-chip-open"]')
        ?.click(),
    );
    expect(open).toHaveBeenCalledTimes(2);
  },
);

it('exposes the complete filename to a keyboard user before opening', async () => {
  const filename =
    'Q3 Board Deck — FINAL (revised) v13 [approved by legal].pdf';
  await render([{ path: filename, state: 'ready' }], true);
  const button = container.querySelector<HTMLButtonElement>(
    '[data-testid="turn-file-chip-open"]',
  );
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
    );
    button?.focus();
  });
  expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
    filename,
  );
  expect(open).not.toHaveBeenCalled();
});

it.each([false, true])(
  'keeps an update when an absolute presentation receipt resolves to it (receipt first=%s)',
  async (receiptFirst) => {
    const message = (
      toolName: string,
      input: string,
      output: string,
    ): PortalChatMessage => ({
      chatId: 'chat-1',
      messageId: toolName,
      role: 'assistant',
      text: '',
      status: 'complete',
      createdAtMs: 1,
      parts: [
        {
          kind: 'tool_use',
          data: { toolName, input, result: { output, isError: false } },
        },
      ],
    });
    const edit = message('Edit', '{"file_path":"report.md"}', 'Done');
    const receipt = message(
      'ShowFiles',
      '{}',
      '{"files":[{"path":"/ws/report.md","absolutePath":"/ws/report.md","ok":true}]}',
    );
    await render(
      [],
      false,
      true,
      true,
      receiptFirst ? [receipt, edit] : [edit, receipt],
    );
    expect(
      container.querySelectorAll('[data-testid="turn-file-chip"]'),
    ).toHaveLength(1);
    expect(container.textContent).toContain('1 file updated');
    expect(container.textContent).toContain('Updated in Research');
  },
);

it('encodes literal filename characters when opening a chip', async () => {
  await render([
    { path: 'reports/report#1?100%.md', state: 'ready', change: 'updated' },
  ]);
  await click(() =>
    container
      .querySelector<HTMLButtonElement>('[data-testid="turn-file-chip-open"]')
      ?.click(),
  );
  expect(open).toHaveBeenCalledWith('reports/report%231%3F100%25.md');
});

it('keeps retained presentation pending or hidden when the live edit is unfinished or failed', async () => {
  const edit: PortalChatMessage = {
    chatId: 'chat-1',
    messageId: 'edit',
    role: 'assistant',
    text: '',
    status: 'complete',
    createdAtMs: 1,
    parts: [
      {
        kind: 'tool_use',
        data: { toolName: 'Edit', input: '{"file_path":"report.md"}' },
      },
    ],
  };
  await render([{ path: 'report.md', state: 'ready' }], false, false, true, [
    edit,
  ]);
  expect(container.textContent).toContain('1 file updating');
  await click(() =>
    container
      .querySelector<HTMLButtonElement>('[data-testid="turn-file-chip-open"]')
      ?.click(),
  );
  expect(open).not.toHaveBeenCalled();
  await render([{ path: 'report.md', state: 'ready' }], false, true, true, [
    {
      ...edit,
      parts: [
        {
          kind: 'tool_use',
          data: {
            toolName: 'Edit',
            input: '{"file_path":"report.md"}',
            result: { output: 'Denied', isError: true },
          },
        },
      ],
    },
  ]);
  expect(container.querySelector('[data-testid="turn-files"]')).toBeNull();
});

it.each(['creating', 'failed'] as const)(
  'reconciles a %s relative edit with an absolute-only receipt before rendering',
  async (state) => {
    const message: PortalChatMessage = {
      chatId: 'chat-1',
      messageId: 'alias',
      role: 'assistant',
      text: '',
      status: 'complete',
      createdAtMs: 1,
      parts: [
        {
          kind: 'tool_use',
          data: {
            toolName: 'ShowFiles',
            input: '{}',
            result: {
              output: '{"files":[{"path":"/ws/report.md","ok":true}]}',
              isError: false,
            },
          },
        },
        {
          kind: 'tool_use',
          data: {
            toolName: 'Edit',
            input: '{"file_path":"report.md"}',
            ...(state === 'failed'
              ? { result: { output: 'Denied', isError: true } }
              : {}),
          },
        },
      ],
    };
    await render([], false, state === 'failed', true, [message]);
    if (state === 'creating') {
      expect(
        container.querySelectorAll('[data-testid="turn-file-chip"]'),
      ).toHaveLength(1);
      expect(container.textContent).toContain('1 file updating');
      await click(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="turn-file-chip-open"]',
          )
          ?.click(),
      );
      expect(open).not.toHaveBeenCalled();
    } else
      expect(container.querySelector('[data-testid="turn-files"]')).toBeNull();
    expect(container.textContent).not.toContain('Saved in');
  },
);

it.each(['creating', 'failed'] as const)(
  'keeps a successful saved mutation when its relative retry is %s',
  async (state) => {
    await render(
      [
        { path: '/ws/report.md', state: 'ready', saved: true },
        { path: 'report.md', state, change: 'updated' },
      ],
      false,
      state === 'failed',
    );
    expect(
      container.querySelectorAll('[data-testid="turn-file-chip"]'),
    ).toHaveLength(1);
    expect(container.textContent).toContain('Saved in Research');
    expect(container.textContent).not.toContain('Updating');
  },
);

it.each(['creating', 'failed'] as const)(
  'does not expose a presentation when its %s alias cannot be checked',
  async (state) => {
    resolve
      .mockResolvedValueOnce({ identity: 'report.md', projectName: 'Research' })
      .mockRejectedValueOnce(new Error('offline'));
    await render(
      [
        { path: '/ws/report.md', state: 'ready' },
        { path: 'report.md', state, change: 'updated' },
      ],
      false,
      state === 'failed',
    );
    expect(container.textContent).not.toContain('Saved in');
    if (state === 'creating')
      expect(container.textContent).toContain('Updating');
    else
      expect(container.querySelector('[data-testid="turn-files"]')).toBeNull();
  },
);

it.each(['move', 'delete'] as const)(
  'reconciles a relative %s after an absolute Write even when the source no longer exists',
  async (operation) => {
    const write: PortalChatMessage = {
      chatId: 'chat-1',
      messageId: 'write-source',
      role: 'assistant',
      text: '',
      status: 'complete',
      createdAtMs: 1,
      parts: [
        {
          kind: 'tool_use',
          data: {
            toolName: 'Write',
            input: '{"file_path":"/ws/report.md"}',
            result: { output: 'Done', isError: false },
          },
        },
      ],
    };
    await render([], false, false, true, [write]);
    expect(container.textContent).toContain('Saved in Research');
    const previous = resolve.getMockImplementation();
    resolve.mockImplementation((file) =>
      Promise.resolve({
        identity: file.path.replace('/ws/', ''),
        projectName: 'Research',
        exists: file.path !== '/ws/report.md' && file.path !== 'report.md',
      }),
    );
    try {
      await render([], false, false, true, [
        write,
        {
          ...write,
          chatId: 'chat-1',
          messageId: operation,
          createdAtMs: 2,
          parts: [
            {
              kind: 'tool_use',
              data: {
                toolName: 'apply_patch',
                input:
                  operation === 'move'
                    ? '*** Update File: report.md\n*** Move to: renamed.md\n@@\n-old\n+new'
                    : '*** Delete File: report.md',
                result: { output: 'Done', isError: false },
              },
            },
          ],
        },
      ]);
      if (operation === 'delete')
        expect(
          container.querySelector('[data-testid="turn-files"]'),
        ).toBeNull();
      else {
        expect(
          container.querySelectorAll('[data-testid="turn-file-chip"]'),
        ).toHaveLength(1);
        expect(container.textContent).toContain('Saved in Research');
        await click(() =>
          container
            .querySelector<HTMLButtonElement>(
              '[data-testid="turn-file-chip-open"]',
            )
            ?.click(),
        );
        expect(open).toHaveBeenCalledWith('renamed.md');
      }
    } finally {
      if (previous) resolve.mockImplementation(previous);
    }
  },
);

it('clean summaries allow manual disclosure and keep every saved file in a bounded list', async () => {
  await render(
    Array.from({ length: 12 }, (_, index) => ({
      path: `report-${index}.md`,
      state: 'ready' as const,
    })),
    true,
  );
  const toggle = container.querySelector<HTMLButtonElement>(
    'button[aria-expanded]',
  );
  expect(toggle).not.toBeNull();
  expect(
    container.querySelectorAll('[data-testid="turn-file-chip"]'),
  ).toHaveLength(12);
  expect(
    container.querySelector('[data-testid="turn-files-scroll"]'),
  ).not.toBeNull();
  await click(() => toggle?.click());
  expect(
    container
      .querySelector('[data-testid="turn-file-chip"]')
      ?.closest('[hidden]'),
  ).not.toBeNull();
  await click(() => toggle?.click());
  expect(
    container.querySelectorAll('[data-testid="turn-file-chip"]'),
  ).toHaveLength(12);
});

it.each([false, true])(
  'projects waiting, resumed and denied writes through the real turn provider (clean=%s, CAN-5291)',
  async (clean) => {
    const timer = (data: Record<string, unknown>): PortalChatMessage => ({
      chatId: 'chat',
      messageId: 'approval-timer',
      role: 'system',
      text: '',
      status: 'streaming',
      createdAtMs: 1,
      parts: [{ kind: 'turn_timer', data: { startedAt: 1, ...data } }],
    });
    for (const toolName of ['Write', 'Edit']) {
      const write = (
        id: string,
        result?: { output: string; isError: boolean },
      ): PortalChatMessage => ({
        chatId: 'chat',
        messageId: id,
        role: 'assistant',
        text: '',
        status: 'streaming',
        createdAtMs: 1,
        parts: [
          {
            kind: 'tool_use',
            data: {
              toolUseId: id,
              toolName,
              input: { file_path: 'report.md', content: 'Report' },
              ...(result ? { result } : {}),
            },
          },
        ],
      });
      await render([], clean, false, true, [
        write('write'),
        timer({ pausedAt: 5 }),
      ]);
      const chip = (): HTMLButtonElement | null =>
        container.querySelector('[data-testid="turn-file-chip-open"]');
      expect(container.textContent).toContain('Waiting for approval');
      expect(container.textContent).not.toMatch(
        /Creating…|Updating…|file updating/,
      );
      expect(chip()?.getAttribute('aria-busy')).toBe('false');
      expect(chip()?.getAttribute('aria-label')).toBe(
        'report.md, waiting for approval',
      );
      await click(() => chip()?.click());
      expect(open).not.toHaveBeenCalled();
      expect(
        container.querySelector('[data-testid="turn-file-chip-reveal"]'),
      ).toBeNull();
      await render([], clean, false, true, [
        write('write'),
        timer({ pausedAt: 5, resumedAt: 9 }),
      ]);
      expect(container.textContent).toContain(
        toolName === 'Edit' ? 'Updating…' : 'Creating…',
      );
      expect(chip()?.getAttribute('aria-busy')).toBe('true');
      // One denial must not remove the other call's still-pending contribution.
      const denied = {
        output: 'The user denied this tool use.',
        isError: true,
      };
      await render([], clean, false, true, [
        write('write'),
        write('other', denied),
        timer({ pausedAt: 10 }),
      ]);
      expect(
        container.querySelectorAll('[data-testid="turn-file-chip"]'),
      ).toHaveLength(1);
      expect(container.textContent).toContain('Waiting for approval');
      await render([], clean, false, true, [
        write('write', denied),
        timer({ pausedAt: 10, resumedAt: 15 }),
      ]);
      expect(container.querySelector('[data-testid="turn-files"]')).toBeNull();
      // A prior successful change survives a later denied edit, without waiting.
      await render([], clean, true, true, [
        write('write', { output: 'ok', isError: false }),
        write('other', denied),
        timer({ pausedAt: 10, completedAt: 20 }),
      ]);
      expect(
        container.querySelectorAll('[data-testid="turn-file-chip"]'),
      ).toHaveLength(1);
      expect(container.textContent).not.toContain('Waiting for approval');
      expect(chip()?.getAttribute('aria-label')).toBe('Open report.md');
    }
  },
);
