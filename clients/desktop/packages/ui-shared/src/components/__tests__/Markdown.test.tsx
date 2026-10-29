/** @jest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Markdown,
  markdownOptions,
  markdownTableCellProps,
  TRANSCRIPT_MARKDOWN_OPTIONS,
  isNavigableTranscriptHref,
  withSoftLineBreaks,
  type MarkdownOverrides,
} from '../Markdown';
import { markdownOptions as serverMarkdownOptions } from '../markdown-render';
import { MarkdownMath } from '../MarkdownMath';
import {
  MAX_MATH_EXPRESSION_LENGTH,
  prepareMarkdownMath,
} from '../markdown-math';

jest.mock('mdast-util-from-markdown', () => ({
  fromMarkdown: (
    markdown: string,
  ): {
    children: Array<{
      type: string;
      depth?: number;
      ordered?: boolean;
      position: {
        start: { offset: number; line: number };
        end: { offset: number; line: number };
      };
    }>;
  } => {
    const blocks = markdown.split(/\n\n/);
    let cursor = 0;
    return {
      children: blocks.map((block) => {
        const start = markdown.indexOf(block, cursor);
        const end = start + block.length;
        cursor = end;
        const startLine = markdown.slice(0, start).split('\n').length;
        const endLine = markdown.slice(0, end).split('\n').length;
        const type = block.startsWith('[docs]:')
          ? 'definition'
          : block.startsWith('# ')
            ? 'heading'
            : block.startsWith('```')
              ? 'code'
              : block.startsWith('- ')
                ? 'list'
                : block.startsWith('|')
                  ? 'table'
                  : block.startsWith('<')
                    ? 'html'
                    : 'paragraph';
        return {
          type,
          depth: type === 'heading' ? 1 : undefined,
          ordered: type === 'list' ? false : undefined,
          position: {
            start: { offset: start, line: startLine },
            end: { offset: end, line: endLine },
          },
        };
      }),
    };
  },
}));
jest.mock('mdast-util-gfm', () => ({
  gfmFromMarkdown: (): Record<string, never> => ({}),
}));
jest.mock('micromark-extension-gfm', () => ({
  gfm: (): Record<string, never> => ({}),
}));

import { SourcePositionMarkdown } from '../SourcePositionMarkdown';

describe('Markdown', () => {
  it('progressively mounts large completed documents and exposes completion', () => {
    const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const frameCallbacks: FrameRequestCallback[] = [];
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const originalCancelAnimationFrame = window.cancelAnimationFrame;
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: (callback: FrameRequestCallback): number => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      },
    });
    Object.defineProperty(window, 'cancelAnimationFrame', {
      configurable: true,
      value: (): void => undefined,
    });
    const source = Array.from(
      { length: 12 },
      (_, index) => `## Section ${index}\n\nParagraph ${index}.`,
    ).join('\n\n');
    try {
      act(() => {
        root.render(
          <Markdown
            progressive={{
              minimumCharacters: 0,
              initialBlocks: 4,
              blocksPerFrame: 4,
            }}
          >
            {source}
          </Markdown>,
        );
      });
      expect(host.querySelectorAll('h2, p')).toHaveLength(4);
      expect(
        host.querySelector('[data-progressive-markdown-complete="false"]'),
      ).not.toBeNull();
      expect(
        host.querySelector('span[data-progressive-markdown-complete]'),
      ).toBeNull();
      expect(
        host
          .querySelector('h2')
          ?.getAttribute('data-progressive-markdown-complete'),
      ).toBe('false');

      while (frameCallbacks.length > 0) {
        const callback = frameCallbacks.shift();
        if (callback) act(() => callback(performance.now()));
      }
      expect(host.querySelectorAll('h2, p')).toHaveLength(24);
      expect(
        host.querySelector('[data-progressive-markdown-complete="true"]'),
      ).not.toBeNull();
      expect(
        host
          .querySelector('h2')
          ?.getAttribute('data-progressive-markdown-complete'),
      ).toBe('true');

      act(() => {
        root.render(
          <Markdown
            options={{}}
            progressive={{
              minimumCharacters: 0,
              initialBlocks: 4,
              blocksPerFrame: 4,
            }}
          >
            {source}
          </Markdown>,
        );
      });
      expect(host.querySelectorAll('h2, p')).toHaveLength(24);
      expect(
        host.querySelector('[data-progressive-markdown-complete="true"]'),
      ).not.toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
      Object.defineProperty(window, 'requestAnimationFrame', {
        configurable: true,
        value: originalRequestAnimationFrame,
      });
      Object.defineProperty(window, 'cancelAnimationFrame', {
        configurable: true,
        value: originalCancelAnimationFrame,
      });
      globalThis.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
    }
  });

  it('keeps an already rendered streaming document mounted atomically when it completes', () => {
    const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const originalCancelAnimationFrame = window.cancelAnimationFrame;
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: (): number => 1,
    });
    Object.defineProperty(window, 'cancelAnimationFrame', {
      configurable: true,
      value: (): void => undefined,
    });
    const source = Array.from(
      { length: 12 },
      (_, index) => `## Section ${index}\n\nParagraph ${index}.`,
    ).join('\n\n');
    const completedSource = `${source}\n\n## Final section\n\nFinal paragraph.`;
    const progressive = {
      minimumCharacters: 0,
      initialBlocks: 4,
      blocksPerFrame: 4,
    };
    try {
      act(() => {
        root.render(<Markdown streaming>{source}</Markdown>);
      });
      expect(host.querySelectorAll('h2, p')).toHaveLength(24);

      act(() => {
        root.render(
          <Markdown progressive={progressive} streaming={false}>
            {completedSource}
          </Markdown>,
        );
      });

      expect(host.querySelectorAll('h2, p')).toHaveLength(26);
      expect(
        host.querySelector('[data-progressive-markdown-complete]'),
      ).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
      Object.defineProperty(window, 'requestAnimationFrame', {
        configurable: true,
        value: originalRequestAnimationFrame,
      });
      Object.defineProperty(window, 'cancelAnimationFrame', {
        configurable: true,
        value: originalCancelAnimationFrame,
      });
      globalThis.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
    }
  });

  it('preserves Mermaid quotas when progressive rendering is disabled', () => {
    const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const originalCancelAnimationFrame = window.cancelAnimationFrame;
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: (): number => 1,
    });
    Object.defineProperty(window, 'cancelAnimationFrame', {
      configurable: true,
      value: (): void => undefined,
    });
    const source = Array.from(
      { length: 21 },
      (_, index) =>
        `\`\`\`mermaid\nflowchart LR\nA${index}-->B${index}\n\`\`\``,
    ).join('\n\n');
    try {
      act(() => {
        root.render(
          <Markdown
            progressive={{
              minimumCharacters: 0,
              initialBlocks: 1,
              blocksPerFrame: 1,
            }}
          >
            {source}
          </Markdown>,
        );
      });
      expect(
        host.querySelectorAll('[data-testid="markdown-mermaid"]'),
      ).toHaveLength(1);

      act(() => {
        root.render(<Markdown>{source}</Markdown>);
      });

      expect(
        host.querySelectorAll('[data-testid="markdown-mermaid"]'),
      ).toHaveLength(20);
    } finally {
      act(() => root.unmount());
      host.remove();
      Object.defineProperty(window, 'requestAnimationFrame', {
        configurable: true,
        value: originalRequestAnimationFrame,
      });
      Object.defineProperty(window, 'cancelAnimationFrame', {
        configurable: true,
        value: originalCancelAnimationFrame,
      });
      globalThis.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
    }
  });

  it('reuses the compiled tree when a large document has few top-level blocks', () => {
    const source = Array.from(
      { length: 21 },
      (_, index) =>
        `\`\`\`mermaid\nflowchart LR\nA${index}-->B${index}\n\`\`\``,
    ).join('\n\n');
    const markup = renderToStaticMarkup(
      <Markdown
        progressive={{
          minimumCharacters: 0,
          initialBlocks: 30,
          blocksPerFrame: 1,
        }}
      >
        {source}
      </Markdown>,
    );

    expect(markup.match(/data-testid="markdown-mermaid"/g)).toHaveLength(20);
  });

  it('renders the GFM and CommonMark features used by transcript surfaces', () => {
    const html = renderToStaticMarkup(
      <Markdown>
        {[
          '# Heading',
          '',
          '**bold** and *emphasis* and ~~removed~~ and `code`',
          '',
          '- [x] complete',
          '- [ ] pending',
          '',
          '| Name | Value |',
          '| --- | ---: |',
          '| one | 1 |',
        ].join('\n')}
      </Markdown>,
    );

    expect(html).toContain('<h1');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>emphasis</em>');
    expect(html).toContain('<del>removed</del>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked=""');
    expect(html).toContain('disabled=""');
    expect(html).toContain('<table>');
    expect(html).toContain('role="group" aria-label="Table" tabindex="0"');
    expect(html).toContain('text-align:right');
  });

  describe('withSoftLineBreaks (CAN-2811)', () => {
    it('renders single newlines inside a paragraph as <br> elements', () => {
      const html = renderToStaticMarkup(
        <Markdown options={withSoftLineBreaks(TRANSCRIPT_MARKDOWN_OPTIONS)}>
          {'line one\nline two\nline three'}
        </Markdown>,
      );

      expect(html).toBe('<p>line one<br/>line two<br/>line three</p>');
    });

    it('leaves the default options collapsing soft breaks', () => {
      const html = renderToStaticMarkup(
        <Markdown options={TRANSCRIPT_MARKDOWN_OPTIONS}>
          {'line one\nline two'}
        </Markdown>,
      );

      expect(html).toBe('<p>line one\nline two</p>');
    });

    it('preserves paragraphs, hard breaks, lists, code, and inline runs', () => {
      const html = renderToStaticMarkup(
        <Markdown options={withSoftLineBreaks(TRANSCRIPT_MARKDOWN_OPTIONS)}>
          {[
            'Hello **bold\ntext** there',
            'hard  \nbreak',
            '- item\n  continued\n- other',
            '```\ncode\nmore\n```',
            'crlf one\r\ncrlf two',
            '`inline\ncode`',
          ].join('\n\n')}
        </Markdown>,
      );

      expect(html).toContain(
        '<p>Hello <strong>bold<br/>text</strong> there</p>',
      );
      expect(html).toContain('<p>hard<br/>break</p>');
      expect(html).toContain('<li>item<br/>continued</li><li>other</li>');
      expect(html).toContain('code\nmore');
      expect(html).not.toContain('code<br/>more');
      expect(html).toContain('<p>crlf one<br/>crlf two</p>');
      expect(html).toContain('<code>inline code</code>');
      expect(html.match(/<br\/>/g)).toHaveLength(4);
    });

    it('composes with a renderRule the caller already configured', () => {
      const renderRule = jest.fn((next: () => ReactNode): ReactNode => next());
      const html = renderToStaticMarkup(
        <Markdown
          options={withSoftLineBreaks({
            ...TRANSCRIPT_MARKDOWN_OPTIONS,
            renderRule,
          })}
        >
          {'line one\nline two'}
        </Markdown>,
      );

      expect(html).toBe('<p>line one<br/>line two</p>');
      expect(renderRule).toHaveBeenCalled();
    });
  });

  it('decorates block code with copy chrome without changing inline code', () => {
    const html = renderToStaticMarkup(
      <Markdown>
        {'Use `inline()` here.\n\n```ts\nconst answer = 42;\n```'}
      </Markdown>,
    );

    expect(html).toContain('markdown-code-copy-host');
    expect(html).toContain('aria-label="Copy code to clipboard"');
    expect(html).toContain('absolute -right-2 -top-2');
    expect(html).toContain('pointer-events-none');
    expect(html.match(/aria-label="Copy code to clipboard"/g)).toHaveLength(1);
  });

  it('renders raw HTML as text and never evaluates expression props', () => {
    const html = renderToStaticMarkup(
      <Markdown>
        {'<img src="x" onerror="alert(1)">\n\n' +
          '<Widget onClick={() => alert(1)} />'}
      </Markdown>,
    );

    expect(html).toContain('&lt;img src=&quot;x&quot;');
    expect(html).toContain('&lt;Widget onClick=');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<Widget');
  });

  it('allows safe and relative URLs while removing unsafe custom schemes', () => {
    const html = renderToStaticMarkup(
      <Markdown>
        {[
          '[https](https://example.com)',
          '[irc](ircs://chat.example.com)',
          '[mail](mailto:user@example.com)',
          '[xmpp](xmpp:user@example.com)',
          '[relative](../plans/1?tab=comments#latest)',
          '[smb](smb://attacker.example/share)',
          '[file](file:///etc/passwd)',
          '[vscode](vscode://file/etc/passwd)',
          '[ssh](ssh://attacker.example)',
          '[intent](intent://scan)',
          '<vscode://file/etc/passwd>',
          '[reference][unsafe]',
          '',
          '[unsafe]: smb://attacker.example/share',
        ].join('\n')}
      </Markdown>,
    );

    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('href="ircs://chat.example.com"');
    expect(html).toContain('href="mailto:user@example.com"');
    expect(html).toContain('href="xmpp:user@example.com"');
    expect(html).toContain('href="../plans/1?tab=comments#latest"');
    expect(html).not.toContain('href="smb:');
    expect(html).not.toContain('href="file:');
    expect(html).not.toContain('href="vscode:');
    expect(html).not.toContain('href="ssh:');
    expect(html).not.toContain('href="intent:');
  });

  describe('isNavigableTranscriptHref', () => {
    it.each([
      'https://example.com',
      'http://example.com/a?b=1#c',
      'mailto:a@example.com',
      '#anchor',
    ])('treats %s as navigable', (href) => {
      expect(isNavigableTranscriptHref(href)).toBe(true);
    });

    it.each([
      ['scheme with no authority', 'https:report.md'],
      ['scheme with a single slash', 'https:/report.md'],
      ['scheme with empty authority', 'https://'],
      ['scheme with empty authority and path', 'https:///Users/me/a.md'],
      ['bare scheme', 'https:'],
      ['empty mailto target', 'mailto:'],
    ])('treats %s as non-navigable', (_label, href) => {
      expect(isNavigableTranscriptHref(href)).toBe(false);
    });

    it.each([
      '/Users/tirish/notes.md',
      '/home/me/notes.md',
      './report.md',
      '../plans/1',
      'report.md',
      'C:\\repo\\a.ts',
      'file:///etc/passwd',
      'javascript:alert(1)',
      '   ',
      '',
    ])('treats %s as non-navigable', (href) => {
      expect(isNavigableTranscriptHref(href)).toBe(false);
    });
  });

  describe('transcript link policy', () => {
    it('keeps fully-qualified safe URLs navigable', () => {
      const html = renderToStaticMarkup(
        <Markdown options={TRANSCRIPT_MARKDOWN_OPTIONS}>
          {'[docs](https://example.com/docs) and [mail](mailto:a@example.com)'}
        </Markdown>,
      );

      expect(html).toContain('href="https://example.com/docs"');
      expect(html).toContain('href="mailto:a@example.com"');
    });

    it('does not navigate absolute filesystem paths as site URLs', () => {
      const html = renderToStaticMarkup(
        <Markdown options={TRANSCRIPT_MARKDOWN_OPTIONS}>
          {'[overview](/Users/tirish/.canopy/workspaces/home/00-overview.md)'}
        </Markdown>,
      );

      expect(html).not.toContain('<a');
      expect(html).toContain('data-testid="markdown-non-navigable-link"');
      expect(html).toContain(
        'title="/Users/tirish/.canopy/workspaces/home/00-overview.md"',
      );
      expect(html).toContain('overview');
    });

    it.each([
      ['relative path', '[a](./report.md)'],
      ['bare filename', '[a](report.md)'],
      ['parent-relative path', '[a](../plans/1)'],
      ['windows path', '[a](C:\\repo\\src\\a.ts)'],
    ])('does not navigate %s', (_label, markdown) => {
      const html = renderToStaticMarkup(
        <Markdown options={TRANSCRIPT_MARKDOWN_OPTIONS}>{markdown}</Markdown>,
      );

      expect(html).not.toContain('<a');
      expect(html).toContain('data-testid="markdown-non-navigable-link"');
    });

    it('keeps in-document fragments navigable', () => {
      const html = renderToStaticMarkup(
        <Markdown options={TRANSCRIPT_MARKDOWN_OPTIONS}>
          {'[section](#results)'}
        </Markdown>,
      );

      expect(html).toContain('href="#results"');
    });

    it('still strips unsafe schemes', () => {
      const html = renderToStaticMarkup(
        <Markdown options={TRANSCRIPT_MARKDOWN_OPTIONS}>
          {'[boom](javascript:alert(1)) and [f](file:///etc/passwd)'}
        </Markdown>,
      );

      expect(html).not.toContain('javascript:');
      expect(html).not.toContain('file:///etc/passwd');
      expect(html).not.toContain('<a');
    });
  });

  it('sanitizes links before passing them to custom element decorators', () => {
    const overrides: MarkdownOverrides = {
      a({ children, href }) {
        return (
          <span
            data-testid="safe-link"
            data-href={typeof href === 'string' ? href : undefined}
          >
            {children}
          </span>
        );
      },
      strong({ children }) {
        return <strong data-decorated="true">{children}</strong>;
      },
    };
    const html = renderToStaticMarkup(
      <Markdown options={markdownOptions(overrides)}>
        {
          '[safe](https://example.com) and [unsafe][target] and **bold**\n\n[target]: file:///etc/passwd'
        }
      </Markdown>,
    );

    expect(html).toContain(
      '<span data-testid="safe-link" data-href="https://example.com">safe</span>',
    );
    expect(html).toContain('<span data-testid="safe-link">unsafe</span>');
    expect(html).toContain('<strong data-decorated="true">bold</strong>');
    expect(html).not.toContain('file:///etc/passwd');
    expect(html).not.toContain('<a');
  });

  it('keeps file: targets only for a custom anchor that opts in (CAN-3172)', () => {
    const overrides: MarkdownOverrides = {
      a({ children, href }) {
        return (
          <span
            data-testid="file-link"
            data-href={typeof href === 'string' ? href : undefined}
          >
            {children}
          </span>
        );
      },
    };
    const markdown =
      '[inline](file:///workspace/a.ts#L2) and [ref][target] and [bad](javascript:alert(1))\n\n[target]: file:///workspace/b.ts';
    const optedIn = renderToStaticMarkup(
      <Markdown
        options={markdownOptions(overrides, { allowFileUrlLinks: true })}
      >
        {markdown}
      </Markdown>,
    );
    expect(optedIn).toContain('data-href="file:///workspace/a.ts#L2"');
    expect(optedIn).toContain('data-href="file:///workspace/b.ts"');
    expect(optedIn).not.toContain('javascript:');

    // Without a custom anchor the opt-in is ignored: nothing navigates to file:.
    const noAnchor = renderToStaticMarkup(
      <Markdown options={{ allowFileUrlLinks: true }}>{markdown}</Markdown>,
    );
    expect(noAnchor).not.toContain('file:///');
  });

  describe('slash-less local links with a line suffix (CAN-4275)', () => {
    const captureOverrides: MarkdownOverrides = {
      a({ children, href }) {
        return (
          <span
            data-testid="file-link"
            data-href={typeof href === 'string' ? href : 'none'}
          >
            {children}
          </span>
        );
      },
    };

    function renderedHref(
      markdown: string,
      options: Parameters<typeof markdownOptions>[1],
      overrides: MarkdownOverrides | undefined = captureOverrides,
    ): string {
      return renderToStaticMarkup(
        <Markdown options={markdownOptions(overrides, options)}>
          {markdown}
        </Markdown>,
      );
    }

    it.each([
      'README.md:12',
      'README.md:12-20',
      'README.md:12:4',
      'README.md:12:4-20:9',
      '.env:3',
      'my_notes:7',
    ])('keeps %s for a custom anchor that opts into local links', (href) => {
      const html = renderedHref(`[summary](${href})`, {
        allowLocalFileLinks: true,
      });
      expect(html).toContain(`data-href="${href}"`);
    });

    describe.each([
      [':12', true],
      [':12-20', true],
      [':12:4', true],
      [':12:4-20:9', true],
      ['#L12', false],
      ['#L12-L20', false],
      ['#L12-20', false],
      ['#L12C4', false],
    ])(
      'suffix %s across the local-file/custom-anchor gates',
      (suffix, needsLocalAllowance) => {
        it.each([
          [false, false, false],
          [false, true, false],
          [true, false, false],
          [true, true, false],
          [false, false, true],
          [false, true, true],
          [true, false, true],
          [true, true, true],
        ])(
          'local=%s anchor=%s file-url=%s',
          (allowLocalFileLinks, customAnchor, allowFileUrlLinks) => {
            const href = `README.md${suffix}`;
            const options = { allowLocalFileLinks, allowFileUrlLinks };
            const overrides = customAnchor ? captureOverrides : {};
            const allowed =
              !needsLocalAllowance || (allowLocalFileLinks && customAnchor);
            const sanitizer = markdownOptions(overrides, options).sanitizer;
            expect(sanitizer?.(href, 'a', 'href')).toBe(allowed ? href : null);
            const html = renderedHref(`[summary](${href})`, options, overrides);
            if (allowed) {
              expect(html).toContain(`href="${href}"`);
            } else {
              expect(html).not.toContain(`href="${href}"`);
              if (customAnchor) expect(html).toContain('data-href="none"');
            }
            // Hash fragments were already safe relative URLs under the default
            // policy; only colon forms need the new local-file exception.
          },
        );
      },
    );

    it.each([false, true])(
      'keeps prohibited schemes blocked with local opt-in %s',
      (allowLocalFileLinks) => {
        const options = { allowLocalFileLinks, allowFileUrlLinks: true };
        for (const href of [
          'javascript:12',
          'JavaScript:12',
          'vbscript:12',
          'data:12',
          'data:text/plain:12',
          'blob:12',
          'javascript:12-20',
          'javascript:12:4',
          'javascript:12:4-20:9',
        ]) {
          const sanitizer = markdownOptions(
            captureOverrides,
            options,
          ).sanitizer;
          expect(sanitizer?.(href, 'a', 'href')).toBeNull();
          expect(renderedHref(`[x](${href})`, options)).toContain(
            'data-href="none"',
          );
        }
      },
    );

    it.each([':12', ':12-20', ':12:4', ':12:4-20:9'])(
      'rejects control characters rather than extending the colon-form allowance %s',
      (suffix) => {
        const sanitizer = markdownOptions(captureOverrides, {
          allowLocalFileLinks: true,
        }).sanitizer;
        for (const control of ['\u0000', '\u0001', '\u001f', '\u007f']) {
          expect(
            sanitizer?.(`READ${control}ME.md${suffix}`, 'a', 'href'),
          ).toBeNull();
        }
      },
    );

    it.each([false, true])(
      'preserves external URL ports and fragments with local opt-in %s',
      (allowLocalFileLinks) => {
        for (const href of [
          'https://example.com:8443/a#L12-L20',
          'https://example.com/a:12:4-20:9',
          'mailto:a@example.com',
        ]) {
          const options = { allowLocalFileLinks };
          const sanitizer = markdownOptions(
            captureOverrides,
            options,
          ).sanitizer;
          expect(sanitizer?.(href, 'a', 'href')).toBe(href);
          expect(renderedHref(`[external](${href})`, options)).toContain(
            `data-href="${href}"`,
          );
        }
      },
    );

    it('requires the local-file opt-in', () => {
      expect(renderedHref('[summary](README.md:12)', {})).toContain(
        'data-href="none"',
      );
      // The file-URL opt-in alone does not admit bare local paths.
      expect(
        renderedHref('[summary](README.md:12)', { allowFileUrlLinks: true }),
      ).toContain('data-href="none"');
    });

    it('requires a custom anchor', () => {
      const html = renderedHref(
        '[summary](README.md:12)',
        { allowLocalFileLinks: true },
        {},
      );
      expect(html).not.toContain('README.md:12');
      expect(html).not.toContain('href=');
    });

    it.each([
      // Prohibited schemes never become local paths by losing a "suffix".
      'javascript:12',
      'JavaScript:12',
      'vbscript:12',
      'data:12',
      'data:text/plain:12',
      'file:12',
      'blob:12',
      // A suffix is required, and must be the whole tail.
      'README.md:',
      'README.md:12-',
      'README.md:12abc',
      'README.md:0',
      'note:md:12',
      // Bare tokens that are syntactically a URL scheme stay rejected.
      'Makefile:12',
    ])('still rejects %s', (href) => {
      const html = renderedHref(`[x](${href})`, { allowLocalFileLinks: true });
      expect(html).toContain('data-href="none"');
    });

    it('rejects control characters in a slash-less local href', () => {
      const sanitizer = markdownOptions(captureOverrides, {
        allowLocalFileLinks: true,
      }).sanitizer;
      expect(sanitizer?.('READ\u0001ME.md:12', 'a', 'href')).toBeNull();
      expect(sanitizer?.('README.md\u007f:12', 'a', 'href')).toBeNull();
      expect(sanitizer?.('README.md:12', 'a', 'href')).toBe('README.md:12');
    });

    it('leaves external URLs and existing local forms unchanged', () => {
      const html = renderedHref(
        '[a](https://example.com:8443/a#L12) [b](mailto:a@example.com) ' +
          '[c](src/a.ts:12) [d](C:/repo/a.ts:4) [e](README.md#L5)',
        { allowLocalFileLinks: true },
      );
      expect(html).toContain('data-href="https://example.com:8443/a#L12"');
      expect(html).toContain('data-href="mailto:a@example.com"');
      expect(html).toContain('data-href="src/a.ts:12"');
      expect(html).toContain('data-href="C:/repo/a.ts:4"');
      expect(html).toContain('data-href="README.md#L5"');
    });
  });

  it('protects supported math delimiters without parsing code literals', () => {
    const markdown = [
      String.raw`Inline \(\alpha + \beta\).`,
      '',
      String.raw`\[\frac{a}{b}\]`,
      '',
      '$$E = mc^2$$',
      '',
      String.raw`Code: \(\literal\).`.replace(
        String.raw`\(\literal\)`,
        '`\\(literal\\)`',
      ),
      '',
      '```text',
      String.raw`\[literal-fence\]`,
      '```',
      '',
      '``` Math',
      String.raw`\sum_i i`,
      '```',
    ].join('\n');

    const prepared = prepareMarkdownMath(markdown);

    expect(prepared.hasMath).toBe(true);
    expect(prepared.expressions.size).toBe(3);
    expect([...prepared.expressions.values()]).toEqual([
      { source: '\\alpha + \\beta', display: false },
      { source: '\\frac{a}{b}', display: true },
      { source: 'E = mc^2', display: true },
    ]);
    expect(prepared.markdown).toContain('`\\(literal\\)`');
    expect(prepared.markdown).toContain('\\[literal-fence\\]');
    expect(prepared.markdown).toContain('``` Math\n\\sum_i i\n```');
  });

  it('keeps escaped, unclosed, oversized, and excessive math readable', () => {
    const oversized = 'x'.repeat(MAX_MATH_EXPRESSION_LENGTH + 1);
    const markdown = [
      ...Array.from({ length: 1_002 }, (_, index) => `\\(${index}\\)`),
      String.raw`Escaped \\(not math\)`,
      `\\[${oversized}\\]`,
      String.raw`Unclosed \(still text`,
    ].join('\n');

    const prepared = prepareMarkdownMath(markdown);

    expect(prepared.expressions.size).toBe(1_000);
    expect(prepared.markdown).toContain(`\\[${oversized}\\]`);
    expect(prepared.markdown).toContain(String.raw`\\(not math\)`);
    expect(prepared.markdown).toContain(String.raw`Unclosed \(still text`);
  });

  it('skips oversized backtick runs without repeatedly rescanning them', () => {
    const backticks = '`'.repeat(50_000);
    const markdown = `Prefix ${backticks}\n\n${String.raw`Valid \(x\)`}`;

    const prepared = prepareMarkdownMath(markdown);

    expect(prepared.expressions.size).toBe(1);
    expect(prepared.markdown.startsWith(`Prefix ${backticks}`)).toBe(true);
    expect([...prepared.expressions.values()]).toEqual([
      { source: 'x', display: false },
    ]);
  });

  it('leaves math-like text in indented code blocks unchanged', () => {
    const markdown = [
      String.raw`    \(indented\)`,
      '',
      '- nested',
      '',
      String.raw`      \(nested-code\)`,
      '',
      String.raw`Inline \(math\).`,
    ].join('\n');

    const prepared = prepareMarkdownMath(markdown);

    expect(prepared.expressions.size).toBe(1);
    expect(prepared.markdown).toContain(String.raw`    \(indented\)`);
    expect(prepared.markdown).toContain(String.raw`      \(nested-code\)`);
    expect([...prepared.expressions.values()]).toEqual([
      { source: 'math', display: false },
    ]);
  });

  it('leaves math-like text in blockquote-nested code unchanged', () => {
    const markdown = [
      String.raw`>     \(blockquote-code\)`,
      '',
      '> - item',
      '>',
      String.raw`>       \(blockquote-list-code\)`,
      '',
      String.raw`Formula \(rendered\).`,
    ].join('\n');

    const prepared = prepareMarkdownMath(markdown);

    expect(prepared.markdown).toContain(String.raw`>     \(blockquote-code\)`);
    expect(prepared.markdown).toContain(
      String.raw`>       \(blockquote-list-code\)`,
    );
    expect([...prepared.expressions.values()]).toEqual([
      { source: 'rendered', display: false },
    ]);
  });

  it('renders math in indented list continuation paragraphs', () => {
    const markdown = [
      '- item',
      '',
      String.raw`    Formula \(nested-list-math\).`,
      String.raw`    Follow-up \(nested-list-math-2\).`,
      '',
      String.raw`      \(nested-code\)`,
    ].join('\n');

    const prepared = prepareMarkdownMath(markdown);

    expect([...prepared.expressions.values()]).toEqual([
      { source: 'nested-list-math', display: false },
      { source: 'nested-list-math-2', display: false },
    ]);
    expect(prepared.markdown).toContain(String.raw`      \(nested-code\)`);
  });

  it('renders math in nested-list continuation paragraphs', () => {
    const markdown = [
      '- outer',
      '',
      '    - nested',
      '',
      String.raw`      Formula \(nested-list-math\).`,
      String.raw`      Follow-up \(nested-list-math-2\).`,
      '',
      String.raw`          \(nested-code\)`,
      '',
      String.raw`    Outer continuation \(outer-list-math\).`,
    ].join('\n');

    const prepared = prepareMarkdownMath(markdown);

    expect([...prepared.expressions.values()]).toEqual([
      { source: 'nested-list-math', display: false },
      { source: 'nested-list-math-2', display: false },
      { source: 'outer-list-math', display: false },
    ]);
    expect(prepared.markdown).toContain(String.raw`          \(nested-code\)`);
  });

  it('renders math in tab-indented list continuation paragraphs', () => {
    const markdown = [
      '- item',
      '',
      String.raw`	Formula \(tab-list-math\).`,
      String.raw`	  \(tab-nested-code\)`,
    ].join('\n');

    const prepared = prepareMarkdownMath(markdown);

    expect([...prepared.expressions.values()]).toEqual([
      { source: 'tab-list-math', display: false },
    ]);
    expect(prepared.markdown).toContain(String.raw`	  \(tab-nested-code\)`);
  });

  it('scans long indented list content without rescanning prior lines', () => {
    const markdown = [
      '- item',
      '',
      ...Array.from(
        { length: 20_000 },
        (_, index) => `    continuation ${index}`,
      ),
      String.raw`    Formula \(final-list-math\).`,
    ].join('\n');

    const prepared = prepareMarkdownMath(markdown);

    expect([...prepared.expressions.values()]).toEqual([
      { source: 'final-list-math', display: false },
    ]);
  });

  it('leaves math-like text in Markdown destinations unchanged', () => {
    const markdown = [
      String.raw`[link](https://example.com/\(path\))`,
      '![image](https://example.com/$$image$$.png)',
      String.raw`<https://example.com/\(auto\)>`,
      '[reference]: https://example.com/$$reference$$',
      '',
      String.raw`Formula \(rendered\).`,
    ].join('\n');

    const prepared = prepareMarkdownMath(markdown);

    expect(prepared.expressions.size).toBe(1);
    expect(prepared.markdown).toContain(
      String.raw`[link](https://example.com/\(path\))`,
    );
    expect(prepared.markdown).toContain(
      '![image](https://example.com/$$image$$.png)',
    );
    expect(prepared.markdown).toContain(
      String.raw`<https://example.com/\(auto\)>`,
    );
    expect(prepared.markdown).toContain(
      '[reference]: https://example.com/$$reference$$',
    );
    expect([...prepared.expressions.values()]).toEqual([
      { source: 'rendered', display: false },
    ]);
  });

  it('scans unmatched angle brackets in linear time without hiding later math', () => {
    const malformedAngles = '<'.repeat(50_000);
    const markdown = `${malformedAngles} ${String.raw`Formula \(rendered\).`}`;

    const prepared = prepareMarkdownMath(markdown);

    expect(prepared.markdown).toContain(malformedAngles);
    expect([...prepared.expressions.values()]).toEqual([
      { source: 'rendered', display: false },
    ]);
  });

  it('leaves math-like text in multiline reference definitions unchanged', () => {
    const markdown = [
      '[reference]: https://example.com/docs',
      String.raw`  "Title \(reference-title\)"`,
      '',
      '[split]:',
      '  https://example.com/$$reference-path$$',
      String.raw`  'Title \(split-reference-title\)'`,
      '',
      String.raw`Formula \(rendered\).`,
    ].join('\n');

    const prepared = prepareMarkdownMath(markdown);

    expect(prepared.markdown).toContain(
      String.raw`  "Title \(reference-title\)"`,
    );
    expect(prepared.markdown).toContain(
      '  https://example.com/$$reference-path$$',
    );
    expect(prepared.markdown).toContain(
      String.raw`  'Title \(split-reference-title\)'`,
    );
    expect([...prepared.expressions.values()]).toEqual([
      { source: 'rendered', display: false },
    ]);
  });

  it('leaves math-like text in bare GFM autolinks unchanged', () => {
    const markdown = [
      'https://example.com/$$http-path$$',
      String.raw`www.example.com/\(www-path\)`,
      '',
      String.raw`Formula \(rendered\).`,
    ].join('\n');

    const prepared = prepareMarkdownMath(markdown);

    expect(prepared.markdown).toContain('https://example.com/$$http-path$$');
    expect(prepared.markdown).toContain(
      String.raw`www.example.com/\(www-path\)`,
    );
    expect([...prepared.expressions.values()]).toEqual([
      { source: 'rendered', display: false },
    ]);
  });

  it('does not consume closing math delimiters inside code', () => {
    const inlineCode = String.raw`Unclosed \[before \`\]\``;
    const fencedCode = [
      String.raw`Unclosed \[before`,
      '```text',
      String.raw`\]`,
      '```',
    ].join('\n');

    expect(prepareMarkdownMath(inlineCode).expressions.size).toBe(0);
    expect(prepareMarkdownMath(inlineCode).markdown).toBe(inlineCode);
    expect(prepareMarkdownMath(fencedCode).expressions.size).toBe(0);
    expect(prepareMarkdownMath(fencedCode).markdown).toBe(fencedCode);
  });

  it('consumes malformed destination candidates without repeated scans', () => {
    const malformed = ']('.repeat(20_000);
    const markdown = `${malformed}\n${String.raw`Formula \(rendered\).`}`;

    const prepared = prepareMarkdownMath(markdown);

    expect(prepared.markdown).toContain(malformed);
    expect([...prepared.expressions.values()]).toEqual([
      { source: 'rendered', display: false },
    ]);
  });

  it('does not pair inline math delimiters across block boundaries', () => {
    const markdown = [
      String.raw`Unclosed \(first`,
      '',
      '# Heading',
      '',
      String.raw`Later \(valid\).`,
    ].join('\n');

    const prepared = prepareMarkdownMath(markdown);

    expect(prepared.markdown).toContain(String.raw`Unclosed \(first`);
    expect(prepared.markdown).toContain('# Heading');
    expect(prepared.expressions.size).toBe(1);
    expect([...prepared.expressions.values()]).toEqual([
      { source: 'valid', display: false },
    ]);
  });

  it('does not pair inline math delimiters across setext or thematic breaks', () => {
    const setext = [
      String.raw`Unclosed \(first`,
      'Heading',
      '---',
      String.raw`Later \(valid\).`,
    ].join('\n');
    const thematic = [
      String.raw`Unclosed \(first`,
      '* * *',
      String.raw`Later \(valid\).`,
    ].join('\n');

    for (const markdown of [setext, thematic]) {
      const prepared = prepareMarkdownMath(markdown);

      expect(prepared.markdown).toContain(String.raw`Unclosed \(first`);
      expect([...prepared.expressions.values()]).toEqual([
        { source: 'valid', display: false },
      ]);
    }
  });

  it('renders container-nested math fences', () => {
    const markdown = [
      '> ```math',
      String.raw`> \frac{a}{b}`,
      '> ```',
      '',
      '- ```tex',
      String.raw`  \sum_i i`,
      '  ```',
      '',
      '- > ```latex',
      String.raw`  > \int_0^1 x\,dx`,
      '  > ```',
    ].join('\n');
    const prepared = prepareMarkdownMath(markdown);
    const html = renderToStaticMarkup(<Markdown>{markdown}</Markdown>);

    expect(prepared.hasMath).toBe(true);
    expect(html.match(/canopy-markdown-math-loading/g)).toHaveLength(3);
    expect(html).toContain('\\frac{a}{b}');
    expect(html).toContain('\\sum_i i');
    expect(html).toContain('\\int_0^1 x\\,dx');
  });

  it('accepts list-relative math fence closers and processes later math', () => {
    const markdown = [
      '1.  ```math',
      String.raw`    \sum_i i`,
      '    ```',
      '',
      String.raw`Later \(rendered\).`,
    ].join('\n');
    const prepared = prepareMarkdownMath(markdown);
    const html = renderToStaticMarkup(<Markdown>{markdown}</Markdown>);

    expect(prepared.hasMath).toBe(true);
    expect([...prepared.expressions.values()]).toEqual([
      { source: 'rendered', display: false },
    ]);
    expect(html.match(/canopy-markdown-math-loading/g)).toHaveLength(2);
    expect(html).toContain('\\sum_i i');
    expect(html).toContain('rendered');
  });

  it('preserves math source in heading IDs and image alt text', () => {
    const markdown = [
      String.raw`# Energy \(E=mc^2\)`,
      '',
      String.raw`![Mass \(m\)](https://example.com/mass.png)`,
    ].join('\n');
    const html = renderToStaticMarkup(<Markdown>{markdown}</Markdown>);

    expect(html).toContain('id="energy-emc2"');
    expect(html).toContain('alt="Mass (m)"');
    expect(html).not.toContain('canopy-math-');
  });

  it('renders math in footnote bodies', () => {
    const markdown = [
      'Formula with a footnote[^1].',
      '',
      String.raw`[^1]: Footnote math \(x + y\).`,
    ].join('\n');
    const prepared = prepareMarkdownMath(markdown);
    const html = renderToStaticMarkup(<Markdown>{markdown}</Markdown>);

    expect([...prepared.expressions.values()]).toEqual([
      { source: 'x + y', display: false },
    ]);
    expect(html).toContain('<footer>');
    expect(html).toContain('canopy-markdown-math-loading');
    expect(html).toContain('x + y');
  });

  it('renders accessible KaTeX and falls back to source on parse errors', () => {
    const rendered = renderToStaticMarkup(
      <MarkdownMath
        source={String.raw`\frac{\text{tokens}}{\text{joule}}`}
        display
      />,
    );
    const malformed = renderToStaticMarkup(
      <MarkdownMath source={String.raw`\notacommand`} display />,
    );

    expect(rendered).toContain('class="katex-display"');
    expect(rendered).toContain('class="katex-mathml"');
    expect(rendered).toContain('class="katex-html"');
    expect(malformed).toContain('canopy-markdown-math-error');
    expect(malformed).toContain('\\notacommand');
  });
});

describe('SourcePositionMarkdown', () => {
  it('annotates rendered plan blocks with exact source lines and offsets', () => {
    const markdown =
      '# Plan\n\nParagraph with **formatting**.\n\n- first\n- second';
    const html = renderToStaticMarkup(
      <SourcePositionMarkdown>{markdown}</SourcePositionMarkdown>,
    );

    expect(html).toContain(
      '<h1 id="plan" data-sourcepos="1:1" data-md-start="0" data-md-end="6">',
    );
    expect(html).toContain(
      '<p data-sourcepos="3:3" data-md-start="8" data-md-end="38">',
    );
    expect(html).toContain(
      '<ul data-sourcepos="5:6" data-md-start="40" data-md-end="56"',
    );
  });

  it('keeps root-block positions aligned when reference definitions are hidden', () => {
    const markdown = '[docs]: https://example.com\n\nRead [docs].';
    const html = renderToStaticMarkup(
      <SourcePositionMarkdown>{markdown}</SourcePositionMarkdown>,
    );

    expect(html).toContain('data-sourcepos="3:3"');
    expect(html).toContain('Read <a href="https://example.com">docs</a>.');
  });

  it('keeps source annotations on tables and surrounding blocks', () => {
    const markdown =
      '# Plan\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nAfter table.';
    const html = renderToStaticMarkup(
      <SourcePositionMarkdown>{markdown}</SourcePositionMarkdown>,
    );
    expect(html).toContain('data-sourcepos="1:1"');
    expect(html).toContain('<table data-sourcepos="3:5"');
    expect(html).toContain('data-sourcepos="7:7"');
  });

  it('keeps source annotations on decorated code blocks', () => {
    const markdown = '```ts\nconst answer = 42;\n```';
    const html = renderToStaticMarkup(
      <SourcePositionMarkdown>{markdown}</SourcePositionMarkdown>,
    );

    expect(html).toContain(
      '<pre data-sourcepos="1:3" data-md-start="0" data-md-end="28"',
    );
    expect(html).toContain('aria-label="Copy code to clipboard"');
  });

  it('omits annotations when parser and renderer root structures differ', () => {
    const markdown = '<section>Raw block</section>\n\nVisible paragraph.';
    const html = renderToStaticMarkup(
      <SourcePositionMarkdown>{markdown}</SourcePositionMarkdown>,
    );

    expect(html).toContain('Raw block');
    expect(html).toContain('Visible paragraph.');
    expect(html).not.toContain('data-sourcepos');
    expect(html).not.toContain('data-md-start');
    expect(html).not.toContain('data-md-end');
  });

  it('keeps source annotations aligned around inline math placeholders', () => {
    const markdown = String.raw`Formula \(\alpha + \beta\) remains selectable.`;
    const html = renderToStaticMarkup(
      <SourcePositionMarkdown>{markdown}</SourcePositionMarkdown>,
    );

    expect(html).toContain('data-sourcepos="1:1"');
    expect(html).toContain('data-md-start="0"');
    expect(html).toContain(`data-md-end="${markdown.length}"`);
    expect(html).toContain('canopy-markdown-math-loading');
  });

  it('keeps source annotations on fenced math blocks', () => {
    const markdown = [
      '# Plan',
      '',
      '```math',
      String.raw`\frac{a}{b}`,
      '```',
      '',
      'After math.',
    ].join('\n');
    const html = renderToStaticMarkup(
      <SourcePositionMarkdown>{markdown}</SourcePositionMarkdown>,
    );

    expect(html).toContain('data-sourcepos="1:1"');
    expect(html).toContain('data-sourcepos="3:5"');
    expect(html).toContain('data-sourcepos="7:7"');
    expect(html).toContain('canopy-markdown-math-loading');
  });
});

describe('Mermaid fence dispatch', () => {
  it('recognizes Mermaid without math and preserves source-position anchors', () => {
    const source =
      '# Plan\n\n```mermaid\nflowchart LR\nA-->B\n```\n\nNext paragraph.';
    const html = renderToStaticMarkup(
      <SourcePositionMarkdown>{source}</SourcePositionMarkdown>,
    );
    expect(html).toContain('data-testid="markdown-mermaid"');
    expect(html).toContain('data-sourcepos="3:6"');
    expect(html).toContain('data-sourcepos="8:8"');
    expect(html).toContain('flowchart LR');
  });

  it.each(['mermaid', 'Mermaid', 'MERMAID'])(
    'recognizes %s but keeps code examples literal',
    (lang) => {
      const html = renderToStaticMarkup(
        <Markdown>{`~~~${lang}\nflowchart LR\nA-->B\n~~~\n\n\`mermaid\`\n\n\`\`\`text\nflowchart LR\n\`\`\``}</Markdown>,
      );
      expect(html.match(/data-testid="markdown-mermaid"/g)).toHaveLength(1);
      expect(html).toContain('lang-text');
    },
  );
});

describe('compact numeric table cells', () => {
  it.each(['1.5.5', '1,2,3'])(
    'allows malformed numeric token %s to wrap',
    (text) => {
      expect(markdownTableCellProps(text)['data-compact']).toBeUndefined();
    },
  );
  it.each(['12345', '-12.5%', '1,234.5', '1.234,5', '1,5'])(
    'keeps short number %s compact',
    (text) => {
      expect(markdownTableCellProps(text)['data-compact']).toBe(true);
    },
  );
});

it('memoizes identical props and reparses changed children or options', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const renderRule = jest.fn((next: () => ReactNode) => next());
  const options = { renderRule };
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() =>
    root.render(<Markdown options={options}>same **answer**</Markdown>),
  );
  const calls = renderRule.mock.calls.length;
  expect(calls).toBeGreaterThan(0);
  act(() =>
    root.render(<Markdown options={options}>same **answer**</Markdown>),
  );
  expect(renderRule).toHaveBeenCalledTimes(calls);
  act(() =>
    root.render(<Markdown options={options}>changed **answer**</Markdown>),
  );
  expect(renderRule.mock.calls.length).toBeGreaterThan(calls);
  const updatedRule = jest.fn((next: () => ReactNode) => next());
  act(() =>
    root.render(
      <Markdown options={{ renderRule: updatedRule }}>
        changed **answer**
      </Markdown>,
    ),
  );
  expect(updatedRule).toHaveBeenCalled();
  act(() => root.unmount());
});

it('exports markdownOptions through a server-safe entry point', () => {
  expect(markdownOptions).toBe(serverMarkdownOptions);
  expect(markdownOptions().disableParsingRawHTML).toBe(true);
});
