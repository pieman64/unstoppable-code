/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Markdown } from '../Markdown';
import { MarkdownMermaid } from '../MarkdownMermaid';
import { SourcePositionMarkdown } from '../SourcePositionMarkdown';
import { renderMermaid } from '../markdown-mermaid-renderer';
import {
  MermaidExportProvider,
  type MermaidExportToast,
  type MermaidImageClipboard,
  type MermaidSaveDestination,
  type MermaidSiblingSaveRequest,
  type MermaidSiblingSaveResult,
} from '../markdown-mermaid-export-context';
import { MARKDOWN_ROOT_PROPS } from '../markdown-mermaid-export-names';
import {
  MermaidExportError,
  rasterizeMermaidSvg,
} from '../markdown-mermaid-export';
import { downloadBlob } from '../../lib/download-blob';

jest.mock('../markdown-mermaid-renderer', () => ({ renderMermaid: jest.fn() }));
jest.mock('../markdown-mermaid-export', () => {
  class MockMermaidExportError extends Error {}
  return {
    MermaidExportError: MockMermaidExportError,
    standaloneMermaidSvg: jest.fn((svg: string) => ({
      svg,
      width: 200,
      height: 100,
    })),
    rasterizeMermaidSvg: jest.fn(),
    mermaidClipboardHtml: jest.fn(() => '<img alt="diagram">'),
    srgbHexColor: jest.fn((color: string) => color),
    svgBlob: jest.fn(
      (diagram: { svg: string }) =>
        new Blob([diagram.svg], { type: 'image/svg+xml' }),
    ),
  };
});
jest.mock('../../lib/download-blob', () => ({ downloadBlob: jest.fn() }));
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
  const status = (): string | null | undefined =>
    container.querySelector('[role=status]')?.textContent;
  const button = (name: string): HTMLButtonElement | undefined =>
    Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === name,
    );
  async function render(content = markdown, streaming = false): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      root.render(<Markdown streaming={streaming}>{content}</Markdown>);
    });
  }
  async function chooseMoreAction(testId: string): Promise<void> {
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="mermaid-more-actions"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          `[data-testid="mermaid-more-menu"] [data-testid="${testId}"]`,
        )
        ?.click();
      await Promise.resolve();
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
    await chooseMoreAction('mermaid-copy-source');
    expect(writeText).toHaveBeenCalledWith(source);
  });
  it('collapses code on a rejected render and retries when the source changes', async () => {
    mockRender.mockRejectedValueOnce(new Error('invalid'));
    await render();
    expect(container.querySelector('[role=img]')).toBeNull();
    expect(status()).toBe("This diagram couldn't be drawn.");
    expect(
      container
        .querySelector('[role=status]')
        ?.hasAttribute('data-markdown-generated'),
    ).toBe(true);
    expect(container.querySelector('pre')?.textContent).toBe(source);
    expect(container.querySelector('pre')?.hidden).toBe(true);
    await render(markdown.replace('A-->B', 'B-->C'));
    expect(container.querySelector('[role=img]')).not.toBeNull();
  });
  it('notes removed highlighting only when the diagram is drawn', async () => {
    const styled = `${source}\nstyle A fill:#fde2e2,font-size:20px`;
    await render(`\`\`\`mermaid\n${styled}\n\`\`\``);
    expect(mockRender.mock.calls[0]?.[0]).toBe(styled);
    expect(container.querySelector('[role=img] svg')).not.toBeNull();
    expect(status()).toBe("Some highlighting couldn't be shown here.");
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    await chooseMoreAction('mermaid-copy-source');
    expect(writeText).toHaveBeenCalledWith(styled);

    mockRender.mockRejectedValueOnce(new Error('invalid'));
    await render(`\`\`\`mermaid\n${styled}\nB-->C\n\`\`\``);
    expect(status()).toBe("This diagram couldn't be drawn.");
  });
  it('shows no note when every style is admitted', async () => {
    await render(
      `\`\`\`mermaid\n${source}\nclassDef pain fill:#fde2e2\nclass A pain\n\`\`\``,
    );
    expect(container.querySelector('[role=img] svg')).not.toBeNull();
    expect(container.querySelector('[role=status]')).toBeNull();
    await chooseMoreAction('mermaid-toggle-text');
    expect(container.querySelector('[role=img]')).toBeNull();
    expect(container.querySelector('pre')?.hidden).toBe(false);
    expect(button('Show diagram')?.getAttribute('aria-expanded')).toBe('true');
    await act(async () => {
      button('Show diagram')?.click();
      await Promise.resolve();
    });
    expect(container.querySelector('[role=img] svg')).not.toBeNull();
  });
  it('starts refused diagrams collapsed behind an accessible disclosure', async () => {
    const refused = `${source}\nclick A "https://tracker.invalid"`;
    await render(`\`\`\`mermaid\n${refused}\n\`\`\``);
    expect(mockRender).not.toHaveBeenCalled();
    expect(status()).toBe(
      "This diagram uses features that can't be drawn here.",
    );
    expect(container.textContent).not.toMatch(/preview|source/i);
    const code = container.querySelector('pre');
    const disclosure = button('Show diagram text');
    expect(code?.hidden).toBe(true);
    expect(disclosure?.getAttribute('aria-expanded')).toBe('false');
    expect(disclosure?.getAttribute('aria-controls')).toBe(code?.id);
    expect(code?.id).toBeTruthy();
    await act(async () => {
      disclosure?.click();
      await Promise.resolve();
    });
    expect(code?.hidden).toBe(false);
    expect(code?.textContent).toBe(refused);
    expect(button('Hide diagram text')?.getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(
      container
        .querySelector('[data-testid="mermaid-copy-source"]')
        ?.getAttribute('aria-label'),
    ).toBe('Copy diagram text');

    // A different diagram starts collapsed again.
    await render(`\`\`\`mermaid\n${refused}\nB-->C\n\`\`\``);
    expect(container.querySelector('pre')?.hidden).toBe(true);
    expect(button('Show diagram text')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
  });
  it('ignores late results from an earlier source', async () => {
    let fail: ((reason: Error) => void) | undefined;
    mockRender.mockImplementationOnce(
      () =>
        new Promise((_done, reject) => {
          fail = reject;
        }),
    );
    await render();
    const next = markdown.replace('A-->B', 'B-->C');
    await render(next);
    expect(container.querySelector('[role=img] svg')).not.toBeNull();
    await act(async () => {
      fail?.(new Error('late'));
      await Promise.resolve();
    });
    expect(container.querySelector('[role=img] svg')).not.toBeNull();
    expect(container.querySelector('[role=status]')).toBeNull();
    expect(container.querySelector('pre')).toBeNull();
  });
  it('resets disclosure even when returning to an earlier source', async () => {
    const refused = `${source}\nclick A "https://tracker.invalid"`;
    const original = `\`\`\`mermaid\n${refused}\n\`\`\``;
    await render(original);
    act(() => {
      button('Show diagram text')?.click();
    });
    expect(container.querySelector('pre')?.hidden).toBe(false);
    await render(original.replace('A-->B', 'B-->C'));
    expect(container.querySelector('pre')?.hidden).toBe(true);
    await render(original);
    expect(container.querySelector('pre')?.hidden).toBe(true);
    expect(button('Show diagram text')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
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

function siblingSave(): jest.Mock<
  Promise<MermaidSiblingSaveResult>,
  [MermaidSiblingSaveRequest]
> {
  return jest.fn<
    Promise<MermaidSiblingSaveResult>,
    [MermaidSiblingSaveRequest]
  >();
}

describe('Mermaid picture export', () => {
  let container: HTMLDivElement;
  let root: Root;
  const mockRasterize = jest.mocked(rasterizeMermaidSvg);
  const mockDownload = jest.mocked(downloadBlob);
  const notify = jest.fn<void, [MermaidExportToast]>();
  beforeEach(() => {
    notify.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    mockRender.mockReset().mockResolvedValue(svg);
    mockRasterize
      .mockReset()
      .mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    mockDownload.mockReset();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  const byTestId = (id: string): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
  const toasts = (): string[] =>
    notify.mock.calls.map(([toast]) => `${toast.tone}: ${toast.message}`);
  /** Which toolbar controls currently show the success checkmark. */
  const confirmed = (): string[] =>
    Array.from(
      container.querySelectorAll('[data-confirmed]'),
      (glyph) => glyph.closest('button')?.dataset.testid ?? '',
    );
  async function renderWith(
    services: {
      clipboard?: MermaidImageClipboard;
      destination?: MermaidSaveDestination;
      /** Leave out the host toast stack. */
      withoutToasts?: boolean;
    },
    content = `# Release plan\n\n${markdown}`,
  ): Promise<void> {
    const { withoutToasts = false, ...rest } = services;
    await act(async () => {
      await Promise.resolve();
      root.render(
        <MermaidExportProvider {...rest} {...(withoutToasts ? {} : { notify })}>
          <div {...MARKDOWN_ROOT_PROPS}>
            <Markdown>{content}</Markdown>
          </div>
        </MermaidExportProvider>,
      );
    });
  }
  async function click(element: HTMLElement | null): Promise<void> {
    await act(async () => {
      element?.click();
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
    });
  }

  it('keeps the diagram visible but blocks image exports until its theme render is ready', async () => {
    const write = jest.fn().mockResolvedValue(undefined);
    await renderWith({ clipboard: { status: 'available', write } });
    let completeRender: ((value: string) => void) | undefined;
    mockRender.mockImplementationOnce(
      () => new Promise((resolve) => (completeRender = resolve)),
    );
    const previousTheme = document.documentElement.getAttribute('data-theme');
    try {
      await act(async () => {
        document.documentElement.setAttribute('data-theme', 'dark');
        for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
      });
      expect(mockRender).toHaveBeenCalledTimes(2);
      expect(container.querySelector('[role="img"] svg')).not.toBeNull();
      expect(byTestId('mermaid-copy-image')?.disabled).toBe(true);
      expect(byTestId('mermaid-save-png')?.disabled).toBe(true);
      await click(byTestId('mermaid-more-actions'));
      const saveSvg = document.querySelector<HTMLButtonElement>(
        '[data-testid="mermaid-more-menu"] [data-testid="mermaid-save-svg"]',
      );
      expect(saveSvg?.disabled).toBe(true);
      expect(write).not.toHaveBeenCalled();
      expect(mockDownload).not.toHaveBeenCalled();

      await act(async () => {
        completeRender?.(svg.replace('Diagram', 'Dark diagram'));
        for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
      });
      expect(container.querySelector('[role="img"]')?.textContent).toBe(
        'Dark diagram',
      );
      expect(byTestId('mermaid-copy-image')?.disabled).toBe(false);
      expect(byTestId('mermaid-save-png')?.disabled).toBe(false);
      expect(saveSvg?.disabled).toBe(false);
      await click(byTestId('mermaid-copy-image'));
      expect(write).toHaveBeenCalledTimes(1);
      expect(toasts()).toEqual(['success: Image copied.']);
    } finally {
      if (previousTheme === null)
        document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', previousTheme);
    }
  });

  it('names a diagram from its family and nearest heading in the same root', async () => {
    await act(async () => {
      await Promise.resolve();
      root.render(
        <>
          <div {...MARKDOWN_ROOT_PROPS}>
            <Markdown>{'# Other message'}</Markdown>
          </div>
          <div {...MARKDOWN_ROOT_PROPS}>
            <Markdown>{markdown}</Markdown>
          </div>
          <div {...MARKDOWN_ROOT_PROPS}>
            <Markdown>{`## Deploy flow\n\n${markdown}`}</Markdown>
          </div>
        </>,
      );
    });
    const names = Array.from(
      container.querySelectorAll('[role="img"]'),
      (image) => image.getAttribute('aria-label'),
    );
    expect(names).toEqual(['Flow diagram', 'Flow diagram: Deploy flow']);
  });

  it('starts one PNG and HTML clipboard write inside the gesture', async () => {
    const write = jest.fn().mockResolvedValue(undefined);
    await renderWith({ clipboard: { status: 'available', write } });
    const copy = byTestId('mermaid-copy-image');
    act(() => {
      copy?.click();
      // Nothing has been awaited yet: the write began synchronously.
      expect(write).toHaveBeenCalledTimes(1);
    });
    const [image, ownerDocument] = write.mock.calls[0] as [
      { png: Promise<Blob>; html: Promise<Blob> },
      Document,
    ];
    expect(ownerDocument).toBe(document);
    await act(async () => {
      await expect(image.png).resolves.toBeInstanceOf(Blob);
      await expect(image.html).resolves.toBeInstanceOf(Blob);
    });
    await click(null);
    expect(toasts()).toEqual(['success: Image copied.']);
    expect(confirmed()).toEqual(['mermaid-copy-image']);
    // A repeated copy raises its own toast.
    await click(byTestId('mermaid-copy-image'));
    expect(write).toHaveBeenCalledTimes(2);
    expect(toasts()).toEqual([
      'success: Image copied.',
      'success: Image copied.',
    ]);
  });

  it('explains an unavailable clipboard and never reports success', async () => {
    await renderWith({});
    const copy = byTestId('mermaid-copy-image');
    expect(copy?.getAttribute('aria-disabled')).toBe('true');
    const reasonId = copy?.getAttribute('aria-describedby');
    expect(document.getElementById(reasonId ?? '')?.textContent).toBe(
      'Copying images isn’t available here.',
    );
    await click(copy);
    expect(notify).not.toHaveBeenCalled();
    expect(confirmed()).toEqual([]);
    // Saving stays available without a clipboard.
    expect(byTestId('mermaid-save-png')?.disabled).toBe(false);
  });

  it('reports a denied clipboard write as a failure', async () => {
    const write = jest
      .fn()
      .mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
    await renderWith({ clipboard: { status: 'available', write } });
    await click(byTestId('mermaid-copy-image'));
    expect(toasts()).toEqual([
      'error: Couldn’t copy the picture. Check clipboard access and try again.',
    ]);
    expect(confirmed()).toEqual([]);
  });

  it('shows the size limit when a diagram is too large for a PNG', async () => {
    mockRasterize.mockRejectedValue(
      new MermaidExportError(
        'This diagram is too large to export as a picture',
      ),
    );
    await renderWith({});
    await click(byTestId('mermaid-save-png'));
    expect(toasts()).toEqual([
      'error: This diagram is too large to export as a picture',
    ]);
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('saves beside the document, retrying only name conflicts', async () => {
    const open = jest.fn();
    const save = siblingSave()
      .mockResolvedValueOnce({ status: 'conflict' })
      .mockImplementationOnce(({ filename }) =>
        Promise.resolve<MermaidSiblingSaveResult>({
          status: 'saved',
          filename,
          open,
        }),
      );
    await renderWith({
      destination: {
        kind: 'sibling',
        documentName: 'plan.md',
        formats: { png: true, svg: true },
        save,
      },
    });
    await click(byTestId('mermaid-save-png'));
    expect(save.mock.calls.map(([request]) => request.filename)).toEqual([
      'plan-release-plan.png',
      'plan-release-plan-2.png',
    ]);
    expect(save.mock.calls[0]?.[0].format).toBe('png');
    expect(toasts()).toEqual(['success: Saved plan-release-plan-2.png.']);
    expect(confirmed()).toEqual(['mermaid-save-png']);
    const toast = notify.mock.calls[0]?.[0];
    // The file name comes from document text.
    expect(toast?.blockMessageFromReplay).toBe(true);
    expect(toast?.action?.label).toBe('Open');
    toast?.action?.run();
    expect(open).toHaveBeenCalledTimes(1);
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('stops after twenty names and never falls back to a download', async () => {
    const save = siblingSave().mockResolvedValue({ status: 'conflict' });
    await renderWith({
      destination: {
        kind: 'sibling',
        documentName: 'plan.md',
        formats: { png: true, svg: true },
        save,
      },
    });
    await chooseSvg();
    expect(save).toHaveBeenCalledTimes(20);
    expect(save.mock.calls[19]?.[0].filename).toBe('plan-release-plan-20.svg');
    expect(toasts()).toEqual([
      'error: Couldn’t find a free file name. Rename or move earlier pictures and try again.',
    ]);
    expect(confirmed()).toEqual([]);
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('keeps an operational save failure a failure', async () => {
    const save = siblingSave().mockRejectedValue(new Error('EACCES'));
    await renderWith({
      destination: {
        kind: 'sibling',
        documentName: 'plan.md',
        formats: { png: true, svg: true },
        save,
      },
    });
    await click(byTestId('mermaid-save-png'));
    expect(save).toHaveBeenCalledTimes(1);
    expect(toasts()).toEqual([
      'error: Couldn’t save the picture. Check that the folder can be written to and try again.',
    ]);
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('downloads a format the host cannot create beside the document', async () => {
    const save = siblingSave();
    await renderWith({
      destination: {
        kind: 'sibling',
        documentName: 'plan.md',
        formats: { png: false, svg: true },
        save,
      },
    });
    await click(byTestId('mermaid-save-png'));
    expect(save).not.toHaveBeenCalled();
    expect(mockDownload).toHaveBeenCalledWith(
      expect.any(Blob),
      'plan-release-plan.png',
      document,
    );
    expect(toasts()).toEqual(['success: Download started.']);
    expect(notify.mock.calls[0]?.[0].action).toBeUndefined();
  });

  it('numbers headless diagrams and disables duplicate exports while pending', async () => {
    let finish: ((blob: Blob) => void) | undefined;
    mockRasterize.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await renderWith(
      {},
      `${markdown}\n\n${markdown.replace('A-->B', 'C-->D')}`,
    );
    const saves = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="mermaid-save-png"]',
    );
    await click(saves[1]);
    expect(saves[1]?.disabled).toBe(true);
    await click(saves[1]);
    expect(mockRasterize).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish?.(new Blob(['png']));
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
    });
    expect(mockDownload).toHaveBeenCalledWith(
      expect.any(Blob),
      'diagram-2.png',
      document,
    );
    expect(saves[1]?.disabled).toBe(false);
  });

  it('ignores a save that finishes after the diagram changed', async () => {
    let finish: ((blob: Blob) => void) | undefined;
    mockRasterize.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const save = siblingSave();
    await renderWith({
      destination: {
        kind: 'sibling',
        documentName: 'plan.md',
        formats: { png: true, svg: true },
        save,
      },
    });
    await click(byTestId('mermaid-save-png'));
    await renderWith(
      {
        destination: {
          kind: 'sibling',
          documentName: 'plan.md',
          formats: { png: true, svg: true },
          save,
        },
      },
      `# Release plan\n\n${markdown.replace('A-->B', 'B-->C')}`,
    );
    await act(async () => {
      finish?.(new Blob(['png']));
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
    });
    expect(save).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('keeps text copying disabled until a pending sibling save settles', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const save = siblingSave().mockImplementation(
      () => new Promise<MermaidSiblingSaveResult>(() => undefined),
    );
    await renderWith({
      destination: {
        kind: 'sibling',
        documentName: 'plan.md',
        formats: { png: true, svg: true },
        save,
      },
    });
    await click(byTestId('mermaid-save-png'));
    await click(byTestId('mermaid-more-actions'));
    const copy = document.querySelector<HTMLButtonElement>(
      '[data-testid="mermaid-more-menu"] [data-testid="mermaid-copy-source"]',
    );
    expect(copy?.disabled).toBe(true);
    await click(copy);
    expect(writeText).not.toHaveBeenCalled();
    expect(byTestId('mermaid-save-png')?.disabled).toBe(true);
  });

  it('ignores a save after switching documents with identical diagram text', async () => {
    let complete: ((result: MermaidSiblingSaveResult) => void) | undefined;
    const save = jest.fn(
      () =>
        new Promise<MermaidSiblingSaveResult>((resolve) => {
          complete = resolve;
        }),
    );
    const open = jest.fn();
    await renderWith({
      destination: {
        kind: 'sibling',
        documentName: 'plan.md',
        documentId: '/old/plan.md',
        formats: { png: true, svg: true },
        save,
      },
    });
    await click(byTestId('mermaid-save-png'));
    expect(save).toHaveBeenCalledTimes(1);
    await renderWith({
      destination: {
        kind: 'download',
        documentName: 'plan.md',
        documentId: '/new/plan.md',
      },
    });
    await act(async () => {
      complete?.({ status: 'saved', filename: 'old.png', open });
      await Promise.resolve();
    });
    expect(notify).not.toHaveBeenCalled();
    expect(confirmed()).toEqual([]);
    expect(byTestId('mermaid-save-png')?.disabled).toBe(false);
  });

  it('reports results only through the toast and a brief checkmark, never a line of text', async () => {
    const write = jest.fn().mockResolvedValue(undefined);
    await renderWith({ clipboard: { status: 'available', write } });
    const figure = container.querySelector('[data-testid="markdown-mermaid"]');
    const before = figure?.textContent;
    jest.useFakeTimers();
    try {
      await click(byTestId('mermaid-copy-image'));
      expect(toasts()).toEqual(['success: Image copied.']);
      expect(confirmed()).toEqual(['mermaid-copy-image']);
      expect(figure?.textContent).toBe(before);
      expect(byTestId('mermaid-export-status')).toBeNull();
      act(() => {
        jest.advanceTimersByTime(1999);
      });
      expect(confirmed()).toEqual(['mermaid-copy-image']);
      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(confirmed()).toEqual([]);
      // A repeated copy shows the checkmark again.
      await click(byTestId('mermaid-copy-image'));
      expect(confirmed()).toEqual(['mermaid-copy-image']);
      expect(toasts()).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('confirms menu copies on the control that owns them', async () => {
    const write = jest.fn().mockResolvedValue(undefined);
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    await renderWith({ clipboard: { status: 'available', write } });
    const area = container.querySelector<HTMLElement>(
      '[aria-label="Diagram scroll area"]',
    );
    await act(async () => {
      area?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    await click(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="mermaid-context-copy-image"]',
      ),
    );
    expect(write).toHaveBeenCalledTimes(1);
    expect(toasts()).toEqual(['success: Image copied.']);
    expect(confirmed()).toEqual(['mermaid-copy-image']);

    await act(async () => {
      byTestId('mermaid-more-actions')?.click();
      await Promise.resolve();
    });
    await click(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="mermaid-more-menu"] [data-testid="mermaid-copy-source"]',
      ),
    );
    expect(writeText).toHaveBeenCalledWith(source);
    expect(toasts()).toEqual([
      'success: Image copied.',
      'success: Diagram text copied.',
    ]);
    // The menu has closed, so its trigger carries the checkmark.
    expect(confirmed()).toEqual(['mermaid-more-actions']);
  });

  it('announces results without taking up space when the host has no toasts', async () => {
    const write = jest.fn().mockResolvedValue(undefined);
    await renderWith({
      clipboard: { status: 'available', write },
      withoutToasts: true,
    });
    await click(byTestId('mermaid-copy-image'));
    const status = byTestId('mermaid-export-status');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.className).toBe('sr-only');
    expect(status?.textContent).toBe('Image copied.');
    expect(confirmed()).toEqual(['mermaid-copy-image']);
  });

  it('reports failed text copying even when rendering failed', async () => {
    mockRender.mockRejectedValue(new Error('invalid diagram'));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: jest.fn().mockRejectedValue(new Error('denied')) },
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: jest.fn(() => false),
    });
    await renderWith({});
    await click(byTestId('mermaid-copy-source'));
    expect(toasts()).toEqual([
      'error: Couldn’t copy the diagram text. Try again.',
    ]);
    expect(confirmed()).toEqual([]);
    expect(container.querySelector('[aria-live="polite"]')).toBeNull();
  });

  it('opens its own context menu from the pointer and both menu keys', async () => {
    // The chat message's selection menu listens on an ancestor element.
    const parentMenu = jest.fn();
    await act(async () => {
      await Promise.resolve();
      root.render(
        <div {...MARKDOWN_ROOT_PROPS} onContextMenu={parentMenu}>
          <Markdown>{markdown}</Markdown>
        </div>,
      );
    });
    const area = container.querySelector<HTMLElement>(
      '[aria-label="Diagram scroll area"]',
    );
    expect(area?.hasAttribute('data-owns-context-menu')).toBe(true);
    await act(async () => {
      area?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 30,
        }),
      );
      await Promise.resolve();
    });
    expect(parentMenu).not.toHaveBeenCalled();
    const menu = (): HTMLElement | null =>
      document.querySelector('[data-testid="mermaid-context-menu"]');
    expect(
      Array.from(menu()?.querySelectorAll('[role="menuitem"]') ?? [], (item) =>
        item.textContent?.trim(),
      ),
    ).toEqual([
      'Copy image',
      'Save as picture…',
      'Save as SVG…',
      'Copy diagram text',
    ]);
    expect(
      menu()
        ?.querySelector('[data-testid="mermaid-context-copy-image"]')
        ?.hasAttribute('disabled'),
    ).toBe(true);

    for (const init of [
      { key: 'F10', shiftKey: true },
      { key: 'ContextMenu' },
    ]) {
      await act(async () => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
        await Promise.resolve();
      });
      expect(menu()).toBeNull();
      area?.focus();
      await act(async () => {
        area?.dispatchEvent(
          new KeyboardEvent('keydown', {
            ...init,
            bubbles: true,
            cancelable: true,
          }),
        );
        await Promise.resolve();
      });
      expect(menu()).not.toBeNull();
      expect(document.activeElement?.textContent?.trim()).toBe(
        'Save as picture…',
      );
    }
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(area);
  });

  async function chooseSvg(): Promise<void> {
    await act(async () => {
      byTestId('mermaid-more-actions')?.click();
      await Promise.resolve();
    });
    await click(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="mermaid-more-menu"] [data-testid="mermaid-save-svg"]',
      ),
    );
  }
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
