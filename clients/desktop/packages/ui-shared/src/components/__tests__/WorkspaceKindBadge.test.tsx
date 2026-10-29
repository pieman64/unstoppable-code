/**
 * @jest-environment jsdom
 */
/** Workspace identities keep their glyph paint inherited from their container. */
import { renderToString } from 'react-dom/server';
import { WorkspaceKindBadge, type WorkspaceKind } from '../WorkspaceKindBadge';

const KINDS: readonly WorkspaceKind[] = ['single-repo', 'multi-repo', 'cowork'];

function renderBadge(
  element: Parameters<typeof renderToString>[0],
): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderToString(element);
  return host;
}

function paintedValues(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll('svg, svg *')).flatMap((path) =>
    ['fill', 'stroke']
      .map((attribute) => path.getAttribute(attribute))
      .filter((value): value is string => value !== null && value !== 'none'),
  );
}

describe('WorkspaceKindBadge', () => {
  it.each(['single-repo', 'cowork'] as const)(
    'renders the %s identity as a compact filled folder inside its colored badge',
    (kind) => {
      const host = renderBadge(
        <WorkspaceKindBadge kind={kind} color="#38bdf8" />,
      );
      expect(host.querySelector('svg')?.getAttribute('data-glyph')).toBe(
        'folder-fill1',
      );
      expect(host.querySelector('svg')?.getAttribute('width')).toBe('14px');
      expect(host.querySelector('svg')?.getAttribute('fill')).toBe(
        'currentColor',
      );
      expect(
        host
          .querySelector('[data-testid="workspace-kind-badge"]')
          ?.getAttribute('style'),
      ).toContain('background-color:var(--categorical-6)');
      expect(host.innerHTML).toContain('text-white');
      expect(host.querySelector('svg')?.parentElement?.style.transform).toBe(
        'scale(0.75)',
      );
    },
  );
  it.each(KINDS)('paints the %s glyph with currentColor only', (kind) => {
    const host = renderBadge(<WorkspaceKindBadge kind={kind} />);

    const painted = paintedValues(host);
    expect(painted.length).toBeGreaterThan(0);
    expect(painted.every((value) => value === 'currentColor')).toBe(true);
    expect(host.innerHTML).not.toContain('"white"');
  });

  it.each(KINDS)(
    'supplies white to the %s glyph on the solid badge background',
    (kind) => {
      const host = renderBadge(<WorkspaceKindBadge kind={kind} />);

      const glyphHost = host.querySelector('svg')?.parentElement;
      expect(glyphHost?.className).toContain('text-white');
      expect(glyphHost?.className).not.toContain('fg-primary');
    },
  );

  it('keeps every kind on the canonical badge footprint and background', () => {
    for (const kind of KINDS) {
      const host = renderBadge(
        <WorkspaceKindBadge kind={kind} color="#38bdf8" />,
      );
      const badge = host.querySelector('[data-testid="workspace-kind-badge"]');

      expect(badge?.getAttribute('data-kind')).toBe(kind);
      expect(badge?.className).toContain(
        'rounded-[calc(var(--radius-md)-3px)]',
      );
      expect(badge?.getAttribute('style')).toContain(
        'background-color:var(--categorical-6)',
      );
    }
  });

  it('renders the temporary variant as a dashed neutral badge', () => {
    const host = renderBadge(
      <WorkspaceKindBadge kind="multi-repo" temporary color="#38bdf8" />,
    );

    const badge = host.querySelector('[data-testid="workspace-kind-badge"]');
    const style = badge?.getAttribute('style') ?? '';
    expect(style).toContain('background-color:transparent');
    expect(style).toContain('dashed');
    expect(style).toContain('var(--fg-quaternary)');
  });

  it('keeps the temporary glyph on fg-primary rather than white', () => {
    // The temporary badge has no colored background to sit on — white there
    // would be the same invisible-in-light-mode bug this change removes.
    const host = renderBadge(
      <WorkspaceKindBadge kind="multi-repo" temporary />,
    );

    const glyphHost = host.querySelector('svg')?.parentElement;
    expect(glyphHost?.className).toContain('fg-primary');
    expect(glyphHost?.className).not.toContain('text-white');
    expect(paintedValues(host).every((value) => value === 'currentColor')).toBe(
      true,
    );
  });

  it('shrinks only the temporary glyph for dense chips', () => {
    const small = renderBadge(
      <WorkspaceKindBadge kind="multi-repo" temporary size="sm" />,
    );
    const medium = renderBadge(
      <WorkspaceKindBadge kind="multi-repo" temporary size="md" />,
    );

    expect(small.querySelector('svg')?.getAttribute('class')).toContain(
      'h-2.5',
    );
    expect(medium.querySelector('svg')?.getAttribute('class')).toContain('h-3');
  });
});
