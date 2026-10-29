export const ACTIVITY_GALLERY_SECTION_IDS = [
  'summary',
  'changed-files',
  'pull-request',
  'background-processes',
  'mcp-servers',
  'plans',
  'pipeline-runs',
  'scripts',
  'hooks',
  'terminals',
  'todo',
  'notes',
  'prompts',
  'attachments',
] as const;

export type ActivityGallerySectionId =
  (typeof ACTIVITY_GALLERY_SECTION_IDS)[number];

export type ActivityGalleryIcon =
  | 'summary'
  | 'files'
  | 'pull-request'
  | 'process'
  | 'mcp'
  | 'plans'
  | 'pipeline'
  | 'scripts'
  | 'hooks'
  | 'terminal'
  | 'tasks'
  | 'notes'
  | 'prompts'
  | 'attachments';

export type ActivityGalleryAction =
  | 'refresh'
  | 'review'
  | 'create-pr'
  | 'cancel'
  | 'settings'
  | 'pause'
  | 'resume'
  | 'add'
  | 'import'
  | 'dispatch'
  | 'filter';

export type ActivityGalleryTone =
  | 'neutral'
  | 'accent'
  | 'warning'
  | 'positive'
  | 'destructive';

export interface ActivityGalleryBodyRow {
  readonly label: string;
  readonly detail?: string;
  readonly meta?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly tone?: ActivityGalleryTone;
}

export interface ActivityGalleryBody {
  readonly description?: string;
  readonly rows?: readonly ActivityGalleryBodyRow[];
  readonly progress?: number;
  readonly progressLabel?: string;
}

export interface ActivityGalleryState {
  readonly id: string;
  readonly label: string;
  readonly note: string;
  readonly presentation: 'card' | 'action-only' | 'hidden';
  readonly title?: string;
  readonly subtitle?: string;
  readonly action?: ActivityGalleryAction;
  readonly actionLabel?: string;
  /** State selected when the primary card action is invoked. */
  readonly actionTargetStateId?: string;
  readonly tone?: ActivityGalleryTone;
  readonly defaultCollapsed?: boolean;
  readonly body?: ActivityGalleryBody;
}

export interface ActivityGallerySection {
  readonly id: ActivityGallerySectionId;
  readonly title: string;
  readonly icon: ActivityGalleryIcon;
  readonly initialStateId: string;
  readonly states: readonly ActivityGalleryState[];
}

const hidden = (
  id: string,
  label: string,
  note: string,
): ActivityGalleryState => ({
  id,
  label,
  note,
  presentation: 'hidden',
});

