/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TranscriptContentField } from '@canopy/protocol/canopy-core/core';
import type { PortalChatPart } from '@canopy/protocol/portal';
import { ChatPartView } from '../ChatPartView';
import {
  ToolOutputReaderContext,
  type ToolOutputReader,
} from '../DeferredToolOutput';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
describe('ChatPartView row output slot', () => {
  let root: Root;
  let container: HTMLDivElement;
  const read = jest.fn<
    ReturnType<ToolOutputReader>,
    Parameters<ToolOutputReader>
  >();
  beforeEach(() => {
    read.mockReset();
    read.mockResolvedValue({ text: 'full body', byteLength: 9 });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  async function click(selector: string): Promise<void> {
    const button = container.querySelector(selector);
    if (!(button instanceof HTMLButtonElement))
      throw new Error(`Missing ${selector}`);
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
  }
  it.each([false, true])(
    'mounts the shared controller for standalone=%s and keeps the tool input',
    async (standalone) => {
      const outputLocator = {
        messageId: 'result-row',
        blockOrdinal: 3,
        field: 'output' as const,
      };
      const result = { output: 'preview', isError: false, outputLocator };
      const part: PortalChatPart = standalone
        ? {
            kind: 'tool_result',
            data: { toolUseId: 'same', output: 'preview', isError: false },
            outputLocator,
          }
        : {
            kind: 'tool_use',
            data: {
              toolName: 'Bash',
              toolUseId: 'same',
              input: 'echo hello',
              result,
            },
          };
      await act(async () => {
        root.render(
          <ToolOutputReaderContext.Provider value={read}>
            <ChatPartView part={part} />
          </ToolOutputReaderContext.Provider>,
        );
        await Promise.resolve();
      });
      await click('button');
      if (!standalone) expect(container.textContent).toContain('echo hello');
      expect(
        container.querySelector('[data-testid="chat-deferred-output"]'),
      ).not.toBeNull();
      await click('[data-testid="chat-tool-output-open"]');
      expect(read).toHaveBeenCalledWith(
        {
          kind: 'row',
          messageId: 'result-row',
          blockOrdinal: 3,
          field: 'output',
        },
        0,
        expect.any(AbortSignal),
      );
      expect(container.textContent).toContain('full body');
    },
  );
  it('does not offer full output without a reader', async () => {
    await act(async () => {
      root.render(
        <ChatPartView
          part={{
            kind: 'tool_result',
            data: { output: 'preview' },
            outputLocator: {
              messageId: 'row',
              blockOrdinal: 1,
              field: 'output',
            },
          }}
        />,
      );
      await Promise.resolve();
    });
    await click('button');
    expect(container.textContent).toContain('preview');
    expect(
      container.querySelector('[data-testid="chat-tool-output-open"]'),
    ).toBeNull();
  });
  const fields: TranscriptContentField[] = [
    'output',
    'input',
    'text',
    'partialText',
    'finalText',
  ];
  for (const field of fields) {
    it(`builds a row reader identity for omitted ${field}`, async () => {
      const identity = {
        messageId: 'result-row',
        blockOrdinal: 42,
        field,
      };
      const part: PortalChatPart = {
        kind: 'tool_use',
        data: {
          toolName: 'Agent',
          toolUseId: `tool-${field}`,
          input: '',
          result: {
            output: 'preview',
            isError: false,
            outputLocator: identity,
          },
        },
      };
      await act(async () => {
        root.render(
          <ToolOutputReaderContext.Provider value={read}>
            <ChatPartView part={part} />
          </ToolOutputReaderContext.Provider>,
        );
        await Promise.resolve();
      });
      await click('button');
      expect(
        container.querySelector('[data-testid="chat-deferred-output"]'),
      ).not.toBeNull();
      await click('[data-testid="chat-tool-output-open"]');
      expect(read).toHaveBeenCalledWith(
        {
          kind: 'row',
          messageId: 'result-row',
          blockOrdinal: 42,
          field,
        },
        0,
        expect.any(AbortSignal),
      );
    });
  }
});
