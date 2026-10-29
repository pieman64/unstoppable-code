import type { ComposerAction } from './composerCommands';
/**
 * Composer-scoped shortcut requests (ECW-7984 follow-up): ⌥W opens the
 * workspace picker, ⌥M the model picker, ⌥T cycles the effort level.
 *
 * These chords are handled by the global shortcut hook, but the controls they
 * drive own their open state internally and live far down the tree (the Home
 * composer toolbar, or one `ChatInput` among several mounted split panels).
 * A DOM event carries the request the same way `chatAttachmentShortcut` does
 * for ⌘U.
 *
 * The `scope` discriminant is what keeps a single keypress from fanning out to
 * every mounted composer: `home` addresses the one Home composer, and `chat`
 * carries the full chat identity so only the matching `ChatInput` reacts.
 */

export const OPEN_WORKSPACE_PICKER_EVENT = 'canopy:open-workspace-picker';
export const OPEN_MODEL_PICKER_EVENT = 'canopy:open-model-picker';
export const CYCLE_EFFORT_LEVEL_EVENT = 'canopy:cycle-effort-level';
export const DICTATION_PRESS_EVENT = 'canopy:dictation-press';
export const DICTATION_RELEASE_EVENT = 'canopy:dictation-release';

export interface ComposerChatScope {
  scope: 'chat';
  projectId: string;
  worktreeId: string;
  chatId: string;
}

export interface ComposerHomeScope {
  scope: 'home';
  /** Local menu actions target an instance; global shortcuts omit this. */
  composerId?: string;
}

export type ComposerShortcutScope = ComposerChatScope | ComposerHomeScope;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when the event detail addresses the single Home composer. */
export function isComposerHomeScope(value: unknown): boolean {
  return isRecord(value) && value.scope === 'home';
}

/**
 * True when the event detail addresses exactly this chat composer. Mirrors
 * `isChatAttachmentShortcutTarget`: identity is the full
 * (projectId, worktreeId, chatId) triple, so sibling split-panel composers
 * ignore the request.
 */
export function isComposerChatScope(
  value: unknown,
  target: Omit<ComposerChatScope, 'scope'>,
): boolean {
  return (
    isRecord(value) &&
    value.scope === 'chat' &&
    value.projectId === target.projectId &&
    value.worktreeId === target.worktreeId &&
    value.chatId === target.chatId
  );
}

function dispatch(eventName: string, detail: ComposerShortcutScope): boolean {
  const event = new CustomEvent(eventName, { cancelable: true, detail });
  document.dispatchEvent(event);
  return event.defaultPrevented;
}

export function requestWorkspacePickerOpen(): boolean {
  return dispatch(OPEN_WORKSPACE_PICKER_EVENT, { scope: 'home' });
}

export function requestModelPickerOpen(scope: ComposerShortcutScope): boolean {
  return dispatch(OPEN_MODEL_PICKER_EVENT, scope);
}

export function requestEffortLevelCycle(scope: ComposerShortcutScope): boolean {
  return dispatch(CYCLE_EFFORT_LEVEL_EVENT, scope);
}

/** ⌃M went down over this composer: start dictating (or end a hands-free take). */
export function requestDictationPress(scope: ComposerShortcutScope): boolean {
  return dispatch(DICTATION_PRESS_EVENT, scope);
}

/** ⌃M came back up after `heldMs`: a hold ends the take, a tap keeps it. */
export function requestDictationRelease(
  scope: ComposerShortcutScope,
  heldMs: number,
): void {
  document.dispatchEvent(
    new CustomEvent(DICTATION_RELEASE_EVENT, {
      detail: { ...scope, heldMs },
    }),
  );
}

/** How long a dictation press was held, from a release event's detail. */
export function readDictationHeldMs(detail: unknown): number {
  return isRecord(detail) && typeof detail.heldMs === 'number'
    ? detail.heldMs
    : 0;
}

export const COMPOSER_ACTION_EVENT = 'canopy:composer-action';
export function requestComposerAction(
  scope: ComposerShortcutScope,
  action: ComposerAction,
): boolean {
  const event = new CustomEvent(COMPOSER_ACTION_EVENT, {
    cancelable: true,
    detail: { ...scope, action },
  });
  document.dispatchEvent(event);
  return event.defaultPrevented;
}
