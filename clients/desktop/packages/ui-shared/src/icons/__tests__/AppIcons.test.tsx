import { createElement, type ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { buildSync } from 'esbuild';
import * as AppIcons from '../AppIcons';
import {
  AgentAssistantIcon,
  AllModelsFilledIcon,
  AllModelsIcon,
  AppAdvisorIcon,
  AutoplayIcon,
  BugReportIcon,
  ChevronsUpDown,
  ClaudeIcon,
  CloseIcon,
  CustomizeIcon,
  FastModeIcon,
  FastModeOnIcon,
  FileDiff,
  FolderGit2,
  GitBranch,
  GitCommitIcon,
  GitDraftIcon,
  GitForkIcon,
  GitHubIcon,
  GitIcon,
  Github,
  GitMergeConflictIcon,
  GitMergeIcon,
  GitMergeQueueIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  GraphIcon,
  ImagePlus,
  Link2,
  PhoneDynamicIslandFilledIcon,
  PhoneDynamicIslandIcon,
  PhoneFilledIcon,
  PinFilledIcon,
  PinIcon,
  PipelineIcon,
  PlanModeIcon,
  PlansIcon,
  PluginsIcon,
  RaisedHandIcon,
  RepoIcon,
  RerunIcon,
  SettingsIcon,
  ShareIcon,
  Smartphone,
  Sparkles,
  StopFilledIcon,
  StopIcon,
  ThinkingIcon,
  TrashIcon,
  TrashPermanentlyIcon,
  UnarchiveIcon,
  WarningIcon,
  WindowsPlatformIcon,
  WrenchIcon,
  ChipSimpleIcon,
} from '../AppIcons';
import {
  IconBrain2,
  IconDotGrid3x3,
  IconShareAndroid,
  IconZap,
} from '../AppGlyphs.generated';
import manifest from '../icon-manifest.json';
import { PlanModeIcon as SharedPlanModeIcon } from '../PlanModeIcon';

function pathData(html: string): string[] {
  return Array.from(html.matchAll(/ d="([^"]+)"/g), (match) => match[1]).sort();
}

function glyphOf(html: string): string | undefined {
  return html.match(/data-glyph="([^"]+)"/)?.[1];
}

function isComponent(value: unknown): value is ComponentType<object> {
  return typeof value === 'function';
}

/** Every component `AppIcons` exports, by export name. */
const ICON_EXPORTS: [string, ComponentType<object>][] = [];
for (const [name, value] of Object.entries(AppIcons)) {
  if (name !== 'AppIconBase' && isComponent(value)) {
    ICON_EXPORTS.push([name, value]);
  }
}

/**
 * Manifest keys no `AppIcons` export binds: their API moved to an override
 * key, or Central only ever used them on mobile. They stay in the manifest so
 * the Flutter `CanopyGlyph` enum keeps every value name.
 */
const MOBILE_ONLY_KEYS = [
  'arrowOutOfBox',
  'differenceModified',
  'dotGrid3x3',
  'draft',
  'layoutGrid2Filled',
  'mergeConflict',
  'raisedHand',
  'untrash',
];

/**
 * Manifest keys deliberately left unbound because `AppIcons` ships with every
 * route: their single page imports the logo component directly. The External
 * agents setup marks would otherwise add ~10.7 KB gzip of first-load JS to
 * each route.
 */
const PAGE_LOCAL_KEYS = ['hermesAgent', 'metaMuse', 'openclaw', 'opencode'];

interface ManifestEntry {
  source: string;
  name: string;
  fill: number;
}

const glyphEntries: [string, ManifestEntry][] = Object.entries(manifest.glyphs);

function dataGlyph(entry: ManifestEntry): string {
  return entry.source === 'material' || entry.source === 'lucide'
    ? `${entry.name}${entry.fill === 1 ? '-fill1' : ''}`
    : entry.name;
}

