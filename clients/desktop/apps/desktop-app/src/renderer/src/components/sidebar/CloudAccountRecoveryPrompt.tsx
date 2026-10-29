import { type JSX } from 'react';
import { WarningIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  SidebarFooterBanner,
  SidebarFooterBannerIcon,
} from './SidebarFooterBanner';
import { openCloudAccountSettings } from '@/lib/navigation/settings-destinations';

/**
 * Third entry point to cloud-account recovery, for the configuration in which
 * neither of the other two is reachable.
 *
 * The blocking sign-in wall (`CloudSignInGate`) and the Settings → Account tile
 * both surface the recovery notice, but the wall only renders when the identity
 * gate is active and guest mode is off. In a guest-mode build — or with the
 * gate off entirely — recorded consent satisfies `cloudGateSatisfied`, the
 * shell opens normally, and an unreadable credential is invisible while
 * `isModelBlockedByStoredPolicy` silently refuses every non-Ollama model. This
 * banner is the only thing pointing at the cause in that state.
 *
 * It does not duplicate the reset flow: clicking it opens the existing Settings
 * cloud-account section scrolled to the same notice. One implementation of
 * reset, three entry points.
 *
 * No suppression logic is needed while the sign-in wall is showing — the wall
 * returns instead of the shell in `App.tsx`, so the sidebar is not mounted.
 */
export interface CloudAccountRecoveryPromptProps {
  /**
   * `true` when the authoritative account read reported `read: 'error'`. Owned
   * by `SidebarAccountMenu`'s existing account subscription so this banner
   * cannot disagree with the other two surfaces or add a second IPC read on the
   * startup path.
   */
  visible: boolean;
}

export function CloudAccountRecoveryPrompt({
  visible,
}: CloudAccountRecoveryPromptProps): JSX.Element {
  if (!visible) {
    return <></>;
  }

  return (
    <div>
      <SidebarFooterBanner
        ariaLabel="Sign-in needs repair: open account settings"
        surface="status"
        onClick={(): void =>
          openCloudAccountSettings({
            scrollTo: 'cloud-account-recovery-notice',
          })
        }
        testId="sidebar-cloud-account-recovery"
        title="Your saved sign-in can’t be read. Open account settings to reset it."
      >
        <SidebarFooterBannerIcon tone="warning">
          <WarningIcon size={16} aria-hidden="true" />
        </SidebarFooterBannerIcon>
        <span className="min-w-0 flex-1 truncate">Sign-in needs repair</span>
      </SidebarFooterBanner>
    </div>
  );
}
