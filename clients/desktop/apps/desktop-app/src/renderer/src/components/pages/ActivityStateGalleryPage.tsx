import {
  createElement,
  useReducer,
  useState,
  type ComponentType,
  type JSX,
} from 'react';
import {
  Chip,
  HeaderActionButton,
  Heading,
  PanelSection,
  ProgressBar,
  SegmentedControl,
  type SegmentedControlOption,
  Surface,
} from '@canopy/ui-shared/components';
import {
  AttachmentIcon,
  CloseIcon,
  EditBigIcon,
  EyeIcon,
  FilesIcon,
  FilterIcon,
  GitPullRequestIcon,
  HookIcon,
  McpServerIcon,
  NoteIcon,
  PageTextAddIcon,
  PauseIcon,
  PipelineIcon,
  PlansIcon,
  PlayIcon,
  PlusMediumIcon,
  ProcessIcon,
  RefreshIcon,
  RocketLaunchIcon,
  SettingsIcon,
  SummaryIcon,
  TasksIcon,
  TerminalIcon,
  TriggerIcon,
  WarningIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { ChatQuestionPlayground } from './ChatQuestionPlayground';
import { PageTitlebar } from '../shared/PageTitlebar';
import {
  ActivitySectionChromeContext,
  PanelSection as DesktopPanelSection,
} from '../shared/panel-section';
import {
  ACTIVITY_GALLERY_SECTIONS,
  createInitialActivityGalleryMachine,
  reduceActivityGalleryMachine,
  type ActivityGalleryAction,
  type ActivityGalleryBody,
  type ActivityGalleryIcon,
  type ActivityGallerySection,
  type ActivityGalleryState,
  type ActivityGalleryTone,
} from './activityStateGalleryData';

type IconComponent = ComponentType<{ size?: number; className?: string }>;

const SECTION_ICONS: Record<ActivityGalleryIcon, IconComponent> = {
  summary: SummaryIcon,
  files: FilesIcon,
  'pull-request': GitPullRequestIcon,
  process: ProcessIcon,
  mcp: McpServerIcon,
  plans: PlansIcon,
  pipeline: PipelineIcon,
  scripts: RocketLaunchIcon,
  hooks: HookIcon,
  terminal: TerminalIcon,
  tasks: TasksIcon,
  notes: NoteIcon,
  prompts: EditBigIcon,
  attachments: AttachmentIcon,
};

const ACTIONS: Record<
  ActivityGalleryAction,
  { readonly label: string; readonly icon: IconComponent }
> = {
  refresh: { label: 'Refresh', icon: RefreshIcon },
  review: { label: 'Review', icon: EyeIcon },
  'create-pr': { label: 'Create pull request', icon: GitPullRequestIcon },
  cancel: { label: 'Cancel', icon: CloseIcon },
  settings: { label: 'Settings', icon: SettingsIcon },
  pause: { label: 'Pause', icon: PauseIcon },
  resume: { label: 'Resume', icon: PlayIcon },
  add: { label: 'Add', icon: PlusMediumIcon },
  import: { label: 'Import', icon: PageTextAddIcon },
  dispatch: { label: 'Dispatch', icon: TriggerIcon },
  filter: { label: 'Filter', icon: FilterIcon },
};

const TONE_CLASS_NAMES: Record<ActivityGalleryTone, string> = {
  neutral: 'fg-secondary',
  accent: 'fg-accent',
  warning: 'fg-warning',
  positive: 'fg-positive',
  destructive: 'fg-destructive',
};

function SectionIcon({
  icon,
}: {
  readonly icon: ActivityGalleryIcon;
}): JSX.Element {
  return createElement(SECTION_ICONS[icon], { size: 16 });
}

function ActionButton({
  action,
  label,
  onAction,
}: {
  readonly action: ActivityGalleryAction;
  readonly label?: string;
  readonly onAction?: () => void;
}): JSX.Element {
  const descriptor = ACTIONS[action];
  const accessibleLabel = label ?? descriptor.label;
  return (
    <HeaderActionButton
      iconOnly
      aria-label={accessibleLabel}
      tooltipLabel={accessibleLabel}
      tone={action === 'cancel' ? 'warning' : 'accent'}
      onClick={(event): void => {
        event.stopPropagation();
        onAction?.();
      }}
    >
      {createElement(descriptor.icon, { size: 16 })}
    </HeaderActionButton>
  );
}

function HeaderActions({
  state,
  onAction,
}: {
  readonly state: ActivityGalleryState;
  readonly onAction?: () => void;
}): JSX.Element | null {
  if (!state.action) return null;
  return (
    <div className="flex items-center gap-1">
      <ActionButton
        action={state.action}
        label={state.actionLabel}
        onAction={onAction}
      />
      {state.action === 'filter' && <ActionButton action="review" />}
      {state.action === 'pause' && <ActionButton action="settings" />}
      {state.action === 'resume' && <ActionButton action="settings" />}
    </div>
  );
}

function DemoBody({
  body,
  tone = 'neutral',
}: {
  readonly body: ActivityGalleryBody | undefined;
  readonly tone?: ActivityGalleryTone;
}): JSX.Element {
  if (!body) {
    return <p className="text-xs fg-secondary">No additional details.</p>;
  }
  return (
    <div className="space-y-3">
      {body.description && (
        <p className="text-xs leading-relaxed fg-secondary">
          {body.description}
        </p>
      )}
      {body.progress !== undefined && (
        <ProgressBar
          value={body.progress}
          label={body.progressLabel ?? 'Progress'}
          tone={
            tone === 'warning' || tone === 'destructive' ? 'warning' : 'accent'
          }
        />
      )}
      {body.rows && body.rows.length > 0 && (
        <ul className="space-y-1.5">
          {body.rows.map((row, index) => {
            const rowTone = row.tone ?? 'neutral';
            return (
              <Surface
                as="li"
                variant="group"
                size="small"
                key={`${row.label}-${index}`}
              >
                <div className="flex items-center min-h-9 gap-2 px-2.5 py-2 text-xs">
                  <span
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 shrink-0 rounded-full bg-current ${TONE_CLASS_NAMES[rowTone]}`}
                  />
                  <span className="min-w-0 flex-1 truncate fg-primary">
                    {row.label}
                    {row.detail && (
                      <span className="ml-1.5 fg-secondary">{row.detail}</span>
                    )}
                  </span>
                  {row.meta && (
                    <span
                      className={`shrink-0 text-2xs ${TONE_CLASS_NAMES[rowTone]}`}
                    >
                      {row.meta}
                    </span>
                  )}
                  {(row.additions !== undefined ||
                    row.deletions !== undefined) && (
                    <span className="flex shrink-0 items-center gap-1 text-2xs tabular-nums">
                      <span
                        className="fg-positive"
                        data-activity-gallery-additions="true"
                      >
                        +{row.additions ?? 0}
                      </span>
                      <span
                        className="fg-destructive"
                        data-activity-gallery-deletions="true"
                      >
                        −{row.deletions ?? 0}
                      </span>
                    </span>
                  )}
                </div>
              </Surface>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function HiddenStatePreview({
  state,
}: {
  readonly state: ActivityGalleryState;
}): JSX.Element {
  return (
    <Surface variant="dashed" data-activity-gallery-preview="true">
      <div className="flex items-center min-h-22 gap-3 px-4 py-3">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-warning-subtle fg-warning">
          <WarningIcon size={16} />
        </span>
        <div className="min-w-0">
          <p className="text-s font-semibold fg-primary">Section hidden</p>
          <p className="mt-0.5 text-2xs leading-relaxed fg-secondary">
            {state.note}
          </p>
        </div>
      </div>
    </Surface>
  );
}

function ActionOnlyPreview({
  section,
  state,
  onAction,
}: {
  readonly section: ActivityGallerySection;
  readonly state: ActivityGalleryState;
  readonly onAction?: () => void;
}): JSX.Element {
  const action = state.action ?? 'add';
  const label = state.title ?? state.label;
  const descriptor = ACTIONS[action];
  return (
    <div data-activity-gallery-preview="true">
      <ActivitySectionChromeContext.Provider value="body-only">
        <DesktopPanelSection
          icon={<SectionIcon icon={section.icon} />}
          title={section.title}
          hasExpandableContent={false}
          actionOnlyCard
          actionOnlyLabel={label}
          headerAction={
            <HeaderActionButton iconOnly aria-label={label} onClick={onAction}>
              {createElement(descriptor.icon, { size: 16 })}
            </HeaderActionButton>
          }
        />
      </ActivitySectionChromeContext.Provider>
    </div>
  );
}

function CardPreview({
  section,
  state,
  onAction,
}: {
  readonly section: ActivityGallerySection;
  readonly state: ActivityGalleryState;
  readonly onAction?: () => void;
}): JSX.Element {
  if (state.presentation === 'hidden') {
    return <HiddenStatePreview state={state} />;
  }
  if (state.presentation === 'action-only') {
    return (
      <ActionOnlyPreview section={section} state={state} onAction={onAction} />
    );
  }
  const warning = state.tone === 'warning' || state.tone === 'destructive';
  return (
    <div data-activity-gallery-preview="true">
      <PanelSection
        key={`${section.id}-${state.id}`}
        icon={<SectionIcon icon={section.icon} />}
        title={state.title ?? section.title}
        subtitle={state.subtitle}
        headerAction={<HeaderActions state={state} onAction={onAction} />}
        collapsedIconColor={warning ? 'amber' : 'muted'}
        defaultCollapsed={state.defaultCollapsed}
      >
        <DemoBody body={state.body} tone={state.tone} />
      </PanelSection>
    </div>
  );
}

type GalleryView = 'machines' | 'catalog' | 'chat';

const GALLERY_VIEW_OPTIONS: readonly SegmentedControlOption<GalleryView>[] = [
  {
    value: 'machines',
    label: 'State machines',
    dataTestId: 'activity-gallery-view-machines',
  },
  {
    value: 'chat',
    label: 'Chat playground',
    dataTestId: 'activity-gallery-view-chat',
  },
  {
    value: 'catalog',
    label: 'All states',
    dataTestId: 'activity-gallery-view-catalog',
  },
];

/**
 * Dev/E2E reference for every Activity card and state. It renders the real
 * shared card/action primitives; only the deterministic fixture bodies are
 * synthetic. The machine view is interactive, while Catalog shows all states
 * simultaneously for visual comparison.
 */
export function ActivityStateGalleryPage(): JSX.Element {
  const [machine, dispatch] = useReducer(
    reduceActivityGalleryMachine,
    undefined,
    createInitialActivityGalleryMachine,
  );
  const [view, setView] = useState<GalleryView>('machines');

  return (
    <section
      className="flex h-full flex-col"
      data-testid="page-activity-states"
    >
      <PageTitlebar />
      <div
        className={
          view === 'chat'
            ? 'min-h-0 flex-1 overflow-hidden px-4 pb-4'
            : 'min-h-0 flex-1 overflow-y-auto px-8 pb-12'
        }
      >
        <div
          className={
            view === 'chat'
              ? 'flex h-full min-h-0 flex-col gap-3'
              : 'mx-auto max-w-7xl space-y-8'
          }
        >
          <header className={view === 'chat' ? 'hidden' : 'space-y-2'}>
            <Heading level={1} variant="page">
              Activity States
            </Heading>
            <p className="max-w-4xl text-s leading-relaxed fg-secondary">
              Every Activity section and card phase, built from the shipping
              card, icon, tooltip, action-button, divider, and expand/collapse
              primitives. Hidden states are documented explicitly because they
              intentionally render no production card.
            </p>
          </header>

          <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-base/95 p-2 shadow-sm backdrop-blur">
            <SegmentedControl
              label="Gallery view"
              value={view}
              options={GALLERY_VIEW_OPTIONS}
              onChange={setView}
              width="content"
            />
            <div
              className={view === 'chat' ? 'hidden' : 'flex items-center gap-1'}
            >
              <HeaderActionButton
                onClick={() => dispatch({ type: 'reset' })}
                data-testid="activity-gallery-reset"
              >
                Reset
              </HeaderActionButton>
              <HeaderActionButton
                onClick={() => dispatch({ type: 'advance-all' })}
                data-testid="activity-gallery-advance-all"
              >
                Advance all
              </HeaderActionButton>
            </div>
          </div>

          {view === 'chat' ? (
            <div className="min-h-0 flex-1">
              <ChatQuestionPlayground />
            </div>
          ) : view === 'machines' ? (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,22rem),1fr))] items-start gap-5">
              {ACTIVITY_GALLERY_SECTIONS.map((section) => {
                const stateIndex = machine[section.id];
                const state = section.states[stateIndex] ?? section.states[0];
                return (
                  <Surface
                    as="article"
                    variant="inset"
                    padding="default"
                    className="min-w-0"
                    key={section.id}
                    data-testid={`activity-state-machine-${section.id}`}
                    data-current-state={state.id}
                  >
                    <div className="space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <Heading level={2} variant="title">
                            {section.title}
                          </Heading>
                          <p className="mt-0.5 text-2xs fg-secondary">
                            {state.label} · {stateIndex + 1}/
                            {section.states.length}
                          </p>
                        </div>
                        <HeaderActionButton
                          iconOnly
                          aria-label={`Advance ${section.title}`}
                          tooltipLabel={`Advance ${section.title}`}
                          data-testid={`activity-state-advance-${section.id}`}
                          onClick={() =>
                            dispatch({ type: 'advance', sectionId: section.id })
                          }
                        >
                          <PlayIcon size={16} />
                        </HeaderActionButton>
                      </div>
                      <div
                        className="flex flex-wrap gap-1"
                        role="group"
                        aria-label={`${section.title} states`}
                      >
                        {section.states.map((candidate) => (
                          <Chip
                            key={candidate.id}
                            onClick={() =>
                              dispatch({
                                type: 'select',
                                sectionId: section.id,
                                stateId: candidate.id,
                              })
                            }
                            selected={candidate.id === state.id}
                          >
                            {candidate.label}
                          </Chip>
                        ))}
                      </div>
                      <p className="min-h-8 text-2xs leading-relaxed fg-secondary">
                        {state.note}
                      </p>
                      <CardPreview
                        section={section}
                        state={state}
                        onAction={() =>
                          dispatch({ type: 'act', sectionId: section.id })
                        }
                      />
                    </div>
                  </Surface>
                );
              })}
            </div>
          ) : (
            <div className="space-y-8" data-testid="activity-gallery-catalog">
              {ACTIVITY_GALLERY_SECTIONS.map((section) => (
                <section key={section.id} className="space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex h-5 w-5 items-center justify-center fg-secondary">
                      <SectionIcon icon={section.icon} />
                    </span>
                    <Heading level={2} variant="title">
                      {section.title}
                    </Heading>
                    <span className="text-2xs fg-secondary">
                      {section.states.length} states
                    </span>
                  </div>
                  <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,19rem),1fr))] items-start gap-4">
                    {section.states.map((state) => (
                      <Surface
                        as="article"
                        variant="inset"
                        padding="compact"
                        key={state.id}
                        data-testid={`activity-gallery-catalog-${section.id}-${state.id}`}
                      >
                        <div className="space-y-2">
                          <div>
                            <Heading level={3} variant="title">
                              {state.label}
                            </Heading>
                            <p className="mt-0.5 min-h-8 text-2xs leading-relaxed fg-secondary">
                              {state.note}
                            </p>
                          </div>
                          <CardPreview section={section} state={state} />
                        </div>
                      </Surface>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