export const ACTIVITY_GALLERY_SECTIONS: readonly ActivityGallerySection[] = [
  {
    id: 'summary',
    title: 'Summary',
    icon: 'summary',
    initialStateId: 'ready',
    states: [
      {
        id: 'empty',
        label: 'No summary',
        note: 'Visible because Refresh is still a useful action.',
        presentation: 'card',
        subtitle: 'No summary yet',
        action: 'refresh',
        actionTargetStateId: 'generating',
        body: { description: 'Generate a summary of the current worktree.' },
      },
      {
        id: 'generating',
        label: 'Generating',
        note: 'Refresh is busy while the first summary is produced.',
        presentation: 'card',
        subtitle: 'Generating…',
        action: 'cancel',
        actionTargetStateId: 'empty',
        tone: 'accent',
        body: { progress: 42, progressLabel: 'Reading recent work' },
      },
      {
        id: 'ready',
        label: 'Ready',
        note: 'Fresh summary with details and refresh action.',
        presentation: 'card',
        subtitle: 'Updated just now',
        action: 'refresh',
        actionTargetStateId: 'generating',
        body: {
          description:
            'Activity sidebar polish is ready for review across light and dark themes.',
          rows: [
            { label: 'Card geometry normalized', meta: '12 sections' },
            { label: 'Hairline borders verified', meta: 'Retina + standard' },
          ],
        },
      },
      {
        id: 'stale',
        label: 'Stale',
        note: 'Old content remains readable and can be refreshed.',
        presentation: 'card',
        subtitle: 'Updated 10d ago',
        action: 'refresh',
        actionTargetStateId: 'generating',
        body: {
          description:
            'This summary predates the most recent conversation turns.',
        },
      },
      {
        id: 'failed',
        label: 'Refresh failed',
        note: 'Warning tone is reserved for a state requiring attention.',
        presentation: 'card',
        subtitle: 'Could not refresh',
        action: 'refresh',
        actionTargetStateId: 'generating',
        tone: 'warning',
        body: { description: 'The last successful summary is still shown.' },
      },
    ],
  },
  {
    id: 'changed-files',
    title: 'Changed Files',
    icon: 'files',
    initialStateId: 'modified',
    states: [
      hidden(
        'empty',
        'Clean',
        'No files and no section action: the card is hidden.',
      ),
      {
        id: 'modified',
        label: 'Modified files',
        note: 'Warning icon indicates unreviewed local changes.',
        presentation: 'card',
        subtitle: '3 files',
        action: 'review',
        tone: 'warning',
        body: {
          rows: [
            { label: 'PanelSection.tsx', additions: 14, deletions: 2 },
            { label: 'ActivityPanel.tsx', additions: 7, deletions: 1 },
            {
              label: 'activity-sidebar.spec.mjs',
              additions: 26,
              deletions: 0,
            },
          ],
        },
      },
      {
        id: 'filtered',
        label: 'Filtered',
        note: 'Review and filter icon actions share the same button primitive.',
        presentation: 'card',
        subtitle: '12 of 657 files',
        action: 'filter',
        tone: 'warning',
        body: {
          rows: [{ label: 'packages/ui-shared', detail: '12 matching files' }],
        },
      },
      {
        id: 'reviewed',
        label: 'Reviewed',
        note: 'Files remain present after the review surface has been opened.',
        presentation: 'card',
        subtitle: '3 files · reviewed',
        action: 'review',
        body: { rows: [{ label: 'All changes reviewed', tone: 'positive' }] },
      },
      {
        id: 'conflicted',
        label: 'Conflicts',
        note: 'A warning state keeps the section visible when collapsed.',
        presentation: 'card',
        subtitle: '2 conflicts',
        action: 'review',
        tone: 'warning',
        defaultCollapsed: true,
        body: {
          rows: [{ label: 'Resolve merge conflicts', tone: 'destructive' }],
        },
      },
    ],
  },
  {
    id: 'pull-request',
    title: 'Pull Requests',
    icon: 'pull-request',
    initialStateId: 'open',
    states: [
      hidden(
        'empty',
        'No pull request',
        'No PR-specific content: the section is hidden.',
      ),
      {
        id: 'creating',
        label: 'Creating',
        note: 'Creation progress keeps the section visible.',
        presentation: 'card',
        subtitle: 'Creating pull request…',
        action: 'cancel',
        tone: 'accent',
        body: { progress: 64, progressLabel: 'Pushing branch' },
      },
      {
        id: 'open',
        label: 'Open',
        note: 'Normal open PR with passing checks.',
        presentation: 'card',
        subtitle: '1 pull request',
        action: 'review',
        body: {
          rows: [
            { label: '#2841 Activity sidebar polish', meta: 'Open' },
            { label: 'Checks passing', tone: 'positive', meta: '12/12' },
          ],
        },
      },
      {
        id: 'draft',
        label: 'Draft',
        note: 'Draft PR remains neutral.',
        presentation: 'card',
        subtitle: '1 draft pull request',
        action: 'review',
        body: {
          rows: [{ label: '#2841 Activity sidebar polish', meta: 'Draft' }],
        },
      },
      {
        id: 'checks-failing',
        label: 'Checks failing',
        note: 'Failed checks use the warning channel.',
        presentation: 'card',
        subtitle: '1 pull request · checks failing',
        action: 'review',
        tone: 'warning',
        body: {
          rows: [
            { label: 'UI Automation', tone: 'destructive', meta: 'Failed' },
          ],
        },
      },
      {
        id: 'merged',
        label: 'Merged',
        note: 'Terminal success remains available for reference.',
        presentation: 'card',
        subtitle: '1 merged pull request',
        action: 'review',
        body: {
          rows: [
            {
              label: '#2841 Activity sidebar polish',
              tone: 'positive',
              meta: 'Merged',
            },
          ],
        },
      },
      {
        id: 'closed',
        label: 'Closed',
        note: 'Closed without merge remains available for reference.',
        presentation: 'card',
        subtitle: '1 closed pull request',
        action: 'review',
        body: {
          rows: [{ label: '#2841 Activity sidebar polish', meta: 'Closed' }],
        },
      },
    ],
  },
  {
    id: 'background-processes',
    title: 'Agent Background Processes',
    icon: 'process',
    initialStateId: 'running',
    states: [
      hidden(
        'empty',
        'No activity',
        'No process and no useful action: the card is hidden.',
      ),
      {
        id: 'queued',
        label: 'Queued',
        note: 'Queued background work is waiting for an execution slot.',
        presentation: 'card',
        subtitle: '1 queued',
        action: 'cancel',
        actionTargetStateId: 'stopped',
        body: { rows: [{ label: 'Indexing project', meta: 'Queued' }] },
      },
      {
        id: 'running',
        label: 'Running',
        note: 'Live process with streaming output.',
        presentation: 'card',
        subtitle: '1 running',
        action: 'cancel',
        actionTargetStateId: 'stopped',
        tone: 'accent',
        body: { rows: [{ label: 'Indexing project', meta: '0:18' }] },
      },
      {
        id: 'completed',
        label: 'Completed',
        note: 'Completed output stays inspectable.',
        presentation: 'card',
        subtitle: '1 completed',
        body: { rows: [{ label: 'Indexed 2,418 files', tone: 'positive' }] },
      },
      {
        id: 'failed',
        label: 'Failed',
        note: 'Failure warning remains visible when collapsed.',
        presentation: 'card',
        subtitle: '1 failed',
        tone: 'warning',
        body: {
          rows: [
            { label: 'Index process exited with code 1', tone: 'destructive' },
          ],
        },
      },
      {
        id: 'stopped',
        label: 'Stopped',
        note: 'User-stopped background work remains inspectable.',
        presentation: 'card',
        subtitle: '1 stopped',
        body: { rows: [{ label: 'Indexing project', meta: 'Stopped' }] },
      },
    ],
  },
  {
    id: 'mcp-servers',
    title: 'MCP Servers',
    icon: 'mcp',
    initialStateId: 'connected',
    states: [
      {
        id: 'empty',
        label: 'No servers',
        note: 'Refresh keeps the empty card actionable and visible.',
        presentation: 'card',
        subtitle: 'No servers',
        action: 'refresh',
        body: { description: 'No MCP servers were detected.' },
      },
      {
        id: 'loading',
        label: 'Refreshing',
        note: 'Discovery in progress.',
        presentation: 'card',
        subtitle: 'Refreshing…',
        action: 'refresh',
        tone: 'accent',
        body: { progress: 36, progressLabel: 'Detecting servers' },
      },
      {
        id: 'connected',
        label: 'Connected',
        note: 'Healthy servers in the expanded list.',
        presentation: 'card',
        subtitle: '3 servers',
        action: 'refresh',
        body: {
          rows: [
            {
              label: 'Figma',
              detail: 'Agent provider',
              meta: 'Connected',
              tone: 'positive',
            },
            {
              label: 'Linear',
              detail: 'Agent provider',
              meta: 'Connected',
              tone: 'positive',
            },
            {
              label: 'Sentry',
              detail: 'Standalone',
              meta: 'Connected',
              tone: 'positive',
            },
          ],
        },
      },
      {
        id: 'auth-required',
        label: 'Auth required',
        note: 'Authentication warning uses fg-warning.',
        presentation: 'card',
        subtitle: '2 connected · 1 needs attention',
        action: 'refresh',
        tone: 'warning',
        body: {
          rows: [
            { label: 'Notion', meta: 'Sign in required', tone: 'warning' },
          ],
        },
      },
      {
        id: 'unavailable',
        label: 'Unavailable',
        note: 'Connection failure keeps Refresh available.',
        presentation: 'card',
        subtitle: '1 server unavailable',
        action: 'refresh',
        tone: 'warning',
        body: {
          rows: [
            { label: 'Stripe', meta: 'Connection failed', tone: 'destructive' },
          ],
        },
      },
    ],
  },
  {
    id: 'plans',
    title: 'Plans',
    icon: 'plans',
    initialStateId: 'empty',
    states: [
      {
        id: 'empty',
        label: 'Action only',
        note: 'The whole card is the Import plan action.',
        presentation: 'action-only',
        title: 'Import plan',
        action: 'import',
        actionTargetStateId: 'tracked',
      },
      {
        id: 'tracked',
        label: 'Tracked',
        note: 'Visible plans with import action.',
        presentation: 'card',
        subtitle: '2 tracked',
        action: 'import',
        body: {
          rows: [
            { label: 'Sidebar activity polish', meta: 'In progress' },
            { label: 'Panel layout parity', meta: 'Ready' },
          ],
        },
      },
      {
        id: 'hidden-plans',
        label: 'Hidden plans',
        note: 'Subtitle reports visible and hidden counts.',
        presentation: 'card',
        subtitle: '1 tracked · 2 hidden',
        action: 'import',
        body: { rows: [{ label: 'Sidebar activity polish', meta: 'Visible' }] },
      },
    ],
  },
  {
    id: 'pipeline-runs',
    title: 'Pipeline Runs',
    icon: 'pipeline',
    initialStateId: 'running',
    states: [
      {
        id: 'empty',
        label: 'Action only',
        note: 'The whole card dispatches a pipeline.',
        presentation: 'action-only',
        title: 'Dispatch pipeline',
        action: 'dispatch',
        actionTargetStateId: 'pending',
      },
      {
        id: 'pending',
        label: 'Pending',
        note: 'Pending execution can be cancelled.',
        presentation: 'card',
        subtitle: '1 active, 0 completed',
        action: 'cancel',
        actionTargetStateId: 'cancelled',
        tone: 'accent',
        body: { rows: [{ label: 'Release checks', meta: 'Pending' }] },
      },
      {
        id: 'running',
        label: 'Running',
        note: 'Active pipeline uses the warning/attention channel.',
        presentation: 'card',
        subtitle: '1 active, 2 completed',
        action: 'cancel',
        actionTargetStateId: 'cancelled',
        tone: 'warning',
        body: { progress: 58, progressLabel: 'UI automation · 7/12' },
      },
      {
        id: 'paused',
        label: 'Paused',
        note: 'Pause state exposes Resume.',
        presentation: 'card',
        subtitle: '1 paused, 2 completed',
        action: 'resume',
        actionTargetStateId: 'running',
        tone: 'warning',
        body: { rows: [{ label: 'Release checks', meta: 'Paused at review' }] },
      },
      {
        id: 'completed',
        label: 'Completed',
        note: 'Successful history remains expandable.',
        presentation: 'card',
        subtitle: '0 active, 3 completed',
        action: 'dispatch',
        actionTargetStateId: 'pending',
        body: {
          rows: [{ label: 'Release checks', meta: 'Passed', tone: 'positive' }],
        },
      },
      {
        id: 'failed',
        label: 'Failed',
        note: 'Failed pipeline warns while collapsed.',
        presentation: 'card',
        subtitle: '0 active, 1 failed',
        action: 'dispatch',
        actionTargetStateId: 'pending',
        tone: 'warning',
        body: {
          rows: [
            { label: 'UI automation', meta: 'Failed', tone: 'destructive' },
          ],
        },
      },
      {
        id: 'cancelled',
        label: 'Cancelled',
        note: 'Cancelled history remains expandable and can be dispatched again.',
        presentation: 'card',
        subtitle: '0 active, 1 cancelled',
        action: 'dispatch',
        actionTargetStateId: 'pending',
        body: { rows: [{ label: 'Release checks', meta: 'Cancelled' }] },
      },
    ],
  },
  {
    id: 'scripts',
    title: 'Scripts',
    icon: 'scripts',
    initialStateId: 'configured',
    states: [
      {
        id: 'empty',
        label: 'Not configured',
        note: 'Settings is a useful action, so the empty card remains.',
        presentation: 'card',
        subtitle: 'None configured',
        action: 'settings',
        body: { description: 'Configure project scripts in Settings.' },
      },
      {
        id: 'configured',
        label: 'Configured',
        note: 'Ready scripts with Settings action.',
        presentation: 'card',
        subtitle: '3 configured',
        action: 'settings',
        body: {
          rows: [
            { label: 'Test', meta: 'Run' },
            { label: 'Lint', meta: 'Run' },
            { label: 'Build', meta: 'Run' },
          ],
        },
      },
      {
        id: 'running',
        label: 'Running',
        note: 'An active run warns while collapsed.',
        presentation: 'card',
        subtitle: '3 configured · 1 running',
        action: 'cancel',
        actionTargetStateId: 'stopping',
        tone: 'warning',
        body: { progress: 71, progressLabel: 'Test · 248/350' },
      },
      {
        id: 'stopping',
        label: 'Stopping',
        note: 'The stop request remains visible until the process exits.',
        presentation: 'card',
        subtitle: '3 configured · stopping 1 run',
        action: 'settings',
        tone: 'warning',
        body: { rows: [{ label: 'Test', meta: 'Stopping…' }] },
      },
      {
        id: 'success',
        label: 'Succeeded',
        note: 'The latest successful run remains inspectable.',
        presentation: 'card',
        subtitle: '3 configured · last run passed',
        action: 'settings',
        body: { rows: [{ label: 'Test', meta: 'Passed', tone: 'positive' }] },
      },
      {
        id: 'failed',
        label: 'Failed',
        note: 'The latest failed run remains inspectable.',
        presentation: 'card',
        subtitle: '3 configured · last run failed',
        action: 'settings',
        tone: 'warning',
        body: {
          rows: [{ label: 'Test', meta: 'Exit 1', tone: 'destructive' }],
        },
      },
    ],
  },
  {
    id: 'hooks',
    title: 'Hooks',
    icon: 'hooks',
    initialStateId: 'enabled',
    states: [
      {
        id: 'empty',
        label: 'Not configured',
        note: 'Settings keeps the card available.',
        presentation: 'card',
        subtitle: 'None configured',
        action: 'settings',
        body: { description: 'Configure project hooks in Settings.' },
      },
      {
        id: 'enabled',
        label: 'Enabled',
        note: 'Configured hooks expose Pause and Settings controls.',
        presentation: 'card',
        subtitle: '4 configured',
        action: 'pause',
        actionTargetStateId: 'paused',
        body: {
          rows: [
            { label: 'Before prompt', meta: 'Enabled' },
            { label: 'After tool', meta: 'Enabled' },
          ],
        },
      },
      {
        id: 'paused',
        label: 'Paused',
        note: 'Paused hooks expose Resume.',
        presentation: 'card',
        subtitle: '4 configured · paused',
        action: 'resume',
        actionTargetStateId: 'enabled',
        tone: 'warning',
        body: { rows: [{ label: 'All hooks', meta: 'Paused' }] },
      },
      {
        id: 'running',
        label: 'Running',
        note: 'Active hook run warns while collapsed.',
        presentation: 'card',
        subtitle: '4 configured · 1 running',
        action: 'pause',
        actionTargetStateId: 'paused',
        tone: 'warning',
        body: { rows: [{ label: 'After tool · format', meta: 'Running' }] },
      },
      {
        id: 'failed',
        label: 'Failed',
        note: 'Failed hook output remains inspectable.',
        presentation: 'card',
        subtitle: '4 configured · last run failed',
        action: 'pause',
        tone: 'warning',
        body: {
          rows: [
            { label: 'Before commit', meta: 'Exit 2', tone: 'destructive' },
          ],
        },
      },
      {
        id: 'success',
        label: 'Succeeded',
        note: 'The latest successful hook run remains inspectable.',
        presentation: 'card',
        subtitle: '4 configured · last run passed',
        action: 'pause',
        actionTargetStateId: 'paused',
        body: {
          rows: [
            { label: 'After tool · format', meta: 'Passed', tone: 'positive' },
          ],
        },
      },
      {
        id: 'stopped',
        label: 'Stopped',
        note: 'A stopped hook action remains available for inspection.',
        presentation: 'card',
        subtitle: '4 configured · last run stopped',
        action: 'pause',
        actionTargetStateId: 'paused',
        body: { rows: [{ label: 'After tool · format', meta: 'Stopped' }] },
      },
    ],
  },
  {
    id: 'terminals',
    title: 'Terminals',
    icon: 'terminal',
    initialStateId: 'running',
    states: [
      hidden(
        'empty',
        'No terminals',
        'No sessions and no section action: the card is hidden.',
      ),
      {
        id: 'running',
        label: 'Running',
        note: 'Live PTY session.',
        presentation: 'card',
        subtitle: '1 terminal',
        tone: 'warning',
        body: { rows: [{ label: 'npm run dev', meta: 'Running · 2:14' }] },
      },
      {
        id: 'exited',
        label: 'Exited',
        note: 'Successful terminal history.',
        presentation: 'card',
        subtitle: '1 terminal',
        body: {
          rows: [{ label: 'npm test', meta: 'Exit 0', tone: 'positive' }],
        },
      },
      {
        id: 'failed',
        label: 'Failed',
        note: 'Non-zero exit requires attention.',
        presentation: 'card',
        subtitle: '1 terminal · failed',
        tone: 'warning',
        body: {
          rows: [
            { label: 'npm run build', meta: 'Exit 1', tone: 'destructive' },
          ],
        },
      },
    ],
  },
  {
    id: 'todo',
    title: 'Agent Tasks',
    icon: 'tasks',
    initialStateId: 'in-progress',
    states: [
      hidden(
        'empty',
        'No tasks',
        'No tasks and no action: the card is hidden.',
      ),
      {
        id: 'pending',
        label: 'Pending',
        note: 'Tasks exist but none has started.',
        presentation: 'card',
        subtitle: '0/3 completed',
        body: {
          progress: 0,
          progressLabel: '0 of 3 tasks completed',
          rows: [
            { label: 'Inspect existing UI' },
            { label: 'Implement gallery' },
            { label: 'Verify states' },
          ],
        },
      },
      {
        id: 'in-progress',
        label: 'In progress',
        note: 'Progress summary and current item.',
        presentation: 'card',
        subtitle: '1/3 completed',
        tone: 'warning',
        body: {
          progress: 33,
          progressLabel: '1 of 3 tasks completed',
          rows: [
            { label: 'Inspect existing UI', tone: 'positive' },
            { label: 'Implement gallery', meta: 'In progress' },
            { label: 'Verify states' },
          ],
        },
      },
      {
        id: 'blocked',
        label: 'Blocked',
        note: 'Blocked task uses warning tone.',
        presentation: 'card',
        subtitle: '1 blocked · 1/3 completed',
        tone: 'warning',
        body: {
          progress: 33,
          progressLabel: 'Blocked',
          rows: [
            {
              label: 'Verify remote state',
              meta: 'Needs input',
              tone: 'warning',
            },
          ],
        },
      },
      {
        id: 'complete',
        label: 'Complete',
        note: 'Completed task list remains readable.',
        presentation: 'card',
        subtitle: '3/3 completed',
        body: {
          progress: 100,
          progressLabel: 'All tasks completed',
          rows: [{ label: 'All tasks complete', tone: 'positive' }],
        },
      },
    ],
  },
  {
    id: 'notes',
    title: 'Notes',
    icon: 'notes',
    initialStateId: 'empty',
    states: [
      {
        id: 'empty',
        label: 'Action only',
        note: 'The whole card adds a note.',
        presentation: 'action-only',
        title: 'Add note',
        action: 'add',
        actionTargetStateId: 'populated',
      },
      {
        id: 'populated',
        label: 'Populated',
        note: 'Project notes with an Add action.',
        presentation: 'card',
        subtitle: '2 notes',
        action: 'add',
        body: {
          rows: [
            { label: 'Release checklist', detail: 'Shared' },
            { label: 'Design feedback', detail: 'This branch' },
          ],
        },
      },
    ],
  },
  {
    id: 'prompts',
    title: 'Prompts',
    icon: 'prompts',
    initialStateId: 'empty',
    states: [
      {
        id: 'empty',
        label: 'Action only',
        note: 'The whole card adds a prompt.',
        presentation: 'action-only',
        title: 'Add prompt',
        action: 'add',
        actionTargetStateId: 'populated',
      },
      {
        id: 'populated',
        label: 'Populated',
        note: 'Reusable prompts with an Add action.',
        presentation: 'card',
        subtitle: '3 prompts',
        action: 'add',
        body: {
          rows: [
            { label: 'Review this change' },
            { label: 'Write release notes' },
            { label: 'Investigate CI' },
          ],
        },
      },
    ],
  },
  {
    id: 'attachments',
    title: 'Attachments',
    icon: 'attachments',
    initialStateId: 'empty',
    states: [
      {
        id: 'empty',
        label: 'Action only',
        note: 'The whole card imports an attachment.',
        presentation: 'action-only',
        title: 'Import attachment',
        action: 'import',
        actionTargetStateId: 'uploading',
      },
      {
        id: 'populated',
        label: 'Populated',
        note: 'Imported files with another Import action.',
        presentation: 'card',
        subtitle: '3 files',
        action: 'import',
        actionTargetStateId: 'uploading',
        body: {
          rows: [
            { label: 'sidebar-dark.png', meta: 'PNG · 284 KB' },
            { label: 'activity-spec.md', meta: 'Markdown · 12 KB' },
            { label: 'tokens.json', meta: 'JSON · 4 KB' },
          ],
        },
      },
      {
        id: 'uploading',
        label: 'Importing',
        note: 'File import in progress.',
        presentation: 'card',
        subtitle: 'Importing 1 of 3…',
        action: 'cancel',
        actionTargetStateId: 'populated',
        tone: 'accent',
        body: { progress: 48, progressLabel: 'Copying files' },
      },
      {
        id: 'failed',
        label: 'Import failed',
        note: 'Import failure uses warning tone.',
        presentation: 'card',
        subtitle: '1 file could not be imported',
        action: 'import',
        actionTargetStateId: 'uploading',
        tone: 'warning',
        body: {
          rows: [
            {
              label: 'archive.zip',
              meta: 'File too large',
              tone: 'destructive',
            },
          ],
        },
      },
    ],
  },
] as const;

