'use client';

/**
 * Shared presentation for the desktop Codex speed selectors: the labels, the
 * quick-cycle rule, and the configuration composer chip. Pure display: the
 * host resolves availability (the actual route, model, and advertised tiers)
 * and owns every state change, so nothing here decides whether Ultra fast can
 * run. The values match the canonical `CodexSpeed` protocol enum.
 */
import { FastModeIcon, WarningIcon } from '../icons/AppIcons';
import type { ChatComposerToolbarChipConfig } from './ChatComposerToolbar';

/** A runtime speed. Structurally identical to the protocol `CodexSpeed`. */
export type CodexSpeedChoice = 'standard' | 'fast' | 'ultrafast';

/**
 * What a selector shows as selected. `default` is a configuration
 * composer's inherited choice, never a fourth runtime speed.
 */
export type CodexSpeedSelection = CodexSpeedChoice | 'default';

export const CODEX_SPEED_CHOICES: readonly CodexSpeedChoice[] = [
  'standard',
  'fast',
  'ultrafast',
];

export const CODEX_SPEED_LABELS: Readonly<Record<CodexSpeedChoice, string>> = {
  standard: 'Regular',
  fast: 'Fast',
  ultrafast: 'Ultra fast',
};

export const CODEX_SPEED_DEFAULT_LABEL = 'Use default';

/** Usage help for every speed surface. No fixed multiplier is universal. */
export const CODEX_SPEED_USAGE_HELP =
  'Higher speeds may use more of your subscription allowance.';

/** The provider's current speed guidance. */
export const CODEX_SPEED_HELP_URL =
  'https://learn.chatgpt.com/docs/agent-configuration/speed';

/** How the host resolved one speed for the current route and model. */
export interface CodexSpeedChoiceState {
  /** Whether the speed can be chosen now. Regular and Fast always can. */
  selectable: boolean;
  /** One-line reason for a full-picker row when it cannot be chosen. */
  shortReason?: string;
  /** Complete explanation, naming an alternative, for tooltips. */
  reason?: string;
  /**
   * The speed definitely cannot run on this route (the model does not offer
   * it, Auto, another connection), as opposed to a check that is still
   * running or could not be confirmed. Hosts step a definite one down.
   */
  definite?: boolean;
}

export type CodexSpeedChoiceStates = Readonly<
  Record<CodexSpeedChoice, CodexSpeedChoiceState>
>;

export function codexSpeedSelectionLabel(
  selection: CodexSpeedSelection,
): string {
  return selection === 'default'
    ? CODEX_SPEED_DEFAULT_LABEL
    : CODEX_SPEED_LABELS[selection];
}

/**
 * The quick-cycle target: the next speed in Regular → Fast → Ultra fast order
 * that can be chosen now. Ultra fast is skipped unless its state is
 * selectable, so an unknown catalog keeps the existing Regular ↔ Fast toggle.
 * `includeDefault` puts the inherited choice first for configuration
 * composers. A blocked selection moves on like any other; the cycle never
 * selects Ultra fast merely because it became available.
 */
export function nextCodexSpeedSelection(
  current: CodexSpeedSelection,
  states: CodexSpeedChoiceStates,
  options: { includeDefault?: boolean } = {},
): CodexSpeedSelection {
  const order: CodexSpeedSelection[] = options.includeDefault
    ? ['default', ...CODEX_SPEED_CHOICES]
    : [...CODEX_SPEED_CHOICES];
  const start = order.indexOf(current);
  for (let step = 1; step <= order.length; step += 1) {
    const candidate = order[(start + step) % order.length];
    if (candidate === undefined) continue;
    if (candidate === 'default' || states[candidate].selectable) {
      return candidate;
    }
  }
  return current;
}

/** {@link nextCodexSpeedSelection} for composers without an inherited choice. */
export function nextCodexSpeed(
  current: CodexSpeedChoice,
  states: CodexSpeedChoiceStates,
): CodexSpeedChoice {
  const next = nextCodexSpeedSelection(current, states);
  return next === 'default' ? 'standard' : next;
}

export interface CodexSpeedChipInput {
  /** The explicit choice, or `default` for an inherited one. */
  selection: CodexSpeedSelection;
  /**
   * The runtime speed the selection resolves to. Omit it only for an
   * inherited choice the host cannot resolve (a pipeline input inherits the
   * run's configuration).
   */
  effectiveSpeed?: CodexSpeedChoice;
  /** What activating the chip selects (see {@link nextCodexSpeedSelection}). */
  next: CodexSpeedSelection;
  /**
   * Why the effective speed cannot run for the next request. The chip keeps
   * the selection and shows this instead of silently changing speed.
   */
  blockedReason?: string | null;
  onClick: () => void;
  disabled?: boolean;
  dataTestId?: string;
  /** Capsule geometry matches the desktop composers. */
  variant?: 'chip' | 'capsule';
}

/**
 * Toolbar chip for the quick speed cycle. It always names the current speed,
 * so its accessible name states both the current speed and the next one; it
 * is a three-state cycle, not a boolean `aria-pressed` toggle.
 */
export function buildCodexSpeedChip({
  selection,
  effectiveSpeed,
  next,
  blockedReason,
  onClick,
  disabled,
  dataTestId,
  variant = 'capsule',
}: CodexSpeedChipInput): ChatComposerToolbarChipConfig {
  const blocked = Boolean(blockedReason);
  const current =
    selection !== 'default'
      ? CODEX_SPEED_LABELS[selection]
      : effectiveSpeed
        ? `${CODEX_SPEED_DEFAULT_LABEL} (${CODEX_SPEED_LABELS[effectiveSpeed]})`
        : CODEX_SPEED_DEFAULT_LABEL;
  const state = blocked ? `${current}, can't run now` : current;
  const target =
    next === 'default' ? 'the default speed' : CODEX_SPEED_LABELS[next];
  const elevated =
    effectiveSpeed !== undefined && effectiveSpeed !== 'standard';
  return {
    variant,
    icon: <FastModeIcon size="sm" active={elevated} />,
    label: codexSpeedSelectionLabel(selection),
    trailing: blocked ? (
      <WarningIcon aria-hidden size="sm" data-speed-blocked />
    ) : undefined,
    active: elevated || blocked,
    activeTone: blocked ? 'warning' : 'default',
    activeStyle: blocked
      ? undefined
      : {
          backgroundColor: 'var(--codex-fast-mode-background)',
          color: 'var(--codex-fast-mode-foreground)',
        },
    disabled,
    onClick,
    title: blockedReason || CODEX_SPEED_USAGE_HELP,
    ariaLabel: `Speed: ${state}. Select to use ${target}.`,
    dataTestId,
  };
}
