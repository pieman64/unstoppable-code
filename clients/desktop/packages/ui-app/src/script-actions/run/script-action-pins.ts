import type { ScriptAction } from '@canopy/protocol/script-actions';
import {
  formatAcceleratorForDisplay,
  type ShortcutPlatform,
} from '@canopy/protocol/shortcuts';
import type { WorktreeTopBarPinnedAction } from '../../code/shell/WorktreeTopBarPins';
import { isRunnablePinnedScriptAction } from './script-action-eligibility';
import type { UseRunScriptActionResult } from './use-run-script-action';

const TOOLTIP_COMMAND_MAX = 80;

/** First command line, shortened for a one-line tooltip. */
export function scriptActionCommandPreview(command: string): string {
  const firstLine = command.split(/\r?\n/, 1)[0] ?? '';
  const multiline = /[\r\n]/.test(command.replace(/[\r\n]+$/, ''));
  const preview =
    firstLine.length > TOOLTIP_COMMAND_MAX
      ? `${firstLine.slice(0, TOOLTIP_COMMAND_MAX - 1)}…`
      : firstLine;
  return multiline && !preview.endsWith('…') ? `${preview} …` : preview;
}

/** Where an action runs, in the user's terms. */
export function scriptActionTargetLabel(
  action: Pick<ScriptAction, 'target' | 'repoName' | 'packagePath'>,
  selectedRepoName?: string | null,
): string {
  const base =
    action.target.kind === 'repository'
      ? (action.repoName ?? 'Repository')
      : action.target.kind === 'workspace-root'
        ? 'Workspace root'
        : selectedRepoName || 'Selected repository';
  return action.packagePath ? `${base}/${action.packagePath}` : base;
}

export interface BuildScriptActionPinsOptions {
  readonly platform: ShortcutPlatform;
  readonly selectedRepoName?: string | null;
  /** Called with the pin's action; the caller reports failures. */
  readonly onRun: (action: ScriptAction) => void;
}

/**
 * Top-bar pins for the runnable pinned actions, in snapshot order. Returns
 * none when the runner is not enabled, so an inactive, read-only or
 * terminal-free host never renders an executable pin.
 */
export function buildScriptActionPins(
  actions: readonly ScriptAction[] | null | undefined,
  runner: Pick<UseRunScriptActionResult, 'enabled' | 'isRunning' | 'isPending'>,
  { platform, selectedRepoName, onRun }: BuildScriptActionPinsOptions,
): WorktreeTopBarPinnedAction[] {
  if (!runner.enabled || !actions) return [];
  return actions.filter(isRunnablePinnedScriptAction).map((action) => ({
    id: action.id,
    label: action.name,
    command: scriptActionCommandPreview(action.command),
    target: scriptActionTargetLabel(action, selectedRepoName),
    ...(action.shortcut !== null && action.shortcutConflict === undefined
      ? { shortcut: formatAcceleratorForDisplay(action.shortcut, platform) }
      : {}),
    running: runner.isRunning(action),
    pending: runner.isPending(action),
    onRun: () => onRun(action),
  }));
}
