/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';

import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  NotebookView,
  MAX_NOTEBOOK_OUTPUTS_PER_CELL,
  MAX_NOTEBOOK_RENDERED_CELLS,
  MAX_NOTEBOOK_TEXT_CHARS,
} from '../NotebookView';
import type {
  NotebookCell,
  NotebookOutput,
  ParsedNotebook,
} from '../notebook-types';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});
Object.defineProperty(globalThis, 'TextEncoder', {
  configurable: true,
  value: class TestTextEncoder {
    encode(input: string): Uint8Array {
      const encoded = encodeURIComponent(input);
      const bytes: number[] = [];
      for (let index = 0; index < encoded.length; index += 1) {
        if (encoded.charAt(index) === '%') {
          bytes.push(Number.parseInt(encoded.slice(index + 1, index + 3), 16));
          index += 2;
        } else {
          bytes.push(encoded.charCodeAt(index));
        }
      }
      return Uint8Array.from(bytes);
    }
  },
});

function createNotebook(
  cells: readonly NotebookCell[],
  language: string | null = null,
): ParsedNotebook {
  return { language, cells };
}

function renderNotebook(notebook: ParsedNotebook): HTMLDivElement {
  const container = document.createElement('div');
  container.innerHTML = renderToString(<NotebookView notebook={notebook} />);
  return container;
}

