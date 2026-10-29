/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Markdown } from '../Markdown';
import { MarkdownMermaid } from '../MarkdownMermaid';
import { SourcePositionMarkdown } from '../SourcePositionMarkdown';
import { renderMermaid } from '../markdown-mermaid-renderer';

jest.mock('../markdown-mermaid-renderer', () => ({ renderMermaid: jest.fn() }));
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
});
const mockRender = jest.mocked(renderMermaid);
const source = 'flowchart LR\nA-->B';
const markdown = `\`\`\`mermaid\n${source}\n\`\`\``;
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><text>Diagram</text></svg>';

describe('Mermaid display lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    mockRender.mockReset().mockResolvedValue(svg);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  async function render(content = markdown, streaming = false): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      root.render(<Markdown streaming={streaming}>{content}</Markdown>);
    });
  }
  it('defers streaming diagrams, then displays and copies original source', async () => {
    await render(markdown, true);
    expect(mockRender).not.toHaveBeenCalled();
    expect(container.querySelector('pre')?.textContent).toBe(source);
    await render();
    expect(mockRender).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role=img] svg')).not.toBeNull();
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    await act(async () => {
      await Promise.resolve();
      container
        .querySelector<HTMLButtonElement>('[data-testid="mermaid-copy-source"]')
        ?.click();
    });
    expect(writeText).toHaveBeenCalledWith(source);
  });
  it('preserves source on a rejected render and retries when the source changes', async () => {
    mockRender.mockRejectedValueOnce(new Error('invalid'));
    await render();
    expect(container.querySelector('[role=img]')).toBeNull();
    expect(container.textContent).toContain('Diagram could not be rendered');
    expect(
      container
        .querySelector('[role=status]')
        ?.hasAttribute('data-markdown-generated'),
    ).toBe(true);
    expect(container.querySelector('pre')?.textContent).toBe(source);
    await render(markdown.replace('A-->B', 'B-->C'));
    expect(container.querySelector('[role=img]')).not.toBeNull();
  });
  it('does not publish stale output after returning to streaming', async () => {
    let resolve: ((value: string) => void) | undefined;
    mockRender.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await render();
    await render(markdown, true);
    await act(async () => {
      await Promise.resolve();
      resolve?.(svg);
    });
    expect(container.querySelector('[role=img]')).toBeNull();
    expect(container.querySelector('pre')?.textContent).toBe(source);
  });
  it('keeps policy errors silent while source is streaming', () => {
    act(() => {
      root.render(<MarkdownMermaid source="" streaming />);
    });

    expect(container.querySelector('[role=status]')).toBeNull();
    expect(container.querySelector('pre')?.textContent).toBe('');
    expect(mockRender).not.toHaveBeenCalled();
  });
  it('exposes authored diagram titles and descriptions to assistive technology', async () => {
    mockRender.mockResolvedValueOnce(
      '<svg xmlns="http://www.w3.org/2000/svg"><title>Release workflow</title><desc>Code moves from review to production.</desc><text>Diagram</text></svg>',
    );

    await render();

    const image = container.querySelector<HTMLElement>('[role="img"]');
    expect(image?.getAttribute('aria-label')).toBe('Release workflow');
    const descriptionId = image?.getAttribute('aria-describedby');
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId ?? '')?.textContent).toBe(
      'Code moves from review to production.',
    );
  });
  it('does not re-render diagrams for unrelated body style changes', async () => {
    await render();
    expect(mockRender).toHaveBeenCalledTimes(1);

    try {
      await act(async () => {
        document.body.style.cursor = 'col-resize';
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockRender).toHaveBeenCalledTimes(1);
    } finally {
      document.body.style.removeProperty('cursor');
    }
  });
  it('retains real source positions on Mermaid and adjacent prose', async () => {
    await act(async () => {
      await Promise.resolve();
      root.render(
        <SourcePositionMarkdown>{`# Plan\n\n${markdown}\n\nNext paragraph.`}</SourcePositionMarkdown>,
      );
    });
    expect(
      container
        .querySelector('[data-testid="markdown-mermaid"]')
        ?.getAttribute('data-sourcepos'),
    ).toBe('3:6');
    expect(container.querySelector('p')?.getAttribute('data-sourcepos')).toBe(
      '8:8',
    );
  });
  it('leaves math-like syntax inside diagrams untouched and composes caller rules', async () => {
    const rule = jest.fn((next: () => React.ReactNode) => next());
    await act(async () => {
      await Promise.resolve();
      root.render(
        <Markdown options={{ renderRule: rule }}>
          {markdown.replace('A-->B', () => 'A["\\(x\\)"]-->B') + '\n\nText.'}
        </Markdown>,
      );
    });
    expect(mockRender.mock.calls[0]?.[0]).toContain('\\(x\\)');
    expect(rule).toHaveBeenCalled();
    expect(container.querySelector('.katex')).toBeNull();
  });
});

describe('Mermaid visibility scheduling', () => {
  it('waits for visibility and retains completed diagrams while scrolled away', async () => {
    let notifyVisibility: ((visible: boolean) => void) | undefined;
    const original = globalThis.IntersectionObserver;
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: class {
        constructor(
          callback: (entries: { isIntersecting: boolean }[]) => void,
        ) {
          notifyVisibility = (visible: boolean): void =>
            callback([{ isIntersecting: visible }]);
        }
        observe(): void {
          /* driven by the test */
        }
        disconnect(): void {
          /* no browser observer was created */
        }
      },
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mockRender.mockReset().mockResolvedValue(svg);
    try {
      await act(async () => {
        await Promise.resolve();
        root.render(<Markdown>{markdown}</Markdown>);
      });
      expect(mockRender).not.toHaveBeenCalled();
      await act(async () => {
        await Promise.resolve();
        notifyVisibility?.(true);
      });
      expect(container.querySelector('[role=img] svg')).not.toBeNull();
      await act(async () => {
        await Promise.resolve();
        notifyVisibility?.(false);
      });
      expect(container.querySelector('[role=img] svg')).not.toBeNull();
      await act(async () => {
        await Promise.resolve();
        notifyVisibility?.(true);
      });
      expect(mockRender).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
      container.remove();
      Object.defineProperty(globalThis, 'IntersectionObserver', {
        configurable: true,
        value: original,
      });
    }
  });
});
