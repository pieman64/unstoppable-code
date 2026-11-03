/**
 * UI still waiting to be unified, from the standardization audit of develop
 * at 0ba22ed2518 (2026-11-01), in priority order. Status as of 2026-11-01:
 * the overlays ratchet is merging; headings, disclosure, avatars, search
 * fields and progress are being migrated. Update it as each family
 * converges: drop the item and add a sheet for its shared component in
 * `componentsLabCatalog.tsx`.
 */

/** Where a family's unification stands today. */
export type PendingStatus = 'merging' | 'in-progress' | 'waiting';

/** A family with no legacy ratchet yet. */
export interface PendingUnification {
  readonly id: string;
  readonly status: PendingStatus;
  /** What the UI is, in product words. */
  readonly name: string;
  /** How much is left, in one short line. */
  readonly count: string;
  /** The shared components that exist today, with how many files use them. */
  readonly shared: readonly string[];
  /**
   * Where the copies live: repo-relative paths. A name after a colon is a
   * copy defined inside that file.
   */
  readonly copies: readonly string[];
  /** The planned shared component (and ratchet). */
  readonly planned: string;
  /** What decides it, or a caveat. */
  readonly note?: string;
}

/** A family whose ratchet exists, with what its baseline still allows. */
export interface RatchetBacklog {
  readonly family: string;
  readonly remaining: number;
  /** What the count is made of. */
  readonly breakdown: string;
  readonly baseline: string;
}

const DESKTOP = 'apps/desktop-app/src/renderer/src/components';
const UI_SHARED = 'packages/ui-shared/src/components';
const UI_APP = 'packages/ui-app/src';

export const PENDING_UNIFICATIONS: readonly PendingUnification[] = [
  {
    id: 'overlays',
    status: 'merging',
    name: 'Overlays: dialogs and popovers',
    count:
      '27 hand-built backdrops · 62 own portals · 15 bespoke popover shells',
    shared: [
      'DialogModal (140 files)',
      'ConfirmDialog (47)',
      'FloatingMenu (70)',
      'Sheet',
      'RichHoverTooltip',
    ],
    copies: [
      `${DESKTOP}/chat/ScheduleMessageModal.tsx`,
      `${DESKTOP}/chat/ChatPluginsModal.tsx`,
      `${DESKTOP}/activity/PipelineExecutionDetailModal.tsx`,
      `${DESKTOP}/worktree/WorktreeBranchInfoDialog.tsx`,
      `${DESKTOP}/browser/BrowserSignInDialog.tsx`,
      `${DESKTOP}/shared/linear/LinearTicketPickerModal.tsx`,
      `${DESKTOP}/chat/ArchivedChatsPopover.tsx`,
      `${DESKTOP}/shared/AttachmentPreviewPopover.tsx`,
      `${DESKTOP}/chat/TurnDiffPopover.tsx`,
      `${DESKTOP}/resource-diagnostics/ResourceDiagnosticsPopover.tsx`,
      `${DESKTOP}/code-review/ReviewCommentPopover.tsx`,
      `${UI_SHARED}/PipelineStatusPopover.tsx`,
      `${UI_SHARED}/TerminalStatusPopover.tsx`,
    ],
    planned:
      'DialogModal, FloatingMenu and one shared Popover shell, plus an overlay ratchet',
    note: 'Backdrops are fixed inset-0 overlays built by hand; portals are createPortal calls outside ui-shared.',
  },
  {
    id: 'headings',
    status: 'in-progress',
    name: 'Page and section headings',
    count:
      '60 files with their own <h1> · 206 with local <h2>–<h4> · 9 section-header variants',
    shared: ['PageHeader (18 files)', 'SettingsRowsSection (11)'],
    copies: [
      `${DESKTOP}/worktree/FormSectionHeading.tsx`,
      `${DESKTOP}/overview/WorkspaceReadinessOverview.tsx: OverviewSectionHeader`,
      `${DESKTOP}/chat/ProxyAccountUsage.tsx: UsageSectionHeader`,
      `${UI_SHARED}/WorkspaceSectionHeader.tsx`,
      `${UI_SHARED}/ModelGroupHeader.tsx`,
      `${UI_SHARED}/PluginDetailSectionHeading.tsx`,
      `${DESKTOP}/sidebar/SidebarCoworkWorkspaceRow.tsx: SidebarItemGroupHeader`,
      `${DESKTOP}/home/HomeBranchPicker.tsx: PickerMenuSectionLabel`,
    ],
    planned: 'PageHeader and SettingsRowsSection, plus a heading ratchet',
  },
  {
    id: 'tooltips',
    status: 'waiting',
    name: 'Tooltips',
    count: 'native title= in 528 files',
    shared: ['Tooltip (176 files)', 'ActionTooltip'],
    copies: ['title= attributes across desktop, web and the shared packages'],
    planned: 'Tooltip and ActionTooltip',
    note: 'Needs a split: controls move to Tooltip; truncated text may keep title.',
  },
  {
    id: 'tables',
    status: 'waiting',
    name: 'Tables',
    count:
      '21 files with a raw <table> · UnifiedTable in 5 · ResourceTable unused',
    shared: ['UnifiedTable (plugins and MCP only)', 'ResourceTable (unused)'],
    copies: [
      `${DESKTOP}/pipeline/PipelineListView.tsx`,
      `${DESKTOP}/panels/automations/AutomationsPanel.tsx`,
      `${DESKTOP}/pages/McpServersTab.tsx`,
      `${DESKTOP}/pages/usage/MetricsBreakdownPanel.tsx`,
      `${UI_APP}/settings/organization/statistics/StatTable.tsx`,
      `${UI_APP}/settings/memory/OpsView.tsx`,
      `${UI_APP}/workflows/WorkflowsLibrary.tsx`,
      `${UI_APP}/workflows/WorkflowsRuns.tsx`,
      `${UI_SHARED}/InvoicesTable.tsx`,
      `${UI_SHARED}/CreditLedgerTable.tsx`,
      `${UI_SHARED}/BillingHistoryTable.tsx`,
    ],
    planned: 'One shared DataTable',
    note: 'docs/design/layout.md lists the generic table as a known gap.',
  },
  {
    id: 'disclosure',
    status: 'in-progress',
    name: 'Disclosure',
    count: 'raw <details> in 21 files · 7 disclosure components',
    shared: [],
    copies: [
      `${UI_SHARED}/AdvancedDisclosure.tsx`,
      `${UI_SHARED}/CompletedRunsDisclosure.tsx`,
      `${UI_SHARED}/HiddenItemsDisclosureRow.tsx`,
      `${DESKTOP}/settings/FileLabelsSection.tsx: SectionDisclosureButton`,
      `${DESKTOP}/settings/TelemetryDisclosure.tsx`,
      `${UI_SHARED}/UsageIndicator.tsx: UsageDisclosureChevron`,
      `${UI_SHARED}/PanelSection.tsx (collapsible)`,
    ],
    planned: 'One Disclosure',
  },
  {
    id: 'avatars',
    status: 'in-progress',
    name: 'Avatars',
    count: 'DisplayAvatar in 4 files · 6 components draw their own',
    shared: ['DisplayAvatar (4 files)'],
    copies: [
      `${UI_SHARED}/PlanReviewThread.tsx: CommentAvatar`,
      `${UI_SHARED}/ledger/LedgerActorAvatar.tsx`,
      `${UI_APP}/settings/organization/MemberAvatar.tsx`,
      `${UI_APP}/code/shell/SidebarAccountFooter.tsx: SidebarPersonAvatar`,
      `${UI_SHARED}/ProjectAvatarBadge.tsx`,
      'apps/web/src/components/team/profile/ProfileIdentityEditor.tsx: AvatarEditor',
    ],
    planned: 'DisplayAvatar with its sizes and shapes',
  },
  {
    id: 'search-fields',
    status: 'in-progress',
    name: 'Search fields and selects',
    count:
      '4 search fields that skip SearchField · 5 ControlSelect callers left',
    shared: ['SearchField', 'SettingsSelect'],
    copies: [
      `${UI_SHARED}/MarketplaceSearchField.tsx`,
      `${UI_APP}/local-memory/MemoryPanel.tsx: MemorySearchField`,
      `${UI_APP}/workflows/WorkflowsLibrary.tsx: WorkflowsSearchField`,
      `${UI_APP}/capability/CustomizeSearchRow.tsx`,
      `${UI_SHARED}/ControlSelect.tsx (deprecated)`,
    ],
    planned: 'SearchField and SettingsSelect',
  },
  {
    id: 'progress',
    status: 'in-progress',
    name: 'Progress',
    count: '5 progress components',
    shared: [],
    copies: [
      `${UI_SHARED}/CircularProgress.tsx`,
      `${UI_SHARED}/LinearProgress.tsx`,
      `${UI_SHARED}/DagProgressBar.tsx`,
      `${UI_APP}/code/activity/pipeline/PipelineRunDetail.tsx: PipelineRunDagProgressBar`,
      `${UI_APP}/code/activity/background-tray/RunRow.tsx: DagProgressDots`,
    ],
    planned: 'One progress set',
  },
];