describe('NotebookView', () => {
  it('renders Markdown, code labels and stream output', () => {
    const notebook = createNotebook(
      [
        { cellType: 'markdown', source: '# Notes' },
        {
          cellType: 'code',
          source: 'print("hello")',
          executionCount: 7,
          outputs: [{ outputType: 'stream', name: 'stdout', text: 'hello\n' }],
        },
      ],
      'python',
    );
    const container = renderNotebook(notebook);

    expect(
      container.querySelector('[data-cell-type="markdown"] h1')?.textContent,
    ).toBe('Notes');
    expect(
      container.querySelector('[data-testid="notebook-code-language"]')
        ?.textContent,
    ).toBe('python');
    expect(
      container.querySelector('[data-testid="notebook-execution-count"]')
        ?.textContent,
    ).toBe('[7]');
    expect(
      container.querySelector('[data-cell-type="code"] pre')?.textContent,
    ).toBe('print("hello")');
    expect(
      container.querySelector('[data-output-type="stream"] pre')?.textContent,
    ).toBe('hello\n');
    expect(container.querySelector('[data-stream="stdout"]')).not.toBeNull();
  });

  it('renders Markdown cell math with the shared KaTeX renderer', async () => {
    const container = document.createElement('div');
    const root: Root = createRoot(container);
    const observerDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'IntersectionObserver',
    );
    const frameDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'requestAnimationFrame',
    );
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      value: undefined,
    });
    try {
      act(() => {
        root.render(
          <NotebookView
            notebook={createNotebook([
              { cellType: 'markdown', source: 'Formula: $x^2$' },
            ])}
          />,
        );
      });
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 300);
        });
      });

      expect(container.querySelector('.katex')).not.toBeNull();
    } finally {
      act(() => root.unmount());
      if (observerDescriptor) {
        Object.defineProperty(
          globalThis,
          'IntersectionObserver',
          observerDescriptor,
        );
      } else {
        Reflect.deleteProperty(globalThis, 'IntersectionObserver');
      }
      if (frameDescriptor) {
        Object.defineProperty(
          globalThis,
          'requestAnimationFrame',
          frameDescriptor,
        );
      } else {
        Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
      }
    }
  });

  it('renders error tracebacks as plain destructive text', () => {
    const container = renderNotebook(
      createNotebook([
        {
          cellType: 'code',
          source: 'raise ValueError()',
          executionCount: null,
          outputs: [
            {
              outputType: 'error',
              ename: 'ValueError',
              evalue: 'bad value',
              traceback: 'ValueError: bad value\n  at cell',
            },
          ],
        },
      ]),
    );
    const error = container.querySelector('[data-output-type="error"] pre');

    expect(error?.textContent).toContain('ValueError: bad value');
    expect(error?.textContent).toContain('at cell');
    expect(error?.classList.contains('fg-destructive')).toBe(true);
    expect(error?.textContent).not.toContain('\u001b[');
  });

  it('renders Markdown cell attachment images from that cell only', () => {
    const container = renderNotebook(
      createNotebook([
        {
          cellType: 'markdown',
          source:
            '![plot](attachment:plot.png) ![spaced](attachment:my%20plot.png) ![missing](attachment:other.png)',
          attachments: new Map([
            ['plot.png', 'data:image/png;base64,AAAA'],
            ['my plot.png', 'data:image/png;base64,CCCC'],
          ]),
        },
        { cellType: 'markdown', source: '![again](attachment:plot.png)' },
      ]),
    );
    const images = Array.from(container.querySelectorAll('img'));
    expect(images.map((image) => image.getAttribute('src'))).toEqual([
      'data:image/png;base64,AAAA',
      'data:image/png;base64,CCCC',
    ]);
    expect(images.map((image) => image.getAttribute('alt'))).toEqual([
      'plot',
      'spaced',
    ]);
    expect(container.textContent).toContain('missing');
    expect(container.textContent).toContain('again');
  });

  it('renders PNG output as an image data URL', () => {
    const container = renderNotebook(
      createNotebook([
        {
          cellType: 'code',
          source: '',
          executionCount: null,
          outputs: [
            { outputType: 'display_data', data: { 'image/png': 'AAAA' } },
          ],
        },
      ]),
    );
    expect(
      container
        .querySelector('[data-testid="notebook-output-image"]')
        ?.getAttribute('src'),
    ).toMatch(/^data:image\/png;base64,/);
  });

  it('falls back to plain text when PNG base64 is invalid', () => {
    const container = renderNotebook(
      createNotebook([
        {
          cellType: 'code',
          source: '',
          executionCount: null,
          outputs: [
            {
              outputType: 'display_data',
              data: { 'image/png': 'invalid!', 'text/plain': 'plain fallback' },
            },
          ],
        },
      ]),
    );

    expect(container.querySelector('img')).toBeNull();
    expect(
      container.querySelector('[data-output-type="display_data"] pre')
        ?.textContent,
    ).toBe('plain fallback');
  });

  it('renders SVG output as a data URL without inline SVG markup', () => {
    const container = renderNotebook(
      createNotebook([
        {
          cellType: 'code',
          source: '',
          executionCount: null,
          outputs: [
            {
              outputType: 'display_data',
              data: { 'image/svg+xml': '<svg><circle /></svg>' },
            },
          ],
        },
      ]),
    );
    expect(
      container
        .querySelector('[data-testid="notebook-output-image"]')
        ?.getAttribute('src'),
    ).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(
      container.querySelector('[data-output-type="display_data"] svg'),
    ).toBeNull();
  });

  it('does not render HTML MIME output and shows plain text instead', () => {
    const container = renderNotebook(
      createNotebook([
        {
          cellType: 'code',
          source: '',
          executionCount: null,
          outputs: [
            {
              outputType: 'execute_result',
              executionCount: 4,
              data: {
                'text/html': '<strong>unsafe</strong>',
                'text/plain': 'plain fallback',
              },
            },
          ],
        },
      ]),
    );

    expect(
      container.querySelector('[data-output-type="execute_result"] strong'),
    ).toBeNull();
    expect(
      container.querySelector('[data-output-type="execute_result"] pre')
        ?.textContent,
    ).toBe('plain fallback');
  });

  it('renders text/latex output as math', () => {
    const container = renderNotebook(
      createNotebook([
        {
          cellType: 'code',
          source: '',
          executionCount: null,
          outputs: [
            {
              outputType: 'display_data',
              data: { 'text/latex': '$x^2$' },
            },
          ],
        },
      ]),
    );

    expect(
      container.querySelector('[data-math-display="true"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="notebook-output"]')?.textContent,
    ).toContain('x^2');
  });

  it('keeps the scroll container blocked from session replay', () => {
    const container = renderNotebook(createNotebook([]));
    const root = container.firstElementChild;

    expect(root?.getAttribute('data-testid')).toBe('file-notebook-preview');
    expect(Array.from(root?.classList ?? [])).toEqual([
      REPLAY_BLOCK_CLASS,
      'min-h-0',
      'flex-1',
      'overflow-auto',
    ]);
  });

  it('binds scroll persistence and content-load callbacks to the root', () => {
    const onScroll = jest.fn();
    const onContentLoaded = jest.fn();
    const ref = jest.fn();
    const container = document.createElement('div');
    const root: Root = createRoot(container);
    act(() => {
      root.render(
        <NotebookView
          notebook={createNotebook([])}
          scrollBinding={{ ref, onScroll, onContentLoaded }}
        />,
      );
    });
    const scrollContainer = container.querySelector(
      '[data-testid="file-notebook-preview"]',
    );

    expect(ref).toHaveBeenCalledWith(scrollContainer);
    act(() => {
      scrollContainer?.dispatchEvent(new Event('scroll', { bubbles: true }));
      scrollContainer?.dispatchEvent(new Event('load', { bubbles: true }));
    });
    expect(onScroll).toHaveBeenCalledTimes(1);
    expect(onContentLoaded).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('limits the number of rendered cells', () => {
    const cells: NotebookCell[] = Array.from(
      { length: MAX_NOTEBOOK_RENDERED_CELLS + 1 },
      () => ({ cellType: 'raw', source: 'cell' }),
    );
    const container = renderNotebook(createNotebook(cells));

    expect(
      container.querySelectorAll('[data-testid="notebook-cell"]'),
    ).toHaveLength(MAX_NOTEBOOK_RENDERED_CELLS);
    expect(
      container.querySelector('[data-testid="notebook-limit-note"]')
        ?.textContent,
    ).toBe(
      `Showing the first ${MAX_NOTEBOOK_RENDERED_CELLS} of ${MAX_NOTEBOOK_RENDERED_CELLS + 1} cells. Switch to Source to see the rest.`,
    );
  });

  it('limits outputs shown for each code cell', () => {
    const outputs: NotebookOutput[] = Array.from(
      { length: MAX_NOTEBOOK_OUTPUTS_PER_CELL + 1 },
      () => ({ outputType: 'stream', name: 'stdout', text: 'line' }),
    );
    const container = renderNotebook(
      createNotebook([
        {
          cellType: 'code',
          source: '',
          executionCount: null,
          outputs,
        },
      ]),
    );

    expect(
      container.querySelectorAll('[data-testid="notebook-output"]'),
    ).toHaveLength(MAX_NOTEBOOK_OUTPUTS_PER_CELL);
    expect(
      container.querySelector('[data-testid="notebook-limit-note"]')
        ?.textContent,
    ).toBe(
      `Showing the first ${MAX_NOTEBOOK_OUTPUTS_PER_CELL} of ${MAX_NOTEBOOK_OUTPUTS_PER_CELL + 1} outputs.`,
    );
  });

  it('truncates long outputs and cell sources with a note', () => {
    const source = 's'.repeat(MAX_NOTEBOOK_TEXT_CHARS + 1);
    const output = 'o'.repeat(MAX_NOTEBOOK_TEXT_CHARS + 1);
    const container = renderNotebook(
      createNotebook([
        {
          cellType: 'code',
          source,
          executionCount: null,
          outputs: [{ outputType: 'stream', name: 'stdout', text: output }],
        },
      ]),
    );
    const notes = Array.from(
      container.querySelectorAll('[data-testid="notebook-text-truncated"]'),
      (node) => node.textContent,
    );

    expect(notes).toContain(
      `Cell truncated to the first ${MAX_NOTEBOOK_TEXT_CHARS.toLocaleString('en-US')} characters.`,
    );
    expect(notes).toContain(
      `Output truncated to the first ${MAX_NOTEBOOK_TEXT_CHARS.toLocaleString('en-US')} characters.`,
    );
    expect(
      container.querySelector('[data-output-type="stream"] pre')?.textContent,
    ).toHaveLength(MAX_NOTEBOOK_TEXT_CHARS);
  });
});
