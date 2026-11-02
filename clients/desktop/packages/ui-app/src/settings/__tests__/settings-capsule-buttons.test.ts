/** @jest-environment node */
// eslint-disable-next-line no-restricted-imports
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join, relative } from 'node:path';

// Every action on a Settings page is the shared capsule: `Button` (or
// `LoadingButton` / `CopyButton`, or `buttonClassName` for a link) at
// `size="compact"`, the 28px pill. The capsule is a shape, not a role: a
// primary action keeps the accent fill and a destructive one the destructive
// fill. Ghost and outline are only for icon-only circles; a labelled action
// takes a filled or bordered variant. On the account and organization pages a
// raw `<button>` is
// only for controls that are not actions (a tab, a switch, a whole-row target,
// an inline text link, a chip), and says which with `role` or
// `data-settings-control`.

const SETTINGS_ROOT = join(__dirname, '..');
const REPO_ROOT = join(SETTINGS_ROOT, '../../../..');

/** Shared pages outside `settings/` that render inside the account frame. */
const SHARED_SETTINGS_SOURCES: readonly string[] = [
  'packages/ui-app/src/external-agents',
];

export const HOST_SETTINGS_SOURCES: readonly string[] = [
  // Desktop: the hosted pages' host, and the "On this computer" sections and
  // organization slots it renders.
  'apps/desktop-app/src/renderer/src/components/settings/hosted',
  'apps/desktop-app/src/renderer/src/components/settings/CanopyCloudAccountSection.tsx',
  'apps/desktop-app/src/renderer/src/components/settings/LinearKeyRow.tsx',
  'apps/desktop-app/src/renderer/src/components/settings/NotificationDeviceSections.tsx',
  'apps/desktop-app/src/renderer/src/components/settings/PersonalCatalogSettings.tsx',
  'apps/desktop-app/src/renderer/src/components/settings/DesktopDataSharingOptIn.tsx',
  'apps/desktop-app/src/renderer/src/components/auth/CanopyCloudApiKeyField.tsx',
  'apps/desktop-app/src/renderer/src/components/auth/CloudAccountRecoveryNotice.tsx',
  'apps/desktop-app/src/renderer/src/components/auth/SecureStorageNotice.tsx',
  'apps/desktop-app/src/renderer/src/components/sidebar/DesktopCreateTeamDialog.tsx',
  // Web: the account and organization routes, their rail and hosts, and the
  // billing and organization slots they mount.
  'apps/web/src/app/(protected)/account/layout.tsx',
  'apps/web/src/app/(protected)/account/external-agents',
  'apps/web/src/app/(protected)/organization',
  'apps/web/src/components/settings-nav',
  'apps/web/src/components/settings-host',
  'apps/web/src/components/billing/web-billing-settings-slots.tsx',
  'apps/web/src/components/billing/account-payment-method-actions.tsx',
  'apps/web/src/components/billing/account-plan-subscribe-cta.tsx',
  'apps/web/src/components/billing/auto-top-up-controls.tsx',
  'apps/web/src/components/billing/credits-top-up-button.tsx',
  'apps/web/src/components/billing/subscription-actions-menu.tsx',
  'apps/web/src/components/billing/team-payment-method-actions.tsx',
  'apps/web/src/components/billing/team-plan-ctas.tsx',
  'apps/web/src/components/billing/top-up-checkout-dialog.tsx',
  'apps/web/src/components/team/web-organization-settings-slots.tsx',
  'apps/web/src/components/team/personal-team-upgrade-dialog.tsx',
  'apps/web/src/components/team/settings',
  'apps/web/src/components/team/team-external-agents-section.tsx',
  'apps/web/src/components/external-agents/web-external-agents-page.tsx',
];

/**
 * The desktop's own Settings pages (General, Display, Browser, Accounts…).
 * Their actions are checked like the shared pages'; their raw `<button>`
 * controls are not yet tagged, so the raw-button rule skips them.
 */
const DESKTOP_SETTINGS_ROOT =
  'apps/desktop-app/src/renderer/src/components/settings';

