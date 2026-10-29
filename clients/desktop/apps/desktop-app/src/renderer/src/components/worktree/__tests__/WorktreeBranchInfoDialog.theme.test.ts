/**
 * @jest-environment node
 */
// Source-level coverage avoids mounting the dialog's git and store dependencies.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';

const SOURCE = readFileSync(
  join(__dirname, '..', 'WorktreeBranchInfoDialog.tsx'),
  'utf-8',
);

/** The source of one top-level function, from its declaration to the next. */
function functionSource(name: string, nextDeclaration: string): string {
  const start = SOURCE.indexOf(`function ${name}(`);
  const end = SOURCE.indexOf(nextDeclaration, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

// Tailwind palette classes (the old dark-only amber shades) are rejected by
// `scripts/brand/check-theme-token-usage.mjs`, which scans this file.
describe('WorktreeBranchInfoDialog theme colors', () => {
  it('renders the health-check and remote-rename notices through the shared Notice', () => {
    expect(SOURCE).toContain(
      "import { Notice, NoticeButton } from '@canopy/ui-shared/components';",
    );
    for (const [name, next] of [
      ['WorktreeHealthAlert', 'function formatHealthRetryError('],
      ['RemoteRenameWarning', 'interface BranchRenameFormProps'],
    ]) {
      const source = functionSource(name, next);
      expect(source).toMatch(/<Notice\s+intent="attention"/);
      // The tinted box, its border, and its hover fill are owned by `Notice`.
      expect(source).not.toContain('border-line-attention');
      expect(source).not.toContain('hover:bg-warning');
    }
  });
});
