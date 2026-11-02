/**
 * Source-level guard for CAN-2799 ("slow tooltips"): native `title=` tooltips
 * lag noticeably on macOS, so interactive controls must get their hover help
 * from the rich `Tooltip` / `ActionTooltip` / `RichHoverTooltip` components,
 * which open on mouseenter/focus.
 *
 * Many of the components below are too store/IPC-bound to mount in jsdom, so
 * this scans their JSX for `title=` on interactive intrinsic elements
 * (`button`, `a`, `input`, `label`, `select`, `textarea`, `summary`, or
 * anything with `role="button"`). Component props named `title` (`DialogModal`,
 * `PanelSection`, …) and truncation titles on plain text are intentionally
 * not matched.
 *
 * Add a file here once it has been migrated so it cannot regress.
 */
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';

const REPO_ROOT = process.cwd();
const RENDERER = 'apps/desktop-app/src/renderer/src';
const UI_SHARED = 'packages/ui-shared/src/components';
const UI_APP = 'packages/ui-app/src';

/** Files whose interactive controls have been migrated to rich tooltips. */
const MIGRATED_FILES: readonly string[] = [
  `${RENDERER}/components/activity/FilesTreeTab.tsx`,
  `${RENDERER}/components/activity/PipelineTriggerModal.tsx`,
  `${RENDERER}/components/browser/BrowserBar.tsx`,
  `${RENDERER}/components/chat/MemoryUsedDialog.tsx`,
  `${RENDERER}/components/environments/EnvironmentUsageList.tsx`,
  `${RENDERER}/components/github/PrStatusBar.tsx`,
  `${RENDERER}/components/pages/AutomationsPage.tsx`,
  `${RENDERER}/components/pages/CollectionsTab.tsx`,
  `${RENDERER}/components/pages/SkillsTab.tsx`,
  `${RENDERER}/components/panels/AuxPanelWindow.tsx`,
  `${RENDERER}/components/settings/McpTab.tsx`,
  `${RENDERER}/components/terminal/TerminalList.tsx`,
  `${RENDERER}/components/worktree/WorktreeBranchInfoDialog.tsx`,
  `${RENDERER}/components/activity/ActivityOpenControl.tsx`,
  `${RENDERER}/components/activity/DevServerMenuItem.tsx`,
  `${RENDERER}/components/activity/DiffFileTree.tsx`,
  `${RENDERER}/components/activity/WorktreeLaunchButton.tsx`,
  `${RENDERER}/components/activity/details/PipelineAdvisorDetail.tsx`,
  `${RENDERER}/components/activity/details/PipelineChildExecution.tsx`,
  `${RENDERER}/components/app-advisor/AppAdvisorTitlebarCorner.tsx`,
  `${RENDERER}/components/archive/ArchivedContainerView.tsx`,
  `${RENDERER}/components/automations/form/ActivityFormBody.tsx`,
  `${RENDERER}/components/automations/calendar/DayWeekTimeGrid.tsx`,
  `${RENDERER}/components/automations/calendar/MonthGrid.tsx`,
  `${RENDERER}/components/browser/BrowserConsolePanel.tsx`,
  `${RENDERER}/components/browser/BrowserNetworkPanel.tsx`,
  `${RENDERER}/components/browser/BrowserRecordingPanel.tsx`,
  `${RENDERER}/components/browser/BrowserSnapshotsPanel.tsx`,
  `${RENDERER}/components/chat/DesktopSharedFileViewer.tsx`,
  `${RENDERER}/components/chat/FileSelectionMenu.tsx`,
  `${RENDERER}/components/chat/MonacoFileEditor.tsx`,
  `${RENDERER}/components/chat/TurnDiffPopover.tsx`,
  `${RENDERER}/components/chat/TurnDiffSummary.tsx`,
  `${RENDERER}/components/overview/NotificationsPanel.tsx`,
  `${RENDERER}/components/pages/McpServersTab.tsx`,
  `${RENDERER}/components/pages/PipelinesPage.tsx`,
  `${RENDERER}/components/pages/usage/ProviderUsageCards.tsx`,
  `${RENDERER}/components/pipeline/PipelineChatPanel.tsx`,
  `${RENDERER}/components/pipeline/PipelineListView.tsx`,
  `${RENDERER}/components/pipeline/PipelineSettingsPanel.tsx`,
  `${RENDERER}/components/pipeline/PipelineTableRow.tsx`,
  `${RENDERER}/components/pipeline/PipelineToolbar.tsx`,
  `${RENDERER}/components/pipeline/settings/ModelAliasesEditor.tsx`,
  `${RENDERER}/components/pipeline/settings/PluginCollectionsEditor.tsx`,
  `${RENDERER}/components/pipeline/settings/TriggerInputsEditor.tsx`,
  `${RENDERER}/components/pipeline/shared/KeyValueEditor.tsx`,
  `${RENDERER}/components/plan-explore/PlanVisualizerPanel.tsx`,
  `${RENDERER}/components/resource-diagnostics/ResourceDiagnosticsPopover.tsx`,
  `${RENDERER}/components/settings/ClaudeTab.tsx`,
  `${RENDERER}/components/settings/CodexTab.tsx`,
  `${RENDERER}/components/settings/EnvironmentsTab.tsx`,
  `${RENDERER}/components/environments/EnvironmentListParts.tsx`,
  `${RENDERER}/components/settings/FileLabelsSection.tsx`,
  `${RENDERER}/components/shared-containers/SharedContainerSidebarSection.tsx`,
  `${RENDERER}/components/shared/PlanActionControls.tsx`,
  `${RENDERER}/components/shared/search/SearchBar.tsx`,
  `${RENDERER}/components/sidebar/SidebarFooterBanner.tsx`,
  `${RENDERER}/components/standalone-chat/StandaloneArchiveViewer.tsx`,
  `${UI_APP}/code/terminal/TerminalSelectionMenu.tsx`,
  `${RENDERER}/components/watchers/WatcherFollowUpButton.tsx`,
  `${RENDERER}/components/worktree/AddRepoModal.tsx`,
  `${RENDERER}/components/worktree/AddRepoToWorktreeModal.tsx`,
  `${RENDERER}/components/worktree/BranchPicker.tsx`,
  `${RENDERER}/components/worktree/LabelField.tsx`,
  `${RENDERER}/components/worktree/SplitWorkspaceModal.tsx`,
  `${RENDERER}/components/worktree/VariableInsertDropdown.tsx`,
  `${RENDERER}/components/worktree/WorktreeItem.tsx`,
  `${RENDERER}/components/worktree/WorktreeManager.tsx`,
  `${RENDERER}/lib/panels/registry.tsx`,
  `${UI_SHARED}/ComposerSendButton.tsx`,
  `${UI_SHARED}/CopyButton.tsx`,
  `${UI_SHARED}/ExecutionActionButton.tsx`,
  `${UI_SHARED}/HeaderActionButton.tsx`,
  `${UI_SHARED}/MarkdownCodeBlock.tsx`,
  `${UI_SHARED}/MarketplacePluginInstall.tsx`,
  `${UI_SHARED}/PlanReviewThread.tsx`,
  `${UI_SHARED}/PluginsDiscoveryList.tsx`,
  `${UI_SHARED}/RowActions.tsx`,
  `${UI_SHARED}/SkillFileExplorer.tsx`,
  `${UI_SHARED}/SourceInfoButton.tsx`,
  `${UI_SHARED}/UsageGroup.tsx`,
  `${UI_SHARED}/UserBubble.tsx`,
  `${UI_SHARED}/chat/TurnDiffSummary.tsx`,
  `${UI_SHARED}/diff/DiffFileTree.tsx`,
  `${UI_SHARED}/panels/PanelTabBar.tsx`,
  `${UI_APP}/capability/PluginCatalogDetail.tsx`,
  `${UI_APP}/capability/PluginDetailHost.tsx`,
  `${UI_APP}/code/activity/FilesTab.tsx`,
  `${UI_APP}/code/shell/SidebarSurface.tsx`,
  `${UI_APP}/code/shell/WorktreeTopBar.tsx`,
  `${UI_APP}/home/OverviewCard.tsx`,
];

