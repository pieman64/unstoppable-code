import { renderToStaticMarkup } from 'react-dom/server';
import {
  DropdownMenuItem,
  DropdownMenuItemIcon,
  DropdownMenuLabel,
  DropdownMenuSurface,
} from '../DropdownMenu';

function classTokens(html: string): string[] {
  return (/class="([^"]*)"/.exec(html)?.[1] ?? '').split(/\s+/);
}

describe('DropdownMenuSurface padding', () => {
  it('keeps the 4px row inset by default', () => {
    expect(classTokens(renderToStaticMarkup(<DropdownMenuSurface />))).toEqual(
      expect.arrayContaining(['p-1']),
    );
  });

  it('insets grouped controls by 8px and dialog content by 16px', () => {
    const controls = classTokens(
      renderToStaticMarkup(<DropdownMenuSurface padding="controls" />),
    );
    const content = classTokens(
      renderToStaticMarkup(<DropdownMenuSurface padding="content" />),
    );

    expect(controls).toContain('p-2');
    expect(controls).not.toContain('p-1');
    expect(content).toContain('p-4');
    expect(content).not.toContain('p-1');
  });
});

describe('DropdownMenuSurface shell', () => {
  it('takes the picker anatomy only when asked', () => {
    const picker = classTokens(
      renderToStaticMarkup(<DropdownMenuSurface shell="picker" />),
    );
    const plain = classTokens(renderToStaticMarkup(<DropdownMenuSurface />));

    expect(picker).toContain('canopy-picker-menu');
    expect(picker).toContain('bg-quaternary');
    expect(plain).not.toContain('canopy-picker-menu');
  });
});

describe('DropdownMenuItem multiline and status', () => {
  it('releases the fixed row height for a label with a subtitle', () => {
    const single = classTokens(
      renderToStaticMarkup(<DropdownMenuItem>Ask</DropdownMenuItem>),
    );
    const multiline = classTokens(
      renderToStaticMarkup(<DropdownMenuItem multiline>Ask</DropdownMenuItem>),
    );

    expect(single).toContain('h-8');
    expect(single).toContain('gap-2');
    // The same 8px between the icon rail and the text as the shared row, and
    // vertical padding in place of the fixed height.
    expect(multiline).not.toContain('h-8');
    expect(multiline).toContain('gap-2');
    expect(multiline).toContain('py-2');
  });

  it('raises a row to the 44px touch floor only when asked', () => {
    const plain = classTokens(
      renderToStaticMarkup(<DropdownMenuItem>Ask</DropdownMenuItem>),
    );
    const touch = classTokens(
      renderToStaticMarkup(
        <DropdownMenuItem touchTarget>Ask</DropdownMenuItem>,
      ),
    );

    expect(plain).not.toContain('min-h-11');
    // A minimum beside the fixed height, not a replacement for it.
    expect(touch).toContain('min-h-11');
    expect(touch).toContain('h-8');
  });

  it('tints an active or unread row with the operational status and keeps the default tone', () => {
    const active = classTokens(
      renderToStaticMarkup(
        <DropdownMenuItem status="active">App Advisor</DropdownMenuItem>,
      ),
    );
    const unread = classTokens(
      renderToStaticMarkup(
        <DropdownMenuItem status="unread">App Advisor</DropdownMenuItem>,
      ),
    );
    const plain = classTokens(
      renderToStaticMarkup(<DropdownMenuItem>App Advisor</DropdownMenuItem>),
    );

    expect(active).toContain('bg-info-subtle');
    expect(active).toContain('fg-primary');
    expect(active).toContain('enabled:hover:bg-subtle');
    expect(unread).toContain('bg-info-subtle');
    expect(plain).not.toContain('bg-info-subtle');
    expect(plain).not.toContain('bg-info-subtle');
  });
});

describe('DropdownMenuItemIcon tone', () => {
  it('inherits the row ink by default', () => {
    const tokens = classTokens(
      renderToStaticMarkup(<DropdownMenuItemIcon>glyph</DropdownMenuItemIcon>),
    );

    expect(tokens).toContain('h-4');
    expect(tokens).not.toContain('fg-secondary');
    expect(tokens).not.toContain('fg-accent');
  });

  it('quiets a catalog glyph and marks the row holding the selection', () => {
    const secondary = classTokens(
      renderToStaticMarkup(
        <DropdownMenuItemIcon tone="secondary">glyph</DropdownMenuItemIcon>,
      ),
    );
    const accent = classTokens(
      renderToStaticMarkup(
        <DropdownMenuItemIcon tone="accent">glyph</DropdownMenuItemIcon>,
      ),
    );

    expect(secondary).toContain('fg-secondary');
    expect(secondary).not.toContain('fg-accent');
    expect(accent).toContain('fg-accent');
    expect(accent).not.toContain('fg-secondary');
  });
});

