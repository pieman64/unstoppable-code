/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PersistedToolOutputReference,
  TranscriptContentField,
} from '@canopy/protocol/canopy-core/core';
import {
  DeferredToolOutput,
  ToolOutputReaderContext,
  type ToolOutputPage,
  type ToolOutputIdentity,
} from '../DeferredToolOutput';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});
const reference: PersistedToolOutputReference = {
  version: 1,
  artifactId: `sha256-v1-${'a'.repeat(64)}`,
  sha256: 'a'.repeat(64),
  byteLength: 100000,
  encoding: 'utf-8',
  mediaType: 'text/plain',
};
const fieldCopyCases: Array<{
  field: TranscriptContentField;
  openLabel: string;
  loadingLabel: string;
  unavailableMessage: string;
}> = [
  {
    field: 'output',
    openLabel: 'View full output',
    loadingLabel: 'Loading output…',
    unavailableMessage: "Couldn't load full output in this view.",
  },
  {
    field: 'input',
    openLabel: 'View full input',
    loadingLabel: 'Loading input…',
    unavailableMessage: "Couldn't load full input in this view.",
  },
  {
    field: 'text',
    openLabel: 'View full text',
    loadingLabel: 'Loading text…',
    unavailableMessage: "Couldn't load full text in this view.",
  },
  {
    field: 'partialText',
    openLabel: 'View full partial text',
    loadingLabel: 'Loading partial text…',
    unavailableMessage: "Couldn't load full partial text in this view.",
  },
  {
    field: 'finalText',
    openLabel: 'View full final text',
    loadingLabel: 'Loading final text…',
    unavailableMessage: "Couldn't load full final text in this view.",
  },
];
describe('deferred tool output', () => {
  let container: HTMLDivElement;
  let root: Root;
  const read = jest.fn<
    Promise<ToolOutputPage>,
    [ToolOutputIdentity, number, AbortSignal]
  >();
  beforeEach(() => {
    read.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <ToolOutputReaderContext.Provider value={read}>
          <DeferredToolOutput
            identity={{
              kind: 'reference',
              reference,
              messageId: 'message-1',
              toolUseId: 'tool-1',
            }}
            preview="bounded preview"
          />
        </ToolOutputReaderContext.Provider>,
      );
    });
  });
  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });
  async function click(id: string): Promise<void> {
    await act(() => {
      const button = container.querySelector(`[data-testid="${id}"]`);
      if (!(button instanceof HTMLButtonElement))
        throw new Error(`Missing button ${id}`);
      button.click();
      return Promise.resolve();
    });
  }
  function renderRowField(
    identity: ToolOutputIdentity,
    withReader: boolean = true,
  ): void {
    const viewer = (
      <DeferredToolOutput identity={identity} preview="bounded preview" />
    );
    act(() =>
      root.render(
        withReader ? (
          <ToolOutputReaderContext.Provider value={read}>
            {viewer}
          </ToolOutputReaderContext.Provider>
        ) : (
          viewer
        ),
      ),
    );
  }
  it('does no read until opened, pages without accumulating bodies, and retries the failed offset', async () => {
    expect(read).not.toHaveBeenCalled();
    expect(container.textContent).toContain('bounded preview');
    const controls = container.querySelector(
      '[data-testid="chat-deferred-output-controls"]',
    );
    if (!(controls instanceof HTMLDivElement))
      throw new Error('Missing deferred output controls');
    expect(controls.classList).toContain('ring-1');
    expect(controls.classList).toContain('ring-line-base');
    expect(controls.classList).not.toContain('border-border');
    read.mockResolvedValueOnce({
      text: 'first full page',
      nextOffset: 65536,
      byteLength: 100000,
    });
    await click('chat-tool-output-open');
    expect(read).toHaveBeenLastCalledWith(
      {
        kind: 'reference',
        messageId: 'message-1',
        toolUseId: 'tool-1',
        reference,
      },
      0,
      expect.any(AbortSignal),
    );
    read.mockRejectedValueOnce(new Error('Disk read failed'));
    await click('chat-tool-output-next');
    expect(container.textContent).toContain('Disk read failed');
    read.mockResolvedValueOnce({ text: 'final page', byteLength: 100000 });
    await click('chat-tool-output-retry');
    expect(read).toHaveBeenLastCalledWith(
      {
        kind: 'reference',
        messageId: 'message-1',
        toolUseId: 'tool-1',
        reference,
      },
      65536,
      expect.any(AbortSignal),
    );
    expect(container.textContent).toContain('final page');
    expect(container.textContent).not.toContain('first full page');
    const nextButton = container.querySelector(
      '[data-testid="chat-tool-output-next"]',
    );
    if (!(nextButton instanceof HTMLButtonElement))
      throw new Error('Missing next output button');
    expect(nextButton.disabled).toBe(true);
    read.mockResolvedValueOnce({
      text: 'first full page',
      nextOffset: 65536,
      byteLength: 100000,
    });
    await click('chat-tool-output-previous');
    expect(read).toHaveBeenLastCalledWith(
      {
        kind: 'reference',
        messageId: 'message-1',
        toolUseId: 'tool-1',
        reference,
      },
      0,
      expect.any(AbortSignal),
    );
  });

  it('sanitizes the first fetched error page without rewriting later page bodies', async () => {
    act(() => {
      root.render(
        <ToolOutputReaderContext.Provider value={read}>
          <DeferredToolOutput
            identity={{
              kind: 'reference',
              reference,
              messageId: 'message-1',
              toolUseId: 'tool-1',
            }}
            preview="The user denied this tool call: Not on this branch."
            isError
          />
        </ToolOutputReaderContext.Provider>,
      );
    });
    read.mockResolvedValueOnce({
      text: 'PreToolUse:Bash hook error: The user denied this tool call: Not on this branch.',
      nextOffset: 65536,
      byteLength: 100000,
    });
    await click('chat-tool-output-open');
    expect(container.textContent).toContain('Not on this branch.');
    expect(container.textContent).not.toContain('PreToolUse:');
    read.mockResolvedValueOnce({
      text: 'PreToolUse:Bash hook error: body text from a later page',
      byteLength: 100000,
    });
    await click('chat-tool-output-next');
    expect(container.textContent).toContain(
      'PreToolUse:Bash hook error: body text',
    );
  });

  it('preserves fetched successful output even when it resembles a denial', async () => {
    read.mockResolvedValueOnce({
      text: 'PreToolUse:Bash hook error: The user denied this tool call.',
      byteLength: 100000,
    });
    await click('chat-tool-output-open');
    expect(container.textContent).toContain('PreToolUse:Bash hook error:');
  });

  it('aborts an in-flight read when the viewer closes', async () => {
    read.mockImplementation(() => new Promise(() => undefined));
    await click('chat-tool-output-open');
    const signal = read.mock.calls[0]?.[2];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    await click('chat-tool-output-close');
    expect(signal?.aborted).toBe(true);
  });
  it('keeps an equal row identity open and resets for a different ordinal or row', async () => {
    const renderRow = (messageId: string, blockOrdinal: number): void => {
      act(() =>
        root.render(
          <ToolOutputReaderContext.Provider value={read}>
            <DeferredToolOutput
              identity={{
                kind: 'row',
                messageId,
                blockOrdinal,
                field: 'output',
              }}
              preview="row preview"
            />
          </ToolOutputReaderContext.Provider>,
        ),
      );
    };
    renderRow('row', 2);
    read.mockResolvedValue({ text: 'first body', byteLength: 10 });
    await click('chat-tool-output-open');
    renderRow('row', 2);
    expect(container.textContent).toContain('first body');
    expect(read).toHaveBeenCalledTimes(1);
    renderRow('row', 3);
    expect(container.textContent).not.toContain('first body');
    expect(container.textContent).toContain('row preview');
    read.mockResolvedValue({ text: 'second body', byteLength: 11 });
    await click('chat-tool-output-open');
    expect(read).toHaveBeenLastCalledWith(
      { kind: 'row', messageId: 'row', blockOrdinal: 3, field: 'output' },
      0,
      expect.any(AbortSignal),
    );
    renderRow('another-row', 3);
    expect(container.textContent).not.toContain('second body');
  });
  it('ignores an old identity body after a row replacement and aborts it', async () => {
    let settle: (page: ToolOutputPage) => void = () => {};
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    await click('chat-tool-output-open');
    const signal = read.mock.calls[0]?.[2];
    act(() =>
      root.render(
        <ToolOutputReaderContext.Provider value={read}>
          <DeferredToolOutput
            identity={{
              kind: 'row',
              messageId: 'replacement',
              blockOrdinal: 1,
              field: 'output',
            }}
            preview="new preview"
          />
        </ToolOutputReaderContext.Provider>,
      ),
    );
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      settle({ text: 'old secret body', byteLength: 15 });
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain('old secret body');
    expect(container.textContent).toContain('new preview');
  });
  for (const fieldCopy of fieldCopyCases) {
    it(`labels the omitted ${fieldCopy.field} field`, () => {
      const identity: ToolOutputIdentity = {
        kind: 'row',
        messageId: 'message-1',
        blockOrdinal: 42,
        field: 'output',
      };
      expect(Reflect.set(identity, 'field', fieldCopy.field)).toBe(true);
      renderRowField(identity);

      expect(container.textContent).toContain(fieldCopy.openLabel);
      if (fieldCopy.field !== 'output')
        expect(container.textContent).not.toContain('View full output');
    });

    it(`reads the omitted ${fieldCopy.field} field while showing its loading state`, async () => {
      const identity: ToolOutputIdentity = {
        kind: 'row',
        messageId: 'message-1',
        blockOrdinal: 42,
        field: 'output',
      };
      expect(Reflect.set(identity, 'field', fieldCopy.field)).toBe(true);
      read.mockImplementationOnce(() => new Promise(() => undefined));
      renderRowField(identity);
      await click('chat-tool-output-open');
      expect(read).toHaveBeenCalledWith(identity, 0, expect.any(AbortSignal));
      expect(container.textContent).toContain(fieldCopy.loadingLabel);
      if (fieldCopy.field !== 'output')
        expect(container.textContent).not.toContain('Loading output…');
    });

    it(`names unavailable ${fieldCopy.field} content`, async () => {
      const identity: ToolOutputIdentity = {
        kind: 'row',
        messageId: 'message-1',
        blockOrdinal: 42,
        field: 'output',
      };
      expect(Reflect.set(identity, 'field', fieldCopy.field)).toBe(true);
      renderRowField(identity, false);

      await click('chat-tool-output-open');
      expect(container.textContent).toContain(fieldCopy.unavailableMessage);
      if (fieldCopy.field !== 'output')
        expect(container.textContent).not.toContain(
          "Couldn't load full output in this view.",
        );
    });
  }
});
