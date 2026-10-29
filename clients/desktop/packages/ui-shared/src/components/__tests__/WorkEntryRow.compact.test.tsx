/**
 * Compact hover actions on a Work Entry row (desktop early access, as on
 * focused worktree rows): hover offers Pin and Archive, the full menu moves
 * to right-click with ••• kept for touch, and a pinned row shows a pin icon
 * beside its age, where the hover Pin button lands.
 */
import { renderToString } from 'react-dom/server';
import { WorkEntryRow, type WorkEntryRowProps } from '../WorkEntryRow';

const BASE = 'sidebar-work-entry-e1';

function render(props: Partial<WorkEntryRowProps> = {}): string {
  return renderToString(
    <WorkEntryRow
      title="Fix the build"
      testId={BASE}
      entryId="e1"
      lastActivityAt={Date.now() - 3_600_000}
      onDelete={() => undefined}
      renderMenuItems={() => null}
      {...props}
    />,
  );
}

function compact(props: Partial<WorkEntryRowProps> = {}): string {
  return render({
    hoverActions: 'compact',
    onTogglePin: () => undefined,
    onArchive: () => undefined,
    ...props,
  });
}

function count(html: string, testId: string): number {
  return html.split(`data-testid="${testId}"`).length - 1;
}

function openTag(html: string, testId: string): string | undefined {
  return new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`).exec(
    html,
  )?.[0];
}

describe('WorkEntryRow compact hover actions', () => {
  it('keeps Delete and ••• by default', () => {
    const html = render({
      onTogglePin: () => undefined,
      onArchive: () => undefined,
    });
    expect(count(html, `${BASE}-delete-button`)).toBe(1);
    expect(count(html, `${BASE}-pin-button`)).toBe(0);
    expect(count(html, `${BASE}-archive-button`)).toBe(0);
  });

  it('offers Pin and Archive on hover, with ••• for touch only', () => {
    const html = compact();
    expect(count(html, `${BASE}-delete-button`)).toBe(0);
    expect(openTag(html, `${BASE}-pin-button`)).toContain('aria-label="Pin"');
    expect(count(html, `${BASE}-archive-button`)).toBe(1);
    // The ••• trigger stays mounted (the right-click menu anchors to it) but
    // its wrapper leaves fine pointers, so it adds no gap.
    const wrapper = html.indexOf('<span class="flex pointer-fine:hidden">');
    expect(wrapper).toBeGreaterThan(
      html.indexOf(`data-testid="${BASE}-archive-button"`),
    );
    expect(wrapper).toBeLessThan(html.indexOf(`data-testid="${BASE}-menu"`));
  });

  it('reads Unpin and shows the resting pin icon on a pinned row', () => {
    const html = compact({ pinnedToTop: true });
    expect(openTag(html, `${BASE}-pin-button`)).toContain('aria-label="Unpin"');
    const pin = html.indexOf(`data-testid="${BASE}-pinned"`);
    const age = html.indexOf(`data-testid="${BASE}-age"`);
    expect(pin).toBeGreaterThan(-1);
    // The pin sits right before the age, and leaves with it on hover.
    expect(pin).toBeLessThan(age);
    expect(openTag(html, `${BASE}-pinned`)).toContain(
      'group-hover/sidebar-item:hidden',
    );
    expect(count(compact(), `${BASE}-pinned`)).toBe(0);
    // Pinned reads as the filled pin, at rest and on the Unpin button.
    const filled = 'data-glyph="pin-fill1"';
    const pinnedIcon = html.slice(pin, html.indexOf('</span>', pin));
    expect(pinnedIcon).toContain(filled);
    const unpin = html.indexOf(`data-testid="${BASE}-pin-button"`);
    expect(html.slice(unpin, html.indexOf('</button>', unpin))).toContain(
      filled,
    );
    const pinButton = compact().indexOf(`data-testid="${BASE}-pin-button"`);
    const pinButtonHtml = compact().slice(
      pinButton,
      compact().indexOf('</button>', pinButton),
    );
    expect(pinButtonHtml).not.toContain(filled);
    expect(pinButtonHtml).toContain('data-glyph="pin"');
  });

  it('keeps a disabled Archive in place with the reason', () => {
    const tag = openTag(
      compact({ archiveDisabledReason: 'Stop the running chat first' }),
      `${BASE}-archive-button`,
    );
    expect(tag).toContain('disabled');
  });

  it('holds an empty slot for a missing action so Pin never moves', () => {
    const html = compact({ onArchive: undefined });
    expect(count(html, `${BASE}-archive-button`)).toBe(0);
    expect(html).toContain(
      '<span aria-hidden="true" class="w-6 shrink-0 pointer-coarse:hidden">',
    );
  });
});
