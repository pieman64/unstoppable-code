/**
 * Leading status for Work Entry rows (desktop early access): one indicator
 * in the leading slot, orange when a question waits, a loader while a turn
 * runs, blue for unread, and grey otherwise, so the right side is left to the
 * age and the hover actions.
 */
import { renderToString } from 'react-dom/server';
import { WorkEntryRow, type WorkEntryRowProps } from '../WorkEntryRow';
import { SpinnerStyleProvider } from '../spinner-style';

const BASE = 'sidebar-work-entry-e1';

function render(props: Partial<WorkEntryRowProps> = {}): string {
  return renderToString(
    <WorkEntryRow
      title="Fix the build"
      testId={BASE}
      entryId="e1"
      statusPlacement="leading"
      {...props}
    />,
  );
}

function leadingStatus(html: string): string | null {
  return /data-row-status="([a-z-]+)"/.exec(html)?.[1] ?? null;
}

describe('WorkEntryRow leading status', () => {
  it.each<[string, Partial<WorkEntryRowProps>, string, string | null]>([
    ['idle', {}, 'idle', 'bg-fg-quaternary/50'],
    ['done', { status: 'done' }, 'idle', 'bg-fg-quaternary/50'],
    ['question', { hasPendingQuestion: true }, 'needs-input', 'bg-fg-warning'],
    ['working', { working: true }, 'working', null],
    ['unread', { hasUnread: true }, 'unread', null],
  ])('shows the %s state in the leading slot', (_name, props, status, dot) => {
    const html = render(props);
    expect(leadingStatus(html)).toBe(status);
    if (dot) expect(html).toContain(dot);
  });

  it('draws the loader in the Labs spinner style', () => {
    const dots = render({ working: true });
    expect(dots).toContain('animate-thinking-dot');
    expect(dots).not.toContain('data-spinner="comet"');
    const comet = renderToString(
      <SpinnerStyleProvider value="comet">
        <WorkEntryRow
          title="Fix the build"
          testId={BASE}
          entryId="e1"
          statusPlacement="leading"
          working
        />
      </SpinnerStyleProvider>,
    );
    expect(comet).toContain('data-spinner="comet"');
    expect(comet).toContain('width:12px');
    expect(comet).not.toContain('animate-thinking-dot');
  });

  it('puts a question ahead of a running turn, and a turn ahead of unread', () => {
    expect(
      leadingStatus(render({ hasPendingQuestion: true, working: true })),
    ).toBe('needs-input');
    expect(leadingStatus(render({ working: true, hasUnread: true }))).toBe(
      'working',
    );
  });

  it('drops the done check and the trailing status', () => {
    const html = render({ status: 'done', working: true, hasUnread: true });
    expect(html).not.toContain(`data-testid="${BASE}-done"`);
    expect(html).not.toContain(`data-testid="${BASE}-status-slot"`);
  });

  it('keeps the age on the right while a status shows on the left', () => {
    const html = render({ working: true, lastActivityAt: Date.now() - 60_000 });
    expect(html).toContain(`data-testid="${BASE}-age"`);
  });

  it('leaves the trailing placement unchanged by default', () => {
    const html = renderToString(
      <WorkEntryRow title="Fix" testId={BASE} entryId="e1" working />,
    );
    expect(html).toContain(`data-testid="${BASE}-status-slot"`);
    expect(leadingStatus(html)).toBeNull();
  });
});
