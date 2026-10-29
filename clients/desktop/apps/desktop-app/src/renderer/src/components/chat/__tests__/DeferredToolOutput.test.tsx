/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  DeferredToolOutput,
  ToolOutputReaderContext,
} from '../DeferredToolOutput';
import type { ChatToolOutputResponse } from '@canopy/desktop-shared/types';
import type { PersistedToolOutputReference } from '@canopy/agent-transcript/types';

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
describe('deferred tool output', () => {
  let container: HTMLDivElement;
  let root: Root;
  const read = jest.fn<
    Promise<ChatToolOutputResponse>,
    [string, string, PersistedToolOutputReference, number, AbortSignal]
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
            reference={reference}
            preview="bounded preview"
            messageId="message-1"
            toolUseId="tool-1"
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
      'message-1',
      'tool-1',
      reference,
      0,
      expect.any(AbortSignal),
    );
    read.mockRejectedValueOnce(new Error('Disk read failed'));
    await click('chat-tool-output-next');
    expect(container.textContent).toContain('Disk read failed');
    read.mockResolvedValueOnce({ text: 'final page', byteLength: 100000 });
    await click('chat-tool-output-retry');
    expect(read).toHaveBeenLastCalledWith(
      'message-1',
      'tool-1',
      reference,
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
      'message-1',
      'tool-1',
      reference,
      0,
      expect.any(AbortSignal),
    );
  });

  it('aborts an in-flight read when the viewer closes', async () => {
    read.mockImplementation(() => new Promise(() => undefined));
    await click('chat-tool-output-open');
    const signal = read.mock.calls[0]?.[4];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    await click('chat-tool-output-close');
    expect(signal?.aborted).toBe(true);
  });
});
