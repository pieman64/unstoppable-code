import type { ChatComposerToolbarChipConfig } from './ChatComposerToolbar';
import {
  CloseMediumIcon,
  PlanModeIcon,
  QuestionMarkIcon,
} from '../icons/AppIcons';

/** The Plan chip's label while it is on; Cursor and Copilot call it read only. */
export function planModeChipLabel(readOnly: boolean): string {
  return readOnly ? 'Read only' : 'Plan';
}

export interface DismissiblePlanChipOptions {
  /** The default: the tile beside + while Plan is on. */
  presentation?: 'dismissible';
  /** Cursor and Copilot present Plan as read-only mode. */
  readOnly: boolean;
  disabled: boolean;
  /** Turns Plan off; the chip is only shown while it is on. */
  onDisable: () => void;
  /** A narrow box draws the glyph alone, in a circle. */
  compact?: boolean;
  /** Defaults to the existing chat composer's selector. */
  dataTestId?: string;
}

export interface TogglePlanChipOptions {
  /** For composers without a + menu row for Plan: the chip stays mounted. */
  presentation: 'toggle';
  /** Whether Plan is on. */
  active: boolean;
  /** Flips Plan. */
  onToggle: () => void;
  disabled?: boolean;
  dataTestId?: string;
}

export type PlanModeChipOptions =
  | DismissiblePlanChipOptions
  | TogglePlanChipOptions;

/**
 * The Plan chip beside +, in one of two presentations.
 *
 * - `dismissible` (default): shown only while Plan is on, which is switched on
 *   from the + menu. The amber capsule keeps the state visible and removes it
 *   in one click; its close glyph says so. `compact` draws the glyph alone.
 * - `toggle`: a persistent toggle, icon-only while off and the same amber
 *   capsule and label while on. It has no close glyph because it stays put
 *   when turned off.
 */
export function buildPlanModeChip(
  options: PlanModeChipOptions,
): ChatComposerToolbarChipConfig {
  return options.presentation === 'toggle'
    ? buildToggleChip(options)
    : buildDismissibleChip(options);
}

function buildDismissibleChip({
  readOnly,
  disabled,
  onDisable,
  compact = false,
  dataTestId = 'chat-input-plan-mode-inline-button',
}: DismissiblePlanChipOptions): ChatComposerToolbarChipConfig {
  const label = readOnly ? 'Disable read-only mode' : 'Disable plan mode';
  return {
    onClick: onDisable,
    disabled,
    active: true,
    ariaPressed: true,
    activeTone: 'warning',
    ariaLabel: label,
    title: label,
    icon: <PlanModeIcon size="sm" active />,
    ...(compact
      ? {}
      : {
          label: planModeChipLabel(readOnly),
          trailing: <CloseMediumIcon size="sm" aria-hidden data-plan-remove />,
        }),
    variant: 'capsule',
    dataTestId,
  };
}

function buildToggleChip({
  active,
  onToggle,
  disabled,
  dataTestId,
}: TogglePlanChipOptions): ChatComposerToolbarChipConfig {
  return {
    variant: 'capsule',
    onClick: onToggle,
    ...(disabled === undefined ? {} : { disabled }),
    active,
    ariaPressed: active,
    activeTone: 'warning',
    title: active ? 'Disable plan mode' : 'Enable plan mode',
    ariaLabel: 'Toggle plan mode',
    icon: <PlanModeIcon size="sm" active={active} />,
    label: active ? planModeChipLabel(false) : undefined,
    ...(dataTestId === undefined ? {} : { dataTestId }),
  };
}

/**
 * The chip beside + while a question waits with its prompt closed: it reads
 * "Question" and reopens the prompt, as "Plan ready" does for a plan.
 */
export function buildQuestionReadyChip({
  onOpen,
  compact = false,
}: {
  onOpen: () => void;
  compact?: boolean;
}): ChatComposerToolbarChipConfig {
  return {
    onClick: onOpen,
    active: true,
    activeTone: 'warning',
    ariaLabel: 'Question waiting, answer it',
    title: 'Answer the question',
    // `sm`: the 14px the desktop chip's old 16px box drew (Lucide snapping).
    icon: <QuestionMarkIcon size="sm" />,
    ...(compact ? {} : { label: 'Question' }),
    variant: 'capsule',
    dataTestId: 'chat-input-question-ready-chip',
  };
}
