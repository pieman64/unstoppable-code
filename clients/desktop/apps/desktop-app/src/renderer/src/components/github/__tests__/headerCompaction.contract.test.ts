// Test-only source inspection; production renderer code stays browser-only.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import path from 'node:path';

/**
 * The worktree header sheds copy instead of shrinking when the bar gets
 * narrow: `Create PR` → `PR`, and Launch → its rocket icon.
 *
 * That behavior is a CROSS-PACKAGE contract with no runtime error if it
 * breaks. The `topbar` container is declared in `@canopy/ui-app`'s
 * WorktreeTopBar and consumed by two desktop components. A container query
 * whose named container does not exist simply never matches — so renaming or
 * dropping the container would not throw, it would silently pin the header to
 * its COMPACT copy at every width (`PR`, icon-only Launch), because the
 * `@[640px]` half of each pair is the one that never applies.
 *
 * Both controls must also share one breakpoint AND one container: keying them
 * off the flexible status region instead would oscillate, since collapsing
 * Launch widens that region, which would re-expand the label.
 */
const repoRoot = process.cwd();

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const SHARED_TOP_BAR = read(
  'packages/ui-app/src/code/shell/WorktreeTopBar.tsx',
);
const PR_STATUS_BAR = read(
  'apps/desktop-app/src/renderer/src/components/github/PrStatusBar.tsx',
);
// The status run and Create PR are the shared PR actions (REG-3025), which
// the desktop status bar and the web top bar both render.
const PR_ACTIONS = read(
  'packages/ui-app/src/code/pull-requests/PullRequestActions.tsx',
);
const PR_ACTIONS_COPY = read(
  'packages/ui-app/src/code/pull-requests/pull-request-actions-copy.tsx',
);
const HEADER_ACTION_BUTTON = read(
  'packages/ui-shared/src/components/HeaderActionButton.tsx',
);
const LAUNCH_BUTTON = read(
  'apps/desktop-app/src/renderer/src/components/activity/WorktreeLaunchButton.tsx',
);
const EXECUTION_ACTION_BUTTON = read(
  'packages/ui-shared/src/components/ExecutionActionButton.tsx',
);
const GLOBALS_CSS = read(
  'apps/desktop-app/src/renderer/src/styles/globals.css',
);

const BREAKPOINT = '@[640px]/topbar';

describe('worktree header compaction contract', () => {
  it('declares the `topbar` container on the shared bar root', () => {
    // Assert the CLASS on the root element, not the string anywhere in the
    // file — prose mentioning the container (including this contract's own
    // rationale comment) would otherwise satisfy a bare `toContain`.
    const rootClassName = SHARED_TOP_BAR.match(
      // Tolerate JSX comments between the testid and the className.
      /data-testid="worktree-top-bar"\s*\n(?:\s*\/\/[^\n]*\n)*\s*className="([^"]*)"/,
    )?.[1];
    expect(rootClassName).toBeDefined();
    expect(rootClassName).toContain('@container/topbar');
  });

  it('swaps Create PR copy on the shared breakpoint', () => {
    // Compact copy hides above the breakpoint; full copy appears there.
    expect(PR_ACTIONS_COPY).toContain(`${BREAKPOINT}:hidden`);
    expect(PR_ACTIONS_COPY).toContain(`hidden ${BREAKPOINT}:inline`);
  });

  it('collapses Launch to an icon on the SAME breakpoint and container', () => {
    // The icon is the caller's and hides once the label returns; the collapse
    // itself is the shared primitive's `iconOnlyWhenNarrow`, so its label and
    // width classes live in ExecutionActionButton, on the same breakpoint.
    expect(LAUNCH_BUTTON).toContain(`${BREAKPOINT}:hidden`);
    expect(LAUNCH_BUTTON).toContain('iconOnlyWhenNarrow');
    expect(EXECUTION_ACTION_BUTTON).toContain(`hidden ${BREAKPOINT}:inline`);
    // Square while compact, auto-width once the label returns.
    expect(EXECUTION_ACTION_BUTTON).toContain(`${BREAKPOINT}:w-auto`);
  });

  it('never lets the Create PR button shrink below its content', () => {
    // The reported bug: a squeezed button wrapped "Create PR" onto two lines
    // and squashed the icon with it.
    expect(PR_ACTIONS).toContain('<HeaderActionButton');
    expect(HEADER_ACTION_BUTTON).toContain('shrink-0');
    expect(HEADER_ACTION_BUTTON).toContain('whitespace-nowrap');
  });

  it('pins the Create PR icon so it cannot be scaled down', () => {
    const iconUses = PR_ACTIONS.match(/<GitPullRequestIcon[^/]*\/>/g) ?? [];
    expect(iconUses.length).toBeGreaterThan(0);
    for (const use of iconUses) {
      expect(use).toContain('shrink-0');
    }
  });
});

