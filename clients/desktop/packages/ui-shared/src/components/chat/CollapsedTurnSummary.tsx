import {
  forwardRef,
  type JSX,
  type MouseEventHandler,
  type ReactNode,
} from 'react';
import {
  AppAdvisorIcon,
  AppAdvisorWatcherIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClaudeLogo,
  DocumentIcon,
  DocumentSearchIcon,
  GlobeIcon,
  GraphIcon,
  MagnifyingGlassIcon,
  MessageIcon,
  PipelineIcon,
  PlanModeIcon,
  TerminalBorderedIcon,
  TerminalIcon,
  AgentIcon,
  QuestionMarkIcon,
  TaskIcon,
  ThinkingIcon,
  WrenchIcon,
} from '../../icons';
import { DocumentPencilIcon, PickIcon } from '../../icons/AppIcons';
import { formatDuration } from '../../lib/format-usage';
import { useIsPhone } from '../useMediaQuery';
import { useCleanChatLook } from '../chat-look';
import { describeStepCounts, type StepKind } from './step-words';
import { TurnWorkHeader } from './TurnWorkHeader';

/**
 * Tool-counts summary surfaced on collapsed turn groups. Mirrors the
 * `PortalChatTurnGroupEntity.summary` shape from `@canopy/protocol` so the
 * desktop and the web portal can pass the wire counts straight through.
 */
export interface TurnSummary {
  thinking?: number;
  messages?: number;
  bash?: number;
  read?: number;
  edit?: number;
  write?: number;
  plan?: number;
  grep?: number;
  glob?: number;
  todo?: number;
  web?: number;
  agent?: number;
  askUser?: number;
  scriptOutput?: number;
  claude?: number;
  watcher?: number;
  canopy?: number;
  graph?: number;
  appAdvisor?: number;
  pipelineEditor?: number;
  computerUse?: number;
  other?: number;
}

export interface CollapsedTurnSummaryProps {
  /** Aggregate tool counts produced by the host. */
  summary: TurnSummary;
  /** Whether the parent currently shows the expanded intermediate region. */
  isExpanded: boolean;
  /** Click handler. Hosts can leave this unset for read-only summaries. */
  onToggle?: () => void;
  /**
   * Optional host-provided branded app icon. Defaults to a neutral tool icon
   * because this shared package cannot know the active product brand.
   */
  appIcon?: ReactNode;
  /**
   * Optional wall-clock duration of the collapsed turn, in milliseconds.
   *
   * Deliberately a value, not a timer. Every host that could supply this
   * already owns the turn's start and end — the desktop transcript from its
   * turn records, the portal from the wire entity — and a clock started here
   * would be a second, disagreeing source of truth that also kept a collapsed
   * row re-rendering forever. Omit it and the row simply renders the step
   * count, which is what every current caller does.
   *
   * Non-finite or non-positive values render nothing rather than "0s" or
   * "NaNs", so a host can pass a computed difference through without guarding
   * it first.
   */
  elapsedMs?: number;
  /**
   * How the turn ended. The clean chat look's header says "Failed after …" or
   * "Stopped after …" instead of "Worked for …". Defaults to complete.
   */
  completionStatus?: 'complete' | 'failed' | 'cancelled';
  /** Hide the visible step-count label while preserving its automation data. */
  hideLeadingLabel?: boolean;
  /** Test ID hook for automation. */
  dataTestId?: string;
}

interface ChipEntry {
  key: keyof TurnSummary;
  icon: ReactNode;
  label: string;
  count: number;
}

function buildChips(summary: TurnSummary, appIcon?: ReactNode): ChipEntry[] {
  const chips: ChipEntry[] = [];
  const push = (
    key: keyof TurnSummary,
    icon: ReactNode,
    label: string,
  ): void => {
    const count = summary[key];
    if (count != null && count > 0) {
      chips.push({ key, icon, label, count });
    }
  };

  push('messages', <MessageIcon />, 'messages');
  push('thinking', <ThinkingIcon />, 'thinking');
  push('bash', <TerminalIcon />, 'bash');
  push('read', <DocumentIcon />, 'read');
  push('edit', <DocumentPencilIcon />, 'edit');
  push('write', <DocumentPencilIcon />, 'write');
  push('plan', <PlanModeIcon />, 'plan');
  push('grep', <DocumentSearchIcon />, 'grep');
  push('glob', <MagnifyingGlassIcon />, 'glob');
  push('todo', <TaskIcon />, 'todo');
  push('web', <GlobeIcon />, 'web');
  push('agent', <AgentIcon />, 'agents');
  push('askUser', <QuestionMarkIcon />, 'questions');
  push('scriptOutput', <TerminalBorderedIcon />, 'script output');
  push('claude', <ClaudeLogo />, 'claude');
  push('watcher', <AppAdvisorWatcherIcon />, 'watcher');
  push('canopy', appIcon ?? <WrenchIcon />, 'app');
  push('graph', <GraphIcon />, 'code graph');
  push('appAdvisor', <AppAdvisorIcon />, 'app advisor');
  push('pipelineEditor', <PipelineIcon />, 'pipeline');
  push('computerUse', <PickIcon />, 'computer use');
  push('other', <WrenchIcon />, 'other');

  return chips;
}

