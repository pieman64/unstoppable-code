/** @jest-environment node */
// eslint-disable-next-line no-restricted-imports
import { readdirSync, readFileSync, statSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join, relative } from 'node:path';

// Desktop Settings pages draw their controls with the shared parts, so a
// checkbox, a radio, a disclosure and a text area look the same on every
// page and on the web: `Checkbox` / `Radio` (neutral marks, no accent),
// `AdvancedDisclosure`, and `TextArea` / `SettingsTextArea`. Rows keep the
// settings row height (`min-h-10`, 64px with the group's row inset), so no
// page draws the dense 28px row (`min-h-7`) inside a settings group. Dialog
// actions go in `DialogModal`'s footer, never `topRightActions`.

const COMPONENTS_ROOT = join(__dirname, '../..');
const SCANNED_DIRECTORIES = ['settings', 'environments'];

/**
 * Files allowed one of these patterns, with the reason.
 */
const ALLOWED: Readonly<Record<string, readonly RegExp[]>> = {
  // The kit itself: its row-click selector names checkboxes, and its radio
  // group and text area are the kit's own until the Settings kit change
  // moves them onto the shared `Radio` and `TextArea`.
  'settings/SettingsLayout.tsx': [
    /type="checkbox"/,
    /type="radio"/,
    /SETTINGS_CHECK_INPUT_CLASS_NAME/,
    /<textarea(?=[\s>])/,
  ],
  // Applications keeps its develop layout for now (a remaining item).
  'settings/ApplicationsTab.tsx': [/\bmin-h-7\b/],
  // The account page's personal catalog disclosure is outside this sweep.
  'settings/PersonalCatalogSettings.tsx': [/<details(?=[\s>])/],
};

const RULES: readonly { readonly pattern: RegExp; readonly use: string }[] = [
  { pattern: /type="checkbox"/, use: 'the shared Checkbox' },
  { pattern: /type="radio"/, use: 'the shared Radio' },
  {
    pattern: /SETTINGS_CHECK_INPUT_CLASS_NAME/,
    use: 'the shared Checkbox or Radio',
  },
  { pattern: /<details(?=[\s>])/, use: 'AdvancedDisclosure' },
  { pattern: /<textarea(?=[\s>])/, use: 'TextArea or SettingsTextArea' },
  { pattern: /\bmin-h-7\b/, use: 'the settings row height (min-h-10)' },
  // A dialog's actions sit in its footer at the bottom right, never beside
  // the title.
  { pattern: /\btopRightActions\b/, use: "the dialog's footer prop" },
];

function sourceFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return /\.tsx$/.test(path) ? [path] : [];
  return readdirSync(path, { withFileTypes: true }).flatMap(
    (entry): string[] =>
      entry.isDirectory() && entry.name === '__tests__'
        ? []
        : sourceFiles(join(path, entry.name)),
  );
}

describe('desktop Settings controls are the shared parts', () => {
  const files = SCANNED_DIRECTORIES.flatMap((directory) =>
    sourceFiles(join(COMPONENTS_ROOT, directory)),
  );

  it('scans the Settings and Environments sources', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(RULES)('no page draws $pattern; it uses $use', ({ pattern }) => {
    const offenders = files.flatMap((file): string[] => {
      const name = relative(COMPONENTS_ROOT, file);
      if (ALLOWED[name]?.some((allowed) => allowed.source === pattern.source))
        return [];
      const lines = readFileSync(file, 'utf8').split('\n');
      return lines.flatMap((line, index): string[] =>
        pattern.test(line) ? [`${name}:${index + 1}: ${line.trim()}`] : [],
      );
    });
    expect(offenders).toEqual([]);
  });
});