/**
 * Not a Settings page: an app-wide sheet that App.tsx mounts, which keeps its
 * own primary call to action.
 */
const DESKTOP_NOT_SETTINGS: readonly string[] = [
  `${DESKTOP_SETTINGS_ROOT}/DataSharingOptInSheetHost.tsx`,
];

/**
 * Buttons that pass a caller's variant straight through, so the file names no
 * variant of its own. Each names where the variant comes from.
 */
const RUNTIME_VARIANT_PASSTHROUGH: ReadonlyMap<string, string> = new Map([
  [
    'apps/web/src/components/billing/credits-top-up-button.tsx',
    'shared with the pricing page; each caller passes its variant',
  ],
]);

const NON_ACTION_ROLES = new Set([
  'tab',
  'switch',
  'checkbox',
  'radio',
  'menuitem',
  'menuitemradio',
  'menuitemcheckbox',
  'option',
  'combobox',
]);

/** What a raw `<button>` that is not an action may declare itself as. */
const NON_ACTION_KINDS = new Set([
  'row', // a whole list row or card that opens or selects it
  'link', // an inline text link inside copy
  'chip', // a filter chip or a segment of a chip group
  'sort', // a table column header that sorts
  'disclosure', // shows or hides more of the same row
  'field', // a control drawn inside a text field (clear, reveal)
  'picker', // a trigger that opens a menu or picker
  'media', // an avatar or logo that opens a file picker
  'dismiss', // closes the notice or drawer it sits in
]);

/** Variants a labelled action may take: the capsule keeps the action's role. */
const LABELLED_VARIANTS = new Set([
  'primary',
  'secondary',
  'destructive',
  'ghost-destructive',
]);

/** Variants an icon-only circle may also take. */
const ICON_ONLY_VARIANTS = new Set(['ghost', 'outline']);

