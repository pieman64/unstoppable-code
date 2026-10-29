import { renderToString } from 'react-dom/server';
import { SettingsIcon } from '../../icons/AppIcons';
import { RailIconButton } from '../RailIconButton';

describe('RailIconButton', () => {
  it('standardizes compact rail actions and item-hover reveal', () => {
    const html = renderToString(
      <RailIconButton
        icon={SettingsIcon}
        aria-label="Settings"
        revealOnItemHover
      />,
    );

    expect(html).toContain('h-6 w-6');
    expect(html).toContain('border-0');
    expect(html).toContain('bg-transparent');
    expect(html).toContain('fg-tertiary');
    expect(html).not.toContain('hover:bg-');
    expect(html).toContain('hover:fg-primary');
    expect(html).toContain('h-6 w-6');
    expect(html).toContain('opacity-0');
    expect(html).toContain('pointer-events-none');
    expect(html).toContain('group-hover/sidebar-item:opacity-100');
    expect(html).toContain('group-focus-within/sidebar-item:opacity-100');
    expect(html).toContain('focus-within:opacity-100');
    expect(html).toContain('pointer-coarse:opacity-100');
    expect(html.match(/group-hover\/sidebar-item:opacity-100/g)).toHaveLength(
      2,
    );
    expect(html).toContain('aria-label="Settings"');
    expect(html).toContain('relative inline-flex shrink-0');
    expect(html).toContain('width:14px;height:14px');
    expect(html).toContain('data-glyph="settings"');
  });

  it('preserves a square 44px coarse-pointer target', () => {
    const html = renderToString(
      <RailIconButton
        icon={SettingsIcon}
        aria-label="Settings"
        coarsePointerTarget
      />,
    );

    expect(html).toContain('pointer-coarse:min-h-11');
    expect(html).toContain('pointer-coarse:min-w-11');
  });

  it('supports opting into a tone-specific hover surface', () => {
    const html = renderToString(
      <RailIconButton icon={SettingsIcon} aria-label="Settings" hoverSurface />,
    );

    expect(html).toContain('bg-transparent');
    expect(html).toContain('hover:fg-primary');
    expect(html).toContain('hover:bg-subtle');
  });

  it('keeps a 44px touch target on every pointer for a header laid out for touch', () => {
    const touch = renderToString(
      <RailIconButton
        icon={SettingsIcon}
        aria-label="Collapse"
        coarsePointerTarget
        touchTarget
      />,
    );
    const plain = renderToString(
      <RailIconButton
        icon={SettingsIcon}
        aria-label="Collapse"
        coarsePointerTarget
      />,
    );

    // Token match: `pointer-coarse:min-h-11` also contains the substring.
    const buttonTokens = (html: string): string[] =>
      (/<button[^>]*class="([^"]*)"/.exec(html)?.[1] ?? '').split(/\s+/);
    expect(buttonTokens(touch)).toContain('min-h-11');
    expect(buttonTokens(touch)).toContain('pointer-coarse:min-h-11');
    expect(buttonTokens(plain)).not.toContain('min-h-11');
    expect(buttonTokens(plain)).toContain('pointer-coarse:min-h-11');
  });

  it('keeps a secondary-toned action in its ink while only the surface responds', () => {
    const surfaced = renderToString(
      <RailIconButton
        icon={SettingsIcon}
        aria-label="Settings"
        tone="secondary"
        hoverSurface
      />,
    );
    const quiet = renderToString(
      <RailIconButton
        icon={SettingsIcon}
        aria-label="Settings"
        tone="secondary"
      />,
    );

    expect(surfaced).toContain('fg-secondary');
    expect(surfaced).toContain('hover:bg-subtle');
    expect(surfaced).not.toContain('hover:fg-primary');
    expect(surfaced).not.toContain('fg-tertiary');
    expect(quiet).toContain('fg-secondary');
    expect(quiet).not.toContain('hover:fg-primary');
    expect(quiet).not.toContain('hover:bg-');
  });
});
