/** @jest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { coworkProjectMenuItems } from '../cowork-project-menu-items';

describe('coworkProjectMenuItems', () => {
  const build = (
    overrides: Partial<Parameters<typeof coworkProjectMenuItems>[0]> = {},
  ): ReturnType<typeof coworkProjectMenuItems> =>
    coworkProjectMenuItems({
      pinned: false,
      onTogglePin: jest.fn(),
      onOpenSettings: jest.fn(),
      onShareTemplate: jest.fn(),
      onImportSession: jest.fn(),
      ...overrides,
    });

  it('leads with Pin and gives every command row its own icon', () => {
    const items = build({ onMoveToOrganization: jest.fn() });
    expect(items.map((item) => [item.label, item.testId])).toEqual([
      ['Pin to top', 'workspace-toggle-pin-menu-item'],
      ['Project settings', 'workspace-settings-menu-item'],
      ['Share template', 'workspace-share-template-menu-item'],
      ['Import session…', 'workspace-import-session-menu-item'],
      ['Move to org…', 'workspace-move-to-organization-menu-item'],
    ]);
    const glyphs = items.map((item) => renderToStaticMarkup(<>{item.icon}</>));
    for (const glyph of glyphs) expect(glyph).toContain('<svg');
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it('offers Unpin on a pinned project and passes the next pin state', () => {
    const onTogglePin = jest.fn();
    const pin = build({ pinned: true, onTogglePin })[0];
    expect(pin?.label).toBe('Unpin');
    pin?.onSelect?.();
    expect(onTogglePin).toHaveBeenCalledWith(false);
  });

  it('omits Move to org when the host cannot move the project', () => {
    expect(build().map((item) => item.key)).not.toContain(
      'move-to-organization',
    );
  });
});