const INTERACTIVE_TAGS = new Set([
  'button',
  'a',
  'input',
  'label',
  'select',
  'textarea',
  'summary',
]);

interface OpenTag {
  tag: string;
  attrs: string;
  line: number;
}

/**
 * Yields every JSX open tag with its attribute text. Attribute values can
 * contain `>` inside `{...}` expressions (arrow functions, comparisons), so
 * the scan tracks brace depth instead of stopping at the first `>`.
 */
function openTags(source: string): OpenTag[] {
  const tags: OpenTag[] = [];
  const tagStart = /<([A-Za-z][A-Za-z0-9.]*)\b/g;
  let match: RegExpExecArray | null = tagStart.exec(source);
  while (match !== null) {
    let index = tagStart.lastIndex;
    let depth = 0;
    let end = -1;
    while (index < source.length) {
      const char = source[index];
      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
      } else if (depth === 0 && char === '>') {
        end = index;
        break;
      } else if (depth > 0 && (char === '"' || char === "'" || char === '`')) {
        index += 1;
        while (index < source.length && source[index] !== char) {
          if (source[index] === '\\') index += 1;
          index += 1;
        }
      }
      index += 1;
    }
    if (end >= 0) {
      tags.push({
        tag: match[1],
        attrs: source.slice(tagStart.lastIndex, end),
        line: source.slice(0, match.index).split('\n').length,
      });
    }
    match = tagStart.exec(source);
  }
  return tags;
}

function nativeInteractiveTitles(source: string): string[] {
  return openTags(source)
    .filter(({ tag, attrs }) => {
      const intrinsic = /^[a-z]/.test(tag);
      if (!intrinsic || !/(^|\s)title=/.test(attrs)) return false;
      return INTERACTIVE_TAGS.has(tag) || /role=["']button["']/.test(attrs);
    })
    .map(({ tag, line }) => `<${tag}> at line ${line}`);
}

describe('native title tooltips on interactive controls (CAN-2799)', () => {
  it.each(MIGRATED_FILES)('%s uses rich tooltips only', (relativePath) => {
    const source = readFileSync(join(REPO_ROOT, relativePath), 'utf8');
    expect(nativeInteractiveTitles(source)).toEqual([]);
  });

  it('detects a native title on an interactive element', () => {
    const offender = `
      <button type="button" onClick={() => go(a > b)} title="Rename">
        <Icon />
      </button>`;
    expect(nativeInteractiveTitles(offender)).toEqual(['<button> at line 2']);
    expect(
      nativeInteractiveTitles(
        '<p className="truncate" title={name}>{name}</p>',
      ),
    ).toEqual([]);
    expect(nativeInteractiveTitles('<DialogModal title="Rename" />')).toEqual(
      [],
    );
  });
});