describe('App icons', () => {
  it('omits unused glyphs when bundling a single icon', () => {
    const result = buildSync({
      stdin: {
        contents: 'export { CloseIcon } from "../AppIcons";',
        resolveDir: __dirname,
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      jsx: 'automatic',
      external: ['react', 'react/jsx-runtime'],
    });
    const output = result.outputFiles?.[0]?.text ?? '';

    expect(output).toContain('CloseIcon');
    expect(output).toContain('LucideX');
    expect(output).not.toContain('LucideBlocks');
    expect(output).not.toContain('SimpleIconsApple');
    expect(output).not.toContain('ClaudeLogo');
  });

  it('renders every export as a hidden svg tagged with its glyph', () => {
    expect(ICON_EXPORTS.length).toBeGreaterThan(250);
    for (const [name, Icon] of ICON_EXPORTS) {
      const html = renderToString(createElement(Icon));
      expect({ name, svg: html.startsWith('<svg') }).toEqual({
        name,
        svg: true,
      });
      expect({ name, appIcon: html.includes('data-app-icon="true"') }).toEqual({
        name,
        appIcon: true,
      });
      expect({ name, glyph: glyphOf(html) !== undefined }).toEqual({
        name,
        glyph: true,
      });
      expect({ name, hidden: html.includes('aria-hidden="true"') }).toEqual({
        name,
        hidden: true,
      });
      expect({ name, viewBox: html.includes('viewBox="') }).toEqual({
        name,
        viewBox: true,
      });
      expect(html).not.toContain('<mask');
      expect(html).not.toContain('<title');
    }
  });

  it('names an exposed icon through aria-label, never a <title>', () => {
    for (const Icon of [CloseIcon, ClaudeIcon, GitIcon]) {
      const html = renderToString(<Icon ariaHidden={false} title="Label" />);
      expect(html).toContain('aria-hidden="false"');
      expect(html).toContain('role="img"');
      expect(html).toContain('aria-label="Label"');
      expect(html).not.toContain('<title');
    }
  });

  it('resolves every export to a manifest glyph', () => {
    const known = new Set(glyphEntries.map(([, entry]) => dataGlyph(entry)));
    for (const [name, Icon] of ICON_EXPORTS) {
      const glyph = glyphOf(renderToString(createElement(Icon)));
      expect({ name, known: known.has(glyph ?? '') }).toEqual({
        name,
        known: true,
      });
    }
  });

  it('binds every manifest key except the pinned mobile-only ones', () => {
    const rendered = new Set(
      ICON_EXPORTS.map(([, Icon]) =>
        glyphOf(renderToString(createElement(Icon))),
      ),
    );
    const unbound = glyphEntries
      .filter(([, entry]) => !rendered.has(dataGlyph(entry)))
      .map(([key]) => key);
    // A key whose artwork another key already renders is bound too.
    expect(
      unbound
        .filter(
          (key) =>
            MOBILE_ONLY_KEYS.includes(key) || PAGE_LOCAL_KEYS.includes(key),
        )
        .sort(),
    ).toEqual(unbound.sort());
  });

  it('renders the FILL 1 state of each state pair differently', () => {
    const pairs = [
      [PinIcon, PinFilledIcon],
      [FastModeIcon, FastModeOnIcon],
      [StopIcon, StopFilledIcon],
      [AllModelsIcon, AllModelsFilledIcon],
      [PhoneDynamicIslandIcon, PhoneDynamicIslandFilledIcon],
      [Smartphone, PhoneFilledIcon],
    ] as const;
    for (const [Outline, Filled] of pairs) {
      const outline = renderToString(<Outline />);
      const filled = renderToString(<Filled />);
      expect(glyphOf(filled)).toBe(`${glyphOf(outline) ?? ''}-fill1`);
      expect(outline).toContain('fill="none"');
      expect(filled).toContain('fill="currentColor"');
    }
  });

  it('binds the composer fast-mode glyph to the bolt', () => {
    const html = renderToString(<FastModeIcon width={16} height={16} />);

    expect(html).toContain('style="width:14px;height:14px"');
    expect(pathData(html)).toEqual(pathData(renderToString(<IconZap />)));
    expect(glyphOf(html)).toBe('zap');
  });

  it('renders Lucide glyphs at an exact size when a surface opts out of the tiers', () => {
    const html = renderToString(
      <FastModeIcon width={16} height={16} exactSize />,
    );

    expect(html).toContain('width="16px"');
    expect(html).toContain('height="16px"');
    expect(html).toContain('style="width:16px;height:16px"');
    // Opts out of the app-icons.css tier rules, which use !important.
    expect(html).toContain('data-icon-size="exact"');
    expect(html).not.toContain('exactSize');
    expect(html).not.toContain('exactsize');
  });

  it('drops exactSize before markup on repository logos', () => {
    // React omits the unknown attribute but warns, so watch for the warning.
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation((): void => undefined);
    try {
      const html = renderToString(<ClaudeIcon size={14} exactSize />);

      expect(html).toContain('width="14px"');
      expect(html).not.toContain('exactsize');
      expect(
        consoleError.mock.calls.some((call) =>
          call.some((arg) => String(arg).includes('exactSize')),
        ),
      ).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('binds the one Share glyph to the share nodes', () => {
    const html = renderToString(<ShareIcon width={16} height={16} />);

    expect(pathData(html)).toEqual(
      pathData(renderToString(<IconShareAndroid />)),
    );
    expect(glyphOf(html)).toBe('share-2');
  });

  it('binds the thinking control to the Brain 2 glyph', () => {
    const html = renderToString(<ThinkingIcon />);

    expect(pathData(html)).toEqual(pathData(renderToString(<IconBrain2 />)));
    expect(glyphOf(html)).toBe('brain-circuit');
  });

  it('draws UI icons as plain Lucide stroke SVGs', () => {
    for (const [Icon, glyph] of [
      [TrashIcon, 'trash-2'],
      [TrashPermanentlyIcon, 'trash'],
      [ChipSimpleIcon, 'cpu'],
    ] as const) {
      const html = renderToString(<Icon color="rgba(0, 0, 0, 0.5)" />);
      expect(glyphOf(html)).toBe(glyph);
      expect(html).toContain('fill="none"');
      expect(html).toContain('stroke-width="2"');
      expect(html).not.toContain('mask');
    }
  });

  it.each([
    ['plugins', PluginsIcon, 'puzzle'],
    ['Customize', CustomizeIcon, 'briefcase'],
    ['Orchestrator', AppAdvisorIcon, 'orbit'],
    ['other assistants', AgentAssistantIcon, 'bot'],
    ['preferences', SettingsIcon, 'settings'],
    ['bug reports', BugReportIcon, 'bug'],
    ['warnings', WarningIcon, 'triangle-alert'],
    ['feedback', RaisedHandIcon, 'hand'],
  ])('binds %s to its Lucide glyph', (_label, Icon, glyph) => {
    expect(glyphOf(renderToString(<Icon />))).toBe(glyph);
  });

  it('keeps the assistant bot apart from the Orchestrator orbit', () => {
    expect(AgentAssistantIcon).not.toBe(AppAdvisorIcon);
  });

  it.each([
    ['branch', GitBranch, 'git-branch'],
    ['commit', GitCommitIcon, 'git-commit'],
    ['merge', GitMergeIcon, 'git-merge'],
    ['merge queue', GitMergeQueueIcon, 'git-merge-queue'],
    ['pull request', GitPullRequestIcon, 'git-pull-request'],
    [
      'closed pull request',
      GitPullRequestClosedIcon,
      'git-pull-request-closed',
    ],
    ['draft', GitDraftIcon, 'git-pull-request-draft'],
    ['merge conflict', GitMergeConflictIcon, 'alert'],
    ['fork', GitForkIcon, 'repo-forked'],
    ['repository', RepoIcon, 'repo'],
  ])('binds the Git %s concept to its official Octicon', (_l, Icon, glyph) => {
    expect(glyphOf(renderToString(<Icon />))).toBe(glyph);
  });

  it('draws merged, merge conflict and the merge queue apart', () => {
    const merged = pathData(renderToString(<GitMergeIcon />));

    expect(pathData(renderToString(<GitMergeConflictIcon />))).not.toEqual(
      merged,
    );
    expect(pathData(renderToString(<GitMergeQueueIcon />))).not.toEqual(merged);
  });

  it.each([
    ['Link2', Link2, 'link'],
    ['ChevronsUpDown', ChevronsUpDown, 'chevrons-up-down'],
    ['WrenchIcon', WrenchIcon, 'wrench'],
    ['ImagePlus', ImagePlus, 'image-plus'],
    ['UnarchiveIcon', UnarchiveIcon, 'archive-restore'],
    ['AutoplayIcon', AutoplayIcon, 'circle-play'],
    ['RerunIcon', RerunIcon, 'rotate-ccw'],
    ['Sparkles', Sparkles, 'sparkles'],
    ['FileDiff', FileDiff, 'file-diff'],
    ['FolderGit2', FolderGit2, 'repo'],
  ])('applies the %s meaning override', (_label, Icon, glyph) => {
    expect(glyphOf(renderToString(<Icon />))).toBe(glyph);
  });

  it.each([
    ['Claude', ClaudeIcon, 'ClaudeLogo'],
    ['GitHub', GitHubIcon, 'mark-github'],
    ['Git', GitIcon, 'git'],
    ['Windows', WindowsPlatformIcon, 'microsoft'],
  ])('keeps the %s brand mark', (_label, Icon, glyph) => {
    expect(glyphOf(renderToString(<Icon />))).toBe(glyph);
  });

  it('keeps the GitHub mark defaults after moving off the repository logo', () => {
    expect(renderToString(<GitHubIcon />)).toMatch(
      /width="14px"[^>]*height="14px"/,
    );
    expect(renderToString(<Github />)).toMatch(
      /width="24px"[^>]*height="24px"/,
    );
  });

  it('adapts repository logos to the icon size and accessibility contract', () => {
    const html = renderToString(
      <ClaudeIcon size={20} className="shrink-0" ariaHidden={false} />,
    );

    expect(html).toContain('width="20px"');
    expect(html).toContain('height="20px"');
    expect(html).toContain('style="width:20px;height:20px"');
    expect(html).toContain('class="shrink-0"');
    expect(html).toContain('aria-hidden="false"');
    expect(html).toContain('data-app-icon="true"');
    expect(glyphOf(html)).toBe('ClaudeLogo');
    expect(renderToString(<ClaudeIcon />)).toContain('width="16px"');
  });

  it('uses plain panel outlines and dividers without open arrows', () => {
    const panels = [
      [AppIcons.BottombarHiddenBottomWideIcon, 'panel-bottom', 'M3 15h18'],
      [AppIcons.SidebarHiddenLeftWideIcon, 'panel-left', 'M9 3v18'],
      [AppIcons.SidebarHiddenRightWideIcon, 'panel-right', 'M15 3v18'],
    ] as const;
    for (const [Icon, glyph, divider] of panels) {
      const html = renderToString(<Icon />);
      expect(glyphOf(html)).toBe(glyph);
      expect(html.match(/<rect /g)).toHaveLength(1);
      expect(pathData(html)).toEqual([divider]);
      expect(html.split('>')[0]).toContain('fill="none"');
    }
  });

  it('keeps the 3x3 app grid as nine filled dots', () => {
    const html = renderToString(<IconDotGrid3x3 />);
    expect(glyphOf(html)).toBe('grip-fill1');
    expect(html.match(/<circle /g)).toHaveLength(9);
    expect(html.split('>')[0]).toContain('fill="currentColor"');
    expect(html).not.toContain('<rect');
  });

  it('uses a filled close circle with an X cutout and a filled review star', () => {
    const close = renderToString(<AppIcons.ClearFilledIcon />);
    const review = renderToString(<AppIcons.StarSquareIcon />);
    expect(close.split('>')[0]).toContain('fill="currentColor"');
    expect(close).toContain('fill-rule="evenodd"');
    expect(close).toContain('stroke="none"');
    expect(review.split('>')[0]).toContain('fill="currentColor"');
    expect(glyphOf(review)).toBe('star-fill1');
    expect(review).not.toContain('fill-rule="evenodd"');
    expect(review).toContain('stroke-width="2"');
  });

  it('keeps the code graph and pipeline icon families visually distinct', () => {
    expect(glyphOf(renderToString(<GraphIcon />))).toBe('network');
    expect(glyphOf(renderToString(<PipelineIcon />))).toBe('workflow');
  });

  it('uses the shared map glyph for every plan icon alias', () => {
    const shared = renderToString(<SharedPlanModeIcon />);

    expect(renderToString(<PlanModeIcon />)).toBe(shared);
    expect(renderToString(<PlansIcon />)).toBe(shared);
    expect(glyphOf(shared)).toBe('map');
  });

  it('allows class-based dimensions unless an explicit size is provided', () => {
    const classSized = renderToString(<SettingsIcon className="h-4 w-4" />);
    const explicitlySized = renderToString(<SettingsIcon size={16} />);

    expect(classSized).toContain('class="h-4 w-4"');
    expect(classSized).not.toContain('style="width:14px;height:14px"');
    expect(explicitlySized).toContain('style="width:14px;height:14px"');
  });
});

describe('drawnStrokeWidth', () => {
  const strokeOf = (html: string): string | undefined =>
    /stroke-width:([\d.]+)/.exec(html)?.[1];

  it('draws a Lucide line at the requested CSS px for its rendered tier', () => {
    expect(
      Number(
        strokeOf(
          renderToString(
            <AppIcons.PersonIcon size={14} drawnStrokeWidth={1.5} />,
          ),
        ),
      ),
    ).toBeCloseTo((1.5 * 24) / 14, 3);
    expect(
      Number(
        strokeOf(
          renderToString(
            <AppIcons.PersonIcon size={20} drawnStrokeWidth={1.5} />,
          ),
        ),
      ),
    ).toBeCloseTo(1.8, 3);
  });

  it('leaves the catalog stroke alone without it, and ignores filled artwork', () => {
    expect(strokeOf(renderToString(<AppIcons.PersonIcon size={14} />))).toBe(
      undefined,
    );
    const merge = renderToString(
      <AppIcons.GitMergeIcon size={14} drawnStrokeWidth={1.5} />,
    );
    expect(strokeOf(merge)).toBe(undefined);
    expect(merge).not.toContain('drawnStrokeWidth');
  });
});
