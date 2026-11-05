import { useState, type ComponentProps, type JSX, type ReactNode } from 'react';
import {
  ActionMenuItems,
  ActionMenuRowStyle,
  ActiveItemsSummary,
  AgentStateGlyph,
  AiCreditsCheckFeedback,
  AiCreditsStopLine,
  AppAdvisorProjectAgentAccessControl,
  AppearanceSelect,
  ArchivedChatsCard,
  AutomationPipelineTargetFields,
  BackgroundServiceNotice,
  DropdownMenuSurface,
  type ActionMenuItem,
  type AppAdvisorProjectAgentAccessValue,
  type AutomationPipelineRunIn,
  type AutomationPipelineTaskList,
} from '@canopy/ui-shared/components';
import {
  ArchiveIcon,
  CloseIcon,
  CopyIcon,
  PencilIcon,
  PinIcon,
  TrashIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import type { ActiveInstalledItemCounts } from '@canopy/ui-shared/lib';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

/**
 * Sheets for the shared components whose states were not on the lab yet:
 * action menus, the active items summary, agent state glyphs, the AI credits
 * lines, the project agent access control, the appearance select, the
 * archived chats card, the pipeline automation target and the background
 * service notice.
 */

const NO_ITEMS: ActiveInstalledItemCounts = {
  plugins: 0,
  skills: 0,
  mcpServers: 0,
  collections: 0,
};

const MENU_ITEMS: readonly ActionMenuItem[] = [
  {
    key: 'rename',
    label: 'Rename',
    icon: <PencilIcon />,
    shortcut: 'F2',
  },
  { key: 'copy', label: 'Copy link', icon: <CopyIcon /> },
  { key: 'pin', label: 'Pin to top', icon: <PinIcon />, busy: true },
  {
    key: 'archive',
    label: 'Archive (needs a finished turn)',
    icon: <ArchiveIcon />,
    disabled: true,
    tooltip: 'Finish the running turn first',
  },
  {
    key: 'close',
    label: 'Close',
    icon: <CloseIcon />,
    separatorBefore: true,
  },
  { key: 'close-others', label: 'Close others', icon: <CloseIcon /> },
  {
    key: 'delete',
    label: 'Delete this chat and every file it created in the project',
    icon: <TrashIcon />,
    tone: 'destructive',
    separatorBefore: true,
  },
];

const GROUPED_MENU_ITEMS: readonly ActionMenuItem[] = [
  { key: 'heading', label: 'Open in', icon: null, kind: 'label' },
  {
    key: 'finder',
    label: 'Finder',
    icon: <CopyIcon />,
    role: 'menuitemradio',
    checked: true,
    sectionLabel: 'Default editor',
  },
  {
    key: 'terminal',
    label: 'Terminal',
    icon: <CopyIcon />,
    role: 'menuitemradio',
    checked: false,
  },
  {
    key: 'more',
    label: 'More',
    icon: <PencilIcon />,
    kind: 'submenu',
    submenu: [{ key: 'zed', label: 'Zed', icon: <PencilIcon /> }],
    separatorBefore: true,
    sectionStatus: { tone: 'failure', text: 'Couldn’t read editors.' },
  },
  {
    key: 'loading',
    label: 'Remote',
    icon: <PencilIcon />,
    sectionStatus: {
      tone: 'default',
      text: 'Looking for editors…',
      loading: true,
    },
  },
];

function MenuCell({
  label,
  items,
}: {
  readonly label: string;
  readonly items: readonly ActionMenuItem[];
}): JSX.Element {
  const [last, setLast] = useState<string | null>(null);
  return (
    <SpecimenCell label={last ? `${label} · chose ${last}` : label}>
      <ActionMenuRowStyle>
        <DropdownMenuSurface className="w-64" role="menu">
          <ActionMenuItems
            items={items}
            onSelect={(item): void => setLast(item.label)}
          />
        </DropdownMenuSurface>
      </ActionMenuRowStyle>
    </SpecimenCell>
  );
}

function ActionMenuSheet(): JSX.Element {
  return (
    <SpecimenPanel title="ActionMenuItems">
      <SpecimenGrid min={260}>
        <MenuCell
          label="Icons, shortcut, busy, disabled, destructive, shared icon run"
          items={MENU_ITEMS}
        />
        <MenuCell
          label="Section label, radio rows, submenu, status lines"
          items={GROUPED_MENU_ITEMS}
        />
        <MenuCell label="Empty menu" items={[]} />
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

function ActiveItemsSheet(): JSX.Element {
  return (
    <SpecimenPanel title="ActiveItemsSummary">
      <SpecimenGrid min={420}>
        <SpecimenCell label="Several kinds">
          <ActiveItemsSummary
            state={{
              kind: 'ready',
              counts: { plugins: 3, skills: 1, mcpServers: 2, collections: 0 },
            }}
            onManage={(): void => undefined}
            testId="lab-active-items-many"
          />
        </SpecimenCell>
        <SpecimenCell label="One item">
          <ActiveItemsSummary
            state={{ kind: 'ready', counts: { ...NO_ITEMS, skills: 1 } }}
            onManage={(): void => undefined}
            testId="lab-active-items-one"
          />
        </SpecimenCell>
        <SpecimenCell label="Empty">
          <ActiveItemsSummary
            state={{ kind: 'ready', counts: NO_ITEMS }}
            onManage={(): void => undefined}
            testId="lab-active-items-empty"
          />
        </SpecimenCell>
        <SpecimenCell label="Loading">
          <ActiveItemsSummary
            state={{ kind: 'loading' }}
            onManage={(): void => undefined}
            testId="lab-active-items-loading"
          />
        </SpecimenCell>
        <SpecimenCell label="Error">
          <ActiveItemsSummary
            state={{
              kind: 'error',
              message: 'Couldn’t read the installed items.',
            }}
            onManage={(): void => undefined}
            testId="lab-active-items-error"
          />
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

function AgentStateSheet(): JSX.Element {
  return (
    <SpecimenPanel title="AgentStateGlyph">
      <SpecimenGrid min={140}>
        <SpecimenCell label="Working, inline">
          <AgentStateGlyph state="working" />
        </SpecimenCell>
        <SpecimenCell label="Working, unread">
          <AgentStateGlyph state="working" unread />
        </SpecimenCell>
        <SpecimenCell label="Working, sidebar row slot">
          <AgentStateGlyph state="working" slot="row" />
        </SpecimenCell>
        <SpecimenCell label="Background, 1 task">
          <AgentStateGlyph state="background" backgroundTasks={1} />
        </SpecimenCell>
        <SpecimenCell label="Background, 6 tasks">
          <AgentStateGlyph state="background" backgroundTasks={6} />
        </SpecimenCell>
        <SpecimenCell label="Background, unread">
          <AgentStateGlyph state="background" backgroundTasks={2} unread />
        </SpecimenCell>
        <SpecimenCell label="Larger spinner (16px)">
          <AgentStateGlyph state="working" sizePx={16} />
        </SpecimenCell>
        <SpecimenCell label="No tooltip (a label says it)">
          <span className="inline-flex items-center gap-1.5 text-xs fg-secondary">
            <AgentStateGlyph
              state="background"
              backgroundTasks={6}
              tooltip={false}
            />
            Background 6
          </span>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

function AiCreditsSheet(): JSX.Element {
  return (
    <SpecimenPanel title="AiCreditsCheckFeedback and AiCreditsStopLine">
      <SpecimenGrid min={320}>
        <SpecimenCell label="Uncovered, with Reopen billing">
          <AiCreditsCheckFeedback
            kind="uncovered"
            onReopenBilling={(): void => undefined}
            dataTestId="lab-credits-uncovered"
          />
        </SpecimenCell>
        <SpecimenCell label="Uncovered, reopen in flight">
          <AiCreditsCheckFeedback
            kind="uncovered"
            onReopenBilling={(): void => undefined}
            reopenPending
            dataTestId="lab-credits-pending"
          />
        </SpecimenCell>
        <SpecimenCell label="Uncovered, another operation in flight (disabled)">
          <AiCreditsCheckFeedback
            kind="uncovered"
            onReopenBilling={(): void => undefined}
            reopenDisabled
            dataTestId="lab-credits-disabled"
          />
        </SpecimenCell>
        <SpecimenCell label="Uncovered, no action offered">
          <AiCreditsCheckFeedback
            kind="uncovered"
            dataTestId="lab-credits-no-action"
          />
        </SpecimenCell>
        <SpecimenCell label="Check failed (error)">
          <AiCreditsCheckFeedback
            kind="check-failed"
            dataTestId="lab-credits-failed"
          />
        </SpecimenCell>
        <SpecimenCell label="Transcript stop line">
          <AiCreditsStopLine dataTestId="lab-credits-stop-line" />
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

const OWNERS = [
  { owner: { kind: 'personal' as const }, label: 'Personal' },
  {
    owner: { kind: 'organization' as const, organizationId: 'org_acme' },
    label: 'Acme Robotics',
  },
  {
    owner: { kind: 'organization' as const, organizationId: 'org_globex' },
    label:
      'Globex Corporation International Holdings (Europe, Middle East and Africa)',
  },
  {
    owner: { kind: 'organization' as const, organizationId: 'org_old' },
    label: 'Initech',
    unavailable: true,
  },
];

function AccessCell({
  label,
  initial,
  disabled,
  saving,
  prefix,
  ownerOptions = OWNERS,
}: {
  readonly label: string;
  readonly initial: AppAdvisorProjectAgentAccessValue;
  readonly disabled?: boolean;
  readonly saving?: boolean;
  readonly prefix: string;
  readonly ownerOptions?: typeof OWNERS;
}): JSX.Element {
  const [value, setValue] = useState(initial);
  return (
    <SpecimenCell label={label} wide>
      <div className="w-full">
        <AppAdvisorProjectAgentAccessControl
          value={value}
          ownerOptions={ownerOptions}
          onChange={setValue}
          disabled={disabled}
          saving={saving}
          testIdPrefix={prefix}
        />
      </div>
    </SpecimenCell>
  );
}

function AccessSheet(): JSX.Element {
  return (
    <SpecimenPanel title="AppAdvisorProjectAgentAccessControl">
      <SpecimenGrid min={520}>
        <AccessCell
          label="Enabled"
          prefix="lab-access-enabled"
          initial={{ mode: 'enabled', selectedOwners: [] }}
        />
        <AccessCell
          label="Disabled"
          prefix="lab-access-off"
          initial={{ mode: 'disabled', selectedOwners: [] }}
        />
        <AccessCell
          label="Select owners (live), with a long name and an unavailable owner"
          prefix="lab-access-owners"
          initial={{
            mode: 'selected-owners',
            selectedOwners: [{ kind: 'personal' }],
          }}
        />
        <AccessCell
          label="Select owners, none chosen"
          prefix="lab-access-none"
          initial={{ mode: 'selected-owners', selectedOwners: [] }}
        />
        <AccessCell
          label="Selected owner the host no longer lists"
          prefix="lab-access-stale"
          ownerOptions={OWNERS.slice(0, 2)}
          initial={{
            mode: 'selected-owners',
            selectedOwners: [
              { kind: 'organization', organizationId: 'org_deleted_1234' },
            ],
          }}
        />
        <AccessCell
          label="Saving"
          prefix="lab-access-saving"
          saving
          initial={{
            mode: 'selected-owners',
            selectedOwners: [{ kind: 'personal' }],
          }}
        />
        <AccessCell
          label="Disabled control"
          prefix="lab-access-disabled"
          disabled
          initial={{
            mode: 'selected-owners',
            selectedOwners: [{ kind: 'personal' }],
          }}
        />
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

const THEMES = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'Match system' },
  {
    value: 'long',
    label: 'High contrast with extra large type for a bright room',
  },
] as const;

function Swatch({ color }: { readonly color: string }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="size-3 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}

const PREVIEW_THEMES = [
  { value: 'light', label: 'Light', preview: <Swatch color="#f6f4ef" /> },
  { value: 'dark', label: 'Dark', preview: <Swatch color="#1f1e1b" /> },
] as const;

function AppearanceCell({
  label,
  options,
  initial,
  disabled,
  busy,
  testId,
}: {
  readonly label: string;
  readonly options: ReadonlyArray<{
    readonly value: string;
    readonly label: string;
    readonly preview?: ReactNode;
  }>;
  readonly initial: string;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly testId: string;
}): JSX.Element {
  const [value, setValue] = useState(initial);
  return (
    <SpecimenCell label={label}>
      <AppearanceSelect
        label="Theme"
        value={value}
        options={options}
        onChange={setValue}
        testId={testId}
        disabled={disabled}
        busy={busy}
      />
    </SpecimenCell>
  );
}

function AppearanceSheet(): JSX.Element {
  return (
    <SpecimenPanel title="AppearanceSelect">
      <SpecimenGrid min={200}>
        <AppearanceCell
          label="Default"
          options={THEMES}
          initial="system"
          testId="lab-appearance"
        />
        <AppearanceCell
          label="With theme previews"
          options={PREVIEW_THEMES}
          initial="dark"
          testId="lab-appearance-preview"
        />
        <AppearanceCell
          label="Long label"
          options={THEMES}
          initial="long"
          testId="lab-appearance-long"
        />
        <AppearanceCell
          label="Busy (saving)"
          options={THEMES}
          initial="dark"
          busy
          testId="lab-appearance-busy"
        />
        <AppearanceCell
          label="Disabled"
          options={THEMES}
          initial="light"
          disabled
          testId="lab-appearance-disabled"
        />
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

const noop = (): void => undefined;

function ArchivedCardCell({
  label,
  items,
  overflowCount = 0,
}: {
  readonly label: string;
  readonly items: ComponentProps<typeof ArchivedChatsCard>['items'];
  readonly overflowCount?: number;
}): JSX.Element {
  return (
    <SpecimenCell label={label}>
      <ArchivedChatsCard
        items={items}
        overflowCount={overflowCount}
        onOpen={noop}
        onRestore={noop}
        onSummarize={noop}
        onShowAll={noop}
        className="static"
      />
    </SpecimenCell>
  );
}

function ArchivedChatsSheet(): JSX.Element {
  return (
    <SpecimenPanel title="ArchivedChatsCard">
      <SpecimenGrid min={340}>
        <ArchivedCardCell
          label="Restorable, unread, past the restore window, and more below"
          overflowCount={12}
          items={[
            {
              id: 'a',
              title: 'Remove email under name in account menu',
              meta: 'Opus 5.5 · 10 turns',
              restorable: true,
            },
            {
              id: 'b',
              title: 'Audit the sidebar spacing',
              meta: 'Opus 5.5 · 7 turns',
              restorable: true,
              unread: true,
            },
            {
              id: 'c',
              title: 'Past the restore window',
              meta: 'Sonnet 5.5 · 3 turns',
              restorable: false,
            },
            {
              id: 'd',
              title:
                'A very long chat title that keeps going well past the width of the card so it has to truncate',
              meta: 'Haiku 5.5 · 2 turns · a long fact line that also truncates',
              restorable: true,
            },
          ]}
        />
        <ArchivedCardCell
          label="Restoring and summarizing (both actions read busy)"
          items={[
            {
              id: 'e',
              title: 'Restoring this chat',
              meta: 'Opus 5.5 · 4 turns',
              restorable: true,
              restoring: true,
            },
            {
              id: 'f',
              title: 'Summarizing this chat',
              meta: 'Opus 5.5 · 9 turns',
              restorable: true,
              summarizing: true,
            },
          ]}
        />
        <ArchivedCardCell label="Empty" items={[]} />
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

const TASKS: AutomationPipelineTaskList = {
  status: 'ready',
  options: [
    { id: 't1', label: 'Fix flaky upload test' },
    { id: 't2', label: 'Release notes for 2.14' },
  ],
};

function TargetCell({
  label,
  initial,
  tasks,
  projectKind = 'code',
  taskId = '',
  onRetryTasks,
  disabled,
  prefix,
}: {
  readonly label: string;
  readonly initial: AutomationPipelineRunIn;
  readonly tasks: AutomationPipelineTaskList;
  readonly projectKind?: 'code' | 'cowork';
  readonly taskId?: string;
  readonly onRetryTasks?: () => void;
  readonly disabled?: boolean;
  readonly prefix: string;
}): JSX.Element {
  const [value, setValue] = useState(initial);
  const [task, setTask] = useState(taskId);
  return (
    <SpecimenCell label={label}>
      <div className="w-full max-w-sm">
        <AutomationPipelineTargetFields
          projectKind={projectKind}
          value={value}
          onChange={setValue}
          taskId={task}
          tasks={tasks}
          onTaskChange={setTask}
          onRetryTasks={onRetryTasks}
          disabled={disabled}
          testIdPrefix={prefix}
        />
      </div>
    </SpecimenCell>
  );
}

function PipelineTargetSheet(): JSX.Element {
  return (
    <SpecimenPanel title="AutomationPipelineTargetFields">
      <SpecimenGrid min={320}>
        <TargetCell
          label="New worktree each run"
          prefix="lab-target-new"
          initial="new_worktree"
          tasks={TASKS}
        />
        <TargetCell
          label="Project folder (helper line)"
          prefix="lab-target-project"
          initial="project"
          tasks={TASKS}
        />
        <TargetCell
          label="Existing task, chosen"
          prefix="lab-target-task"
          initial="task"
          taskId="t1"
          tasks={TASKS}
        />
        <TargetCell
          label="Existing task, none available"
          prefix="lab-target-empty"
          initial="task"
          tasks={{ status: 'ready', options: [] }}
        />
        <TargetCell
          label="Stale selection"
          prefix="lab-target-stale"
          initial="task"
          taskId="gone"
          tasks={TASKS}
        />
        <TargetCell
          label="Loading tasks"
          prefix="lab-target-loading"
          initial="task"
          tasks={{ status: 'loading' }}
        />
        <TargetCell
          label="Error, with Try again"
          prefix="lab-target-error"
          initial="task"
          tasks={{ status: 'error' }}
          onRetryTasks={noop}
        />
        <TargetCell
          label="Error, no retry"
          prefix="lab-target-error-plain"
          initial="task"
          tasks={{ status: 'error' }}
        />
        <TargetCell
          label="Unavailable on this host"
          prefix="lab-target-unavailable"
          initial="task"
          tasks={{
            status: 'unavailable',
            message: 'Tasks can’t be listed for a remote project yet.',
          }}
        />
        <TargetCell
          label="Cowork project (no new worktree)"
          prefix="lab-target-cowork"
          projectKind="cowork"
          initial="task"
          taskId="t2"
          tasks={TASKS}
        />
        <TargetCell
          label="Disabled"
          prefix="lab-target-disabled"
          initial="task"
          taskId="t1"
          tasks={TASKS}
          disabled
        />
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

function BackgroundServiceSheet(): JSX.Element {
  return (
    <SpecimenPanel title="BackgroundServiceNotice">
      <SpecimenGrid min={360}>
        <SpecimenCell label="Idle">
          <div className="w-full">
            <BackgroundServiceNotice retry="idle" onRetry={noop} />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Trying again (busy)">
          <div className="w-full">
            <BackgroundServiceNotice retry="running" onRetry={noop} />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Still failing">
          <div className="w-full">
            <BackgroundServiceNotice retry="failed" onRetry={noop} />
          </div>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

export function SharedASpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-8">
      <ActionMenuSheet />
      <ActiveItemsSheet />
      <AgentStateSheet />
      <AiCreditsSheet />
      <AccessSheet />
      <AppearanceSheet />
      <ArchivedChatsSheet />
      <PipelineTargetSheet />
      <BackgroundServiceSheet />
    </div>
  );
}
