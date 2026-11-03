import { renderToStaticMarkup } from 'react-dom/server';
import { Check } from '../../icons/AppIcons';
import { formatBadgeCount } from '../../lib/badge';
import { Badge, Count, Dot } from '../Badge';

// Spelled out rather than imported so a change to the geometry fails here
// instead of silently agreeing with itself.
const BADGE_GEOMETRY =
  'inline-flex h-4.5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-1.75 text-2xs font-medium leading-none';

describe('Badge', () => {
  it('renders one 18px capsule with the neutral tone by default', () => {
    expect(renderToStaticMarkup(<Badge>Owner</Badge>)).toBe(
      `<span data-badge-tone="neutral" class="${BADGE_GEOMETRY} bg-muted fg-secondary">Owner</span>`,
    );
  });

  it.each([
    ['info', 'bg-info-subtle fg-info'],
    ['success', 'bg-success-subtle fg-success-strong'],
    ['warning', 'bg-warning-subtle fg-warning-strong'],
    ['danger', 'bg-destructive-subtle fg-destructive-strong'],
    ['special', 'bg-special-subtle fg-special-strong'],
  ] as const)(
    'paints the %s tone with a -subtle fill and strong ink',
    (tone, cls) => {
      const html = renderToStaticMarkup(<Badge tone={tone}>State</Badge>);
      expect(html).toContain(`class="${BADGE_GEOMETRY} ${cls}"`);
    },
  );

  it('never uses a border, ring, accent, uppercase or semibold', () => {
    const tones = [
      'neutral',
      'info',
      'success',
      'warning',
      'danger',
      'special',
    ] as const;
    for (const tone of tones) {
      const html = renderToStaticMarkup(<Badge tone={tone}>State</Badge>);
      expect(html).not.toMatch(
        /\b(border|ring-|accent|uppercase|font-semibold|font-bold)/,
      );
    }
  });

  it('draws a leading glyph at 12px', () => {
    const html = renderToStaticMarkup(
      <Badge tone="success" icon={Check}>
        Checks passed
      </Badge>,
    );
    expect(html).toMatch(/<svg[^>]*class="size-3 shrink-0"/);
    expect(html).toMatch(/<svg[^>]*width="12px"/);
    expect(html.indexOf('<svg')).toBeLessThan(html.indexOf('Checks passed'));
  });

  it('draws a 16px square tag at the compact size, for dense views', () => {
    expect(
      renderToStaticMarkup(
        <Badge size="compact" tone="success">
          added
        </Badge>,
      ),
    ).toBe(
      '<span data-badge-tone="success" data-badge-size="compact" class="inline-flex h-4 shrink-0 items-center gap-0.5 whitespace-nowrap rounded-sm px-1 text-3xs font-medium leading-none bg-success-subtle fg-success-strong">added</span>',
    );
  });

  it('draws a compact leading glyph at 10px', () => {
    const html = renderToStaticMarkup(
      <Badge size="compact" icon={Check}>
        PK
      </Badge>,
    );
    expect(html).toMatch(/<svg[^>]*class="size-2.5 shrink-0"/);
    expect(html).toMatch(/<svg[^>]*width="10px"/);
  });

  it('appends placement classes after the tone', () => {
    expect(
      renderToStaticMarkup(<Badge className="ml-auto">Pro</Badge>),
    ).toContain('bg-muted fg-secondary ml-auto"');
  });
});

describe('formatBadgeCount', () => {
  it.each([
    [0, '0'],
    [7, '7'],
    [99, '99'],
    [100, '99+'],
    [1234, '99+'],
    [-3, '0'],
    [Number.NaN, '0'],
    [4.9, '4'],
  ])('formats %p as %p', (value, text) => {
    expect(formatBadgeCount(value)).toBe(text);
  });
});

describe('Count', () => {
  it('next to a label renders the real number as plain proportional text', () => {
    expect(renderToStaticMarkup(<Count value={768} />)).toBe(
      '<span class="fg-quaternary">768</span>',
    );
  });

  it('on an icon caps at 99+ in a 16px capsule', () => {
    const html = renderToStaticMarkup(<Count value={240} placement="icon" />);
    expect(html).toContain('>99+<');
    expect(html).toContain('h-4 min-w-4');
    expect(html).toContain('tabular-nums');
    expect(html).toContain('data-count-tone="neutral"');
  });

  it('paints unread blue and waiting-on-you orange, never the accent', () => {
    const unread = renderToStaticMarkup(
      <Count value={4} placement="icon" tone="unread" />,
    );
    const attention = renderToStaticMarkup(
      <Count value={2} placement="icon" tone="attention" />,
    );
    expect(unread).toContain('bg-fg-info fg-emphasis');
    expect(attention).toContain('bg-fg-warning fg-emphasis');
    expect(`${unread}${attention}`).not.toContain('accent');
  });
});

describe('Dot', () => {
  it.each([
    ['unread', 'bg-fg-info'],
    ['attention', 'bg-fg-warning'],
    ['filter', 'bg-fg-quaternary'],
    ['success', 'bg-fg-success-strong'],
    ['danger', 'bg-fg-destructive-strong'],
  ] as const)('draws a 6px %s dot', (tone, cls) => {
    expect(renderToStaticMarkup(<Dot tone={tone} />)).toBe(
      `<span aria-hidden="true" data-dot-tone="${tone}" class="inline-block size-1.5 shrink-0 rounded-full ${cls}"></span>`,
    );
  });
});

describe('Dot with a label', () => {
  it('is an image with an accessible name instead of decoration', () => {
    expect(
      renderToStaticMarkup(<Dot tone="unread" label="Unread work in group" />),
    ).toBe(
      '<span role="img" aria-label="Unread work in group" data-dot-tone="unread" class="inline-block size-1.5 shrink-0 rounded-full bg-fg-info"></span>',
    );
  });
});

describe('Count beside a label with a value that is not a number', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'shows 0 for %p, like the icon placement',
    (value) => {
      expect(renderToStaticMarkup(<Count value={value} />)).toMatch(/>0</);
    },
  );
});