/**
 * Below the copy-shedding breakpoint the cluster drops whole controls, in a
 * fixed priority order. Without it the cluster kept its intrinsic width
 * inside a `min-w-0 flex-1` region and OVERFLOWED the bar, painting the
 * archive / Create PR / `Open in` controls on top of the sibling Launch
 * button instead of degrading.
 */
describe('worktree header priority disclosure', () => {
  /** Threshold each tier reappears at, parsed from the source constant. */
  function tierThreshold(tier: string): number {
    const block = PR_ACTIONS.match(
      /const HEADER_PRIORITY = \{([\s\S]*?)\n\} as const;/,
    )?.[1];
    expect(block).toBeDefined();
    const line = new RegExp(`${tier}: '([^']*)'`).exec(block ?? '')?.[1];
    expect(line).toBeDefined();
    const px = /@\[(\d+)px\]\/topbar:/.exec(line ?? '')?.[1];
    expect(px).toBeDefined();
    return Number(px);
  }

  it('drops controls lowest-priority first as the bar narrows', () => {
    // Archive goes first, then Create PR, then the badges, then `Open in`.
    const archive = tierThreshold('archive');
    const createPr = tierThreshold('createPr');
    const badges = tierThreshold('badges');
    const openIn = tierThreshold('openIn');

    expect(archive).toBeGreaterThan(createPr);
    expect(createPr).toBeGreaterThan(badges);
    expect(badges).toBeGreaterThan(openIn);
  });

  it('keeps every tier below the copy-shedding breakpoint', () => {
    // Copy is shed before whole controls are dropped.
    for (const tier of ['archive', 'createPr', 'badges', 'openIn']) {
      expect(tierThreshold(tier)).toBeLessThan(640);
    }
  });

  it('gives Create PR its own wrapper instead of merging the tier into the button', () => {
    // Keep responsive display utilities on the wrapper. The shared button
    // owns its inline-flex shell, and the grouped cancel-action hover state
    // is its typed `groupHover`, whose classes carry no responsive tier.
    expect(PR_ACTIONS).not.toContain('CREATE_PR_BTN');
    expect(PR_ACTIONS).toContain('className={HEADER_PRIORITY.createPr}');
    const groupHoverClasses = /const GROUP_HOVER_CLASS_NAMES[^;]*;/.exec(
      HEADER_ACTION_BUTTON,
    )?.[0];
    expect(groupHoverClasses).toBeDefined();
    expect(groupHoverClasses).not.toContain('/topbar:');
  });

  it('never wraps the archive control, which renders nothing when empty', () => {
    // `ArchivedChatsControl` returns null for a worktree with no archived
    // chats, but a wrapper <div> around it still exists and still consumes one
    // of the cluster's 8px gaps. Measured: the last status item sat 20px from
    // the buttons (12px row gap + the empty wrapper's 8px) while Create PR,
    // which lives inside the cluster, sat at 8px. The tier class therefore has
    // to ride ON the control.
    expect(PR_STATUS_BAR).toContain('className={HEADER_PRIORITY.archive}');
    expect(PR_STATUS_BAR).not.toMatch(
      /className=\{HEADER_PRIORITY\.archive\}\s*>\s*\n\s*<ArchivedChatsControl/,
    );
  });

  it('spaces ghost status controls tighter than the solid action cluster', () => {
    // Ghost controls (CI, PR badge, Merge / Commit & Push / Fix) group on the
    // row gap; the badge group must match it so `CI → #1234` is not a special
    // case. The solid cluster then stands off by row gap + its own `ml-*`, and
    // that total has to equal the cluster's INTERNAL gap — otherwise Create PR
    // (which lives inside the cluster) keeps a different distance from
    // `Open in` than the status controls do, and the gap before the buttons
    // changes with whichever state is showing.
    const spacing = (
      pattern: RegExp,
      source: string = PR_STATUS_BAR,
    ): number | undefined => {
      const token = pattern.exec(source)?.[1];
      return token === undefined ? undefined : Number(token) * 4;
    };
    const rowGap = spacing(/flex min-h-6\.5 items-center gap-(\d+) text-xs/);
    const badgeGap = spacing(
      /HEADER_PRIORITY\.badges\} items-center gap-(\d+)/,
      PR_ACTIONS,
    );
    const clusterGap = spacing(
      /"ml-\d+ flex shrink-0 items-center gap-(\d+) electron-no-drag"/,
    );
    const clusterOffset = spacing(
      /"ml-(\d+) flex shrink-0 items-center gap-\d+ electron-no-drag"/,
    );

    expect(rowGap).toBeDefined();
    expect(badgeGap).toBe(rowGap);
    expect(clusterGap).toBeDefined();
    expect(clusterOffset).toBeDefined();
    // Ghost run is tighter than the standoff before the solid buttons.
    expect(rowGap).toBeLessThan(clusterGap ?? 0);
    expect((rowGap ?? 0) + (clusterOffset ?? 0)).toBe(clusterGap);
  });

  it('keeps the arrow cursor over everything in the header', () => {
    // The header is chrome, not a document. The pointer cursor arrives from
    // UA/preflight rules on whole ELEMENT TYPES (`a[href]`, and Tailwind
    // preflight's `button`), so it cannot be held off with a class on each
    // control — one link added later brings it back. The rule is therefore
    // scoped to the bars themselves and has to keep covering DESCENDANTS.
    const rule =
      /\[data-testid='(worktree-top-bar|pr-status-bar)'\][^{]*\{[^}]*cursor:\s*default/.exec(
        GLOBALS_CSS,
      );
    expect(rule).not.toBeNull();
    const selector = GLOBALS_CSS.slice(
      GLOBALS_CSS.indexOf("[data-testid='worktree-top-bar']"),
      GLOBALS_CSS.indexOf('cursor: default'),
    );
    for (const bar of ['worktree-top-bar', 'pr-status-bar']) {
      expect(selector).toContain(`[data-testid='${bar}']`);
      // The descendant half, not just the root.
      expect(selector).toMatch(new RegExp(`\\[data-testid='${bar}'\\]\\s+\\*`));
    }
    // Typing surfaces keep their caret.
    expect(selector).toContain(':not(input)');
  });

  it('drops the launch cluster last, below every PrStatusBar tier', () => {
    const launchRoot = LAUNCH_BUTTON.match(
      /className="([^"]*)"\s*\n\s*data-testid="worktree-launch-button"/,
    )?.[1];
    expect(launchRoot).toBeDefined();
    const px = /@\[(\d+)px\]\/topbar:flex/.exec(launchRoot ?? '')?.[1];
    expect(px).toBeDefined();
    expect(Number(px)).toBeLessThan(tierThreshold('openIn'));
  });
});

