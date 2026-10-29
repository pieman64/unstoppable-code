/**
 * The last-activity age on a Work Entry row ("5m", "3h", "2d"): it sits on
 * the right of an idle row, gives the spot to a live status, and hides while
 * the hover actions take that space.
 */
import { renderToString } from 'react-dom/server';
import { WorkEntryRow, type WorkEntryRowProps } from '../WorkEntryRow';

const BASE = 'sidebar-work-entry-e1';
const HOUR = 3_600_000;

function render(props: Partial<WorkEntryRowProps> = {}): string {
  return renderToString(
    <WorkEntryRow
      title="Fix the build"
      testId={BASE}
      entryId="e1"
      {...props}
    />,
  );
}

function ageSpan(html: string): string | null {
  const match = new RegExp(
    `<span[^>]*data-testid="${BASE}-age"[^>]*>([^<]*)</span>`,
  ).exec(html);
  return match ? match[0] : null;
}

describe('WorkEntryRow last-activity age', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: Date.UTC(2026, 9, 6, 12, 0, 0) });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows the compact age of the last activity', () => {
    const html = render({ lastActivityAt: Date.now() - 3 * HOUR });
    expect(ageSpan(html)).toContain('>3h<');
  });

  it('shows nothing without a last-activity time', () => {
    expect(ageSpan(render())).toBeNull();
  });

  it('gives the spot to a live status', () => {
    const at = Date.now() - HOUR;
    expect(ageSpan(render({ lastActivityAt: at, working: true }))).toBeNull();
    expect(ageSpan(render({ lastActivityAt: at, hasUnread: true }))).toBeNull();
    expect(
      ageSpan(render({ lastActivityAt: at, hasPendingQuestion: true })),
    ).toBeNull();
  });

  it('hides while the hover actions take its place', () => {
    const span = ageSpan(
      render({ lastActivityAt: Date.now() - HOUR, onDelete: () => {} }),
    );
    expect(span).toContain('group-hover/sidebar-item:hidden');
    expect(span).toContain('pointer-coarse:hidden');
  });
});