const BUTTON_COMPONENTS = /<(Button|LoadingButton|CopyButton)(?=[\s>])/g;
const RAW_BUTTON = /<button(?=[\s>])/g;
const CLASS_HELPER = /buttonClassName\(\s*\{/g;

function sourceFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return /\.tsx$/.test(path) ? [path] : [];
  return readdirSync(path, { withFileTypes: true }).flatMap(
    (entry): string[] =>
      entry.isDirectory() && entry.name === '__tests__'
        ? []
        : sourceFiles(join(path, entry.name)),
  );
}

/** The opening tag (or call) starting at `index`, to its closing `>` / `)`. */
function openingAt(source: string, index: number, close: '>' | ')'): string {
  let depth = 0;
  for (let end = index; end < source.length; end += 1) {
    const char = source[end];
    if (char === '{' || char === '(') depth += 1;
    else if (char === '}' || char === ')') {
      if (close === ')' && char === ')' && depth === 1)
        return source.slice(index, end + 1);
      depth -= 1;
    } else if (close === '>' && char === '>' && depth === 0)
      return source.slice(index, end + 1);
  }
  return source.slice(index);
}

interface Found {
  readonly index: number;
  /** The first capture group, or the whole match. */
  readonly name: string;
}

/** Every match of a global pattern, with its index and first group. */
function matchesOf(source: string, pattern: RegExp): Found[] {
  const found: Found[] = [];
  const global = new RegExp(pattern.source, 'g');
  for (let match = global.exec(source); match; match = global.exec(source))
    found.push({ index: match.index, name: match[1] ?? match[0] });
  return found;
}

/** Names this file binds to `useSettingsButtonSize()`, the compact size. */
function compactSizeNames(source: string): Set<string> {
  return new Set(
    matchesOf(source, /const (\w+) = useSettingsButtonSize\(\)/).map(
      ({ name }) => name,
    ),
  );
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function offenders(
  file: string,
  { rawButtons }: { readonly rawButtons: boolean },
): string[] {
  const source = readFileSync(file, 'utf8');
  const path = relative(REPO_ROOT, file);
  const compactNames = compactSizeNames(source);
  const found: string[] = [];
  for (const match of matchesOf(source, BUTTON_COMPONENTS)) {
    const tag = openingAt(source, match.index, '>');
    const at = `${path}:${lineOf(source, match.index)}`;
    const sizeName = /\bsize=\{(\w+)\}/.exec(tag)?.[1];
    if (
      !/\bsize="compact"/.test(tag) &&
      !(sizeName !== undefined && compactNames.has(sizeName))
    )
      found.push(`${at} <${match.name}> is not size="compact"`);
    // A variant chosen at run time must name only allowed variants.
    const runtime = /\bvariant=\{([^}]*)\}/.exec(tag)?.[1];
    if (runtime !== undefined) {
      const named = matchesOf(runtime, /'([\w-]+)'/).map(({ name }) => name);
      if (
        !RUNTIME_VARIANT_PASSTHROUGH.has(path) &&
        (named.length === 0 ||
          named.some((name) => !LABELLED_VARIANTS.has(name)))
      )
        found.push(`${at} <${match.name}> picks its variant at run time`);
    }
    // Ghost and outline are for icon-only circles; a labelled action keeps
    // its role (primary, secondary, destructive) as a capsule.
    const variant = /\bvariant="([\w-]+)"/.exec(tag)?.[1];
    const iconOnly = /\biconOnly\b/.test(tag);
    if (
      variant !== undefined &&
      !LABELLED_VARIANTS.has(variant) &&
      !(iconOnly && ICON_ONLY_VARIANTS.has(variant))
    )
      found.push(`${at} <${match.name}> is a ${variant} action`);
  }
  for (const match of matchesOf(source, CLASS_HELPER)) {
    const call = openingAt(source, match.index + 'buttonClassName'.length, ')');
    const at = `${path}:${lineOf(source, match.index)}`;
    if (!/\bsize:\s*'compact'/.test(call))
      found.push(`${at} buttonClassName() is not size: 'compact'`);
  }
  if (!rawButtons) return found;
  for (const match of matchesOf(source, RAW_BUTTON)) {
    const tag = openingAt(source, match.index, '>');
    const role = /\brole="(\w+)"/.exec(tag)?.[1];
    const kind = /\bdata-settings-control="(\w+)"/.exec(tag)?.[1];
    if (role !== undefined && NON_ACTION_ROLES.has(role)) continue;
    if (kind !== undefined && NON_ACTION_KINDS.has(kind)) continue;
    found.push(
      `${path}:${lineOf(source, match.index)} raw <button> is neither a capsule action nor a declared non-action`,
    );
  }
  return found;
}

describe('settings action buttons', () => {
  const files = [
    ...sourceFiles(SETTINGS_ROOT),
    ...[...SHARED_SETTINGS_SOURCES, ...HOST_SETTINGS_SOURCES].filter((path) => !path.startsWith('apps/web/')).flatMap((path) =>
      sourceFiles(join(REPO_ROOT, path)),
    ),
  ];
  const guarded = new Set(files);
  const notSettings = new Set(
    DESKTOP_NOT_SETTINGS.map((path) => join(REPO_ROOT, path)),
  );
  const desktopFiles = sourceFiles(
    join(REPO_ROOT, DESKTOP_SETTINGS_ROOT),
  ).filter((file) => !guarded.has(file) && !notSettings.has(file));

  it('are the shared compact capsule, keeping their role', () => {
    expect([
      ...files.flatMap((file) => offenders(file, { rawButtons: true })),
      ...desktopFiles.flatMap((file) => offenders(file, { rawButtons: false })),
    ]).toEqual([]);
  });

  it('scans the settings sources', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(desktopFiles.length).toBeGreaterThan(80);
    expect(desktopFiles.some((file) => file.includes('account-proxy'))).toBe(
      true,
    );
  });

  it('names only sources that exist', () => {
    const named: readonly string[] = [
      ...HOST_SETTINGS_SOURCES,
      ...DESKTOP_NOT_SETTINGS,
      ...Array.from(RUNTIME_VARIANT_PASSTHROUGH.keys()),
    ];
    expect(
      named.filter((path: string) => !path.startsWith('apps/web/')).filter((path: string) => !existsSync(join(REPO_ROOT, path))),
    ).toEqual([]);
  });
});
