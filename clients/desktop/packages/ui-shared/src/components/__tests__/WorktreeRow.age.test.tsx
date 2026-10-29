/**
 * The last-activity age on a sidebar worktree row: on the right of the title
 * line while the row is idle, giving the spot to any live status and to the
 * hover actions.
 */
import { renderToString } from 'react-dom/server';
import { WorktreeRow, type WorktreeRowProps } from '../WorktreeRow';

const HOUR = 3_600_000;

function render(props: Partial<WorktreeRowProps> = {}): string {
  return renderToString(
    <WorktreeRow
      branchLabel="feature/age"
      branchName="feature/age"
      uiStatus="idle"
      textScale="sidebar"
      {...props}
    />,
  );
}

function ageSpan(html: string): string | null {
  const match =
    /<span[^>]*data-testid="worktree-row-age"[^>]*>([^<]*)<\/span>/.exec(html);
  return match ? match[0] : null;
}

describe('WorktreeRow last-activity age', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: Date.UTC(2026, 9, 6, 12, 0, 0) });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows the compact age of the last activity on an idle row', () => {
    expect(
      ageSpan(render({ lastActivityAt: Date.now() - 5 * HOUR })),
    ).toContain('>5h<');
  });

  it('shows nothing without a last-activity time', () => {
    expect(ageSpan(render())).toBeNull();
  });

  it('gives the spot to a live status', () => {
    const at = Date.now() - HOUR;
    expect(
      ageSpan(render({ lastActivityAt: at, isStreaming: true })),
    ).toBeNull();
    expect(ageSpan(render({ lastActivityAt: at, hasUnread: true }))).toBeNull();
    expect(
      ageSpan(render({ lastActivityAt: at, setupPhase: 'running-setup' })),
    ).toBeNull();
  });

  it('hides while the hover actions take its place', () => {
    const html = render({
      lastActivityAt: Date.now() - HOUR,
      actionChipSlot: <span />,
    });
    // The age leaves with its trailing group (pin, merged, age).
    const group =
      /<span[^>]*data-testid="worktree-row-trailing-meta"[^>]*>/.exec(
        html,
      )?.[0];
    expect(group).toContain('group-hover/sidebar-item:hidden');
    expect(ageSpan(html)).not.toBeNull();
  });

  it('suffixes its automation id on pinned copies', () => {
    const html = render({
      lastActivityAt: Date.now() - HOUR,
      testIdSuffix: '-pin-top',
    });
    expect(html).toContain('data-testid="worktree-row-age-pin-top"');
  });

  it('keeps the pin beside a one-button-wide age, under the hover Pin', () => {
    const html = render({
      statusModel: 'focused',
      pinnedToTop: true,
      lastKnownPrStatus: { state: 'merged' },
      uiStatus: 'done',
      runtimeState: 'done',
      lastActivityAt: Date.now() - HOUR,
    });
    // The age cell is one 24px hover button wide, so Archive takes its spot.
    expect(ageSpan(html)).toContain('w-6');
    // Pin sits last before the age, so the hover Pin button lands on it.
    const merged = html.indexOf('data-testid="worktree-row-merged"');
    const pin = html.indexOf('data-testid="worktree-row-pinned"');
    const age = html.indexOf('data-testid="worktree-row-age"');
    expect(merged).toBeGreaterThan(-1);
    expect(merged).toBeLessThan(pin);
    expect(pin).toBeLessThan(age);
    // Pinned reads as the filled pin.
    expect(html.slice(pin, html.indexOf('</span>', pin))).toContain(
      'data-glyph="pin-fill1"',
    );
  });
});
