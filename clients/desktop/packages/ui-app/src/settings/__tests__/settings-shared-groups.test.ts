/** @jest-environment node */
// eslint-disable-next-line no-restricted-imports
import { readdirSync, readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join, relative } from 'node:path';
import {
  SETTINGS_CARD_GROUP_CLASS,
  SETTINGS_CARD_ROW_CLASS,
  SETTINGS_GROUP_CLASS,
  SETTINGS_GROUP_SURFACE_CLASS,
} from '@canopy/ui-shared/components/settings/SettingsCard';

// Account and organization settings draw their grouped boxes, rows and
// dividers exactly as desktop's own Settings pages (Appearance, General) do.
// The box, its hairline edge and its inset dividers come from one shared
// module; a page that hand-builds its own box (a rounded list with its own
// `divide-y`, or the settings hairline edge) drifts from the rest of
// Settings. Content cards on the wide pages (Timeline, Statistics, digests,
// member profiles) are not settings groups and stay out of this rule.

const SETTINGS_ROOT = join(__dirname, '..');
const REPO_ROOT = join(SETTINGS_ROOT, '../../../..');
const DESKTOP_SETTINGS_LAYOUT = join(
  REPO_ROOT,
  'apps/desktop-app/src/renderer/src/components/settings/SettingsLayout.tsx',
);
/** The one section, group and row kit desktop and web render. */
const SHARED_SETTINGS_ROWS = join(
  REPO_ROOT,
  'packages/ui-shared/src/components/settings/SettingsRows.tsx',
);

/**
 * Lists that are not a settings group: a scrolling checklist inside a
 * dialog. Each entry names its file and why it keeps its own frame.
 */
const NOT_A_SETTINGS_GROUP: Readonly<Record<string, string>> = {
  'organization/team-subteams-section.tsx':
    "the team membership dialog's scrolling checklist",
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(
    (entry): string[] => {
      const path = join(directory, entry.name);
      if (entry.isDirectory())
        return entry.name === '__tests__' ? [] : sourceFiles(path);
      return /\.tsx?$/.test(entry.name) ? [path] : [];
    },
  );
}

/** A class string that draws a grouped box of its own. */
const HAND_BUILT_GROUP = [
  // A rounded box splitting its own rows.
  /divide-y[^"'`]*\brounded-|\brounded-[^"'`]*divide-y/,
  // The settings box's hairline edge, outside the shared module.
  /\bring-line-base\b/,
];

describe('settings groups and rows', () => {
  it('desktop SettingsGroup draws the shared settings group', () => {
    const source = readFileSync(DESKTOP_SETTINGS_LAYOUT, 'utf8');
    const start = source.indexOf('export function SettingsGroup');
    const group = source.slice(start, source.indexOf('\n}\n', start));
    expect(group).toMatch(/<SettingsRowsGroup\b/);
    expect(group).not.toMatch(
      /\bring-line-base\b|\bdivide-y\b|\bbg-secondary\b/,
    );
    const shared = readFileSync(SHARED_SETTINGS_ROWS, 'utf8');
    const sharedStart = shared.indexOf('export function SettingsRowsGroup');
    expect(
      shared.slice(sharedStart, shared.indexOf('\n}\n', sharedStart)),
    ).toMatch(/\bSETTINGS_GROUP_CLASS\b/);
  });

  it('desktop pages render the shared section, row and sub-row', () => {
    // One kit: desktop's names are the shared components, so a desktop
    // page and a shared surface (the project settings dialog, the Code
    // Graph summary) cannot drift apart.
    const source = readFileSync(DESKTOP_SETTINGS_LAYOUT, 'utf8');
    expect(source).toMatch(
      /export const SettingsSection = SettingsRowsSection;/,
    );
    expect(source).toMatch(/export const SettingsRow = SettingsRowsRow;/);
    expect(source).toMatch(/export const SettingsSubRow = SettingsRowsSubRow;/);
    expect(source).not.toMatch(/min-h-10/);
  });

  it('the section box and the list group share one surface', () => {
    expect(SETTINGS_GROUP_CLASS).toContain(SETTINGS_GROUP_SURFACE_CLASS);
    expect(SETTINGS_CARD_GROUP_CLASS).toContain(SETTINGS_GROUP_SURFACE_CLASS);
  });

  it('a shared row keeps desktop’s row rhythm', () => {
    // Desktop: a row of at least 40px inside the group's 12px vertical
    // inset, with the hairline outside that height (64px + 1px). A shared
    // row matches: content-box height, so its divider adds to it.
    const shared = readFileSync(SHARED_SETTINGS_ROWS, 'utf8');
    expect(shared).toMatch(/flex min-h-10 items-center justify-between/);
    expect(SETTINGS_GROUP_CLASS).toMatch(/\*:py-3\b/);
    for (const token of ['box-content', 'min-h-10', 'py-3'])
      expect(SETTINGS_CARD_ROW_CLASS.split(' ')).toContain(token);
  });

  it('pages draw no grouped box of their own', () => {
    const offenders = sourceFiles(SETTINGS_ROOT).flatMap((file): string[] => {
      const path = relative(SETTINGS_ROOT, file);
      if (NOT_A_SETTINGS_GROUP[path] !== undefined) return [];
      return readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, index): string[] =>
          HAND_BUILT_GROUP.some((pattern) => pattern.test(line))
            ? [`${path}:${index + 1}: ${line.trim()}`]
            : [],
        );
    });
    expect(offenders).toEqual([]);
  });

  it('keeps the exemption list honest', () => {
    for (const path of Object.keys(NOT_A_SETTINGS_GROUP)) {
      const source = readFileSync(join(SETTINGS_ROOT, path), 'utf8');
      expect(HAND_BUILT_GROUP.some((pattern) => pattern.test(source))).toBe(
        true,
      );
    }
  });
});
