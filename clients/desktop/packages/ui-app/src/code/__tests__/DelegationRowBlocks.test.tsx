/** @jest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DelegationBlocksPage,
  TranscriptBlockEntry,
  TranscriptReadResult,
} from '@canopy/app-core';
import type {
  DelegationBlocksReadRequest,
  DelegationPagesState,
} from '@canopy/app-state';
import {
  DelegationRowBlocks,
  type DelegationRowBlocksProps,
} from '../DelegationRowBlocks';
import {
  ToolOutputReaderContext,
  type ToolOutputReader,
  type ToolOutputPage,
} from '../DeferredToolOutput';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
const readBlocks = jest.fn<
  Promise<TranscriptReadResult<DelegationBlocksPage>>,
  [DelegationBlocksReadRequest, AbortSignal]
>();
const readContent = jest.fn();
const reads: DelegationPagesState = {
  readBlocks,
  readContent,
  readPage: jest.fn(),
};
function select<T>(selector: (state: DelegationPagesState) => T): T {
  return selector(reads);
}
let capable = true;
jest.mock('@canopy/app-state', () => ({
  useDelegationPagesStore: (): typeof select => select,
  useWorkspaceCapabilities: (): { delegationBlockReads: boolean } => ({
    delegationBlockReads: capable,
  }),
}));
function result(
  first: number,
  options?: {
    preview?: boolean;
    end?: boolean;
    revision?: number;
    runTruncated?: true;
  },
): TranscriptReadResult<DelegationBlocksPage> {
  const entries: TranscriptBlockEntry[] = Array.from(
    { length: 16 },
    (_, index) => ({
      kind: 'block',
      ordinal: first + index,
      block: { type: 'text', text: `block-${first + index}` },
    }),
  );
  if (options?.preview)
    entries[0] = {
      kind: 'preview',
      ordinal: first,
      block: { type: 'tool_result', output: 'short' },
      omittedFields: ['output', 'input', 'text', 'partialText', 'finalText'],
    };
  return {
    ok: true,
    value: {
      messageId: 'row',
      firstBlockOrdinal: first,
      entries,
      blockCount: 96,
      ...(options?.end
        ? {}
        : { cursor: `cursor-${first + 16}`, nextBlockOrdinal: first + 16 }),
      transcriptRevision: options?.revision ?? 7,
      ...(options?.runTruncated ? { runTruncated: true } : {}),
    },
  };
}
function renderEntry(entry: TranscriptBlockEntry): ReactNode {
  return <span className="ph-no-capture">{entry.ordinal}</span>;
}

describe('bounded row block window', () => {
  let root: Root;
  let container: HTMLDivElement;
  let props: DelegationRowBlocksProps;
  let reader: ToolOutputReader;
  const releasePending: Array<() => void> = [];
  beforeEach(() => {
    releasePending.length = 0;
    capable = true;
    readBlocks.mockReset();
    readContent.mockReset();
    readBlocks.mockImplementation((request) =>
      Promise.resolve(
        result(
          request.firstBlockOrdinal ??
            Number(request.cursor?.replace('cursor-', '') ?? 0),
        ),
      ),
    );
    reader = jest.fn(() => Promise.resolve({ text: 'full', byteLength: 4 }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    props = {
      source: {
        scope: {
          workspaceId: 'workspace',
          worktreeId: 'worktree',
          chatId: 'owner',
        },
      },
      target: {
        kind: 'delegation',
        chatId: 'owner',
        delegationId: 'child',
        runGeneration: 2,
      },
      row: {
        id: 'row',
        role: 'assistant',
        timestamp: 1,
        blocksPaged: { blockCount: 96 },
        row: {},
      },
      epoch: 3,
      streamRevisionHint: 7,
      available: true,
      renderEntry,
    };
  });
  afterEach(() => {
    act(() => {
      root.unmount();
      for (const release of releasePending) release();
    });
    container.remove();
    jest.restoreAllMocks();
  });
  async function render(): Promise<void> {
    await act(async () => {
      root.render(
        <ToolOutputReaderContext.Provider value={reader}>
          <DelegationRowBlocks {...props} />
        </ToolOutputReaderContext.Provider>,
      );
      await Promise.resolve();
    });
  }
  function button(label: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll('button')).find(
      (element) => element.textContent === label,
    );
    if (!found) throw new Error(`No button ${label}`);
    return found;
  }
  async function click(label: string): Promise<void> {
    await act(async () => {
      button(label).click();
      await Promise.resolve();
    });
  }
  function ordinals(): number[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>('[data-block-ordinal]'),
    ).map((element) => Number(element.dataset.blockOrdinal));
  }
  function currentOrdinals(): number[] {
    return Array.from(container.querySelectorAll('[data-block-content]')).map(
      (element) => Number(element.textContent),
    );
  }

  it('keeps the open ordinal range and toggle focus across a newer hint without old cursors', async () => {
    await render();
    await click('Show message');
    for (let index = 0; index < 4; index += 1) await click('Show more');
    const toggle = button('Hide message');
    toggle.focus();
    readBlocks.mockImplementation((request) =>
      Promise.resolve(
        result(
          request.firstBlockOrdinal ??
            Number(request.cursor?.replace('cursor-', '') ?? 0),
          { revision: 8 },
        ),
      ),
    );
    props = { ...props, streamRevisionHint: 8 };
    await render();
    expect(button('Hide message')).toBe(toggle);
    expect(document.activeElement).toBe(toggle);
    expect(ordinals()[0]).toBe(16);
    expect(ordinals()).toHaveLength(64);
    expect(readBlocks.mock.calls[5]?.[0]).toMatchObject({
      firstBlockOrdinal: 16,
      streamRevisionHint: 8,
    });
    expect(readBlocks.mock.calls[5]?.[0].cursor).toBeUndefined();
  });

  it.each([2, 16])(
    'preflights to ordinal zero when the retained start is at or beyond block count %i',
    async (blockCount) => {
      await render();
      await click('Show message');
      for (let index = 0; index < 4; index += 1) await click('Show more');
      readBlocks.mockImplementation((request) =>
        Promise.resolve(
          request.firstBlockOrdinal === 0
            ? {
                ok: true,
                value: {
                  messageId: 'row',
                  firstBlockOrdinal: 0,
                  entries: [
                    { kind: 'block', ordinal: 0, block: {} },
                    { kind: 'block', ordinal: 1, block: {} },
                  ],
                  blockCount,
                  transcriptRevision: 8,
                },
              }
            : { ok: false, kind: 'failed' },
        ),
      );
      props = {
        ...props,
        row: { ...props.row, blocksPaged: { blockCount } },
        streamRevisionHint: 8,
      };
      await render();
      expect(
        readBlocks.mock.calls
          .slice(5)
          .map(([request]) => request.firstBlockOrdinal),
      ).toEqual([0]);
      expect(currentOrdinals()).toEqual([0, 1]);
      expect(button('Hide message')).toBeDefined();
      expect(readBlocks.mock.calls[5]?.[0]).toMatchObject({
        firstBlockOrdinal: 0,
        streamRevisionHint: 8,
      });
      expect(container.textContent).not.toContain('Try again');
    },
  );

  it('keeps Retry without ordinal-zero retry for generic failure when row count is unknown', async () => {
    await render();
    await click('Show message');
    for (let index = 0; index < 4; index += 1) await click('Show more');
    readBlocks.mockImplementation((request) =>
      Promise.resolve(
        request.streamRevisionHint === 8
          ? { ok: false, kind: 'failed' }
          : result(
              request.firstBlockOrdinal ??
                Number(request.cursor?.replace('cursor-', '') ?? 0),
            ),
      ),
    );
    props = {
      ...props,
      row: {
        id: props.row.id,
        role: props.row.role,
        timestamp: props.row.timestamp,
        row: props.row.row,
      },
      streamRevisionHint: 8,
    };
    await render();

    expect(
      readBlocks.mock.calls
        .slice(5)
        .map(([request]) => request.firstBlockOrdinal),
    ).toEqual([16]);
    expect(button('Try again')).toBeDefined();
  });

  it('uses the first refreshed page revision for every continuation read', async () => {
    await render();
    await click('Show message');
    for (let index = 0; index < 4; index += 1) await click('Show more');
    readBlocks.mockImplementation((request) => {
      if (request.cursor !== undefined && request.streamRevisionHint !== 9)
        return Promise.resolve({ ok: false, kind: 'stale' });
      const first =
        request.firstBlockOrdinal ??
        Number(request.cursor?.replace('cursor-', '') ?? 0);
      return Promise.resolve(result(first, { revision: 9 }));
    });

    props = { ...props, streamRevisionHint: 8 };
    await render();

    expect(readBlocks.mock.calls[5]?.[0]).toMatchObject({
      firstBlockOrdinal: 16,
      streamRevisionHint: 8,
    });
    expect(
      readBlocks.mock.calls
        .slice(6)
        .map(([request]) => request.streamRevisionHint),
    ).toEqual([9, 9, 9]);
    expect(ordinals()).toHaveLength(64);
    expect(ordinals()[0]).toBe(16);
    expect(ordinals()[63]).toBe(79);
  });

  it('ignores invalid and regressing block hints without closing the row', async () => {
    await render();
    await click('Show message');
    const toggle = button('Hide message');
    for (const streamRevisionHint of [7, 6, -1, NaN, Infinity, 7.5]) {
      props = { ...props, streamRevisionHint };
      await render();
      expect(button('Hide message')).toBe(toggle);
    }
    expect(readBlocks).toHaveBeenCalledTimes(1);
  });

  it('revokes old blocks and bodies immediately while a revision refresh is held', async () => {
    readBlocks.mockResolvedValueOnce(result(0, { preview: true }));
    await render();
    await click('Show message');
    let finish: ((value: ToolOutputPage) => void) | undefined;
    reader = jest.fn(
      () =>
        new Promise<ToolOutputPage>((resolve) => {
          finish = resolve;
          releasePending.push(() => resolve({ text: '', byteLength: 0 }));
        }),
    );
    await render();
    await click('View full output');
    readBlocks.mockReturnValueOnce(
      new Promise((resolve) => {
        releasePending.push(() => resolve({ ok: false, kind: 'cancelled' }));
      }),
    );
    props = { ...props, streamRevisionHint: 8 };
    await render();
    expect(container.querySelector('[data-block-content]')).toBeNull();
    expect(button('Hide message')).toBeDefined();
    await act(async () => {
      finish?.({ text: 'old full body', byteLength: 13 });
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain('old full body');
  });

  it('shows a preview once: the host gets its structure, the viewer its body', async () => {
    const hosted: TranscriptBlockEntry[] = [];
    props = {
      ...props,
      renderEntry: (entry: TranscriptBlockEntry): ReactNode => {
        hosted.push(entry);
        return renderEntry(entry);
      },
    };
    readBlocks.mockResolvedValue({
      ok: true,
      value: {
        messageId: 'row',
        firstBlockOrdinal: 0,
        entries: [
          {
            kind: 'preview',
            ordinal: 0,
            block: { type: 'text', text: 'long text preview' },
            omittedFields: ['text'],
          },
          {
            kind: 'preview',
            ordinal: 1,
            block: { type: 'tool_result', toolUseId: 'call', output: 'cut' },
            omittedFields: ['output'],
          },
        ],
        blockCount: 2,
        transcriptRevision: 7,
      },
    });
    await render();
    await click('Show message');
    // A text block with only omitted text is left to its viewer.
    expect(hosted.map((entry) => entry.ordinal)).toEqual([1]);
    const hostedEntry = hosted[0];
    expect(hostedEntry?.kind).toBe('preview');
    expect(
      hostedEntry?.kind === 'preview' ? hostedEntry.block : undefined,
    ).toEqual({
      type: 'tool_result',
      toolUseId: 'call',
      output: '',
    });
    expect(container.textContent?.split('long text preview')).toHaveLength(2);
  });

  it('does not read until Show message, then uses absolute ordinals and keeps controls outside replay content', async () => {
    await render();
    expect(readBlocks).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Partial:');
    await click('Show message');
    expect(readBlocks.mock.calls[0]?.[0]).toEqual({
      ...props.source,
      target: props.target,
      messageId: 'row',
      epoch: 3,
      streamRevisionHint: 7,
      firstBlockOrdinal: 0,
      limit: 16,
    });
    expect(ordinals()).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
    expect(
      container.querySelector('[data-block-ordinal="0"] .ph-no-capture'),
    ).not.toBeNull();
    expect(button('Show more').closest('.ph-no-capture')).toBeNull();
  });
  it('bounds four pages, renders a boundary once and anchors focus and scroll when moving backward', async () => {
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    container.replaceWith(scroller);
    scroller.appendChild(container);
    scroller.scrollTop = 500;
    jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement): DOMRect {
        const first =
          container.querySelector<HTMLElement>('[data-block-ordinal]')?.dataset
            .blockOrdinal ?? '0';
        const top =
          this.dataset.blockOrdinal === undefined
            ? 0
            : (Number(this.dataset.blockOrdinal) - Number(first)) * 20;
        return {
          x: 0,
          y: top,
          top,
          bottom: top + 20,
          left: 0,
          right: 100,
          width: 100,
          height: 20,
          toJSON: (): object => ({}),
        };
      });
    await render();
    await click('Show message');
    for (let index = 0; index < 4; index += 1) await click('Show more');
    expect(ordinals()).toHaveLength(64);
    expect(ordinals()[0]).toBe(16);
    expect(ordinals()[63]).toBe(79);
    expect(scroller.scrollTop).toBe(180);
    expect(
      container.querySelectorAll('[data-block-ordinal="64"]'),
    ).toHaveLength(1);
    expect(document.activeElement).toBe(
      container.querySelector('[data-block-ordinal="64"]'),
    );
    await click('Show earlier');
    expect(ordinals()[0]).toBe(0);
    expect(ordinals()[63]).toBe(63);
    expect(scroller.scrollTop).toBe(500);
    expect(document.activeElement).toBe(
      container.querySelector('[data-block-ordinal="0"]'),
    );
    scroller.replaceWith(container);
  });
  it('deduplicates an overlapping boundary by its absolute ordinal', async () => {
    await render();
    await click('Show message');
    readBlocks.mockResolvedValueOnce(result(15));
    await click('Show more');
    expect(ordinals()).toHaveLength(31);
    expect(
      container.querySelectorAll('[data-block-ordinal="15"]'),
    ).toHaveLength(1);
    expect(ordinals()[30]).toBe(30);
  });
  it('resets the window when the store recovers a stale cursor with first page', async () => {
    await render();
    await click('Show message');
    await click('Show more');
    readBlocks.mockResolvedValueOnce(result(0, { revision: 8 }));
    await click('Show more');
    expect(ordinals()).toHaveLength(16);
    expect(ordinals()[0]).toBe(0);
  });
  it('fences pending blocks on collapse, source and epoch changes', async () => {
    let settle:
      | ((value: TranscriptReadResult<DelegationBlocksPage>) => void)
      | undefined;
    readBlocks.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    await render();
    await click('Show message');
    const oldSignal = readBlocks.mock.calls[0]?.[1];
    await click('Hide message');
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => {
      settle?.(result(0));
      await Promise.resolve();
    });
    expect(ordinals()).toEqual([]);
    await click('Show message');
    const epochSignal = readBlocks.mock.calls[1]?.[1];
    props = { ...props, epoch: 4 };
    await render();
    expect(epochSignal?.aborted).toBe(true);
    expect(ordinals()).toEqual([]);
    await click('Show message');
    const sourceSignal = readBlocks.mock.calls[2]?.[1];
    props = {
      ...props,
      source: { ...props.source, archivedContainerId: 'different' },
    };
    await render();
    expect(sourceSignal?.aborted).toBe(true);
    expect(ordinals()).toEqual([]);
  });
  it('opens every omitted field with its absolute row identity and fences an evicted body', async () => {
    readBlocks.mockResolvedValueOnce(result(0, { preview: true }));
    const pending: {
      signal: AbortSignal;
      settle: (value: ToolOutputPage) => void;
    }[] = [];
    reader = jest.fn((identity, offset, signal) => {
      void identity;
      void offset;
      return new Promise((settle) => {
        pending.push({ signal, settle });
      });
    });
    await render();
    await click('Show message');
    const opens = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="chat-tool-output-open"]',
      ),
    );
    expect(opens).toHaveLength(5);
    for (const open of opens)
      await act(async () => {
        open.click();
        await Promise.resolve();
      });
    expect(reader).toHaveBeenNthCalledWith(
      1,
      {
        kind: 'row',
        messageId: 'row',
        blockOrdinal: 0,
        field: 'output',
        streamRevision: 7,
      },
      0,
      expect.any(AbortSignal),
    );
    expect(reader).toHaveBeenNthCalledWith(
      5,
      {
        kind: 'row',
        messageId: 'row',
        blockOrdinal: 0,
        field: 'finalText',
        streamRevision: 7,
      },
      0,
      expect.any(AbortSignal),
    );
    for (let index = 0; index < 4; index += 1) await click('Show more');
    expect(pending.every((entry) => entry.signal.aborted)).toBe(true);
    await act(async () => {
      for (const entry of pending)
        entry.settle({ text: 'old private body', byteLength: 16 });
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain('old private body');
  });
  it('fences an in-flight body when a stale cursor refresh keeps the same ordinal', async () => {
    readBlocks.mockResolvedValueOnce(result(0, { preview: true }));
    let signal: AbortSignal | undefined;
    let finish: ((value: ToolOutputPage) => void) | undefined;
    reader = jest.fn((identity, offset, currentSignal) => {
      void identity;
      void offset;
      signal = currentSignal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    await render();
    await click('Show message');
    await click('View full output');
    readBlocks.mockResolvedValueOnce(result(0, { preview: true, revision: 8 }));
    await click('Show more');
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      finish?.({ text: 'stale revision body', byteLength: 19 });
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain('stale revision body');
  });

  it('preserves capture loss and supports retry and unsupported hosts without a read', async () => {
    props = { ...props, row: { ...props.row, truncated: true } };
    capable = false;
    await render();
    expect(container.textContent).not.toContain('Show message');
    expect(readBlocks).not.toHaveBeenCalled();
    capable = true;
    props = { ...props, epoch: 4 };
    await render();
    readBlocks.mockResolvedValueOnce({ ok: false, kind: 'unavailable' });
    await click('Show message');
    expect(container.textContent).toContain(
      "Couldn't load messages in this view.",
    );
    readBlocks.mockResolvedValueOnce(result(0, { runTruncated: true }));
    await click('Try again');
    expect(container.textContent).toContain(
      "Part of this agent's messages isn't shown here.",
    );
    expect(container.textContent).toContain(
      "Part of this step isn't shown here.",
    );
    await click('Show more');
    expect(container.textContent).toContain(
      "Part of this agent's messages isn't shown here.",
    );
  });
});
