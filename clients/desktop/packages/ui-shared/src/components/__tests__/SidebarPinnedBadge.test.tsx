/**
 * Server-rendered tests for {@link SidebarPinnedBadge}, the pin mark a pinned
 * project, worktree, or Work Entry carries at the trailing edge of its row.
 */
import { renderToString } from 'react-dom/server';
import { SidebarPinnedBadge } from '../SidebarPinnedBadge';

describe('SidebarPinnedBadge', () => {
  it('names the state for assistive technology', () => {
    const html = renderToString(<SidebarPinnedBadge testId="pin" />);

    expect(html).toContain('data-testid="pin"');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Pinned"');
    expect(html).toContain('fg-quaternary');
  });

  it('fades and goes inert while its row reveals hover actions', () => {
    const html = renderToString(<SidebarPinnedBadge testId="pin" />);

    expect(html).toContain('pointer-events-none');
    expect(html).toContain('pointer-fine:group-hover/sidebar-item:opacity-0');
    expect(html).toContain(
      'pointer-fine:group-focus-within/sidebar-item:opacity-0',
    );
  });

  it('lets a host replace the fade with its own visibility rule', () => {
    const html = renderToString(
      <SidebarPinnedBadge
        testId="pin"
        fadeOnRowHover={false}
        className="group-hover/sidebar-item:hidden"
      />,
    );

    expect(html).not.toContain('opacity-0');
    expect(html).toContain('group-hover/sidebar-item:hidden');
  });
});