/**
 * Breadcrumb labels must size to AVAILABLE space, not to a fixed fraction of
 * the bar. The original `max-w-[25cqw]` / `50cqw` caps truncated regardless
 * of need — measured at a 1600px window, the branch name was cut 4px short
 * while 533px of the row sat unused — and equally refused to give up space
 * they were not using when the bar got tight.
 */
describe('worktree header breadcrumb sizing', () => {
  it('caps no read-only label at a fixed fraction of the bar', () => {
    // The old `max-w-[25cqw]`/`50cqw` caps truncated the DISPLAY labels while
    // half the row sat unused, so the label constants must stay cap-free.
    // This deliberately does NOT ban `cqw` file-wide: the branch RENAME input
    // grows with what is typed and needs a proportional ceiling — a live
    // input hitting a cap scrolls, it does not silently truncate.
    for (const name of ['BRANCH_LABEL', 'BASE_BRANCH_ITEM']) {
      const value = new RegExp(`const ${name} = '([^']*)'`).exec(
        PR_STATUS_BAR,
      )?.[1];
      expect(value).toBeDefined();
      expect(value).not.toMatch(/max-w-\[\d+cqw\]/);
    }
  });

  it('lets the labels shrink below their content', () => {
    const branchLabel = PR_STATUS_BAR.match(
      /const BRANCH_LABEL = '([^']*)'/,
    )?.[1];
    expect(branchLabel).toBeDefined();
    // `min-w-0` defeats a flex item's `min-width: auto` floor; `truncate`
    // renders the ellipsis once it is actually squeezed.
    expect(branchLabel).toContain('min-w-0');
    expect(branchLabel).toContain('truncate');
  });

  it('never makes the breadcrumb flex-1, which its own `mr-auto` would collapse', () => {
    // Auto margins absorb positive free space BEFORE flex-grow is
    // distributed, so a `flex-basis: 0` breadcrumb carrying `mr-auto` would
    // render at zero width.
    const branchGroup = PR_STATUS_BAR.match(
      /className="(group\/branch[^"]*)"/,
    )?.[1];
    expect(branchGroup).toBeDefined();
    expect(branchGroup).toContain('min-w-0');
    expect(branchGroup).not.toMatch(/\bflex-1\b/);
  });

  it('takes the row’s slack at the breadcrumb, not at the action cluster', () => {
    // Where the auto margin sits decides where the slack lands. On the
    // cluster, the status items stay pinned to the breadcrumb and their
    // distance from the buttons tracks whatever copy the state happens to
    // carry — measured 8px to 66px across states. On the breadcrumb, every
    // status item packs against the buttons on the row's own gap instead.
    const branchGroup = PR_STATUS_BAR.match(
      /className="(group\/branch[^"]*)"/,
    )?.[1];
    expect(branchGroup).toContain('mr-auto');
    // Exactly one auto margin: two would split the slack between them.
    const clusterClass = PR_STATUS_BAR.match(
      /className="(ml-\d+ flex shrink-0 items-center gap-\d+ electron-no-drag)"/,
    )?.[1];
    expect(clusterClass).toBeDefined();
    expect(clusterClass).not.toContain('ml-auto');
  });

  it('makes the base branch yield faster than the branch', () => {
    // The shrink factor lives on the chevron+label WRAPPER, which is the
    // flex item the breadcrumb actually sizes; `BASE_BRANCH_ITEM` now only
    // carries the inner button's floor.
    const baseGroup = PR_STATUS_BAR.match(
      /const BASE_BRANCH_GROUP =\s*\n(?:\s*\/\/[^\n]*\n)*\s*'([^']*)'/,
    )?.[1];
    expect(baseGroup).toBeDefined();
    const shrink = /\bshrink-(\d+)\b/.exec(baseGroup ?? '')?.[1];
    expect(Number(shrink)).toBeGreaterThan(1);
  });

  it('gives the branch pill no min-width, so it hugs a short name', () => {
    // A floor padded the pill out past a short branch (`work`), leaving its
    // hover surface visibly wider than the label. The trigger's className is
    // a template literal (the hover state swaps its right padding), so match
    // the backtick form up to the anchor-ref span.
    const trigger = PR_STATUS_BAR.match(
      /className=\{`([^`]*)`\}\s*\n?\s*>\s*\n\s*<span\s*\n\s*ref=\{branchMenuAnchorRef\}/,
    )?.[1];
    expect(trigger).toBeDefined();
    expect(trigger).not.toMatch(/\bmin-w-\[/);
  });
});

/**
 * The action cluster must stay RIGID. Every control inside it is `shrink-0`,
 * so a shrinkable cluster gets squeezed narrower than its own contents and
 * they spill out of it: the `Open in` pill measured 912px inside an 882px
 * wrapper and painted over the Launch button, while an overflow check that
 * only looked at the wrapper reported no overlap at all.
 */
describe('worktree header action cluster rigidity', () => {
  it('keeps the action cluster shrink-0', () => {
    const clusterClass = PR_STATUS_BAR.match(
      /className="(ml-\d+ flex shrink-0 items-center gap-\d+ electron-no-drag)"/,
    )?.[1];
    expect(clusterClass).toBeDefined();
    expect(clusterClass).toContain('shrink-0');
  });
});

/**
 * The header row and the panel tab strip below it stack vertically, so their
 * controls form visual columns. The header row used `pr-2` (8px) while every
 * other row in the chrome insets by 9px, which put each header control 1px
 * off from the control directly beneath it.
 */
describe('worktree header edge insets', () => {
  it('insets the header row by 9px on every edge but the leading one', () => {
    const rowClass = PR_STATUS_BAR.match(
      /className=\{?[`"](@container\/prbar[^`"]*)[`"]/,
    )?.[1];
    expect(rowClass).toBeDefined();
    expect(rowClass).toContain('py-2.25');
    expect(rowClass).toContain('pr-2.25');
    // The leading edge follows the inset layout's first tab.
    expect(rowClass).toContain('${leadingInsetClassName}');
    // The asymmetric shorthand that caused the 1px column drift.
    expect(rowClass).not.toMatch(/\bpr-2(?![.\d])/);
  });

  it('insets the shared bar trailing cluster by the same 9px', () => {
    expect(SHARED_TOP_BAR).toContain('pr-2.25');
  });
});

/**
 * The base branch must degrade to an ellipsis, never to nothing.
 *
 * With only `min-w-0` it collapsed to its padding — zero characters — while
 * the chevron separator stayed, leaving an arrow pointing at empty space.
 * Putting the floor on the inner button alone was not enough either: the
 * WRAPPER still collapsed to zero and its content overflowed onto the action
 * cluster.
 */
describe('worktree header base branch', () => {
  it('floors the chevron+label wrapper so it cannot collapse', () => {
    const group = PR_STATUS_BAR.match(
      /const BASE_BRANCH_GROUP =\s*\n(?:\s*\/\/[^\n]*\n)*\s*'([^']*)'/,
    )?.[1];
    expect(group).toBeDefined();
    // A non-zero floor on the spacing scale (`min-w-18`), never `min-w-0`.
    expect(group).toMatch(/\bmin-w-(?!0\b)[\d.]+\b/);
    expect(group).not.toContain('min-w-0');
  });

  it('hides the chevron together with the label, one tier before Open in', () => {
    const group = PR_STATUS_BAR.match(
      /const BASE_BRANCH_GROUP =\s*\n(?:\s*\/\/[^\n]*\n)*\s*'([^']*)'/,
    )?.[1];
    const px = /@\[(\d+)px\]\/topbar:/.exec(group ?? '')?.[1];
    expect(px).toBeDefined();
    const openIn = /openIn: '([^']*)'/.exec(PR_ACTIONS)?.[1];
    const openInPx = /@\[(\d+)px\]\/topbar:/.exec(openIn ?? '')?.[1];
    expect(Number(px)).toBeGreaterThan(Number(openInPx));
  });
});

/**
 * Header chrome details that only show up under a cursor or a ruler.
 */
describe('worktree header chrome polish', () => {
  it('renders the whole bar with the default cursor', () => {
    // Wrappers and label spans default to `cursor: auto`, which paints an
    // I-beam over their text — a text caret in app chrome. Both roots opt out
    // so every descendant inherits `default`.
    const sharedRoot = SHARED_TOP_BAR.match(
      /data-testid="worktree-top-bar"\s*\n(?:\s*\/\/[^\n]*\n)*\s*className="([^"]*)"/,
    )?.[1];
    expect(sharedRoot).toBeDefined();
    expect(sharedRoot).toContain('cursor-default');

    const statusRoot = PR_STATUS_BAR.match(
      /className=\{?[`"](@container\/prbar[^`"]*)[`"]/,
    )?.[1];
    expect(statusRoot).toContain('cursor-default');
  });

  it('keeps both halves of the compact `Open in` control square', () => {
    const openDropdown = read(
      'apps/desktop-app/src/renderer/src/components/worktree/OpenDropdown.tsx',
    );
    // The className is a template literal (it composes the shared secondary
    // surface), so match either quote style.
    const appButton = openDropdown.match(
      /data-testid="worktree-open-app"[\s\S]{0,400}?className=\{?[`"]([^`"]*)[`"]/,
    )?.[1];
    expect(appButton).toBeDefined();
    // Square while compact; the label's own breakpoint restores the padded,
    // auto-width form. Without this the icon half measured 34×28 beside a
    // 28×28 chevron.
    expect(appButton).toContain('w-7');
    expect(appButton).toContain('justify-center');
    expect(appButton).toContain('@[560px]/prbar:w-auto');
  });
});

/**
 * Controls that lose their label in the compact header must say what they do
 * on hover, through the SHARED tooltip (the native `title` is slow and
 * OS-styled, so it reads as foreign next to the rest of the chrome).
 */
describe('worktree header tooltips', () => {
  const OPEN_DROPDOWN = read(
    'apps/desktop-app/src/renderer/src/components/worktree/OpenDropdown.tsx',
  );

  it('gives both halves of the `Open in` control a shared tooltip', () => {
    expect(OPEN_DROPDOWN).toContain('<Tooltip');
    expect(OPEN_DROPDOWN).toMatch(/label=\{`Open in \$\{splitApp\.name\}`\}/);
    expect(OPEN_DROPDOWN).toMatch(/label="Open in…"/);
    // The native tooltip is replaced, not stacked on top of the shared one.
    expect(OPEN_DROPDOWN).not.toMatch(
      /title=\{`Open in \$\{splitApp\.name\}`\}/,
    );
  });

  it('suppresses the chevron tooltip while its menu is open', () => {
    expect(OPEN_DROPDOWN).toContain('suppressed={open}');
  });

  it('gives the icon-only Launch control a shared tooltip', () => {
    expect(LAUNCH_BUTTON).toContain('<Tooltip');
    expect(LAUNCH_BUTTON).toMatch(
      /label=\{onLaunch === undefined \? 'Launch scripts' : launchLabel\}/,
    );
    expect(LAUNCH_BUTTON).not.toContain('title="Launch scripts"');
  });

  it('explains the compact `PR` button on hover without breaking its progress checklist', () => {
    // The tooltip must sit OUTSIDE the host's progress wrapper
    // (`GitActionProgressTooltip` on desktop): that wrapper clones trigger
    // props onto its child and expects the raw <button>, so a nested tooltip
    // would swallow them and kill the in-progress checklist.
    const block = PR_ACTIONS.slice(
      PR_ACTIONS.indexOf('className={HEADER_PRIORITY.createPr}'),
    ).slice(0, 1600);
    const tooltipAt = block.indexOf('<Tooltip');
    const buttonAt = block.indexOf('<CreatePrButton');
    expect(tooltipAt).toBeGreaterThan(-1);
    expect(buttonAt).toBeGreaterThan(-1);
    expect(tooltipAt).toBeLessThan(buttonAt);
    // The button hands the progress wrapper the raw HeaderActionButton.
    expect(PR_ACTIONS).toMatch(
      /renderProgress\(\s*\{ type: 'create-pr' \},\s*<HeaderActionButton/,
    );
    // Full action, not the visible label, and quiet while the action runs.
    expect(block).toContain('getCreatePrActionName');
    expect(block).toContain(
      'suppressed={activity.creatingPr || isBusy(activity)}',
    );
    // The desktop host wraps the trigger in its progress checklist.
    expect(PR_STATUS_BAR).toContain('<GitActionProgressTooltip');
  });
});

/**
 * Pinned scripts (CAN-2050) sit in the action cluster before Launch. They are
 * the most expendable copy and an early whole-control tier: labels shed above
 * every other copy breakpoint, then the run drops before `Open in` and the
 * launch cluster. Each pin renders a labelled and a compact button keyed to
 * ONE breakpoint, so exactly one of them shows at every width.
 */
describe('worktree header pinned scripts', () => {
  const PINS = read('packages/ui-app/src/code/shell/WorktreeTopBarPins.tsx');

  function tier(name: string): string {
    const block = PR_ACTIONS.match(
      /const HEADER_PRIORITY = \{([\s\S]*?)\n\} as const;/,
    )?.[1];
    const value = new RegExp(`${name}: '([^']*)'`).exec(block ?? '')?.[1];
    expect(value).toBeDefined();
    return value ?? '';
  }

  function threshold(name: string): number {
    return Number(/@\[(\d+)px\]\/topbar:/.exec(tier(name))?.[1]);
  }

  it('sheds pin labels before any other header copy', () => {
    expect(threshold('pinLabels')).toBeGreaterThan(640);
    expect(threshold('pinCompact')).toBe(threshold('pinLabels'));
    // Opposite halves of one breakpoint.
    expect(tier('pinLabels')).toMatch(/^hidden @\[\d+px\]\/topbar:flex$/);
    expect(tier('pinCompact')).toMatch(/^flex @\[\d+px\]\/topbar:hidden$/);
  });

  it('drops the pin run after the badges and before Open in', () => {
    expect(threshold('pins')).toBeLessThan(threshold('badges'));
    expect(threshold('pins')).toBeGreaterThan(threshold('openIn'));
    // The launch cluster's own floor stays below every tier.
    expect(threshold('openIn')).toBeGreaterThan(200);
  });

  it('applies the tiers and keeps pins out of the drag region', () => {
    expect(PINS).toContain('${HEADER_PRIORITY.pins} electron-no-drag');
    expect(PINS).toContain('className={HEADER_PRIORITY.pinLabels}');
    expect(PINS).toContain('className={HEADER_PRIORITY.pinCompact}');
    expect(PINS).toContain('<HeaderActionButton');
    // Pins render inside the cluster, before the launch control.
    const pinsAt = SHARED_TOP_BAR.indexOf('<WorktreeTopBarPins');
    const launchAt = SHARED_TOP_BAR.indexOf('{launchControl ??');
    expect(pinsAt).toBeGreaterThan(-1);
    expect(pinsAt).toBeLessThan(launchAt);
  });

  it('gates pins on a local terminal', () => {
    expect(SHARED_TOP_BAR).toMatch(
      /capabilities\.scriptActions === true && capabilities\.terminalPty === true/,
    );
  });
});