export const RATCHET_BACKLOG: readonly RatchetBacklog[] = [
  {
    family: 'Spacing',
    remaining: 2623,
    breakdown: '753 space-between, 1870 margin',
    baseline: 'docs/design/legacy-spacing.baseline.json',
  },
  {
    family: 'Icons',
    remaining: 892,
    breakdown:
      '611 dimension props, 135 size classes, 43 off-scale, 103 local wrappers',
    baseline: 'docs/design/legacy-icons.baseline.json',
  },
  {
    family: 'Buttons',
    remaining: 666,
    breakdown: '650 raw buttons, 16 role="button", across 404 files',
    baseline: 'docs/design/legacy-buttons.baseline.json',
  },
  {
    family: 'Markers',
    remaining: 232,
    breakdown: '100 pills, 80 dots, 52 components',
    baseline: 'docs/design/legacy-markers.baseline.json',
  },
  {
    family: 'Feedback',
    remaining: 146,
    breakdown:
      '5 tinted boxes, 64 error texts, 68 role="alert", 9 empty recipes',
    baseline: 'docs/design/legacy-feedback.baseline.json',
  },
  {
    family: 'Loading',
    remaining: 76,
    breakdown:
      '10 LoadingPlaceholder, 20 loading-text strings, 46 raw pulse classes',
    baseline: 'docs/design/legacy-loading.baseline.json',
  },
  {
    family: 'Facts',
    remaining: 10,
    breakdown: '10 <dl> elements',
    baseline: 'docs/design/legacy-facts.baseline.json',
  },
  {
    family: 'Fields',
    remaining: 0,
    breakdown: 'Done',
    baseline: 'docs/design/legacy-fields.baseline.json',
  },
];
