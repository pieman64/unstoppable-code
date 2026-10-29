import { renderToStaticMarkup } from 'react-dom/server';
import { AnsiOutput } from '../AnsiOutput';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';

const LINES = ['> npm run build', 'done'];

function rootClasses(markup: string): string[] {
  const match =
    /<div[^>]*data-testid="ansi-output(?:-empty)?"[^>]*class="([^"]*)"/.exec(
      markup,
    );
  return (match?.[1] ?? '').split(/\s+/).filter(Boolean);
}

describe('AnsiOutput surface', () => {
  it('owns the log panel surface: one fill, mono type, and its own scrolling', () => {
    const classes = rootClasses(
      renderToStaticMarkup(<AnsiOutput lines={LINES} />),
    );

    expect(classes).toEqual(
      expect.arrayContaining([
        'overflow-auto',
        'bg-secondary',
        'font-mono',
        'fg-secondary',
      ]),
    );
    // The code-block surface has no outline.
    expect(classes.some((name) => name.startsWith('border'))).toBe(false);
  });

  it('defaults to the standalone panel', () => {
    const classes = rootClasses(
      renderToStaticMarkup(<AnsiOutput lines={LINES} />),
    );

    expect(classes).toEqual(
      expect.arrayContaining(['rounded-md', 'p-3', 'text-2xs', 'leading-5']),
    );
  });

  it('nests the live tail inside a card: the card radius minus its inset', () => {
    const markup = renderToStaticMarkup(
      <AnsiOutput lines={LINES} variant="tail" maxRenderLines={12} />,
    );
    const classes = rootClasses(markup);

    expect(classes).toEqual(
      expect.arrayContaining(['rounded-sm', 'p-3', 'text-2xs']),
    );
    expect(classes).not.toContain('rounded-md');
    expect(classes).not.toContain('leading-5');
    // Sized to show exactly the tail it renders: 12 lines at the 2xs line
    // height plus the panel's own vertical padding.
    expect(markup).toContain('max-height:calc(12 * 0.75rem + 1.5rem)');
  });

  it('runs the reader edge to edge, aligned to the dialog column', () => {
    const classes = rootClasses(
      renderToStaticMarkup(<AnsiOutput lines={LINES} variant="reader" />),
    );

    expect(classes).toEqual(
      expect.arrayContaining(['px-5', 'py-4', 'text-xs']),
    );
    expect(classes.some((name) => name.startsWith('rounded'))).toBe(false);
  });

  it('keeps caller classes for placement and height', () => {
    const classes = rootClasses(
      renderToStaticMarkup(
        <AnsiOutput lines={LINES} className="min-h-0 flex-1" />,
      ),
    );

    expect(classes).toEqual(expect.arrayContaining(['min-h-0', 'flex-1']));
  });

  it('renders nothing without lines, unless a placeholder is given', () => {
    expect(renderToStaticMarkup(<AnsiOutput lines={[]} />)).toBe('');

    const markup = renderToStaticMarkup(
      <AnsiOutput lines={[]} variant="reader" placeholder="No output yet" />,
    );
    expect(markup).toContain('No output yet');
    expect(rootClasses(markup)).toEqual(
      expect.arrayContaining(['bg-secondary', 'px-5', 'py-4']),
    );
  });

  it('blocks the log lines from session replay in every variant', () => {
    for (const variant of ['panel', 'tail', 'reader'] as const) {
      const classes = rootClasses(
        renderToStaticMarkup(<AnsiOutput lines={LINES} variant={variant} />),
      );
      expect(classes).toContain(REPLAY_BLOCK_CLASS);
    }
  });

  it('leaves the static empty-state placeholder unblocked', () => {
    const classes = rootClasses(
      renderToStaticMarkup(
        <AnsiOutput lines={[]} placeholder="No output yet" />,
      ),
    );
    expect(classes).not.toContain(REPLAY_BLOCK_CLASS);
  });
});