export type ActivityGalleryMachineState = Record<
  ActivityGallerySectionId,
  number
>;

export type ActivityGalleryMachineEvent =
  | { readonly type: 'advance'; readonly sectionId: ActivityGallerySectionId }
  | { readonly type: 'act'; readonly sectionId: ActivityGallerySectionId }
  | { readonly type: 'advance-all' }
  | {
      readonly type: 'select';
      readonly sectionId: ActivityGallerySectionId;
      readonly stateId: string;
    }
  | { readonly type: 'reset' };

function initialActivityGalleryStateIndex(
  sectionId: ActivityGallerySectionId,
): number {
  const section = ACTIVITY_GALLERY_SECTIONS.find(
    (candidate) => candidate.id === sectionId,
  );
  if (!section) return 0;
  return Math.max(
    0,
    section.states.findIndex((state) => state.id === section.initialStateId),
  );
}

export function createInitialActivityGalleryMachine(): ActivityGalleryMachineState {
  return {
    summary: initialActivityGalleryStateIndex('summary'),
    'changed-files': initialActivityGalleryStateIndex('changed-files'),
    'pull-request': initialActivityGalleryStateIndex('pull-request'),
    'background-processes': initialActivityGalleryStateIndex(
      'background-processes',
    ),
    'mcp-servers': initialActivityGalleryStateIndex('mcp-servers'),
    plans: initialActivityGalleryStateIndex('plans'),
    'pipeline-runs': initialActivityGalleryStateIndex('pipeline-runs'),
    scripts: initialActivityGalleryStateIndex('scripts'),
    hooks: initialActivityGalleryStateIndex('hooks'),
    terminals: initialActivityGalleryStateIndex('terminals'),
    todo: initialActivityGalleryStateIndex('todo'),
    notes: initialActivityGalleryStateIndex('notes'),
    prompts: initialActivityGalleryStateIndex('prompts'),
    attachments: initialActivityGalleryStateIndex('attachments'),
  };
}

export function reduceActivityGalleryMachine(
  current: ActivityGalleryMachineState,
  event: ActivityGalleryMachineEvent,
): ActivityGalleryMachineState {
  if (event.type === 'reset') return createInitialActivityGalleryMachine();

  const next = { ...current };
  if (event.type === 'advance-all') {
    for (const section of ACTIVITY_GALLERY_SECTIONS) {
      next[section.id] = (current[section.id] + 1) % section.states.length;
    }
    return next;
  }

  const section = ACTIVITY_GALLERY_SECTIONS.find(
    (candidate) => candidate.id === event.sectionId,
  );
  if (!section) return current;
  if (event.type === 'advance') {
    next[event.sectionId] =
      (current[event.sectionId] + 1) % section.states.length;
    return next;
  }

  if (event.type === 'act') {
    const activeState = section.states[current[event.sectionId]];
    if (!activeState.actionTargetStateId) return current;
    const targetIndex = section.states.findIndex(
      (state) => state.id === activeState.actionTargetStateId,
    );
    if (targetIndex === -1) return current;
    next[event.sectionId] = targetIndex;
    return next;
  }

  const index = section.states.findIndex((state) => state.id === event.stateId);
  if (index === -1) return current;
  next[event.sectionId] = index;
  return next;
}
