import type { JSX } from 'react';
import { useScriptActions } from '@canopy/app-state/script-actions';
import {
  isScriptActionDispatchChord,
  scriptActionCommandPreview,
  scriptActionTargetLabel,
} from '@canopy/ui-app/script-actions';
import { formatAcceleratorForDisplay } from '@canopy/protocol/shortcuts';
import type { ScriptAction } from '@canopy/protocol/script-actions';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { ShortcutKeys } from '@/components/shared/ShortcutKeys';
import { rendererShortcutPlatform } from '@/lib/globalFocusShortcut';
import { useChatStore } from '@/stores/chatStore';
import { SettingsGroup, SettingsRow, SettingsSection } from './SettingsLayout';

/** Why a stored binding does not dispatch, or null when it does. */
function inactiveReason(action: ScriptAction): string | null {
  if (action.status !== 'approved')
    return 'Review this script to use its shortcut';
  if (action.unavailableReason !== undefined) return action.unavailableReason;
  if (action.shortcutConflict !== undefined) return action.shortcutConflict;
  return null;
}

/**
 * The selected worktree's script shortcuts, beside the app's own bindings.
 * Read-only: shortcuts are assigned in the Scripts review. Renders nothing
 * without a selected worktree or any bound script.
 */
export function ScriptShortcutsSection(): JSX.Element | null {
  const selection = useChatStore((state) => state.selectedWorktree);
  const { snapshot } = useScriptActions({
    projectId: selection?.projectId,
    worktreeId: selection?.worktreeId,
  });
  const platform = rendererShortcutPlatform();
  const bound = (snapshot?.actions ?? []).filter(
    (action): action is ScriptAction & { shortcut: string } =>
      action.shortcut !== null &&
      isScriptActionDispatchChord(action.shortcut, platform),
  );
  if (bound.length === 0) return null;
  return (
    <SettingsSection
      title="Scripts in this worktree"
      dataTestId="settings-script-shortcuts"
    >
      <SettingsGroup>
        {bound.map((action) => {
          const reason = inactiveReason(action);
          return (
            <SettingsRow
              key={action.id}
              label={action.name}
              dataTestId={`script-shortcut-row-${action.id}`}
              description={
                reason ?? (
                  <>
                    <span className={REPLAY_BLOCK_CLASS}>
                      {scriptActionCommandPreview(action.command)}
                    </span>{' '}
                    in {scriptActionTargetLabel(action)}
                  </>
                )
              }
              control={
                <span className={reason === null ? undefined : 'opacity-60'}>
                  <ShortcutKeys
                    shortcut={formatAcceleratorForDisplay(
                      action.shortcut,
                      platform,
                    )}
                  />
                </span>
              }
            />
          );
        })}
      </SettingsGroup>
    </SettingsSection>
  );
}
