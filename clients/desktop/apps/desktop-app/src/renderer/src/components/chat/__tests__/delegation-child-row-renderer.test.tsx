/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import type * as AppState from '@canopy/app-state';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DelegationPage,
  DelegationBlocksPage,
  PortableChildRow,
  TranscriptReadResult,
} from '@canopy/app-core';
import type {
  DelegationPageReadRequest,
  DelegationBlocksReadRequest,
  DelegationPagesState,
} from '@canopy/app-state';
import type { DisplayBlock } from '../types';
import { useChatStore } from '@/stores/chatStore';
import { renderDelegationChildBlock } from '../delegation-child-row-renderer';
import { ChatBlockRenderer } from '../ChatBlockRenderer';
import { DelegationTranscriptSourceContext } from '../delegated-agent-transcript';

const readPage = jest.fn<
  Promise<TranscriptReadResult<DelegationPage>>,
  [DelegationPageReadRequest, AbortSignal]
>();
const readBlocks = jest.fn<
  Promise<TranscriptReadResult<DelegationBlocksPage>>,
  [DelegationBlocksReadRequest, AbortSignal]
>();
const reads: DelegationPagesState = {
  readPage,
  readBlocks,
  readContent: jest.fn(),
};
function selectState<T>(selector: (state: DelegationPagesState) => T): T {
  return selector(reads);
}
jest.mock('@canopy/app-state', () => ({
  ...jest.requireActual<typeof AppState>('@canopy/app-state'),
  useCanopyClient: (): { transcripts: object } => ({ transcripts: {} }),
  useWorkspaceCapabilities: (): {
    delegationTranscriptReads: boolean;
    delegationBlockReads: boolean;
  } => ({
    delegationTranscriptReads: true,
    delegationBlockReads: true,
  }),
  useDelegationPagesStore: (): typeof selectState => selectState,
}));
jest.mock('@/lib/terminal-instances', () => ({
  getOrCreateInstance: jest.fn(),
  peekInstance: jest.fn(),
  TERMINAL_BG_COLOR: '#000',
}));
jest.mock('@xterm/xterm', () => ({ Terminal: jest.fn() }));
jest.mock('@xterm/addon-fit', () => ({ FitAddon: jest.fn() }));
jest.mock('@/lib/openFileInBrowserPanel', () => ({
  isBrowserRenderedFile: (): boolean => false,
  openFileInBrowserPanel: jest.fn(),
}));
jest.mock('../ToolCallBlock', () => ({
  ToolCallBlock: ({
    toolName,
    result,
  }: {
    toolName: string;
    result?: {
      output: string;
      messageId?: string;
      toolUseId?: string;
      fullOutputRef?: unknown;
      outputIdentity?: {
        kind: string;
        messageId: string;
        blockOrdinal: number;
        field: string;
      };
    };
  }): JSX.Element => (
    <div
      data-tool-name={toolName}
      data-result-row={result?.messageId}
      data-result-id={result?.toolUseId}
      data-has-ref={!!result?.fullOutputRef}
      data-output-identity={JSON.stringify(result?.outputIdentity)}
    >
      {result?.output ?? 'pending result'}
    </div>
  ),
}));
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});
const card: DisplayBlock = {
  type: 'delegated_agent_call',
  agentBlockId: 'card',
  delegationId: 'delegate',
  parentTurnId: 'turn',
  sequence: 1,
  createdAt: 1,
  selectedModelId: 'model',
  runtimeModelId: 'model',
  targetHarnessId: 'claude',
  parentToolCallId: 'spawn',
  parentHarnessId: 'claude',
  description: 'Review',
  prompt: 'Review',
  executionMode: 'background',
  status: 'completed',
  runGeneration: 2,
  outputTruncated: false,
  transcriptStore: 'chat-stream-v2',
  subBlocks: [],
};
function row(
  id: string,
  blocks: readonly unknown[],
  extras: object = {},
): PortableChildRow {
  return {
    id,
    role: 'assistant',
    timestamp: 1,
    row: {
      id,
      role: 'assistant',
      timestamp: 1,
      parentBlockId: 'card',
      blocks,
      ...extras,
    },
  };
}
function use(id: string): unknown {
  return { type: 'tool_use', toolUseId: id, toolName: 'probe', input: '{}' };
}
const fullOutputRef = {
  version: 1,
  artifactId: `sha256-v1-${'a'.repeat(64)}`,
  sha256: 'a'.repeat(64),
  byteLength: 90000,
  encoding: 'utf-8',
  mediaType: 'text/plain',
};
function result(id: string, output: string): object {
  return {
    type: 'tool_result',
    toolUseId: id,
    toolName: 'probe',
    output,
    isError: false,
  };
}
function reply(
  rows: readonly PortableChildRow[],
  cursor?: string,
): { ok: true; value: DelegationPage } {
  return {
    ok: true,
    value: { transcriptRevision: 1, rows, ...(cursor ? { cursor } : {}) },
  };
}
describe('desktop stream row renderer', () => {
  let container: HTMLDivElement;
  let root: Root;
  let oldHints: ReturnType<
    typeof useChatStore.getState
  >['delegationStreamHints'];
  beforeEach(() => {
    oldHints = useChatStore.getState().delegationStreamHints;
    readPage.mockReset();
    readBlocks.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useChatStore.setState({ delegationStreamHints: oldHints });
  });
  async function render(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      root.render(
        <DelegationTranscriptSourceContext.Provider
          value={{ projectId: 'project', worktreeId: 'tree', chatId: 'chat' }}
        >
          <ChatBlockRenderer block={card} />
        </DelegationTranscriptSourceContext.Provider>,
      );
    });
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-expanded]',
    );
    if (!toggle) throw new Error('Missing card');
    await act(async () => {
      await Promise.resolve();
      toggle.click();
    });
  }
  async function earlier(): Promise<void> {
    const button = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent === 'Load earlier messages',
    );
    expect(button).toBeDefined();
    if (button)
      await act(async () => {
        await Promise.resolve();
        button.click();
      });
  }
  it('opens paged blocks through the host renderer at absolute ordinals without duplicate readers', async () => {
    readPage.mockResolvedValue(
      reply([{ ...row('paged', []), blocksPaged: { blockCount: 18 } }]),
    );
    readBlocks.mockResolvedValueOnce({
      ok: true,
      value: {
        messageId: 'paged',
        transcriptRevision: 1,
        blockCount: 18,
        firstBlockOrdinal: 0,
        nextBlockOrdinal: 16,
        cursor: 'next',
        entries: Array.from({ length: 16 }, (_, ordinal) => ({
          kind: 'block',
          ordinal,
          block: { type: 'text', text: `block ${ordinal}` },
        })),
      },
    });
    readBlocks.mockResolvedValueOnce({
      ok: true,
      value: {
        messageId: 'paged',
        transcriptRevision: 1,
        blockCount: 18,
        firstBlockOrdinal: 16,
        nextBlockOrdinal: 18,
        entries: [
          {
            kind: 'block',
            ordinal: 16,
            block: {
              type: 'tool_use',
              toolUseId: 'dup',
              toolName: 'Read',
              input: '{}',
            },
          },
          {
            kind: 'preview',
            ordinal: 17,
            block: {
              type: 'tool_result',
              toolUseId: 'dup',
              toolName: 'Read',
              output: 'bounded preview',
              isError: false,
            },
            omittedFields: ['output'],
          },
        ],
      },
    });
    await render();
    expect(readBlocks).not.toHaveBeenCalled();
    async function press(label: string): Promise<void> {
      const button = Array.from(container.querySelectorAll('button')).find(
        (item) => item.textContent === label,
      );
      expect(button).toBeDefined();
      if (button)
        await act(async () => {
          button.click();
          await Promise.resolve();
        });
    }
    const showMessage = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent === 'Show message',
    );
    expect(showMessage?.closest('.ph-no-capture')).toBeNull();
    await press('Show message');
    expect(
      container.querySelector('[data-block-ordinal="0"] .ph-no-capture')
        ?.textContent,
    ).toContain('block 0');
    expect(container.textContent).toContain('block 0');
    await press('Show more');
    expect(
      container.querySelector(
        '[data-block-ordinal="17"] [data-tool-name="Read"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelectorAll('[data-testid="chat-tool-output-open"]'),
    ).toHaveLength(1);
    expect(readBlocks.mock.calls[1]?.[0]).toMatchObject({
      messageId: 'paged',
      cursor: 'next',
      target: {
        kind: 'delegation',
        delegationId: 'delegate',
        runGeneration: 2,
      },
    });
  });
  it('validates bounded entries and forwards true ordinals to the existing host renderer', () => {
    const renderBlock = jest.fn(() => <span>private body</span>);
    act(() =>
      root.render(
        renderDelegationChildBlock(
          {
            kind: 'block',
            ordinal: 42,
            block: { type: 'text', text: 'private body' },
          },
          row('row', []),
          renderBlock,
        ),
      ),
    );
    expect(renderBlock).toHaveBeenCalledWith(
      { type: 'text', text: 'private body' },
      42,
    );
    expect(container.querySelector('.ph-no-capture')?.textContent).toBe(
      'private body',
    );
    act(() =>
      root.render(
        renderDelegationChildBlock(
          { kind: 'block', ordinal: 43, block: { type: 'text', text: 37 } },
          row('row', []),
          renderBlock,
        ),
      ),
    );
    expect(container.textContent).toContain(
      "Part of this step isn't shown here.",
    );
    expect(renderBlock).toHaveBeenCalledTimes(1);
  });
  it('renders an inline image the core projection relays without its path', async () => {
    // portableBlocks drops an image's host path and keeps its bounded dataUrl.
    readPage.mockResolvedValueOnce(
      reply([
        row('image', [
          {
            type: 'image',
            alt: 'Relayed screenshot',
            dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
          },
        ]),
      ]),
    );
    await render();
    const image = container.querySelector<HTMLImageElement>(
      '[data-child-row-id="image"] img',
    );
    expect(image?.getAttribute('alt')).toBe('Relayed screenshot');
    expect(image?.getAttribute('src')).toBe(
      'data:image/png;base64,iVBORw0KGgo=',
    );
    expect(container.textContent).not.toContain("isn't shown here");
  });

  it('pairs across page boundaries and renders standalone when the call slides away', async () => {
    readPage.mockResolvedValueOnce(
      reply([row('newest', [{ type: 'text', text: 'newest' }])], 'page-1'),
    );
    await render();
    readPage.mockResolvedValueOnce(
      reply([row('middle-1', [{ type: 'text', text: 'middle-1' }])], 'page-2'),
    );
    await earlier();
    readPage.mockResolvedValueOnce(
      reply([row('result', [result('same', 'stored output')])], 'page-3'),
    );
    await earlier();
    expect(
      container.querySelector('[data-child-row-id="result"]')?.textContent,
    ).toContain('stored output');
    readPage.mockResolvedValueOnce(
      reply([row('middle-3', [{ type: 'text', text: 'middle-3' }])], 'page-4'),
    );
    await earlier();
    readPage.mockResolvedValueOnce(
      reply([row('use', [use('same')])], 'page-5'),
    );
    await earlier();
    expect(container.querySelectorAll('[data-tool-name="probe"]')).toHaveLength(
      1,
    );
    expect(
      container.querySelector('[data-child-row-id="use"]')?.textContent,
    ).toContain('stored output');
    readPage.mockResolvedValueOnce(
      reply([row('newest', [{ type: 'text', text: 'newest' }])], 'page-1'),
    );
    const newer = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent === 'Load newer messages',
    );
    expect(newer).toBeDefined();
    if (newer)
      await act(async () => {
        await Promise.resolve();
        newer.click();
      });
    expect(container.querySelector('[data-child-row-id="use"]')).toBeNull();
    expect(
      container.querySelector('[data-child-row-id="result"]')?.textContent,
    ).toContain('stored output');
    expect(container.querySelectorAll('[data-tool-name="probe"]')).toHaveLength(
      1,
    );
  });

  it('unpairs after sliding away a result, then re-pairs on loading newer', async () => {
    readPage.mockResolvedValueOnce(
      reply([row('result', [result('same', 'paired output')])], 'use-page'),
    );
    await render();
    readPage.mockResolvedValueOnce(reply([row('use', [use('same')])], 'old-1'));
    await earlier();
    for (let i = 1; i <= 3; i += 1) {
      readPage.mockResolvedValueOnce(
        reply(
          [row(`old-${i}`, [{ type: 'text', text: `old-${i}` }])],
          `old-${i + 1}`,
        ),
      );
      await earlier();
    }
    expect(container.querySelector('[data-child-row-id="result"]')).toBeNull();
    expect(
      container.querySelector('[data-child-row-id="use"]')?.textContent,
    ).toContain('pending result');
    readPage.mockResolvedValueOnce(
      reply([row('result', [result('same', 'paired output')])], 'use-page'),
    );
    const newer = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent === 'Load newer messages',
    );
    expect(newer).toBeDefined();
    if (newer)
      await act(async () => {
        await Promise.resolve();
        newer.click();
      });
    expect(
      container.querySelector('[data-child-row-id="use"]')?.textContent,
    ).toContain('paired output');
  });
  it('keeps duplicate tool ids scoped to their occurrence and exact stored result row', async () => {
    readPage.mockResolvedValueOnce(
      reply([
        row('use-1', [use('duplicate')]),
        row('result-1', [
          { ...result('duplicate', 'first output'), fullOutputRef },
        ]),
        row('use-2', [use('duplicate')]),
        row('result-2', [
          { ...result('duplicate', 'second output'), fullOutputRef },
        ]),
      ]),
    );
    await render();
    expect(
      container.querySelector('[data-child-row-id="use-1"]')?.textContent,
    ).toContain('first output');
    expect(
      container.querySelector('[data-child-row-id="use-2"]')?.textContent,
    ).toContain('second output');
    expect(
      container
        .querySelector('[data-child-row-id="use-1"] [data-result-row]')
        ?.getAttribute('data-result-row'),
    ).toBe('result-1');
    expect(
      container
        .querySelector('[data-child-row-id="use-2"] [data-result-id]')
        ?.getAttribute('data-result-id'),
    ).toBe('duplicate');
    expect(container.querySelectorAll('[data-has-ref="true"]')).toHaveLength(2);
  });
  it('preserves raw ordinals for duplicate results in one row after unsupported blocks', async () => {
    readPage.mockResolvedValueOnce(
      reply([
        row('both', [
          { type: 'future' },
          use('duplicate'),
          { ...result('duplicate', 'first body'), fullOutputRef },
          use('duplicate'),
          { ...result('duplicate', 'second body'), fullOutputRef },
        ]),
      ]),
    );
    await render();
    expect(
      Array.from(
        container.querySelectorAll('[data-has-ref="true"]'),
        (element) => element.getAttribute('data-output-identity'),
      ),
    ).toEqual([
      '{"kind":"row","messageId":"both","blockOrdinal":2,"field":"output"}',
      '{"kind":"row","messageId":"both","blockOrdinal":4,"field":"output"}',
    ]);
  });
  it('preserves the standalone full-output locator and never calls the legacy log loader', async () => {
    const { useDelegationTranscriptStore } =
      await import('@/stores/delegationTranscriptStore');
    const load = jest.spyOn(useDelegationTranscriptStore.getState(), 'load');
    readPage.mockResolvedValueOnce(
      reply([
        row('stored-result', [
          { ...result('raw-id', 'standalone preview'), fullOutputRef },
        ]),
      ]),
    );
    await render();
    const output = container.querySelector('[data-tool-name="probe"]');
    expect(output?.getAttribute('data-result-row')).toBe('stored-result');
    expect(output?.getAttribute('data-result-id')).toBe('raw-id');
    expect(output?.getAttribute('data-has-ref')).toBe('true');
    expect(load).not.toHaveBeenCalled();
    load.mockRestore();
  });

  it('passes the exact scope/chat/run hint and reloads only accepted progress for that run', async () => {
    useChatStore.setState({
      delegationStreamHints: {
        'project/tree': {
          epoch: 4,
          runs: { 'chat:delegate:2': { streamRevision: 7, cardRevision: 1 } },
        },
      },
    });
    readPage.mockResolvedValue(
      reply([row('first', [{ type: 'text', text: 'first' }])]),
    );
    await render();
    expect(readPage.mock.calls[0]?.[0]).toMatchObject({
      epoch: 4,
      streamRevisionHint: 7,
      target: { chatId: 'chat', delegationId: 'delegate', runGeneration: 2 },
    });
    await act(async () => {
      useChatStore.setState({
        delegationStreamHints: {
          'project/tree': {
            epoch: 4,
            runs: {
              'chat:delegate:2': { streamRevision: 7, cardRevision: 1 },
              'chat:other:2': { streamRevision: 100, cardRevision: 100 },
            },
          },
        },
      });
      await Promise.resolve();
    });
    expect(readPage).toHaveBeenCalledTimes(1);
    readPage.mockResolvedValueOnce(
      reply([row('fresh', [{ type: 'text', text: 'fresh' }])]),
    );
    await act(async () => {
      useChatStore.setState({
        delegationStreamHints: {
          'project/tree': {
            epoch: 4,
            runs: { 'chat:delegate:2': { streamRevision: 8, cardRevision: 2 } },
          },
        },
      });
      await Promise.resolve();
    });
    expect(readPage).toHaveBeenCalledTimes(2);
    expect(readPage.mock.calls[1]?.[0].streamRevisionHint).toBe(8);
    expect(
      container.querySelector('[data-child-row-id="fresh"]'),
    ).not.toBeNull();
  });

  it('preserves mixed attribution, chronology and unsupported-row omissions', async () => {
    readPage.mockResolvedValueOnce(
      reply([
        row('parent', [{ type: 'text', text: 'parent note' }], {
          delegationAuthor: {
            kind: 'agent',
            depth: 0,
            description: 'Parent agent',
            delegationId: 'parent',
          },
        }),
        row('human', [{ type: 'text', text: 'human note' }], {
          role: 'user',
          delegationAuthor: { kind: 'user' },
        }),
        row('child', [
          { type: 'thinking', text: 'child thought' },
          { type: 'future-private-block', private: 'never render this' },
        ]),
      ]),
    );
    await render();
    const parent = container.querySelector('[data-child-row-id="parent"]');
    expect(parent?.textContent).toContain('Parent agent');
    expect(parent?.textContent).toContain('parent note');
    expect(
      container.querySelector('[data-child-row-id="human"]')?.textContent,
    ).toContain('You');
    expect(
      container.querySelector('[data-child-row-id="child"]')?.textContent,
    ).toContain("Part of this step isn't shown here.");
    expect(container.textContent).not.toContain('never render this');
    expect(
      Array.from(container.querySelectorAll('[data-child-row-id]')).map(
        (item) => item.getAttribute('data-child-row-id'),
      ),
    ).toEqual(['parent', 'human', 'child']);
  });
});