describe('DropdownMenuLabel typography and spacing', () => {
  it('sets a command or path label in the mono face', () => {
    const mono = classTokens(
      renderToStaticMarkup(
        <DropdownMenuLabel mono>npm test</DropdownMenuLabel>,
      ),
    );
    const plain = classTokens(
      renderToStaticMarkup(<DropdownMenuLabel>Actions</DropdownMenuLabel>),
    );

    expect(mono).toContain('font-mono');
    expect(plain).not.toContain('font-mono');
  });

  it('relaxes the vertical inset for an identity block', () => {
    const relaxed = classTokens(
      renderToStaticMarkup(
        <DropdownMenuLabel spacing="relaxed">Jane</DropdownMenuLabel>,
      ),
    );
    const plain = classTokens(
      renderToStaticMarkup(<DropdownMenuLabel>Actions</DropdownMenuLabel>),
    );

    expect(relaxed).toContain('py-2');
    expect(relaxed).not.toContain('py-1');
    expect(relaxed).toContain('px-2');
    expect(plain).toContain('py-1');
  });
});

describe('DropdownMenuItem operational tones', () => {
  it.each([
    ['status-success', 'fg-success-strong'],
    ['status-active', 'fg-info'],
    ['status-failed', 'fg-destructive-strong'],
  ] as const)(
    'inks a %s row with the operational status and keeps the default hover',
    (tone, ink) => {
      const tokens = classTokens(
        renderToStaticMarkup(
          <DropdownMenuItem tone={tone}>Remote Control</DropdownMenuItem>,
        ),
      );

      expect(tokens).toContain(ink);
      // The operational ink replaces the default ink rather than competing
      // with it: `fg-status-*` only ever won over `fg-primary` by stylesheet
      // order.
      expect(tokens).not.toContain('fg-primary');
      expect(tokens).toContain('enabled:hover:bg-subtle');
      expect(tokens).not.toContain('bg-success-subtle');
    },
  );

  it('lets selected outrank an operational tone, as it does every tone', () => {
    const tokens = classTokens(
      renderToStaticMarkup(
        <DropdownMenuItem tone="status-success" selected>
          Remote Control
        </DropdownMenuItem>,
      ),
    );

    expect(tokens).toContain('bg-muted');
    expect(tokens).toContain('fg-primary');
    expect(tokens).not.toContain('fg-success-strong');
  });
});

describe('DropdownMenuItem alert', () => {
  it('inks a warning row amber and keeps the default hover surface', () => {
    const tokens = classTokens(
      renderToStaticMarkup(
        <DropdownMenuItem alert="warning">Usage</DropdownMenuItem>,
      ),
    );

    expect(tokens).toContain('fg-warning');
    expect(tokens).not.toContain('fg-primary');
    expect(tokens).toContain('enabled:hover:bg-subtle');
  });

  it('inks a critical row red without the destructive-action hover', () => {
    const tokens = classTokens(
      renderToStaticMarkup(
        <DropdownMenuItem alert="critical">Usage</DropdownMenuItem>,
      ),
    );

    // `fg-destructive` sorts before `fg-primary` in the stylesheet, so as an
    // appended class it never painted; the alert has to replace the ink.
    expect(tokens).toContain('fg-destructive');
    expect(tokens).not.toContain('fg-primary');
    expect(tokens).toContain('enabled:hover:bg-subtle');
    expect(tokens).not.toContain('enabled:hover:bg-destructive-subtle');
  });

  it('keeps the alert ink on a selected row over the muted surface', () => {
    const tokens = classTokens(
      renderToStaticMarkup(
        <DropdownMenuItem alert="warning" selected>
          Usage
        </DropdownMenuItem>,
      ),
    );

    expect(tokens).toContain('bg-muted');
    expect(tokens).toContain('enabled:hover:bg-muted');
    expect(tokens).toContain('fg-warning');
    expect(tokens).not.toContain('fg-primary');
  });

  it('leaves a row without an alert on the default ink', () => {
    const tokens = classTokens(
      renderToStaticMarkup(<DropdownMenuItem>Usage</DropdownMenuItem>),
    );

    expect(tokens).toContain('fg-primary');
    expect(tokens).not.toContain('fg-warning');
    expect(tokens).not.toContain('fg-destructive');
  });
});

describe('DropdownMenuItemIcon tone', () => {
  it.each([
    ['success', 'fg-success'],
    ['info', 'fg-blue'],
    ['destructive', 'fg-destructive'],
  ] as const)('inks a %s glyph independently of its row', (tone, ink) => {
    const tokens = classTokens(
      renderToStaticMarkup(<DropdownMenuItemIcon tone={tone} />),
    );

    expect(tokens).toContain(ink);
    // The fixed 16px slot is unchanged.
    expect(tokens).toContain('h-4');
    expect(tokens).toContain('w-4');
  });

  it('inherits the row ink by default', () => {
    const tokens = classTokens(renderToStaticMarkup(<DropdownMenuItemIcon />));

    expect(tokens).not.toContain('fg-success');
    expect(tokens).not.toContain('fg-blue');
    expect(tokens).not.toContain('fg-destructive');
  });
});
