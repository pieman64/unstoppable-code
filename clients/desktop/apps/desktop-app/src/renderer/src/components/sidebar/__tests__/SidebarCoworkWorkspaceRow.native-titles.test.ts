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
 * desktop row renders; since turn-state phase 38a its Working spinner is the
 * shared `AgentStateGlyph`. All three sources are scanned.
 */
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';

const SOURCE = readFileSync(
  join(__dirname, '..', 'SidebarCoworkWorkspaceRow.tsx'),
  'utf8',
);
const SHARED_COMPONENTS = join(
  __dirname,
  '../../../../../../../../packages/ui-shared/src/components',
);
const SHARED_ROW_SOURCE = readFileSync(
  join(SHARED_COMPONENTS, 'WorkEntryRow.tsx'),
  'utf8',
);
const GLYPH_SOURCE = readFileSync(
  join(SHARED_COMPONENTS, 'AgentStateGlyph.tsx'),
  'utf8',
);

describe('SidebarCoworkWorkspaceRow native title attributes', () => {
  it('renders its Work Entry rows through the shared row', () => {
    expect(SOURCE).toMatch(/<WorkEntryRow\b/);
  });

  it('renders no native title on the status glyphs', () => {
    for (const label of ['Question waiting', 'Done'])
      expect(SHARED_ROW_SOURCE).toContain(`aria-label="${label}"`);
    expect(SHARED_ROW_SOURCE).toMatch(/<AgentStateGlyph\s+state="working"/);
    expect(GLYPH_SOURCE).toContain("state === 'working' ? 'Working'");
    expect(GLYPH_SOURCE).toContain('aria-label={label}');
    for (const label of ['Working', 'Question waiting', 'Done']) {
      expect(SHARED_ROW_SOURCE).not.toContain(`title="${label}"`);
      expect(SOURCE).not.toContain(`title="${label}"`);
    }
    expect(GLYPH_SOURCE).not.toMatch(/\btitle=/);
  });

  it('wraps the working and done glyphs in the rich tooltip', () => {
    expect(GLYPH_SOURCE).toMatch(/<Tooltip label=\{label\}>/);
    expect(SHARED_ROW_SOURCE).toMatch(/<Tooltip label="Done">/);
  });
});
