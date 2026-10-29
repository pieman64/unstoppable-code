import { useEffect, useRef } from 'react';
import {
  COMPOSER_ACTION_EVENT,
  isComposerChatScope,
  isComposerHomeScope,
  type ComposerShortcutScope,
} from '@/lib/composerShortcutRequests';
import type { ComposerAction } from '@/lib/composerCommands';

/** Each action is addressed to one composer, including split panels. */
export function useComposerActions(
  target: ComposerShortcutScope | null,
  actions: Partial<Record<ComposerAction, () => void>>,
  enabled: boolean,
): void {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  useEffect(() => {
    if (!target || !enabled) return;
    function handle(event: Event): void {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      const matches =
        target?.scope === 'home'
          ? isComposerHomeScope(detail) &&
            typeof detail === 'object' &&
            detail !== null &&
            ('composerId' in detail ? detail.composerId : undefined) ===
              target.composerId
          : target && isComposerChatScope(detail, target);
      if (
        !matches ||
        !detail ||
        typeof detail !== 'object' ||
        !('action' in detail) ||
        typeof detail.action !== 'string'
      )
        return;
      const action = Object.entries(actionsRef.current).find(
        ([name]) => name === detail.action,
      )?.[1];
      if (!action) return;
      event.preventDefault();
      action();
    }
    document.addEventListener(COMPOSER_ACTION_EVENT, handle);
    return (): void =>
      document.removeEventListener(COMPOSER_ACTION_EVENT, handle);
  }, [target, enabled]);
}