const SUMMARY_STEP_KINDS: Partial<Record<keyof TurnSummary, StepKind>> = {
  thinking: 'thinking',
  bash: 'command',
  scriptOutput: 'command',
  read: 'read',
  edit: 'edit',
  write: 'edit',
  grep: 'search',
  glob: 'search',
  todo: 'tasks',
  web: 'web',
  graph: 'graph',
};

/** Every counted summary key, in chip order. Messages are not steps. */
const SUMMARY_STEP_ORDER: readonly (keyof TurnSummary)[] = [
  'thinking',
  'bash',
  'read',
  'edit',
  'write',
  'plan',
  'grep',
  'glob',
  'todo',
  'web',
  'agent',
  'askUser',
  'scriptOutput',
  'claude',
  'watcher',
  'canopy',
  'graph',
  'appAdvisor',
  'pipelineEditor',
  'computerUse',
  'other',
];

/**
 * A turn summary's steps by kind, in chip order, for the clean chat look's
 * plain-words row. Tools without a kind of their own count as "used N
 * tools".
 */
export function turnSummaryStepCounts(
  summary: TurnSummary,
): [StepKind, number][] {
  const counts: [StepKind, number][] = [];
  for (const key of SUMMARY_STEP_ORDER) {
    const count = summary[key] ?? 0;
    if (count > 0) counts.push([SUMMARY_STEP_KINDS[key] ?? 'other', count]);
  }
  return counts;
}

/**
 * The leading label for the row: "1 step", "4 steps", or "Agent steps".
 *
 * WHY ZERO IS NOT "0 steps". `buildChips` only emits a family with `count > 0`,
 * so `totalSteps` is `0` for any turn whose intermediate messages carry no
 * `tool_use` parts — a reasoning-only turn, most commonly. Those turns still
 * pass `hasCollapsibleIntermediate`, so this row renders on top of content that
 * genuinely does expand. Labelling it "0 steps" tells the reader there is
 * nothing behind the chevron and actively discourages the click. The neutral
 * label keeps the row legible (the reason the label exists at all) without
 * making a false claim about what it contains.
 *
 * PLURALISATION is a naive `s`, which is correct for this one noun; there is no
 * localisation layer in this package to defer to, and inventing one for a
 * single word would be worse than the honest limitation.
 */
function formatStepCount(total: number): string {
  if (total === 0) {
    return 'Agent steps';
  }
  return `${total} ${total === 1 ? 'step' : 'steps'}`;
}

/**
 * Renders {@link CollapsedTurnSummaryProps.elapsedMs} for display, or `null`
 * when there is nothing worth showing.
 *
 * The sub-second case is the reason this is not a bare call to
 * `formatDuration`: that helper rounds to whole seconds, so a 400ms turn comes
 * out as "0s" — technically true and completely useless next to a step count.
 * "<1s" says the same thing without claiming the turn took no time.
 */
function formatElapsedLabel(elapsedMs: number | undefined): string | null {
  if (elapsedMs == null || !Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return null;
  }
  return elapsedMs < 1000 ? '<1s' : formatDuration(elapsedMs);
}

export interface CollapsedTurnSummaryRowProps {
  /** Whether the parent currently shows the expanded intermediate region. */
  isExpanded: boolean;
  /** Click handler. Hosts can leave this unset for read-only summaries. */
  onClick?: MouseEventHandler<HTMLButtonElement>;
  /** Accessible name, conventionally `Agent steps: …`. */
  ariaLabel: string;
  /** Test ID hook for automation. */
  dataTestId?: string;
  /**
   * Positioning classes only, such as `ml-auto`. The row has no surface of
   * its own, so hosts must not add a background, border, radius, or shadow.
   */
  className?: string;
  /**
   * Whether the row takes the 44px phone-tier touch target. Defaults to
   * `true`; the desktop transcript opts out to keep its existing geometry.
   */
  phoneTouchTarget?: boolean;
  /** Row content after the chevron: labels and count chips. */
  children: ReactNode;
}

/**
 * The clickable shell of a collapsed turn summary: the toggle button, its
 * chevron, and the common row layout. Hosts supply the accessible name and
 * the row content, so desktop and shared chip vocabularies can differ while
 * the control itself is defined once.
 *
 * The row sits directly on the chat background: no fill, border, radius, or
 * shadow, at rest, hovered, or expanded. Hover lifts the foreground instead,
 * and keyboard focus draws the shared `focus-ring` outline.
 */
export const CollapsedTurnSummaryRow = forwardRef<
  HTMLButtonElement,
  CollapsedTurnSummaryRowProps
