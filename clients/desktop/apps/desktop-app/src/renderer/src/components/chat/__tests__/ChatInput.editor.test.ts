/**
 * Source-level guard: `ChatInput.tsx` is too store/IPC-bound to mount in
 * jsdom, so this checks that the desktop composer renders the shared
 * `ComposerEditor` from ui-rich (the same wrapper the web composer renders)
 * rather than driving the bare `SlateEditor` with private density plumbing.
 */
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';

const source = readFileSync(join(__dirname, '..', 'ChatInput.tsx'), 'utf8');

describe('ChatInput composer editor', () => {
  it('renders the shared ComposerEditor sized to its text', () => {
    expect(source).toContain('<ComposerEditor');
    // The editable reserves no empty lines: one line on the capsule, and the
    // expanded editor grows with its text.
    expect(source).toMatch(/density="minimal"/);
    // JSX only, so a comment naming the old editor cannot trip this.
    expect(source).not.toMatch(/<SlateEditor[\s/>]/);
    // The expanded container still takes its height cap from the panel's
    // density step, so a short panel keeps its transcript in view.
    expect(source).toMatch(
      /expandedComposerEditorContainerClassName\(composerDensity\)/,
    );
  });
});
