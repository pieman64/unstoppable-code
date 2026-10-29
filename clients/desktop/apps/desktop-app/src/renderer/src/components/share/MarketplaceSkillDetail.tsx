import { useMemo, type JSX } from 'react';
import { MarketplaceDetailPageShell } from '@canopy/ui-app/capability';
import { MarketplaceShareButton } from '@canopy/ui-shared/components';
import type { MarketplaceShareAction } from '@canopy/ui-shared/lib';
import { useNavigationStore } from '@/stores/navigationStore';
import { usePublicShareLanding } from './usePublicShareLanding';
import { MarketplaceSkillDetailBody } from './MarketplaceSkillDetailBody';

interface MarketplaceSkillDetailProps {
  externalId: string;
  entity?: 'skill' | 'plugin';
  name: string;
  onClose: () => void;
  /** Share, beside the primary; hidden unless usable (a catalog skill is already public). */
  shareAction?: MarketplaceShareAction;
}

/**
 * A Marketplace skill's page: its README and requirements, with Install
 * opening the same install review as a skill link.
 */
export function MarketplaceSkillDetail({
  externalId,
  entity = 'skill',
  name,
  onClose,
  shareAction,
}: MarketplaceSkillDetailProps): JSX.Element {
  const link = useMemo(
    () => ({
      entity,
      externalId,
      intent: 'install' as const,
    }),
    [entity, externalId],
  );
  // Browsing the Marketplace is not the web handoff funnel, so this page
  // reports no handoff events.
  const landing = usePublicShareLanding(link);
  const snapshot = landing.snapshot;
  const description =
    snapshot?.entity === 'skill' || snapshot?.entity === 'plugin'
      ? snapshot.description || undefined
      : undefined;
  const installed = landing.installed;
  // The shared detail header (CAN-4261): title, description and meta, the
  // actions beside the title, no Back (the breadcrumb leads out), and only a
  // Share it can use; a catalog skill is already public.
  return (
    <MarketplaceDetailPageShell
      title={name}
      header={{
        description,
        meta: [
          snapshot?.entity === 'skill' ? snapshot.publisher?.name : undefined,
          installed !== null ? (
            <span role="status" data-testid="deep-link-share-installed-status">
              {landing.installStatus !== ''
                ? landing.installStatus
                : installed.entity === 'skill'
                  ? `Installed as “${installed.skillName}”`
                  : 'Installed'}
            </span>
          ) : undefined,
        ],
      }}
      share={
        shareAction?.status === 'shareable' ? (
          <MarketplaceShareButton
            action={shareAction}
            name={name}
            placement="detail"
            dataTestId="plugins-entry-detail-share"
          />
        ) : undefined
      }
    >
      <MarketplaceSkillDetailBody
        entity={entity}
        landing={landing}
        onNavigate={onClose}
        // Install opens the same review every shared resource uses
        // (CAN-3710); it installs and lands on the skill.
        onInstall={(): void => {
          useNavigationStore.getState().openShareInstall(link, 'in-app');
        }}
        headerTitle={name}
        headerDescription={description}
      />
    </MarketplaceDetailPageShell>
  );
}
