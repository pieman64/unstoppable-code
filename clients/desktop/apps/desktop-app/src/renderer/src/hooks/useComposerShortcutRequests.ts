import { useEffect, useState } from 'react';
import {
  CYCLE_EFFORT_LEVEL_EVENT,
  isComposerChatScope,
  isComposerHomeScope,
  OPEN_MODEL_PICKER_EVENT,
  DICTATION_PRESS_EVENT,
  DICTATION_RELEASE_EVENT,
  readDictationHeldMs,
  type ComposerShortcutScope,
} from '@/lib/composerShortcutRequests';

export interface ComposerShortcutRequestsOptions {
  /**
   * The identity this composer answers to. Pass null while the composer
   * cannot be addressed (no active chat, hidden panel, ...) so requests aimed
   * at a sibling composer are ignored.
   */
  target: ComposerShortcutScope | null;
  /** Invoked on ⌥T. Should match the effort control's own click handler. */
  onCycleEffort: () => void;
  /**
   * ⌃M went down / came back up (after `heldMs`). Omit both where the
   * composer has no voice dictation, so the chord stays unclaimed.
   */
  onDictationPress?: () => void;
  onDictationRelease?: (heldMs: number) => void;
  /** False while the controls are disabled; requests become no-ops. */
  enabled: boolean;
}

/**
 * Subscribes a composer to its ⌥ shortcut requests (ECW-7984 follow-up) and
 * returns the ⌥M open signal to hand to `ModelPicker`.
 *
 * Several composers can be mounted at once (split panels, the Pipeline
 * Assistant drawer), so every request is matched against `target` before it
 * is acted on — a broadcast would fire every mounted picker at once, which is
 * exactly the fan-out defect the ⌘U attachment shortcut was fixed for.
 */
export function useComposerShortcutRequests({
  target,
  onCycleEffort,
  onDictationPress,
  onDictationRelease,
  enabled,
}: ComposerShortcutRequestsOptions): number {
  const [modelPickerOpenSignal, setModelPickerOpenSignal] = useState(0);

  useEffect(() => {
    if (!enabled || !target) {
      return;
    }

    function addressesThisComposer(detail: unknown): boolean {
      if (!target) {
        return false;
      }
      return target.scope === 'home'
        ? isComposerHomeScope(detail)
        : isComposerChatScope(detail, {
            projectId: target.projectId,
            worktreeId: target.worktreeId,
            chatId: target.chatId,
          });
    }

    function handleOpenModelPicker(event: Event): void {
      // `CustomEvent.detail` is `any`; the scope guards below narrow it.
      const detail: unknown =
        event instanceof CustomEvent ? event.detail : null;
      if (!addressesThisComposer(detail)) {
        return;
      }
      event.preventDefault();
      setModelPickerOpenSignal((signal) => signal + 1);
    }

    function handleCycleEffort(event: Event): void {
      // `CustomEvent.detail` is `any`; the scope guards below narrow it.
      const detail: unknown =
        event instanceof CustomEvent ? event.detail : null;
      if (!addressesThisComposer(detail)) {
        return;
      }
      event.preventDefault();
      onCycleEffort();
    }

    function handleDictationPress(event: Event): void {
      // `CustomEvent.detail` is `any`; the scope guards below narrow it.
      const detail: unknown =
        event instanceof CustomEvent ? event.detail : null;
      if (!onDictationPress || !addressesThisComposer(detail)) {
        return;
      }
      event.preventDefault();
      onDictationPress();
    }

    function handleDictationRelease(event: Event): void {
      const detail: unknown =
        event instanceof CustomEvent ? event.detail : null;
      if (!onDictationRelease || !addressesThisComposer(detail)) {
        return;
      }
      onDictationRelease(readDictationHeldMs(detail));
    }

    document.addEventListener(OPEN_MODEL_PICKER_EVENT, handleOpenModelPicker);
    document.addEventListener(CYCLE_EFFORT_LEVEL_EVENT, handleCycleEffort);
    document.addEventListener(DICTATION_PRESS_EVENT, handleDictationPress);
    document.addEventListener(DICTATION_RELEASE_EVENT, handleDictationRelease);
    return (): void => {
      document.removeEventListener(DICTATION_PRESS_EVENT, handleDictationPress);
      document.removeEventListener(
        DICTATION_RELEASE_EVENT,
        handleDictationRelease,
      );
      document.removeEventListener(
        OPEN_MODEL_PICKER_EVENT,
        handleOpenModelPicker,
      );
      document.removeEventListener(CYCLE_EFFORT_LEVEL_EVENT, handleCycleEffort);
    };
  }, [target, onCycleEffort, onDictationPress, onDictationRelease, enabled]);

  return modelPickerOpenSignal;
}
