/** @jest-environment jsdom */
import { act, useContext, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyClient,
  DelegationPage,
  DelegationPageRequest,
  TranscriptReadResult,
  TranscriptReadSource,
  TranscriptContentRequest,
  TranscriptContentRange,
} from '@canopy/app-core';
import type {
  DelegationPageReadRequest,
  DelegationPagesState,
} from '@canopy/app-state';
import type * as AppState from '@canopy/app-state';
import {
  DelegationChildPages,
  type DelegationChildPagesProps,
  type DelegationChildRowEntry,
} from '../DelegationChildPages';
import {
  ToolOutputReaderContext,
  DeferredToolOutput,
  type ToolOutputReader,
} from '../DeferredToolOutput';
import { TranscriptReadHostContext } from '../transcript-read-host-context';

const readPage = jest.fn<
  Promise<TranscriptReadResult<DelegationPage>>,
  [DelegationPageReadRequest, AbortSignal]
>();
const readContent = jest.fn<
  Promise<TranscriptReadResult<TranscriptContentRange>>,
  [TranscriptContentRequest, AbortSignal]
>();
const readBlocks = jest.fn();
const reads: DelegationPagesState = { readPage, readContent, readBlocks };
let selectedReads = reads;
function selectState<T>(selector: (state: DelegationPagesState) => T): T {
  return selector(selectedReads);
}
let available = true;
const capabilitiesFor = jest.fn();
jest.mock('@canopy/app-state', () => ({
  useCanopyClient: (): { transcripts: object | undefined } => ({
    transcripts: available ? {} : undefined,
  }),
  useWorkspaceCapabilities: (
    id: string,
  ): { delegationTranscriptReads: boolean; delegationBlockReads: boolean } => {
    capabilitiesFor(id);
    return { delegationTranscriptReads: available, delegationBlockReads: true };
  },
  useDelegationPagesStore: (): typeof selectState => selectState,
}));
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});
/** The page store only consumes encoded byteLength in this browser test. */
class TestTextEncoder {
  encode(text: string): Uint8Array {
    let bytes = 0;
    for (let index = 0; index < text.length; index += 1) {
      const codePoint = text.codePointAt(index);
      if (codePoint === undefined) continue;
      if (codePoint > 0xffff) {
        bytes += 4;
        index += 1;
      } else if (codePoint > 0x7ff) bytes += 3;
      else if (codePoint > 0x7f) bytes += 2;
      else bytes += 1;
    }
    return new Uint8Array(bytes);
  }
}
Reflect.set(globalThis, 'TextEncoder', TestTextEncoder);
const source: TranscriptReadSource = {
  scope: { workspaceId: 'project', worktreeId: 'tree', chatId: 'chat' },
};
function page(
  id: string,
  cursor?: string,
): TranscriptReadResult<DelegationPage> {
  return {
    ok: true,
    value: {
      transcriptRevision: 7,
      ...(cursor ? { cursor } : {}),
      rows: [
        {
          id,
          role: 'assistant',
          timestamp: 1,
          row: { id, blocks: [{ type: 'text', text: id }] },
        },
      ],
    },
  };
}
let reader: ToolOutputReader | null;
function Probe(): ReactNode {
  reader = useContext(ToolOutputReaderContext);
  return null;
}
function rows(entries: readonly DelegationChildRowEntry[]): ReactNode {
  return entries.map((entry) => (
    <span key={entry.key}>
      {entry.key}
      <Probe />
    </span>
  ));
}
describe('shared child window', () => {
  let container: HTMLDivElement;
  let root: Root;
  let props: DelegationChildPagesProps;
  const releasePending: Array<() => void> = [];
  beforeEach(() => {
    releasePending.length = 0;
    selectedReads = reads;
    available = true;
    reader = null;
    readPage.mockReset();
    readContent.mockReset();
    capabilitiesFor.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    props = {
      source,
      delegationId: 'delegate',
      runGeneration: 2,
      renderRows: rows,
      hint: { epoch: 3, streamRevision: 7 },
    };
    readPage.mockResolvedValue(page('newest', 'older-1'));
  });
  afterEach(() => {
    act(() => {
      root.unmount();
      for (const release of releasePending) release();
    });
    container.remove();
  });
  async function render(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      root.render(<DelegationChildPages {...props} />);
    });
  }
  async function click(label: string): Promise<void> {
    const button = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent === label,
    );
    expect(button).toBeDefined();
    if (!button) return;
    await act(async () => {
      await Promise.resolve();
      button.click();
    });
  }
  function ids(): string[] {
    return Array.from(container.querySelectorAll('[data-child-row-id]')).map(
      (row) => row.getAttribute('data-child-row-id') ?? '',
    );
  }
  it('drops logical mode and fences body reads when v2 is lost while v1 stays available', async () => {
    props = { ...props, v2Available: true };
    await render();
    if (!reader) throw new Error('Missing reader');
    readContent.mockResolvedValue({
      ok: true,
      value: { text: 'text', byteLength: 4 },
    });
    await reader(
      { kind: 'row', messageId: 'newest', blockOrdinal: 0, field: 'text' },
      0,
      new AbortController().signal,
    );
    expect(readContent.mock.calls[0]?.[0]).toMatchObject({
      field: 'text',
      fieldSource: 'logical',
      epoch: 3,
    });
    props = { ...props, v2Available: false };
    await render();
    if (!reader) throw new Error('Missing reader');
    await reader(
      { kind: 'row', messageId: 'newest', blockOrdinal: 0, field: 'text' },
      0,
      new AbortController().signal,
    );
    expect(readContent.mock.calls[1]?.[0]).not.toHaveProperty('fieldSource');
    expect(readPage).toHaveBeenCalledTimes(2);
  });

  it('offers explicit message expansion for paged blocks before reading them', async () => {
    readPage.mockResolvedValue({
      ok: true,
      value: {
        transcriptRevision: 7,
        rows: [
          {
            id: 'paged',
            role: 'assistant',
            timestamp: 1,
            row: { id: 'paged' },
            blocksPaged: { blockCount: 46 },
          },
        ],
      },
    });
    props = {
      ...props,
      renderBlock: (entry): ReactNode => <span>{entry.ordinal}</span>,
    };
    await render();
    expect(container.textContent).toContain('Partial:');
    expect(
      Array.from(container.querySelectorAll('button')).map(
        (button) => button.textContent,
      ),
    ).toContain('Show message');
  });

  it('loads newest with exact scope, target and hints; unavailable views never read', async () => {
    await render();
    expect(ids()).toEqual(['newest']);
    expect(readPage).toHaveBeenCalledWith(
      {
        source,
        target: {
          kind: 'delegation',
          chatId: 'chat',
          delegationId: 'delegate',
          runGeneration: 2,
        },
        cursor: 'newest',
        epoch: 3,
        streamRevisionHint: 7,
      },
      expect.any(AbortSignal),
    );
    expect(capabilitiesFor).toHaveBeenCalledWith('tree');
    available = false;
    props = { ...props, renderRows: (entries): ReactNode => rows(entries) };
    await render();
    expect(container.textContent).toBe("Couldn't load messages in this view.");
    expect(container.querySelector('button')).toBeNull();
    expect(readPage).toHaveBeenCalledTimes(1);
  });
  it('keeps host provenance intact and stabilizes equal-by-value sources', async () => {
    const extended = { ...source, standalone: { projectLocalId: 'owner' } };
    props = { ...props, source: extended };
    readPage.mockResolvedValueOnce({
      ok: true,
      value: {
        transcriptRevision: 7,
        rows: [
          {
            id: 'stored',
            role: 'assistant',
            timestamp: 1,
            row: {
              id: 'stored',
              blocks: [
                {
                  type: 'tool_result',
                  toolUseId: 'same',
                  output: 'preview',
                  isError: false,
                },
              ],
            },
          },
        ],
      },
    });
    await render();
    expect(readPage.mock.calls[0]?.[0].source).toEqual({
      scope: { workspaceId: 'project', worktreeId: 'tree', chatId: 'chat' },
      standalone: { projectLocalId: 'owner' },
    });
    const mounted = container.querySelector('[data-child-row-id="stored"]');
    const equalSource = {
      ...extended,
      standalone: { projectLocalId: 'owner' },
    };
    props = { ...props, source: equalSource };
    await render();
    expect(readPage).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-child-row-id="stored"]')).toBe(
      mounted,
    );
    readContent.mockResolvedValue({
      ok: true,
      value: { text: 'body', byteLength: 4 },
    });
    if (!reader) throw new Error('Missing reader');
    await reader(
      { kind: 'row', messageId: 'stored', blockOrdinal: 0, field: 'output' },
      0,
      new AbortController().signal,
    );
    expect(readContent.mock.calls[0]?.[0]).toMatchObject({
      standalone: { projectLocalId: 'owner' },
    });
  });
  it('preserves extra source fields through the real store to both client methods without an equal-source refetch', async () => {
    const { createDelegationPagesStore } =
      jest.requireActual<typeof AppState>('@canopy/app-state');
    const clientPage = jest
      .fn<
        Promise<TranscriptReadResult<DelegationPage>>,
        [DelegationPageRequest, AbortSignal]
      >()
      .mockResolvedValue(page('stored'));
    const clientContent = jest
      .fn<
        Promise<TranscriptReadResult<TranscriptContentRange>>,
        [TranscriptContentRequest, AbortSignal]
      >()
      .mockResolvedValue({
        ok: true,
        value: { text: 'full body', byteLength: 9 },
      });
    const client: CanopyClient = {
      capabilities: {
        localExecution: false,
        terminalPty: false,
        fileSystemAccess: 'read',
        voice: false,
        settingsScope: 'api-keys-only',
        pipelines: 'crud-only',
        routing: 'url',
        overviewNotifications: false,
      },
      transcripts: {
        delegationPage: clientPage,
        content: clientContent,
        blocks: jest.fn(),
      },
      query: () => Promise.reject(new Error('Unexpected query')),
      command: () => Promise.reject(new Error('Unexpected command')),
      subscribe: () => (): void => {},
    };
    selectedReads = createDelegationPagesStore(client).getState();
    const extended = { ...source, standalone: { projectLocalId: 'owner' } };
    props = { ...props, source: extended, hint: { epoch: 3 } };
    await render();
    const mounted = container.querySelector('[data-child-row-id="stored"]');
    const equalSource = { ...source, standalone: { projectLocalId: 'owner' } };
    props = { ...props, source: equalSource };
    await render();
    expect(clientPage).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-child-row-id="stored"]')).toBe(
      mounted,
    );
    if (!reader) throw new Error('Missing reader');
    await reader(
      { kind: 'row', messageId: 'stored', blockOrdinal: 0, field: 'output' },
      0,
      new AbortController().signal,
    );
    expect(clientPage.mock.calls[0]?.[0]).toEqual({
      scope: { workspaceId: 'project', worktreeId: 'tree', chatId: 'chat' },
      standalone: { projectLocalId: 'owner' },
      target: {
        kind: 'delegation',
        chatId: 'chat',
        delegationId: 'delegate',
        runGeneration: 2,
      },
    });
    expect(clientContent.mock.calls[0]?.[0]).toEqual({
      scope: { workspaceId: 'project', worktreeId: 'tree', chatId: 'chat' },
      standalone: { projectLocalId: 'owner' },
      target: {
        kind: 'delegation',
        chatId: 'chat',
        delegationId: 'delegate',
        runGeneration: 2,
      },
      messageId: 'stored',
      blockOrdinal: 0,
      field: 'output',
      fieldSource: 'logical',
      offset: 0,
      limit: 65536,
    });
  });
  it('unmounts old rows immediately when the epoch changes while the new read is pending', async () => {
    await render();
    readPage.mockReturnValueOnce(
      new Promise((resolve) => {
        releasePending.push(() => resolve({ ok: false, kind: 'cancelled' }));
      }),
    );
    props = { ...props, hint: { epoch: 4, streamRevision: 7 } };
    await render();
    expect(ids()).toEqual([]);
  });
  it('forwards an absent stream revision but keeps the legacy no-hint zero default', async () => {
    props = { ...props, hint: { epoch: 3 } };
    await render();
    expect(readPage.mock.calls[0]?.[0]).toMatchObject({ epoch: 3 });
    expect(readPage.mock.calls[0]?.[0].streamRevisionHint).toBeUndefined();
    props = { ...props, delegationId: 'legacy', hint: undefined };
    await render();
    expect(readPage.mock.calls[1]?.[0]).toMatchObject({
      epoch: 0,
      streamRevisionHint: 0,
    });
  });
  it('does not retain an earlier revision when the host later omits it', async () => {
    await render();
    readPage.mockResolvedValueOnce({ ok: false, kind: 'failed' });
    props = { ...props, hint: { epoch: 3, streamRevision: 8 } };
    await render();
    props = { ...props, hint: { epoch: 3 } };
    await render();
    await click('Reload messages');
    expect(readPage.mock.calls.at(-1)?.[0].streamRevisionHint).toBeUndefined();
  });
  it('opens each duplicate result at its own raw ordinal', async () => {
    readPage.mockResolvedValueOnce({
      ok: true,
      value: {
        transcriptRevision: 7,
        rows: [
          {
            id: 'stored',
            role: 'assistant',
            timestamp: 1,
            row: {
              id: 'stored',
              blocks: [
                {
                  type: 'tool_result',
                  toolUseId: 'same',
                  output: 'one',
                  isError: false,
                },
                {
                  type: 'tool_result',
                  toolUseId: 'same',
                  output: 'two',
                  isError: false,
                },
              ],
            },
          },
        ],
      },
    });
    await render();
    readContent.mockImplementation((request) =>
      Promise.resolve({
        ok: true,
        value:
          request.blockOrdinal === 0
            ? { text: 'first body', byteLength: 10 }
            : { text: 'second body', byteLength: 11 },
      }),
    );
    if (!reader) throw new Error('Missing reader');
    await expect(
      reader(
        { kind: 'row', messageId: 'stored', blockOrdinal: 0, field: 'output' },
        0,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ text: 'first body', byteLength: 10 });
    await expect(
      reader(
        { kind: 'row', messageId: 'stored', blockOrdinal: 1, field: 'output' },
        0,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ text: 'second body', byteLength: 11 });
    expect(
      readContent.mock.calls.map(([request]) => request.blockOrdinal),
    ).toEqual([0, 1]);
    await expect(
      reader(
        {
          kind: 'reference',
          messageId: 'stored',
          toolUseId: 'same',
          reference: {
            version: 1,
            artifactId: 'unused',
            sha256: 'unused',
            byteLength: 1,
            encoding: 'utf-8',
            mediaType: 'text/plain',
          },
        },
        0,
        new AbortController().signal,
      ),
    ).rejects.toThrow("Couldn't load full output in this view.");
    expect(readContent).toHaveBeenCalledTimes(2);
  });
  it('aborts and discards an open body across an epoch remount with identical row ids', async () => {
    props = {
      ...props,
      renderRows: (entries): ReactNode =>
        entries.map((entry) => (
          <DeferredToolOutput
            key={entry.key}
            identity={{
              kind: 'row',
              messageId: entry.key,
              blockOrdinal: 0,
              field: 'output',
            }}
            preview="preview"
          />
        )),
    };
    await render();
    let settle: (
      value: TranscriptReadResult<TranscriptContentRange>,
    ) => void = () => {};
    readContent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    await click('View full output');
    const oldSignal = readContent.mock.calls[0]?.[1];
    props = { ...props, hint: { epoch: 4 } };
    await render();
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => {
      settle({ ok: true, value: { text: 'old epoch body', byteLength: 14 } });
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain('old epoch body');
    expect(
      container.querySelector('[data-testid="chat-tool-output-open"]'),
    ).not.toBeNull();
  });
  it('requires a host renderer and source, even with the read capability', async () => {
    props = { delegationId: 'delegate', runGeneration: 2 };
    await render();
    expect(container.textContent).toBe("Couldn't load messages in this view.");
    expect(readPage).not.toHaveBeenCalled();
  });
  it('uses the owner host context without guessing a child source, with explicit props taking precedence', async () => {
    const owner = { source, renderRows: rows, epoch: 8 };
    await act(async () => {
      root.render(
        <TranscriptReadHostContext.Provider value={owner}>
          <DelegationChildPages delegationId="nested" runGeneration={2} />
        </TranscriptReadHostContext.Provider>,
      );
      await Promise.resolve();
    });
    expect(readPage).toHaveBeenCalledWith(
      expect.objectContaining({
        source,
        epoch: 8,
        streamRevisionHint: undefined,
        target: {
          kind: 'delegation',
          chatId: 'chat',
          delegationId: 'nested',
          runGeneration: 2,
        },
      }),
      expect.any(AbortSignal),
    );
    readPage.mockClear();
    await act(async () => {
      root.render(
        <TranscriptReadHostContext.Provider value={owner}>
          <DelegationChildPages {...props} />
        </TranscriptReadHostContext.Provider>,
      );
      await Promise.resolve();
    });
    expect(readPage).toHaveBeenCalledWith(
      expect.objectContaining({ source, epoch: 3, streamRevisionHint: 7 }),
      expect.any(AbortSignal),
    );
  });
  it('slides four contiguous pages in both directions and focuses the new row', async () => {
    await render();
    for (let i = 1; i <= 4; i += 1) {
      readPage.mockResolvedValueOnce(page(`older-${i}`, `older-${i + 1}`));
      await click('Load earlier messages');
    }
    expect(ids()).toEqual(['older-4', 'older-3', 'older-2', 'older-1']);
    expect(document.activeElement?.getAttribute('data-child-row-id')).toBe(
      'older-4',
    );
    readPage.mockResolvedValueOnce(page('newest', 'older-1'));
    await click('Load newer messages');
    expect(ids()).toEqual(['older-3', 'older-2', 'older-1', 'newest']);
    expect(document.activeElement?.getAttribute('data-child-row-id')).toBe(
      'newest',
    );
    expect(readPage.mock.calls[5]?.[0].cursor).toBe('newest');
  });
  it('anchors a retained row on prepend and drop without focus scrolling', async () => {
    container.style.overflowY = 'auto';
    container.scrollTop = 100;
    const rect = jest
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: Element): DOMRect {
        const id = this.getAttribute('data-child-row-id');
        const index = ids().indexOf(id ?? '');
        return {
          top: index * 20,
          bottom: index * 20 + 20,
          left: 0,
          right: 100,
          width: 100,
          height: 20,
          x: 0,
          y: index * 20,
          toJSON: (): object => ({}),
        };
      });
    await render();
    readPage.mockResolvedValueOnce(page('older-1', 'older-2'));
    await click('Load earlier messages');
    expect(container.scrollTop).toBe(120);
    for (let i = 2; i <= 4; i += 1) {
      readPage.mockResolvedValueOnce(page(`older-${i}`, `older-${i + 1}`));
      await click('Load earlier messages');
    }
    expect(container.scrollTop).toBe(180);
    expect(ids()).toHaveLength(4);
    rect.mockRestore();
  });
  it('disables controls while loading and retries failures only explicitly', async () => {
    await render();
    let finish: (
      value: TranscriptReadResult<DelegationPage>,
    ) => void = () => {};
    readPage.mockReturnValueOnce(
      new Promise<TranscriptReadResult<DelegationPage>>((resolve) => {
        finish = resolve;
      }),
    );
    await click('Load earlier messages');
    expect(container.textContent).toContain('Loading messages…');
    expect(
      Array.from(container.querySelectorAll('button')).every(
        (button) => button.disabled,
      ),
    ).toBe(true);
    await act(async () => {
      await Promise.resolve();
      finish({ ok: false, kind: 'failed' });
    });
    expect(container.textContent).toContain("Couldn't load messages.");
    expect(readPage).toHaveBeenCalledTimes(2);
    readPage.mockResolvedValueOnce(page('refreshed'));
    await click('Reload messages');
    expect(ids()).toEqual(['refreshed']);
    expect(document.activeElement?.getAttribute('data-child-row-id')).toBe(
      'refreshed',
    );
  });
  it('uses archived standalone failure copy', async () => {
    props = {
      ...props,
      source: {
        ...source,
        standaloneHistory: true,
        archivedContainerId: 'archive',
      },
    };
    readPage.mockResolvedValueOnce({ ok: false, kind: 'failed' });
    await render();
    expect(container.textContent).toContain("Couldn't load archived messages.");
  });
  it('refreshes stale newest once, never loops or displays cancellation', async () => {
    readPage
      .mockResolvedValueOnce({ ok: false, kind: 'stale' })
      .mockResolvedValueOnce({ ok: false, kind: 'stale' });
    await render();
    expect(readPage).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Couldn't load messages.");
    readPage.mockResolvedValueOnce({ ok: false, kind: 'cancelled' });
    await click('Reload messages');
    expect(container.textContent).not.toContain("Couldn't load messages.");
    expect(readPage).toHaveBeenCalledTimes(3);
  });
  it('refreshes its new revision chain atomically without losing an open paged row or focus', async () => {
    const paged: TranscriptReadResult<DelegationPage> = {
      ok: true,
      value: {
        transcriptRevision: 7,
        rows: [
          {
            id: 'live-row-1',
            role: 'assistant',
            timestamp: 1,
            row: {},
            blocksPaged: { blockCount: 42 },
          },
        ],
      },
    };
    readPage.mockResolvedValueOnce(paged);
    readBlocks.mockResolvedValue({
      ok: true,
      value: {
        messageId: 'live-row-1',
        firstBlockOrdinal: 0,
        blockCount: 42,
        transcriptRevision: 7,
        entries: [
          {
            kind: 'block',
            ordinal: 0,
            block: { type: 'text', text: 'first block' },
          },
        ],
      },
    });
    props = {
      ...props,
      renderBlock: (entry): ReactNode => (
        <span>first block {entry.ordinal}</span>
      ),
    };
    await render();
    await click('Show message');
    const row = container.querySelector('[data-child-row-id="live-row-1"]');
    const toggle = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent === 'Hide message',
    );
    toggle?.focus();
    container.scrollTop = 120;
    readPage.mockResolvedValueOnce({
      ok: true,
      value: {
        transcriptRevision: 8,
        cursor: 'revision-8-earlier',
        rows: [{ id: 'release', role: 'assistant', timestamp: 2, row: {} }],
      },
    });
    if (!paged.ok) throw new Error('fixture');
    readPage.mockResolvedValueOnce({
      ok: true,
      value: { ...paged.value, transcriptRevision: 8 },
    });
    readBlocks.mockResolvedValue({
      ok: true,
      value: {
        messageId: 'live-row-1',
        firstBlockOrdinal: 0,
        blockCount: 42,
        transcriptRevision: 8,
        entries: [
          {
            kind: 'block',
            ordinal: 0,
            block: { type: 'text', text: 'first block' },
          },
        ],
      },
    });
    props = { ...props, hint: { epoch: 3, streamRevision: 8 } };
    await render();
    expect(ids()).toEqual(['live-row-1', 'release']);
    expect(container.querySelector('[data-child-row-id="live-row-1"]')).toBe(
      row,
    );
    expect(document.activeElement).toBe(toggle);
    expect(container.textContent).toContain('first block');
    expect(container.scrollTop).toBe(120);
    expect(readPage.mock.calls[2]?.[0]).toMatchObject({
      cursor: 'revision-8-earlier',
      streamRevisionHint: 8,
    });
    await render();
    expect(readPage).toHaveBeenCalledTimes(3);
  });

  it('feeds a resolved block revision ahead of the card hint into the same newest refresh path', async () => {
    const current: TranscriptReadResult<DelegationPage> = {
      ok: true,
      value: {
        transcriptRevision: 7,
        rows: [
          {
            id: 'paged',
            role: 'assistant',
            timestamp: 1,
            row: {},
            blocksPaged: { blockCount: 42 },
          },
        ],
      },
    };
    readPage.mockResolvedValueOnce(current);
    if (!current.ok) throw new Error('fixture');
    readPage.mockResolvedValue({
      ok: true,
      value: { ...current.value, transcriptRevision: 8 },
    });
    readBlocks.mockResolvedValue({
      ok: true,
      value: {
        messageId: 'paged',
        firstBlockOrdinal: 0,
        blockCount: 42,
        transcriptRevision: 8,
        entries: [{ kind: 'block', ordinal: 0, block: {} }],
      },
    });
    props = {
      ...props,
      renderBlock: (entry): ReactNode => (
        <span>current block {entry.ordinal}</span>
      ),
    };
    await render();
    await click('Show message');
    expect(readPage).toHaveBeenCalledTimes(2);
    expect(readPage.mock.calls[1]?.[0]).toMatchObject({
      cursor: 'newest',
      streamRevisionHint: 8,
    });
    expect(container.textContent).toContain('Hide message');
    expect(container.textContent).toContain('current block');
    await render();
    expect(readPage).toHaveBeenCalledTimes(2);
  });

  it('does not present an already opened full body as current while retaining the row during refresh', async () => {
    props = {
      ...props,
      renderRows: (entries): ReactNode =>
        entries.map((entry) => (
          <DeferredToolOutput
            key={entry.key}
            identity={{
              kind: 'row',
              messageId: entry.key,
              blockOrdinal: 0,
              field: 'output',
            }}
            preview="preview"
          />
        )),
    };
    readContent.mockResolvedValue({
      ok: true,
      value: { text: 'old displayed full body', byteLength: 23 },
    });
    await render();
    await click('View full output');
    expect(container.textContent).toContain('old displayed full body');
    const row = container.querySelector('[data-child-row-id="newest"]');
    readPage.mockReturnValueOnce(
      new Promise((resolve) => {
        releasePending.push(() => resolve({ ok: false, kind: 'cancelled' }));
      }),
    );
    props = { ...props, hint: { epoch: 3, streamRevision: 8 } };
    await render();
    expect(container.querySelector('[data-child-row-id="newest"]')).toBe(row);
    expect(container.textContent).not.toContain('old displayed full body');
  });

  it('revokes retained-row body authorization while a newer hint refresh is pending', async () => {
    readContent.mockResolvedValue({
      ok: true,
      value: { text: 'body', byteLength: 4 },
    });
    await render();
    const oldReader = reader;
    expect(oldReader).not.toBeNull();
    readPage.mockReturnValueOnce(
      new Promise((resolve) => {
        releasePending.push(() => resolve({ ok: false, kind: 'cancelled' }));
      }),
    );
    props = { ...props, hint: { epoch: 3, streamRevision: 8 } };
    await render();
    await expect(
      oldReader?.(
        { kind: 'row', messageId: 'newest', blockOrdinal: 0, field: 'output' },
        0,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    await expect(
      reader?.(
        { kind: 'row', messageId: 'newest', blockOrdinal: 0, field: 'output' },
        0,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(readContent).not.toHaveBeenCalled();
  });

  it('keeps history and shows New messages until Show latest is chosen', async () => {
    await render();
    readPage.mockResolvedValueOnce(page('older', 'older-2'));
    await click('Load earlier messages');
    const row = container.querySelector('[data-child-row-id="older"]');
    const focused = document.activeElement;
    container.scrollTop = 80;
    props = { ...props, hint: { epoch: 3, streamRevision: 8 } };
    await render();
    expect(ids()).toEqual(['older', 'newest']);
    expect(container.querySelector('[data-child-row-id="older"]')).toBe(row);
    expect(container.textContent).toContain('New messages');
    expect(
      container.querySelector('[role="status"][aria-live="polite"]')
        ?.textContent,
    ).toContain('New messages');
    expect(document.activeElement).toBe(focused);
    expect(container.scrollTop).toBe(80);
    expect(readPage).toHaveBeenCalledTimes(2);
    readPage.mockResolvedValueOnce({
      ok: true,
      value: {
        transcriptRevision: 8,
        rows: [{ id: 'latest', role: 'assistant', timestamp: 1, row: {} }],
      },
    });
    await click('Show latest');
    expect(ids()).toEqual(['latest']);
    expect(container.textContent).not.toContain('New messages');
  });

  it('ignores duplicate, invalid and regressing revision hints', async () => {
    await render();
    for (const streamRevision of [7, 6, -1, NaN, Infinity, 7.5]) {
      props = { ...props, hint: { epoch: 3, streamRevision } };
      await render();
    }
    expect(readPage).toHaveBeenCalledTimes(1);
  });

  it('reloads only newer hints and epochs, fencing late completion and aborting on unmount', async () => {
    await render();
    props = { ...props, hint: { epoch: 3, streamRevision: 6 } };
    await render();
    expect(readPage).toHaveBeenCalledTimes(1);
    let late: (value: TranscriptReadResult<DelegationPage>) => void = () => {};
    readPage.mockReturnValueOnce(
      new Promise<TranscriptReadResult<DelegationPage>>((resolve) => {
        late = resolve;
      }),
    );
    props = { ...props, hint: { epoch: 3, streamRevision: 8 } };
    await render();
    readPage.mockResolvedValueOnce(page('epoch-new'));
    props = { ...props, hint: { epoch: 4, streamRevision: 0 } };
    await render();
    await act(async () => {
      await Promise.resolve();
      late(page('old-late'));
    });
    expect(ids()).toEqual(['epoch-new']);
    expect(readPage.mock.calls[1]?.[1].aborted).toBe(true);
    act(() => root.unmount());
    expect(readPage.mock.calls[2]?.[1].aborted).toBe(true);
    root = createRoot(container);
  });
  it('renders row and run omissions outside the host merger, with narrow replay blocking', async () => {
    readPage.mockResolvedValueOnce({
      ok: true,
      value: {
        transcriptRevision: 7,
        runTruncated: true,
        rows: [
          {
            id: 'short',
            role: 'assistant',
            timestamp: 1,
            truncated: true,
            row: {},
          },
          {
            id: 'paged',
            role: 'assistant',
            timestamp: 2,
            blocksPaged: { blockCount: 99 },
            row: {},
          },
        ],
      },
    });
    await render();
    expect(container.textContent).toContain(
      "Part of this step isn't shown here.",
    );
    expect(container.textContent).toContain('Partial');
    expect(container.textContent).toContain(
      "Part of this agent's messages isn't shown here.",
    );
    expect(
      container.querySelectorAll('[data-child-row-content].ph-no-capture'),
    ).toHaveLength(2);
    expect(container.querySelector('button.ph-no-capture')).toBeNull();
  });
  it('reads the raw result ordinal with exact target and refuses a row from another target', async () => {
    readPage.mockResolvedValueOnce({
      ok: true,
      value: {
        transcriptRevision: 7,
        rows: [
          {
            id: 'stored',
            role: 'user',
            timestamp: 1,
            row: {
              id: 'stored',
              blocks: [
                { type: 'future' },
                { type: 'text', text: 'x' },
                {
                  type: 'tool_result',
                  toolUseId: 'same',
                  output: 'preview',
                  isError: false,
                },
              ],
            },
          },
        ],
      },
    });
    await render();
    expect(reader).not.toBeNull();
    if (!reader) return;
    readContent.mockResolvedValueOnce({
      ok: true,
      value: { text: 'full', byteLength: 4 },
    });
    await expect(
      reader(
        { kind: 'row', messageId: 'stored', blockOrdinal: 2, field: 'output' },
        65536,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ text: 'full', byteLength: 4 });
    expect(readContent).toHaveBeenCalledWith(
      {
        ...source,
        target: {
          kind: 'delegation',
          chatId: 'chat',
          delegationId: 'delegate',
          runGeneration: 2,
        },
        messageId: 'stored',
        blockOrdinal: 2,
        field: 'output',
        epoch: 3,
        streamRevision: 7,
        fieldSource: 'logical',
        offset: 65536,
        limit: 65536,
      },
      expect.any(AbortSignal),
    );
    const oldReader = reader;
    readPage.mockResolvedValueOnce(page('other'));
    props = { ...props, delegationId: 'other' };
    await render();
    expect(reader).not.toBe(oldReader);
    if (!reader) return;
    await expect(
      reader(
        { kind: 'row', messageId: 'stored', blockOrdinal: 2, field: 'output' },
        0,
        new AbortController().signal,
      ),
    ).rejects.toThrow("Couldn't load full output in this view.");
    expect(readContent).toHaveBeenCalledTimes(1);
  });
});
