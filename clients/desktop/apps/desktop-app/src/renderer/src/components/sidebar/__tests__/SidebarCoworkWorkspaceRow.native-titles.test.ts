/**
 * Source-level guard for CAN-2799 on the cowork sidebar row. The row is
 * store-bound (chat, projects, standalone-chat, onboarding) and its status
 * glyphs are only reachable through that graph, so this scans the JSX for the
 * native `title=` attributes that used to double as hover help. Native title
 * tooltips lag noticeably on macOS; status glyphs must explain themselves
 * through the rich `Tooltip` (or the hover preview popover they already own).
 * The truncating entry/workspace name titles are text-overflow aids and E2E
 * selectors, so they are deliberately not matched.
 *
 * Since CAN-3053 the glyphs live in the shared `WorkEntryRow`, which the
 * desktop row renders; both sources are scanned.
 */
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';

const SOURCE = readFileSync(
  join(__dirname, '..', 'SidebarCoworkWorkspaceRow.tsx'),
  'utf8',
);
const SHARED_ROW_SOURCE = readFileSync(
  join(
    __dirname,
    '../../../../../../../../packages/ui-shared/src/components/WorkEntryRow.tsx',
  ),
  'utf8',
);

describe('SidebarCoworkWorkspaceRow native title attributes', () => {
  it('renders its Work Entry rows through the shared row', () => {
    expect(SOURCE).toMatch(/<WorkEntryRow\b/);
  });

  it('renders no native title on the status glyphs', () => {
    for (const label of ['Working', 'Question waiting', 'Done']) {
      expect(SHARED_ROW_SOURCE).toContain(`aria-label="${label}"`);
      expect(SHARED_ROW_SOURCE).not.toContain(`title="${label}"`);
      expect(SOURCE).not.toContain(`title="${label}"`);
    }
  });

  it('wraps the working and done glyphs in the rich tooltip', () => {
    expect(SHARED_ROW_SOURCE).toMatch(/<Tooltip label="Working">/);
    expect(SHARED_ROW_SOURCE).toMatch(/<Tooltip label="Done">/);
  });
});
