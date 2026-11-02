import { localCollectionEntryId } from '@canopy/ui-app/capability';
import { useGitHubStore } from '@/stores/githubStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import type { PublicShareInstalledTarget } from './usePublicShareLanding';
import {
  installRevealNotice,
  type InstallRevealOutcome,
} from './installRevealNotice';

/**
 * Where a finished install of a shared resource lands (CAN-3710): the install
 * review closes, the result opens with it marked, and a short notice says
 * what happened. Automations keep their own Library notice, which follows the
 * copy's enabled state.
 */

/**
 * Same literal the Plugins page listens for, so a collection installed while
 * it is mounted is listed before its detail opens.
 */
export const COLLECTIONS_CHANGED_EVENT = 'canopy:collections-changed';

export interface InstallReveal {
  target: PublicShareInstalledTarget;
  outcome: InstallRevealOutcome;
  /** The install's own terminal status, when it has one. */
  status?: string;
  /** Part of the share did not land, so the notice warns. */
  partial?: boolean;
}

/**
 * Opens an installed item where it lives, with it marked where the page can
 * mark it. Every page change goes through the store's guarded navigation, so
 * a dirty editor may still keep the user where they are.
 */
export function openInstalledResult(target: PublicShareInstalledTarget): void {
  const navigation = useNavigationStore.getState();
  switch (target.entity) {
    case 'automation':
      navigation.openAutomationEdit({ activityId: target.activityId });
      break;
    case 'skill':
      navigation.openSkillViewer({
        kind: 'installed',
        sourceId: target.sourceId,
        skillName: target.skillName,
      });
      break;
    case 'plugin':
      navigation.openPluginsNavigation({
        kind: 'entry-detail',
        entryId: target.entryId,
      });
      break;
    case 'collection':
      window.dispatchEvent(new Event(COLLECTIONS_CHANGED_EVENT));
      navigation.openPluginsNavigation({
        kind: 'entry-detail',
        entryId: localCollectionEntryId(target.collectionId),
      });
      break;
    case 'pipeline':
      navigation.openPipelineReveal({ pipelineId: target.pipelineId });
      break;
    case 'agent':
      navigation.openAgentReveal({
        agentId: target.agentId,
        mode: 'highlight',
      });
      break;
    case 'workspace':
      void useStandaloneChatStore
        .getState()
        .switchChatProject(target.projectId);
      navigation.navigate('chat');
      break;
  }
}

/**
 * Lands on a finished install: the result opens, then a short notice says
 * what happened. The item is installed whether or not a guarded navigation
 * lets the page change, so the notice shows either way. An automation lands
 * on its Library row, whose own notice follows the copy's enabled state.
 */
export function openInstallReveal({
  target,
  outcome,
  status = '',
  partial = false,
}: InstallReveal): void {
  if (target.entity === 'automation') {
    useNavigationStore
      .getState()
      .openAutomationReveal({ activityId: target.activityId, outcome });
    return;
  }
  openInstalledResult(target);
  announceInstall({ target, outcome, status, partial });
}

/**
 * The finished install's notice alone, for a landing that must not move the
 * user: they left for other work while it installed (CAN-5219).
 */
export function announceInstall({
  target,
  outcome,
  status = '',
  partial = false,
}: InstallReveal): void {
  if (target.entity === 'automation') return;
  useGitHubStore
    .getState()
    .addToast(
      installRevealNotice(target.entity, outcome, status),
      partial ? 'warning' : 'success',
    );
}
