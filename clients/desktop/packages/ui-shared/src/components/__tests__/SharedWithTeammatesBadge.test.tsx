/**
 * Server-rendered tests for {@link SharedWithTeammatesBadge}.
 *
 * The interesting axis is `fadeOnRowHover`: it is the classic-sidebar path
 * where the badge shares pixels with the row's revealed hover actions, so the
 * glyph is made inert and its tooltip is skipped rather than mounted-and-
 * blocked. The accessible name has to survive that, and so does the host's
 * layout class — `RichHoverTooltip`'s disabled branch drops the wrapper that
 * would otherwise have carried it.
 */
import { renderToString } from 'react-dom/server';
import { SharedWithTeammatesBadge } from '../SharedWithTeammatesBadge';

describe('SharedWithTeammatesBadge', () => {
  describe('without the row-hover fade', () => {
    it('mounts a real tooltip around the glyph', () => {
      const html = renderToString(<SharedWithTeammatesBadge />);

      expect(html).toContain('data-testid="worktree-row-shared-badge"');
      // RichHoverTooltip's trigger wrapper. Its presence is what proves the
      // tooltip is live rather than short-circuited by `disabled`.
      expect(html).toContain('relative inline-flex');
      expect(html).toContain('Shared with teammates');
      // Nothing is revealed over this badge, so it must stay clickable.
      expect(html).not.toContain('pointer-events-none');
    });

    it('puts the host layout class on the tooltip wrapper', () => {
      const html = renderToString(
        <SharedWithTeammatesBadge className="pointer-coarse:mr-11.5" />,
      );

      expect(html).toContain('pointer-coarse:mr-11.5');
    });
  });

  describe('with the row-hover fade', () => {
    it('keeps the accessible name without mounting a tooltip', () => {
      const html = renderToString(<SharedWithTeammatesBadge fadeOnRowHover />);

      expect(html).toContain('data-testid="worktree-row-shared-badge"');
      // The name lives on the glyph, so it survives the tooltip being skipped.
      expect(html).toContain('aria-label="Shared with teammates"');
      // The tooltip would be unreachable anyway — the glyph fades on the very
      // `group-hover` that would open it — so it is not mounted at all rather
      // than mounted and blocked, which would cost a `useId`, state, refs and
      // a `cloneElement` on every shared row in the sidebar.
      expect(html).not.toContain('relative inline-flex');
    });

    it('is inert so it cannot swallow clicks aimed at the revealed actions', () => {
      const html = renderToString(<SharedWithTeammatesBadge fadeOnRowHover />);

      expect(html).toContain('pointer-events-none');
      expect(html).toContain('pointer-fine:group-hover/sidebar-item:opacity-0');
    });

    it('still applies the host layout class once the wrapper is gone', () => {
      // Regression guard: the disabled branch returns the child bare, so a
      // class routed through the wrapper would silently vanish — taking the
      // host's coarse-pointer action reserve with it.
      const html = renderToString(
        <SharedWithTeammatesBadge
          fadeOnRowHover
          className="pointer-coarse:mr-11.5"
        />,
      );

      expect(html).toContain('pointer-coarse:mr-11.5');
    });
  });

  it('suffixes its automation id for mounted row copies', () => {
    const html = renderToString(
      <SharedWithTeammatesBadge fadeOnRowHover testIdSuffix="-pin-top" />,
    );

    expect(html).toContain('worktree-row-shared-badge-pin-top');
  });
});