>(function CollapsedTurnSummaryRow(
  {
    isExpanded,
    onClick,
    ariaLabel,
    dataTestId,
    className = '',
    phoneTouchTarget = true,
    children,
  },
  ref,
): JSX.Element {
  // PHONE-TIER TOUCH TARGET. The compact `py-2` row is a ~30px tap target,
  // below the 44px floor the rest of the phone surface holds itself to, and it
  // is one of the few controls in a transcript a thumb actually has to hit.
  // Gated on the phone tier rather than on `pointer-coarse` so a touchscreen
  // laptop keeps the dense transcript it has room for.
  //
  // The gate is viewport-based, not host-based. The desktop main window sets
  // `minWidth: 800` (`apps/desktop-app/src/main/index.ts`), so the Code tab —
  // which reaches this component through `packages/ui-app`'s `TurnGroupView` —
  // never matches and keeps its dense row. The App Advisor popout can go down
  // to `APP_ADVISOR_MIN_WIDTH = 360`, where the larger target is wanted for the
  // same thumb-reach reason. See the matching note in `UserBubble`.
  const isPhone = useIsPhone();

  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-expanded={isExpanded}
      aria-label={ariaLabel}
      data-testid={dataTestId}
      className={`focus-ring flex w-full items-center gap-3 px-3 py-2 text-xs fg-secondary transition hover:fg-primary${
        className === '' ? '' : ` ${className}`
      }${phoneTouchTarget && isPhone ? ' min-h-11' : ''}`}
    >
      <span className="flex-shrink-0 fg-secondary" aria-hidden="true">
        {isExpanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
      </span>
      {children}
    </button>
  );
});

/**
 * Pure display summary of a collapsed turn: a step count, an optional elapsed
 * time, and the per-tool-family count chips. Click toggles a parent's expanded
 * state via `onToggle`. State is owned by the caller so this stays a leaf
 * component.
 *
 * WHY THERE IS A TEXT LABEL AT ALL. This row used to be chips and nothing
 * else, so a turn that ran one tool rendered as a ~30px strip reading "wrench
 * 1" — an unlabelled glyph next to a bare integer, with the entire meaning
 * carried by an `aria-label` that a sighted user never sees. Leading with "4
 * steps · 12s" makes the row legible at a glance, and the chips become the
 * detail behind the summary rather than the whole of it. The chips, the
 * `aria-label`, the `data-tool-chip` keys, and `dataTestId` are all unchanged:
 * desktop UI automation selects on them.
 */
export function CollapsedTurnSummary({
  summary,
  isExpanded,
  onToggle,
  appIcon,
  elapsedMs,
  completionStatus = 'complete',
  hideLeadingLabel = false,
  dataTestId,
}: CollapsedTurnSummaryProps): JSX.Element {
  const chips = buildChips(summary, appIcon);
  // An empty summary produces no chips, and `Agent steps: ` with a trailing
  // colon and nothing after it is worse than no detail at all for a screen
  // reader.
  const ariaDetail = chips
    .map((chip) => `${chip.count} ${chip.label}`)
    .join(', ');
  const ariaLabel =
    ariaDetail === '' ? 'Agent steps' : `Agent steps: ${ariaDetail}`;
  const totalSteps = chips.reduce(
    (total: number, chip: ChipEntry): number => total + chip.count,
    0,
  );
  const elapsedLabel = formatElapsedLabel(elapsedMs);
  const clean = useCleanChatLook();

  // Clean chat look: the finished turn's header, "Worked for 3m 24s", opens
  // the steps; what they did reads as words on hover.
  if (clean) {
    return (
      <TurnWorkHeader
        elapsedMs={elapsedMs}
        live={false}
        completionStatus={completionStatus}
        expandable
        isOpen={isExpanded}
        onToggle={onToggle}
        ariaLabel={ariaLabel}
        title={describeStepCounts(turnSummaryStepCounts(summary)) || undefined}
        dataTestId={dataTestId}
      />
    );
  }

  return (
    <CollapsedTurnSummaryRow
      isExpanded={isExpanded}
      onClick={onToggle}
      ariaLabel={ariaLabel}
      dataTestId={dataTestId}
    >
      <span
        className={`${
          hideLeadingLabel ? 'hidden' : 'flex'
        } flex-shrink-0 items-center gap-1.5 whitespace-nowrap font-medium`}
        data-turn-step-count={totalSteps}
      >
        {!hideLeadingLabel && (
          <>
            {formatStepCount(totalSteps)}
            {elapsedLabel !== null && (
              <span
                className="font-normal fg-tertiary"
                data-turn-elapsed={elapsedLabel}
              >
                · {elapsedLabel}
              </span>
            )}
          </>
        )}
      </span>
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="flex items-center gap-1"
          title={chip.label}
          data-tool-chip={chip.key}
        >
          <span className="flex-shrink-0">{chip.icon}</span>
          <span className="text-2xs font-medium">{chip.count}</span>
        </span>
      ))}
    </CollapsedTurnSummaryRow>
  );
}
